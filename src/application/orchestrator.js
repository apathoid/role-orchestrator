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
/** @import {PendingAction} from './action-round.js' */
/** @import {Handoff} from './handoff.js' */
/** @import {AttemptPermissions, AuthorityPort, Catalog, ContextItem, PermissionPort, Profile, ProviderPort, ProviderSession, StateStore} from '../core/ports.js' */

/**
 * @typedef {{
 *   store: StateStore, provider: ProviderPort, catalog: Catalog, profile: Profile,
 *   clock: Clock, ids: IdFactory, limits: Limits, invocationTimeoutMs: number,
 *   providerFor?: (profile: Profile) => ProviderPort | undefined,
 *   diagnostics?: DiagnosticPort, authority: AuthorityPort, permissions?: PermissionPort, configurationRef: string,
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
    store, provider, catalog, profile, clock, ids, limits, invocationTimeoutMs, authority, permissions, configurationRef,
    diagnostics = noopDiagnostics, schedule = scheduleDeadline,
    providerFor = selected => selected.providerId === profile.providerId ? provider : undefined,
  } = deps;
  if (!Number.isSafeInteger(invocationTimeoutMs) || invocationTimeoutMs < 1 || invocationTimeoutMs > 2_147_483_647) {
    throw new RangeError('invocationTimeoutMs must be an integer from 1 to 2147483647');
  }
  /** @type {Map<string, Running>} */
  const running = new Map();
  /** @type {Map<string, Map<string, PendingAction>>} */
  const workers = new Map();
  // Terminal logical outcomes can coexist with a connection the adapter has
  // yet to detach. Such a connection still consumes its concurrency slot.
  const undetached = new Set();
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
    const pending = workers.get(state.operationId) ?? new Map();
    workers.set(state.operationId, pending);
    const completion = drive(state.operationId, signal.signal, pending).finally(() => {
      if (running.get(state.operationId)?.signal === signal) running.delete(state.operationId);
      void Promise.allSettled([...pending.values()].map(worker => worker.completion)).then(() => {
        if (!pending.size && !running.has(state.operationId) && workers.get(state.operationId) === pending) {
          workers.delete(state.operationId);
        }
      });
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
      const state = createOperation(ids.newId(), request, authority.reference, limits);
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
      for (const worker of workers.get(operationId)?.values() ?? []) worker.stop.abort(source);
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
    /** @type {Promise<ProviderSession> | undefined} */
    let opening;
    /** @type {ProviderSession | undefined} */
    let session;
    /** @type {AttemptPermissions | undefined} */
    let boundPermissions;
    let mayHaveSent = false;
    let contextCursor = state.revision;
    /** @type {'PERMISSION_DENIED' | 'REVOKED' | undefined} */
    let denied;
    /** @type {ContextItem[]} */
    const observations = [];
    let acceptingObservations = true;
    const interrupted = Promise.withResolvers();
    void interrupted.promise.catch(() => {});
    /** @template T @param {Promise<T>} work @returns {Promise<T>} */
    const withinDeadline = work => Promise.race([work, interrupted.promise]);
    /** @type {unknown} */
    let output;
    /** @type {Outcome} */
    let outcome;
    /** @type {'sent' | 'not_sent' | 'unknown'} */
    let certainty = 'not_sent';
    const abort = () => {
      acceptingObservations = false;
      interrupted.reject(signal.reason);
      const owned = session;
      if (mayHaveSent && owned) {
        void Promise.resolve().then(() => executor.cancel(owned, attemptId)).catch(() => {
          trace(state, 'provider.cleanup', 'PROTOCOL_ERROR', attemptId);
        });
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      signal.throwIfAborted();
      const entries = handoff ? [] : await withinDeadline(catalog.list());
      const selectedProfile = handoff?.profile ?? profile;
      function requireAuthority() {
        const decision = authority.authorize(state.authorityRef, selectedProfile.profileId);
        if (decision !== 'ALLOWED') {
          denied = decision;
          throw new OrchestrationError(decision, 'Invocation is outside the active grant');
        }
      }
      signal.throwIfAborted();
      requireAuthority();
      const attachments = handoff ? handoff.attachments ?? [] : state.request.attachments;
      const requiredCapabilities = new Set(handoff?.requiredCapabilities);
      if (attachments.some(item => item.mediaType.toLowerCase().startsWith('image/'))) {
        requiredCapabilities.add('input.image');
      }
      if (requiredCapabilities.size) {
        signal.throwIfAborted();
        const capabilities = selectedProfile.capabilities ?? (await withinDeadline(executor.describe())).capabilities;
        if ([...requiredCapabilities].some(key => !Object.hasOwn(capabilities, key) ||
            capabilities[key].support !== 'supported')) {
          return {
            outcome: failedOutcome(attemptId, 'CAPABILITY_UNAVAILABLE', false),
            certainty: /** @type {const} */ ('not_sent'), output, observations, contextCursor,
          };
        }
      }
      signal.throwIfAborted();
      opening = executor.open(selectedProfile, signal);
      session = await withinDeadline(opening);
      const owned = session;
      const invocation = await serialize(async () => {
        const current = await inspect(state.operationId);
        signal.throwIfAborted();
        requireAuthority();
        const dispatched = await transition(current, { kind: 'attempt.dispatched', attemptId });
        contextCursor = dispatched.revision;
        signal.throwIfAborted();
        requireAuthority();
        boundPermissions = permissions?.bind({
          attemptId, profileId: selectedProfile.profileId, authorityRef: state.authorityRef, signal,
          report: (event, reason) => trace(dispatched, event, reason, attemptId),
        });
        mayHaveSent = true;
        if (!handoff) trace(dispatched, 'controller.requested', 'DISPATCH_STARTED', attemptId);
        // Keep the dispatch decision and actual provider call in the same turn.
        const context = handoff ?? {
          operationId: state.operationId, actionId: attemptId, kind: /** @type {const} */ ('controller'),
          objective: state.request.text, instructions: controllerInstructions, profile,
          workspaceContext: state.request.workspaceContext, userConstraints: state.request.userConstraints,
          context: controllerContext(dispatched, entries, correction), authorityRef: state.authorityRef,
        };
        return { response: withinDeadline(executor.invoke(owned, {
          ...context, attachments, requiredCapabilities: [...requiredCapabilities], attemptId, timeoutMs: invocationTimeoutMs, signal,
          permissions: boundPermissions ? { request: boundPermissions.request } : undefined,
        }, item => { if (acceptingObservations) observations.push(item); })) };
      });
      const reply = await invocation.response;
      signal.throwIfAborted();
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
      const code = denied ?? (stop.aborted ? 'CANCELLED' : local.signal.aborted ? 'DEADLINE_EXCEEDED'
        : mayHaveSent ? 'PROVIDER_DISCONNECTED' : 'PROVIDER_START_FAILED');
      certainty = mayHaveSent ? 'unknown' : 'not_sent';
      outcome = failedOutcome(attemptId, code, mayHaveSent);
    } finally {
      acceptingObservations = false;
      boundPermissions?.close();
      clear();
      signal.removeEventListener('abort', abort);
      if (opening) {
        let closed = false;
        // A late open still transfers a session to this cleanup path.
        const detached = opening.then(owned => executor.close(owned), () => {}).then(() => {
          closed = true;
          if (undetached.delete(attemptId)) releaseSlot();
        }).catch(() => trace(state, 'provider.cleanup', 'PROTOCOL_ERROR', attemptId));
        /** @type {{promise: Promise<void>, resolve: () => void}} */
        const cleanupDeadline = Promise.withResolvers();
        const clearCleanup = schedule(invocationTimeoutMs, () => {
          trace(state, 'provider.cleanup', 'DEADLINE_EXCEEDED', attemptId);
          cleanupDeadline.resolve();
        });
        await Promise.race([detached, cleanupDeadline.promise]);
        clearCleanup();
        if (!closed) undetached.add(attemptId);
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
        const active = new Set(undetached);
        for (const operation of all) {
          for (const attempt of operation.attempts) {
            if (attempt.status !== 'terminal') active.add(attempt.attemptId);
          }
        }
        if (undetached.size >= limits.maxConcurrentInvocations) {
          return { state: actionId ? state : await technicalWait(state, { code: 'RESOURCE_LIMIT', operationId }) };
        }
        if (active.size >= limits.maxConcurrentInvocations) {
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
    const newlyAdmitted = admissions.flatMap(item => item.kind === 'accepted' ? [item.action] : []);
    const actions = new Map([...known, ...newlyAdmitted].map(action => [action.actionId, action]));
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
    return { admissions, selected: [...new Set(selected)], newlyAdmitted, actions, newResult };
  }

  /** @param {string} operationId @param {AbortSignal} stop @param {Map<string, PendingAction>} pending */
  async function drive(operationId, stop, pending) {
    /** @type {FieldError | undefined} */
    let correction;
    while (!stop.aborted) {
      const reserved = await reserve(operationId, stop);
      if (!reserved.attemptId) return reserved.state;
      const attemptId = reserved.attemptId;
      /** @type {{selected: Action[], newlyAdmitted: Action[], actions: ReadonlyMap<string, Action>,
       *   policy: 'all_requested' | 'next_completion', newResult: boolean} | undefined} */
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
          const live = new Set(pending.keys());
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
                pending.get(actionId)?.stop.abort('superseded');
              }
              if (value.cancellations.length) releaseSlot();
              if (assessment && !live.size) return transition(state, { kind: 'operation.finished', assessment });
              if (assessment) {
                settleCancellation = [...pending.entries()].flatMap(([id, task]) =>
                  value.cancellations.includes(id) ? [task.completion] : []);
              }
              if (value.clarification) return transition(state, { kind: 'operation.waiting', waiting: {
                kind: 'question', questionId: ids.newId(), question: value.clarification.question,
              } });
              if (value.waitPolicy) selection = {
                ...round, policy: value.waitPolicy.kind,
              };
              return state;
            }
          }
        }
        trace(state, 'controller.invalid_proposal', correction?.code ?? 'INVALID_PROPOSAL', attemptId);
        return state;
      });
      if (next.status !== 'active') return next;
      if (settleCancellation.length) await Promise.all(settleCancellation);
      if (selection) await runActionRound(selection.selected, selection.newlyAdmitted, selection.actions, next,
        (action, signal) => dispatchWorker(next, action, signal),
        (action, code, resource) => recordAction(operationId, action, 'action.deferred', code, resource),
        pending, selection.policy, selection.newResult);
    }
    return inspect(operationId);
  }

  return { submit, resume, inspect, cancel };
}
