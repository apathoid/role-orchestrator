import { decodeDecision, decodeOutcome, decodeRequest } from '../core/contracts.js';
import { decode, id, optional, record, text } from '../core/decode.js';
import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { applyEvent, createOperation, resourceSnapshot, sameRecord } from '../core/operation.js';
import { controllerContext, controllerInstructions } from './controller-context.js';

/** @import {CancellationSource, Outcome, ReasonCode} from '../core/contracts.js' */
/** @import {FieldError} from '../core/decode.js' */
/** @import {Clock, DiagnosticPort, IdFactory} from '../core/diagnostics.js' */
/** @import {Event, Limits, Operation, Reason} from '../core/operation.js' */
/** @import {Catalog, ContextItem, Profile, ProviderPort, ProviderSession, StateStore} from '../core/ports.js' */

/**
 * @typedef {{
 *   store: StateStore, provider: ProviderPort, catalog: Catalog, profile: Profile,
 *   clock: Clock, ids: IdFactory, limits: Limits, invocationTimeoutMs: number,
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
  } = deps;
  if (!Number.isSafeInteger(invocationTimeoutMs) || invocationTimeoutMs < 1 || invocationTimeoutMs > 2_147_483_647) {
    throw new RangeError('invocationTimeoutMs must be an integer from 1 to 2147483647');
  }
  /** @type {Map<string, Running>} */
  const running = new Map();
  let writes = Promise.resolve();

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
      return next;
    });
  }

  /** @param {Operation} state @param {string} attemptId @param {AbortSignal} stop @param {FieldError | undefined} correction */
  async function invoke(state, attemptId, stop, correction) {
    const local = new AbortController();
    const signal = AbortSignal.any([stop, local.signal]);
    const clear = schedule(invocationTimeoutMs, () => local.abort('deadline'));
    /** @type {ProviderSession | undefined} */
    let session;
    let mayHaveSent = false;
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
        requestedCancel = Promise.resolve().then(() => provider.cancel(owned, attemptId)).catch(() => {
          trace(state, 'provider.cleanup', 'PROTOCOL_ERROR', attemptId);
        });
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const entries = await catalog.list();
      signal.throwIfAborted();
      session = await provider.open(profile, signal);
      const owned = session;
      const invocation = await serialize(async () => {
        const current = await inspect(state.operationId);
        signal.throwIfAborted();
        const dispatched = await transition(current, { kind: 'attempt.dispatched', attemptId });
        signal.throwIfAborted();
        mayHaveSent = true;
        trace(dispatched, 'controller.requested', 'DISPATCH_STARTED', attemptId);
        // Keep the dispatch decision and actual provider call in the same turn.
        return { response: provider.invoke(owned, {
          attemptId, operationId: state.operationId, actionId: attemptId, kind: 'controller',
          objective: state.request.text, instructions: controllerInstructions, profile,
          workspaceContext: state.request.workspaceContext, userConstraints: state.request.userConstraints,
          context: controllerContext(dispatched, entries, correction), authorityRef: state.authorityRef,
          timeoutMs: invocationTimeoutMs, signal,
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
        try { await provider.close(session); } catch { trace(state, 'provider.cleanup', 'PROTOCOL_ERROR', attemptId); }
      }
    }
    return { outcome, certainty, output, observations };
  }

  /** @param {string} operationId @param {AbortSignal} stop */
  async function drive(operationId, stop) {
    /** @type {FieldError | undefined} */
    let correction;
    while (!stop.aborted) {
      const reserved = await serialize(async () => {
        const state = await inspect(operationId);
        if (state.status !== 'active') return { state };
        if (resourceSnapshot(state).remaining === 0) {
          return { state: await technicalWait(state, { code: 'RESOURCE_LIMIT', operationId }) };
        }
        const attemptId = ids.newId();
        return { attemptId, state: await transition(state, { kind: 'attempt.reserved', attemptId, actionId: attemptId }) };
      });
      if (!reserved.attemptId) return reserved.state;
      const attemptId = reserved.attemptId;
      const response = await invoke(reserved.state, attemptId, stop, correction);
      const next = await serialize(async () => {
        let state = await transition(await inspect(operationId), {
          kind: 'attempt.outcome', outcome: response.outcome, dispatchCertainty: response.certainty, observations: response.observations,
        });
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
          if (value.operationId !== operationId) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.operationId', expected: 'the current operation id' };
          } else if (value.contextCursor > state.revision) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.contextCursor', expected: 'an observed revision' };
          } else if (value.additions.length || value.cancellations.length || value.waitPolicy) {
            correction = { code: 'INVALID_PROPOSAL', path: '$', expected: 'a clarification or final assessment on the direct path' };
          } else if (references.some(ref => !availableRefs.has(ref))) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.finalAssessment', expected: 'references to available observations and findings' };
          } else if (state.events.some(event => event.kind === 'controller.responded' && event.decision.decisionId === value.decisionId)) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.decisionId', expected: 'a fresh decision id' };
          } else {
            state = await transition(state, { kind: 'controller.responded', decision: value });
            if (assessment) return transition(state, { kind: 'operation.finished', assessment });
            if (value.clarification) return transition(state, { kind: 'operation.waiting', waiting: {
              kind: 'question', questionId: ids.newId(), question: value.clarification.question,
            } });
          }
        }
        trace(state, 'controller.invalid_proposal', correction?.code ?? 'INVALID_PROPOSAL', attemptId);
        return state;
      });
      if (next.status !== 'active') return next;
    }
    return inspect(operationId);
  }

  return { submit, resume, inspect, cancel };
}
