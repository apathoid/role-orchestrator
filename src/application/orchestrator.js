import { decodeDecision, decodeOutcome, decodeRequest } from '../core/contracts.js';
import { decode, id, optional, record, text } from '../core/decode.js';
import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { applyEvent, createOperation, resourceSnapshot, sameRecord } from '../core/operation.js';
import { admitActions } from '../core/action-graph.js';
import { controllerContext, controllerInstructions } from './controller-context.js';
import { materializeHandoff } from './handoff.js';
import { runActionRound } from './action-round.js';

/** @import {Action, CancellationSource, Decision, Outcome, ReasonCode} from '../core/contracts.js' */
/** @import {FieldError} from '../core/decode.js' */
/** @import {Clock, DiagnosticPort, IdFactory} from '../core/diagnostics.js' */
/** @import {Event, Limits, Operation, Reason} from '../core/operation.js' */
/** @import {Handoff} from './handoff.js' */
/** @import {Catalog, ContextItem, Profile, ProviderPort, ProviderSession, StateStore} from '../core/ports.js' */

/**
 * @typedef {{
 *   store: StateStore, provider: ProviderPort, catalog: Catalog, profile: Profile,
 *   clock: Clock, ids: IdFactory, limits: Limits, invocationTimeoutMs: number,
 *   providerFor?: (profile: Profile) => ProviderPort | undefined,
 *   diagnostics?: DiagnosticPort, authorityRef: string, configurationRef: string,
 *   schedule?: (timeoutMs: number, expire: () => void) => () => void
 * }} Dependencies
 * @typedef {{operation: Operation, completion: Promise<Operation>}} Submission
 * @typedef {{signal: AbortController, completion: Promise<Operation>}} Running
 */

/** @template T @typedef {T extends Event ? Omit<T, 'operationId' | 'eventId' | 'receivedAt'> : never} EventData */

const followup = record({ requestId: id, text, questionId: optional(id) });

export class OrchestrationError extends Error {
  /** @param {ReasonCode} code @param {string} message @param {string} [path] */
  constructor(code, message, path) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

/** @param {number} timeoutMs @param {() => void} expire */
function scheduleDeadline(timeoutMs, expire) {
  const timer = setTimeout(expire, timeoutMs);
  return () => clearTimeout(timer);
}

/** @param {string} attemptId @param {ReasonCode} code @param {boolean} mayHaveSent @returns {Outcome} */
function failedOutcome(attemptId, code, mayHaveSent) {
  return {
    schemaVersion: 1, attemptId,
    terminal: mayHaveSent ? 'unknown' : code === 'CANCELLED' ? 'cancelled' : 'failed',
    effect: mayHaveSent ? 'unknown' : 'none', diagnostics: [{ code, ref: undefined }], outputRefs: [],
    usage: { inputTokens: null, outputTokens: null, cost: null },
  };
}

/** @param {Dependencies} deps */
export function createOrchestrator(deps) {
  const {
    store, provider, catalog, profile, clock, ids, limits, invocationTimeoutMs, authorityRef, configurationRef,
    diagnostics = noopDiagnostics, schedule = scheduleDeadline,
    providerFor = selected => selected.providerId === profile.providerId ? provider : undefined,
  } = deps;
  if (!Number.isSafeInteger(invocationTimeoutMs) || invocationTimeoutMs < 1 || invocationTimeoutMs > 2_147_483_647) {
    throw new RangeError('invocationTimeoutMs must be an integer from 1 to 2147483647');
  }
  /** @type {Map<string, Running>} */
  const running = new Map();
  /** @type {Map<string, Map<string, AbortController>>} */
  const workerStops = new Map();
  let writes = Promise.resolve();
  /** @type {{promise: Promise<void>, resolve: () => void}} */
  let slot = Promise.withResolvers();

  function releaseSlot() {
    slot.resolve();
    slot = Promise.withResolvers();
  }

  // The application owns mutation order. Provider I/O never holds this queue.
  /** @template T @param {() => Promise<T>} task */
  function serialize(task) {
    const next = writes.then(task);
    writes = next.then(() => {}, () => {});
    return next;
  }

  /** @param {string} operationId */
  async function inspect(operationId) {
    const state = await store.load(operationId);
    if (!state) throw new OrchestrationError('INVALID_PROPOSAL', 'Unknown operation', '$.operationId');
    return state;
  }

  /** @param {Operation} next @param {number | null} revision */
  async function commit(next, revision) {
    const result = await store.commit(next.operationId, revision, next);
    if (result.kind !== 'committed') {
      throw new OrchestrationError(result.kind === 'conflict' ? 'STORE_CONFLICT' : 'STORE_UNAVAILABLE',
        'Unable to persist operation state');
    }
  }

  /** @param {Operation} state @param {EventData<Event>} data */
  async function transition(state, data) {
    const result = applyEvent(state, {
      ...data, operationId: state.operationId, eventId: ids.newId(), receivedAt: clock.now(),
    });
    if (result.kind === 'rejected') throw new OrchestrationError(result.reason.code, 'Invalid transition: ' + data.kind);
    if (result.kind === 'applied') {
      await commit(result.state, state.revision);
      emitDiagnostic(diagnostics, result.diagnostic);
    }
    return result.state;
  }

  /** @param {Operation} state @param {string} eventName @param {string} reasonCode @param {string} [attemptId] */
  function trace(state, eventName, reasonCode, attemptId) {
    emitDiagnostic(diagnostics, {
      schemaVersion: 1, eventId: ids.newId(), receivedAt: clock.now(), sequence: state.revision,
      level: eventName.endsWith('invalid_proposal') ? 'warn' : 'info', component: 'application',
      eventName, reasonCode, operationId: state.operationId, attemptId,
    });
  }

  /** @param {Operation} state @param {Reason} reason */
  function technicalWait(state, reason) {
    return transition(state, { kind: 'operation.waiting', waiting: { kind: 'technical', reason } });
  }

  /** @param {Operation} state @returns {Submission} */
  function activeSubmission(state) {
    return { operation: state, completion: running.get(state.operationId)?.completion ?? Promise.resolve(state) };
  }

  /** @param {Operation} state @returns {Submission} */
  function launch(state) {
    const signal = new AbortController();
    const completion = drive(state.operationId, signal.signal).finally(() => {
      if (running.get(state.operationId)?.signal === signal) running.delete(state.operationId);
    });
    running.set(state.operationId, { signal, completion });
    void completion.catch(() => {});
    return { operation: state, completion };
  }

  /** @param {unknown} input @returns {Promise<Submission>} */
  async function submit(input) {
    const parsed = decodeRequest(input);
    if (parsed.kind === 'rejected') {
      throw new OrchestrationError(parsed.reason.code, parsed.reason.expected, parsed.reason.path);
    }
    const request = parsed.value;
    if (request.configurationRef !== configurationRef) {
      throw new OrchestrationError('PERMISSION_DENIED', 'Unknown trusted configuration', '$.configurationRef');
    }
    return serialize(async () => {
      const all = await store.list();
      const previous = all.find(item => item.request.requestId === request.requestId);
      if (previous) {
        if (!sameRecord(previous.request, request)) throw new OrchestrationError('IDENTITY_CONFLICT', 'Request id reused');
        return activeSubmission(previous);
      }
      if (all.some(item => item.transcriptRefs.includes(request.requestId))) {
        throw new OrchestrationError('IDENTITY_CONFLICT', 'Request id reused');
      }
      const state = createOperation(ids.newId(), request, authorityRef, limits);
      await commit(state, null);
      trace(state, 'operation.accepted', 'ACCEPTED');
      return launch(state);
    });
  }

  /** @param {string} operationId @param {unknown} [input] @returns {Promise<Submission>} */
  async function resume(operationId, input) {
    if (input === undefined) return activeSubmission(await inspect(operationId));
    const parsed = decode(followup, input);
    if (parsed.kind === 'rejected') {
      throw new OrchestrationError(parsed.reason.code, parsed.reason.expected, parsed.reason.path);
    }
    const follow = parsed.value;
    return serialize(async () => {
      const all = await store.list();
      const state = await inspect(operationId);
      for (const operation of all) {
        if (operation.request.requestId === follow.requestId) throw new OrchestrationError('IDENTITY_CONFLICT', 'Request id reused');
        const event = operation.events.find(item => item.kind === 'operation.continued' && item.input.requestId === follow.requestId);
        if (event?.kind === 'operation.continued') {
          if (operation.operationId === operationId && sameRecord(event.input, follow)) return activeSubmission(state);
          throw new OrchestrationError('IDENTITY_CONFLICT', 'Request id reused');
        }
      }
      const question = state.waiting?.kind === 'question' ? state.waiting : undefined;
      if (follow.questionId !== question?.questionId) {
        throw new OrchestrationError('INVALID_PROPOSAL', 'Question is missing, closed or belongs to another operation', '$.questionId');
      }
      const next = await transition(state, { kind: 'operation.continued', input: follow });
      return launch(next);
    });
  }

  /** @param {string} operationId @param {CancellationSource} [source] */
  async function cancel(operationId, source = 'user') {
    return serialize(async () => {
      const state = await inspect(operationId);
      const next = await transition(state, { kind: 'operation.cancelled', source });
      running.get(operationId)?.signal.abort(source);
      for (const stop of workerStops.get(operationId)?.values() ?? []) stop.abort(source);
      releaseSlot();
      return next;
    });
  }

  /**
   * @param {Operation} state @param {string} attemptId @param {AbortSignal} stop
   * @param {FieldError | undefined} correction @param {Handoff} [handoff] @param {ProviderPort} [executor]
   */
  async function invoke(state, attemptId, stop, correction, handoff, executor = provider) {
    const local = new AbortController();
    const signal = AbortSignal.any([stop, local.signal]);
    const clear = schedule(invocationTimeoutMs, () => local.abort('deadline'));
    /** @type {ProviderSession | undefined} */
    let session;
    let mayHaveSent = false;
    let contextCursor = state.revision;
    /** @type {ContextItem[]} */
    const observations = [];
    let acceptingObservations = true;
    let requestedCancel = Promise.resolve();
    /** @type {unknown} */
    let output;
    /** @type {Outcome} */
    let outcome;
    /** @type {'sent' | 'not_sent' | 'unknown'} */
    let certainty = 'not_sent';
    const abort = () => {
      const owned = session;
      if (mayHaveSent && owned) {
        requestedCancel = Promise.resolve().then(() => executor.cancel(owned, attemptId)).catch(() => {
          trace(state, 'provider.cleanup', 'PROTOCOL_ERROR', attemptId);
        });
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const entries = handoff ? [] : await catalog.list();
      const selectedProfile = handoff?.profile ?? profile;
      const attachments = handoff ? handoff.attachments ?? [] : state.request.attachments;
      const requiredCapabilities = new Set(handoff?.requiredCapabilities);
      if (attachments.some(item => item.mediaType.toLowerCase().startsWith('image/'))) {
        requiredCapabilities.add('input.image');
      }
      if (requiredCapabilities.size) {
        signal.throwIfAborted();
        const capabilities = selectedProfile.capabilities ?? (await executor.describe()).capabilities;
        if ([...requiredCapabilities].some(key => !Object.hasOwn(capabilities, key) ||
            capabilities[key].support !== 'supported')) {
          return {
            outcome: failedOutcome(attemptId, 'CAPABILITY_UNAVAILABLE', false),
            certainty: /** @type {const} */ ('not_sent'), output, observations, contextCursor,
          };
        }
      }
      signal.throwIfAborted();
      session = await executor.open(selectedProfile, signal);
      const owned = session;
      const invocation = await serialize(async () => {
        const current = await inspect(state.operationId);
        signal.throwIfAborted();
        const dispatched = await transition(current, { kind: 'attempt.dispatched', attemptId });
        contextCursor = dispatched.revision;
        signal.throwIfAborted();
        mayHaveSent = true;
        if (!handoff) trace(dispatched, 'controller.requested', 'DISPATCH_STARTED', attemptId);
        // Keep the dispatch decision and actual provider call in the same turn.
        const context = handoff ?? {
          operationId: state.operationId, actionId: attemptId, kind: /** @type {const} */ ('controller'),
          objective: state.request.text, instructions: controllerInstructions, profile,
          workspaceContext: state.request.workspaceContext, userConstraints: state.request.userConstraints,
          context: controllerContext(dispatched, entries, correction), authorityRef: state.authorityRef,
        };
        return { response: executor.invoke(owned, {
          ...context, attachments, requiredCapabilities: [...requiredCapabilities], attemptId, timeoutMs: invocationTimeoutMs, signal,
        }, item => { if (acceptingObservations) observations.push(item); }) };
      });
      const reply = await invocation.response;
      const parsed = decodeOutcome(reply.outcome);
      if (parsed.kind === 'rejected' || parsed.value.attemptId !== attemptId ||
          !['not_sent', 'sent', 'unknown'].includes(reply.dispatchCertainty) ||
          (reply.dispatchCertainty === 'not_sent' && parsed.value.effect !== 'none')) {
        outcome = failedOutcome(attemptId, 'PROTOCOL_ERROR', true);
        certainty = 'unknown';
      } else {
        ({ dispatchCertainty: certainty, output } = reply);
        outcome = parsed.value;
      }
    } catch (error) {
      if (error instanceof OrchestrationError && ['STORE_CONFLICT', 'STORE_UNAVAILABLE'].includes(error.code)) throw error;
      const code = stop.aborted ? 'CANCELLED' : local.signal.aborted ? 'DEADLINE_EXCEEDED'
        : mayHaveSent ? 'PROVIDER_DISCONNECTED' : 'PROVIDER_START_FAILED';
      certainty = mayHaveSent ? 'unknown' : 'not_sent';
      outcome = failedOutcome(attemptId, code, mayHaveSent);
    } finally {
      acceptingObservations = false;
      clear();
      signal.removeEventListener('abort', abort);
      await requestedCancel;
      if (session) {
        try { await executor.close(session); } catch { trace(state, 'provider.cleanup', 'PROTOCOL_ERROR', attemptId); }
      }
    }
    return { outcome, certainty, output, observations, contextCursor };
  }

  /** @param {string} operationId @param {AbortSignal} stop @param {string} [actionId] */
  async function reserve(operationId, stop, actionId) {
    let notified = false;
    while (true) {
      const result = await serialize(async () => {
        const state = await inspect(operationId);
        if (stop.aborted || state.status !== 'active') return { state };
        if (actionId) {
          if (state.events.some(event => event.kind === 'action.cancelled' && event.actionId === actionId)) return { state };
          if (state.attempts.some(attempt => attempt.actionId === actionId)) return { state, known: true };
        }
        const resources = resourceSnapshot(state);
        if (resources.remaining <= 0) {
          return { state: actionId ? state : await technicalWait(state, { code: 'RESOURCE_LIMIT', operationId }) };
        }
        const all = await store.list();
        const active = all.reduce((count, item) => count + resourceSnapshot(item).active, 0);
        if (active >= limits.maxConcurrentInvocations) {
          if (!notified && actionId) {
            notified = true;
            await transition(state, { kind: 'action.deferred', actionId, code: 'RESOURCE_LIMIT', resource: 'concurrency' });
          }
          return { state, ready: slot.promise };
        }
        const attemptId = ids.newId();
        return {
          attemptId, state: await transition(state, { kind: 'attempt.reserved', attemptId, actionId: actionId ?? attemptId }),
        };
      });
      if (!result.ready) return result;
      await result.ready;
    }
  }

  /** @param {Operation} state @param {Action} action @param {AbortSignal} stop */
  async function dispatchDelegate(state, action, stop) {
    const owned = workerStops.get(state.operationId) ?? new Map();
    if (owned.has(action.actionId)) return false;
    const local = new AbortController();
    owned.set(action.actionId, local);
    workerStops.set(state.operationId, owned);
    try {
      return await dispatchWorker(state, action, AbortSignal.any([stop, local.signal]));
    } finally {
      owned.delete(action.actionId);
      if (!owned.size) workerStops.delete(state.operationId);
    }
  }

  /** @param {Operation} state @param {Action} action @param {AbortSignal} stop */
  async function dispatchWorker(state, action, stop) {
    const current = await inspect(state.operationId);
    if (stop.aborted || current.status !== 'active') return false;
    const entries = await catalog.list();
    const handoff = materializeHandoff(current, action, entries, controllerContext(current, entries, undefined));
    const executor = handoff.kind === 'accepted' ? providerFor(handoff.handoff.profile) : undefined;
    if (handoff.kind === 'rejected' || !executor) {
      await recordAction(state.operationId, action, 'action.rejected', 'CAPABILITY_UNAVAILABLE',
        handoff.kind === 'rejected' ? handoff.resource : action.profileId);
      return false;
    }
    const reserved = await reserve(state.operationId, stop, action.actionId);
    if (!reserved.attemptId) {
      if (reserved.known) return true;
      if (!stop.aborted && !reserved.state.events.some(event => event.kind === 'action.cancelled' &&
        event.actionId === action.actionId)) await recordAction(state.operationId, action, 'action.deferred', 'RESOURCE_LIMIT');
      return false;
    }
    const attemptId = reserved.attemptId;
    try {
      const response = await invoke(reserved.state, attemptId, stop, undefined, handoff.handoff, executor);
      const observations = response.observations;
      if (response.output !== undefined) {
        observations.push({ ref: 'attempt-output:' + attemptId, source: 'model_claim', completeness: 'complete', value: response.output });
      }
      await serialize(async () => transition(await inspect(state.operationId), {
        kind: 'attempt.outcome', outcome: response.outcome, dispatchCertainty: response.certainty, observations,
      }));
      return true;
    } finally {
      releaseSlot();
    }
  }

  /** @param {string} operationId @param {Action} action @param {'action.rejected' | 'action.deferred'} kind
   * @param {ReasonCode} code @param {string} [resource]
   */
  async function recordAction(operationId, action, kind, code, resource) {
    await serialize(async () => transition(await inspect(operationId), {
      kind, actionId: action.actionId, code, resource,
    }));
  }

  /** @param {Operation} state @param {Decision} decision */
  function planRound(state, decision) {
    const known = state.events.flatMap(event => event.kind === 'controller.responded'
      ? event.admissions?.flatMap(item => item.kind === 'accepted' ? [item.action] : []) ?? [] : []);
    if (decision.cancellations.some(id => !known.some(action => action.actionId === id))) {
      return { error: /** @type {FieldError} */ ({
        code: 'INVALID_PROPOSAL', path: '$.cancellations', expected: 'ids of previously admitted actions',
      }) };
    }
    const admissions = admitActions(known, decision.additions);
    const actions = new Map([...known, ...admissions.flatMap(item => item.kind === 'accepted' ? [item.action] : [])]
      .map(action => [action.actionId, action]));
    const rejected = new Set(admissions.flatMap(item => item.kind === 'rejected' ? [item.actionId] : []));
    const selected = [];
    const waitingFor = new Set();
    const terminals = new Set(state.attempts.filter(attempt => attempt.status === 'terminal').map(attempt => attempt.actionId));
    for (const target of decision.waitPolicy?.targets ?? []) {
      const actionId = target.kind === 'attempt'
        ? state.attempts.find(attempt => attempt.attemptId === target.id)?.actionId : target.id;
      const action = actionId === undefined ? undefined : actions.get(actionId);
      if (actionId === undefined || (!action && !rejected.has(actionId))) {
        return { error: /** @type {FieldError} */ ({
          code: 'INVALID_PROPOSAL', path: '$.waitPolicy.targets', expected: 'ids of known or proposed actions or their attempts',
        }) };
      }
      waitingFor.add(actionId);
      if (action && !rejected.has(actionId)) selected.push(action);
    }
    const newResult = state.events.some((event, index) => index + 1 > decision.contextCursor && event.kind === 'attempt.outcome' &&
      state.attempts.some(attempt => attempt.attemptId === event.outcome.attemptId && waitingFor.has(attempt.actionId)));
    if (decision.waitPolicy && !newResult && !rejected.size && [...waitingFor].every(id => terminals.has(id))) {
      return { error: /** @type {FieldError} */ ({
        code: 'INVALID_PROPOSAL', path: '$.waitPolicy.targets', expected: 'at least one pending action or unseen result',
      }) };
    }
    return { admissions, selected: [...new Set(selected)], newResult };
  }

  /** @param {string} operationId @param {AbortSignal} stop */
  async function drive(operationId, stop) {
    /** @type {FieldError | undefined} */
    let correction;
    /** @type {Map<string, Promise<boolean>>} */
    const pending = new Map();
    try {
      return await loop();
    } finally {
      await Promise.allSettled([...pending.values()]);
    }

    async function loop() {
      while (!stop.aborted) {
        const reserved = await reserve(operationId, stop);
        if (!reserved.attemptId) return reserved.state;
        const attemptId = reserved.attemptId;
        /** @type {{selected: Action[], policy: 'all_requested' | 'next_completion', newResult: boolean} | undefined} */
        let selection;
        /** @type {Promise<boolean>[]} */
        let settleCancellation = [];
        const response = await invoke(reserved.state, attemptId, stop, correction);
        const next = await serialize(async () => {
          let state = await transition(await inspect(operationId), {
            kind: 'attempt.outcome', outcome: response.outcome, dispatchCertainty: response.certainty, observations: response.observations,
          });
          releaseSlot();
          if (state.status !== 'active') return state;
          if (response.outcome.terminal !== 'completed') {
            return technicalWait(state, {
              code: response.outcome.diagnostics[0]?.code ?? 'PROTOCOL_ERROR',
              operationId, attemptId, actionId: attemptId, effect: response.outcome.effect, dispatchCertainty: response.certainty,
            });
          }
          const parsed = decodeDecision(response.output);
          correction = parsed.kind === 'rejected' ? parsed.reason : undefined;
          if (parsed.kind === 'accepted') {
            const value = parsed.value;
            const availableRefs = new Set([
              ...state.attempts.flatMap(item => item.outcome?.outputRefs.map(ref => ref.ref) ?? []),
              ...state.events.flatMap(event => event.kind === 'attempt.outcome' ? event.observations?.map(item => item.ref) ?? [] : []),
            ]);
            const assessment = value.finalAssessment;
            const references = assessment ? [
              ...assessment.observationRefs, ...assessment.findingRefs,
              ...assessment.requirements.flatMap(item => [...item.observationRefs, ...item.findingRefs]),
            ] : [];
            const live = new Set([...pending.keys(), ...(workerStops.get(operationId)?.keys() ?? [])]);
            if (value.operationId !== operationId) {
              correction = { code: 'INVALID_PROPOSAL', path: '$.operationId', expected: 'the current operation id' };
            } else if (value.contextCursor > response.contextCursor) {
              correction = { code: 'INVALID_PROPOSAL', path: '$.contextCursor', expected: 'an observed revision' };
            } else if ((value.waitPolicy && value.clarification) ||
              (value.additions.length && !value.waitPolicy)) {
              correction = { code: 'INVALID_PROPOSAL', path: '$', expected: 'a clarification, final assessment or action wait policy' };
            } else if (assessment && !value.waitPolicy && [...live].some(id => !value.cancellations.includes(id))) {
              correction = { code: 'INVALID_PROPOSAL', path: '$.finalAssessment', expected: 'an explicit wait or cancellation for each pending action' };
            } else if (value.acceptedActionIds?.some(id => !state.attempts.some(attempt =>
              attempt.actionId === id && attempt.status === 'terminal' && attempt.attemptId !== attempt.actionId))) {
              correction = { code: 'INVALID_PROPOSAL', path: '$.acceptedActionIds', expected: 'ids of terminal actions' };
            } else if (references.some(ref => !availableRefs.has(ref))) {
              correction = { code: 'INVALID_PROPOSAL', path: '$.finalAssessment', expected: 'references to available observations and findings' };
            } else if (state.events.some(event => event.kind === 'controller.responded' && event.decision.decisionId === value.decisionId)) {
              correction = { code: 'INVALID_PROPOSAL', path: '$.decisionId', expected: 'a fresh decision id' };
            } else {
              const round = planRound(state, value);
              if (round.error) correction = round.error;
              else {
                state = await transition(state, { kind: 'controller.responded', decision: value, admissions: round.admissions });
                for (const actionId of new Set(value.cancellations)) {
                  state = await transition(state, { kind: 'action.cancelled', actionId, source: 'superseded' });
                  workerStops.get(operationId)?.get(actionId)?.abort('superseded');
                }
                if (value.cancellations.length) releaseSlot();
                if (assessment && !live.size) return transition(state, { kind: 'operation.finished', assessment });
                if (assessment) {
                  settleCancellation = [...pending.entries()].flatMap(([id, task]) =>
                    value.cancellations.includes(id) ? [task] : []);
                }
                if (value.clarification) return transition(state, { kind: 'operation.waiting', waiting: {
                  kind: 'question', questionId: ids.newId(), question: value.clarification.question,
                } });
                if (value.waitPolicy) selection = { selected: round.selected, policy: value.waitPolicy.kind, newResult: round.newResult };
                return state;
              }
            }
          }
          trace(state, 'controller.invalid_proposal', correction?.code ?? 'INVALID_PROPOSAL', attemptId);
          return state;
        });
        if (next.status !== 'active') return next;
        if (settleCancellation.length) await Promise.all(settleCancellation);
        if (selection) await runActionRound(selection.selected, next, action => dispatchDelegate(next, action, stop),
          (action, code, resource) => recordAction(operationId, action, 'action.deferred', code, resource),
          pending, selection.policy, selection.newResult);
      }
      return inspect(operationId);
    }
  }

  return { submit, resume, inspect, cancel };
}
