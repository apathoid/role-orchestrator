import { admitFindings, checkAssessment, evidenceRefs, findings, recordObservationRefs } from '../core/finding.js';
import { decodeDecision, decodeOutcome, decodeRequest, followup } from '../core/contracts.js';
import { decode, jsonValue } from '../core/decode.js';
import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { applyEvent, createOperation, resourceSnapshot, sameRecord } from '../core/operation.js';
import { admitActions } from '../core/action-graph.js';
import { controllerContext, controllerInstructions } from './controller-context.js';
import { handoffContext, prepareHandoff } from './handoff.js';
import { findingHistory } from './finding-history.js';
import { bindContextAccess } from './context-access.js';
import { defaultContextMaxBytes } from './context-bundle.js';
import { lookupAttempt } from './recovery.js';
import { runActionRound } from './action-round.js';
import { attributeProviderOutputRefs, decodeSummaryReport, observation, receiveProviderObservation } from '../core/observation.js';

/** @import {Action, CancellationSource, Decision, Outcome, ReasonCode} from '../core/contracts.js' */
/** @import {OutcomeEvidence} from '../core/finding.js' */
/** @import {FieldError} from '../core/decode.js' */
/** @import {Clock, DiagnosticEvent, DiagnosticPort, IdFactory} from '../core/diagnostics.js' */
/** @import {ContextItem, Observation} from '../core/observation.js' */
/** @import {Event, Limits, Operation, Reason} from '../core/operation.js' */
/** @import {Lookup, LookupStatus} from './recovery.js' */
/** @import {PendingAction} from './action-round.js' */
/** @import {Handoff} from './handoff.js' */
/** @import {AttemptPermissions, AuthorityPort, Catalog, ContextShare, PermissionPort, Profile, ProviderPort, ProviderResult, ProviderSession, RetryApproval, StateListEntry, StateStore} from '../core/ports.js' */

/**
 * @typedef {{
 *   store: StateStore, provider: ProviderPort, catalog: Catalog, profile: Profile,
 *   clock: Clock, ids: IdFactory, limits: Limits, invocationTimeoutMs: number,
 *   context?: {maxBytes?: number}, allowContextShare?: ContextShare,
 *   providerFor?: (profile: Profile) => ProviderPort | undefined,
 *   approveRetry?: RetryApproval,
 *   diagnostics?: DiagnosticPort, authority: AuthorityPort, permissions?: PermissionPort, configurationRef: string,
 *   schedule?: (timeoutMs: number, expire: () => void) => () => void
 * }} Dependencies
 * @typedef {{operation: Operation, completion: Promise<Operation>}} Submission
 * @typedef {{signal: AbortController, completion: Promise<Operation>}} Running
 */

/** @template T @typedef {T extends Event ? Omit<T, 'operationId' | 'eventId' | 'receivedAt'> : never} EventData */

/** @param {StateListEntry} item @returns {item is Operation} */
function isAvailable(item) {
  return !('kind' in item);
}

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
    context: { maxBytes: contextMaxBytes = defaultContextMaxBytes } = {}, allowContextShare,
    diagnostics = noopDiagnostics, schedule = scheduleDeadline, approveRetry,
    providerFor = selected => selected.providerId === profile.providerId ? provider : undefined,
  } = deps;
  if (!Number.isSafeInteger(invocationTimeoutMs) || invocationTimeoutMs < 1 || invocationTimeoutMs > 2_147_483_647) {
    throw new RangeError('invocationTimeoutMs must be an integer from 1 to 2147483647');
  }
  if (!Number.isSafeInteger(contextMaxBytes) || contextMaxBytes < 1) {
    throw new RangeError('context.maxBytes must be a positive safe integer');
  }
  /** @type {Map<string, Running>} */
  const running = new Map();
  /** @type {Map<string, Map<string, PendingAction>>} */
  const workers = new Map();
  // Terminal logical outcomes can coexist with a connection the adapter has
  // yet to detach. Such a connection still consumes its concurrency slot.
  /** @type {Set<string>} */
  const undetached = new Set();
  /** @type {Set<string>} */
  const liveAttempts = new Set();
  const trusted = { authorityRef: authority.reference, configurationRef, limits: { ...limits } };

  /** @param {string} attemptId */
  function releaseAttempt(attemptId) {
    liveAttempts.delete(attemptId);
    releaseSlot();
  }
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

  /** @param {string} operationId @param {string} findingRef */
  async function inspectFinding(operationId, findingRef) {
    const history = await findingHistory(await inspect(operationId), findingRef, store);
    if (!history) throw new OrchestrationError('INVALID_PROPOSAL', 'Unknown finding', '$.findingRef');
    return history;
  }

  /** @param {Operation} next @param {number | null} revision @param {string} [attemptId] */
  async function commit(next, revision, attemptId) {
    const result = await store.commit(next.operationId, revision, next);
    if (result.kind !== 'committed') {
      const code = result.kind === 'conflict' ? 'STORE_CONFLICT' : 'STORE_UNAVAILABLE';
      // A failed acknowledgement can follow a visible rename. Read for
      // correlation, but only an acknowledged commit authorizes dispatch.
      const observed = await store.load(next.operationId).catch(() => undefined);
      trace(observed ?? next, observed && sameRecord(observed, next)
        ? 'store.unconfirmed_revision_visible' : 'store.commit_unconfirmed', code, attemptId);
      return { error: new OrchestrationError(code, 'Unable to persist operation state'), observed };
    }
  }

  /** @param {Operation} state @param {EventData<Event>} data */
  async function transition(state, data) {
    const event = /** @type {Event} */ ({
      ...data, operationId: state.operationId, eventId: ids.newId(), receivedAt: clock.now(),
    });
    let result = applyEvent(state, event);
    if (result.kind === 'rejected') throw new OrchestrationError(result.reason.code, 'Invalid transition: ' + data.kind);
    if (result.kind === 'duplicate') return result.state;

    const attemptId = event.kind === 'attempt.outcome' ? event.outcome.attemptId
      : 'attemptId' in event ? event.attemptId : undefined;
    const failure = await commit(result.state, state.revision, attemptId);
    if (failure) {
      const { observed, error } = failure;
      if (!observed || (event.kind !== 'attempt.outcome' && event.kind !== 'operation.finished')) throw error;
      // Retry only the local record, using the original event identity.
      // An already visible record still needs a durability acknowledgement.
      if (event.kind === 'attempt.outcome' && event.findings?.length &&
          !observed.events.some(item => item.eventId === event.eventId)) {
        event.findings = receiveWorkerFindings(observed, event, event.findings);
      }
      result = applyEvent(observed, event);
      if (result.kind === 'rejected') throw error;
      const retry = await commit(result.state, observed.revision, attemptId);
      if (retry) throw retry.error;
    }
    if (result.kind === 'applied') emitDiagnostic(diagnostics, result.diagnostic);
    return result.state;
  }

  /** @param {Operation} state @param {string} eventName @param {string} reasonCode @param {string} [attemptId]
   * @param {Pick<DiagnosticEvent, 'actionId' | 'details'>} [context]
   */
  function trace(state, eventName, reasonCode, attemptId, context) {
    emitDiagnostic(diagnostics, {
      schemaVersion: 1, eventId: ids.newId(), receivedAt: clock.now(), sequence: state.revision,
      level: eventName.endsWith('invalid_proposal') ? 'warn' : 'info', component: 'application',
      eventName, reasonCode, operationId: state.operationId, attemptId, ...context,
    });
  }

  /**
   * Correlate delivered items without copying user/model-controlled refs or
   * bodies to the sink. Selection indexes address the admitted action.
   * @param {Operation} state @param {string} attemptId @param {Action} action
   * @param {readonly ContextItem[]} items
   */
  function traceHandoff(state, attemptId, action, items) {
    const selections = new Map();
    for (const [index, ref] of action.contextRefs.entries()) {
      if (!selections.has(ref)) selections.set(ref, index);
    }
    for (const [contextIndex, item] of items.entries()) {
      const selectedIndex = selections.get(item.ref);
      const source = item.receivedSequence;
      const details = {
        contextIndex,
        ...(selectedIndex !== undefined ? { selectedIndex } : {}),
        ...(source ? { sourceRevision: source.revision, sourceIndex: source.index } : {}),
      };
      if (item.completeness === 'unavailable') {
        trace(state, 'context.unavailable', item.unavailableReason?.toUpperCase() ?? 'SOURCE_UNAVAILABLE',
          attemptId, { actionId: action.actionId, details });
      } else if (item.completeness === 'truncated') {
        trace(state, 'context.truncated', item.excerpt === undefined ? 'SOURCE_TRUNCATED' : 'EXCERPT',
          attemptId, { actionId: action.actionId, details });
      } else {
        trace(state, 'context.materialized', item.artifact ? 'ARTIFACT_REFERENCE' : 'DELIVERED',
          attemptId, { actionId: action.actionId, details });
      }
    }
  }

  /** @param {Operation} state @param {Reason} reason */
  function technicalWait(state, reason) {
    return transition(state, { kind: 'operation.waiting', waiting: { kind: 'technical', reason } });
  }

  /** @param {Operation} state @returns {Submission} */
  function activeSubmission(state) {
    return { operation: state, completion: running.get(state.operationId)?.completion ?? Promise.resolve(state) };
  }

  /** @param {Operation} state @param {boolean} [recover] @returns {Submission} */
  function launch(state, recover = false) {
    const signal = new AbortController();
    const pending = workers.get(state.operationId) ?? new Map();
    workers.set(state.operationId, pending);
    const completion = (async () => {
      const lookups = recover ? await recoverAttempts(state.operationId, signal.signal) : undefined;
      return drive(state.operationId, signal.signal, pending, lookups);
    })().finally(() => {
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
      const entries = await store.list(request.requestId);
      if (entries.some(item => 'kind' in item && item.requestMatch === true)) {
        throw new OrchestrationError('STORE_UNAVAILABLE', 'Stored request is unavailable');
      }
      const all = entries.filter(isAvailable);
      const previous = all.find(item => item.request.requestId === request.requestId);
      if (previous) {
        if (!sameRecord(previous.request, request)) throw new OrchestrationError('IDENTITY_CONFLICT', 'Request id reused');
        return activeSubmission(previous);
      }
      if (all.some(item => item.transcriptRefs.includes(request.requestId))) {
        throw new OrchestrationError('IDENTITY_CONFLICT', 'Request id reused');
      }
      if (entries.some(item => 'kind' in item && item.requestMatch === 'unknown')) {
        throw new OrchestrationError('STORE_UNAVAILABLE', 'An unreadable snapshot lacks a request reference');
      }
      const state = createOperation(ids.newId(), request, authority.reference, limits, clock.now());
      const failure = await commit(state, null);
      if (failure) throw failure.error;
      trace(state, 'operation.accepted', 'ACCEPTED');
      return launch(state);
    });
  }

  /** @param {string} operationId @param {unknown} [input] @returns {Promise<Submission>} */
  async function resume(operationId, input) {
    if (input === undefined) {
      return serialize(async () => {
        const state = await inspect(operationId);
        if (state.status !== 'active' || running.has(operationId)) return activeSubmission(state);
        return launch(await transition(state, { kind: 'operation.recovered', trusted }), true);
      });
    }
    const parsed = decode(followup, input);
    if (parsed.kind === 'rejected') {
      throw new OrchestrationError(parsed.reason.code, parsed.reason.expected, parsed.reason.path);
    }
    const follow = parsed.value;
    return serialize(async () => {
      const all = (await store.list()).filter(isAvailable);
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
      const next = await transition(state, { kind: 'operation.continued', input: follow, trusted });
      return launch(next, true);
    });
  }

  /** @param {Operation} state */
  async function settleOrphans(state) {
    let current = state;
    for (const attempt of state.attempts) {
      if (attempt.status === 'terminal' || liveAttempts.has(attempt.attemptId)) continue;
      const dispatched = attempt.status === 'dispatched';
      current = await transition(current, {
        kind: 'attempt.outcome', dispatchCertainty: dispatched ? 'unknown' : 'not_sent',
        outcome: failedOutcome(attempt.attemptId, 'PROVIDER_DISCONNECTED', dispatched),
      });
    }
    return current;
  }

  /** @param {string} operationId @param {AbortSignal} stop */
  async function recoverAttempts(operationId, stop) {
    const state = await serialize(async () => {
      const current = await inspect(operationId);
      return stop.aborted ? current : settleOrphans(current);
    });
    /** @type {Map<string, LookupStatus>} */
    const lookups = new Map();
    const unknown = state.attempts.filter(attempt => attempt.outcome?.terminal === 'unknown');
    if (!unknown.length || stop.aborted) return lookups;
    const local = new AbortController();
    const signal = AbortSignal.any([local.signal, stop]);
    const clear = schedule(invocationTimeoutMs, () => local.abort('deadline'));
    /** @type {PromiseWithResolvers<Lookup>} */
    const interrupted = Promise.withResolvers();
    const abort = () => interrupted.resolve({ status: 'unavailable' });
    signal.addEventListener('abort', abort, { once: true });
    try {
      for (const attempt of unknown) {
        if (signal.aborted) break;
        const { status, result } = await Promise.race([
          lookupAttempt(state, attempt, { configurationRef, authority, catalog, providerFor }, signal)
            .catch(() => /** @type {Lookup} */ ({ status: 'unavailable' })),
          interrupted.promise,
        ]);
        const receivedAt = clock.now();
        lookups.set(attempt.attemptId, status);
        if (stop.aborted) break;
        await serialize(async () => {
          const current = await inspect(operationId);
          if (stop.aborted) return;
          trace(current, 'attempt.status_lookup', status.toUpperCase(), attempt.attemptId);
          if (result) await transition(current, {
            kind: 'attempt.outcome', outcome: result.outcome, dispatchCertainty: result.dispatchCertainty,
            observations: [observation({
              ref: 'attempt-status:' + attempt.attemptId, completeness: 'complete', value: result,
            }, { kind: 'provider_report', sourceId: attempt.route?.providerId ?? attempt.attemptId, receivedAt })],
          });
        });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      clear();
    }
    return lookups;
  }

  /** @param {string} operationId @param {CancellationSource} [source] */
  async function cancel(operationId, source = 'user') {
    return serialize(async () => {
      const state = await inspect(operationId);
      const next = await transition(state, { kind: 'operation.cancelled', source });
      running.get(operationId)?.signal.abort(source);
      for (const worker of workers.get(operationId)?.values() ?? []) worker.stop.abort(source);
      releaseSlot();
      return settleOrphans(next);
    });
  }

  /**
   * @param {Operation} state @param {string} attemptId @param {AbortSignal} stop
   * @param {FieldError | undefined} correction @param {Handoff} [handoff] @param {ProviderPort} [executor]
   * @param {ReadonlyMap<string, LookupStatus>} [lookups] @param {Action} [action]
   */
  async function invoke(state, attemptId, stop, correction, handoff, executor = provider, lookups, action) {
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
    /** @type {'PERMISSION_DENIED' | 'REVOKED' | 'RETRY_NOT_AUTHORIZED' | undefined} */
    let denied;
    /** @type {Observation[]} */
    const observations = [];
    let acceptingObservations = true;
    let contextOpen = false;
    /** @type {Observation[]} */
    const lateObservations = [];
    /** @type {ProviderResult | undefined} */
    let receivedReply;
    /** @type {ProviderResult | undefined} */
    let lateReply;
    let recordingLate = false;
    let flushScheduled = false;

    /** @param {Observation} item */
    function receive(item) {
      if (!signal.aborted) observations.push(item);
      else {
        lateObservations.push(item);
        scheduleLateCommit();
      }
    }

    /** @param {Operation} current */
    async function recordLate(current) {
      recordingLate = true;
      const reply = lateReply;
      lateReply = undefined;
      const samples = lateObservations.splice(0);
      if (!reply && !samples.length) return current;
      const attempt = current.attempts.find(item => item.attemptId === attemptId);
      if (attempt?.status !== 'terminal') return current;

      const known = current.events.flatMap(event => event.kind === 'attempt.outcome' &&
        event.outcome.attemptId === attemptId ? event.observations ?? [] : []);
      // Compare the report itself. A duplicate callback has a new local receipt time.
      /** @param {Observation} item */
      const report = ({ provenance, ...item }) => ({
        ...item, provenance: provenance && { ...provenance, receivedAt: undefined },
      });
      const observations = [];
      for (const sample of samples) {
        const received = report(sample);
        if (known.some(item => sameRecord(report(item), received))) continue;
        observations.push(sample);
        known.push(sample);
      }
      if (!reply && !observations.length) return current;
      const receipt = {
        kind: /** @type {const} */ ('attempt.outcome'),
        outcome: reply ? attributeProviderOutputRefs(reply.outcome, known) : attempt.outcome,
        dispatchCertainty: reply?.dispatchCertainty ?? attempt.dispatchCertainty, observations,
      };
      return transition(current, {
        ...receipt, late: true, findings: handoff && receiveWorkerFindings(current, receipt, reply?.findings),
      });
    }

    function scheduleLateCommit() {
      if (!recordingLate || flushScheduled) return;
      flushScheduled = true;
      void serialize(async () => {
        const current = await inspect(state.operationId).finally(() => { flushScheduled = false; });
        await recordLate(current);
      }).catch(() => trace(state, 'attempt.late_outcome_commit_failed', 'STORE_UNAVAILABLE', attemptId));
    }

    /** @param {ProviderResult} reply @returns {ProviderResult | undefined} */
    function acceptReply(reply) {
      if (!reply) return undefined;
      const parsed = decodeOutcome(reply.outcome);
      if (parsed.kind === 'rejected' || parsed.value.attemptId !== attemptId ||
          !['not_sent', 'sent', 'unknown'].includes(reply.dispatchCertainty) ||
          (reply.dispatchCertainty === 'not_sent' && parsed.value.effect !== 'none')) return undefined;
      const result = { outcome: parsed.value, dispatchCertainty: reply.dispatchCertainty, output: reply.output, findings: reply.findings };
      if (acceptingObservations) {
        receivedReply = result;
        if (result.output !== undefined) {
          const output = decode(jsonValue, result.output);
          receive(observation({
            ref: (handoff ? 'attempt-output:' : 'controller-output:') + attemptId,
            completeness: output.kind === 'accepted' ? 'complete' : 'unavailable',
            value: output.kind === 'accepted' ? output.value : undefined,
          }, { kind: 'model', sourceId: attemptId, receivedAt: clock.now() }));
        }
        if (signal.aborted) {
          lateReply = result;
          scheduleLateCommit();
        }
      }
      return result;
    }

    const interrupted = Promise.withResolvers();
    void interrupted.promise.catch(() => {});
    /** @template T @param {Promise<T>} work @returns {Promise<T>} */
    const withinDeadline = work => Promise.race([work, interrupted.promise]);
    /** @type {unknown} */
    let output;
    /** @type {unknown} */
    let reportedFindings;
    /** @type {Outcome} */
    let outcome;
    /** @type {'sent' | 'not_sent' | 'unknown'} */
    let certainty = 'not_sent';
    const abort = () => {
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
      /** @param {Operation} current */
      function retryKey(current) {
        if (!action?.retryOf) return executor.supportsIdempotency ? attemptId : undefined;
        const prior = current.attempts.find(item => item.attemptId === action.retryOf);
        if (prior?.status === 'terminal') {
          if (action.retryBasis === 'no_effect' && prior.outcome.effect === 'none' &&
              prior.outcome.terminal !== 'unknown') return executor.supportsIdempotency ? attemptId : undefined;
          if (action.retryBasis === 'user_approval' && approveRetry?.({
            operationId: current.operationId, attemptId: prior.attemptId,
            actionId: action.actionId, profileId: selectedProfile.profileId,
          }) === true) return executor.supportsIdempotency ? attemptId : undefined;
          const route = prior.route;
          if (action.retryBasis === 'provider_idempotency' && executor.supportsIdempotency && route?.idempotencyKey &&
              route.configurationRef === configurationRef && route.profileId === selectedProfile.profileId &&
              route.providerId === selectedProfile.providerId && route.model === selectedProfile.model) {
            return route.idempotencyKey;
          }
        }
        denied = 'RETRY_NOT_AUTHORIZED';
        throw new OrchestrationError(denied, 'Retry is outside the available authorization');
      }
      signal.throwIfAborted();
      requireAuthority();
      retryKey(state);
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
            certainty: /** @type {const} */ ('not_sent'), output, observations, contextCursor, recordLate,
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
        const idempotencyKey = retryKey(current);
        const dispatched = await transition(current, {
          kind: 'attempt.dispatched', attemptId, route: {
            configurationRef, profileId: selectedProfile.profileId, providerId: selectedProfile.providerId, model: selectedProfile.model,
            idempotencyKey,
          },
        });
        contextCursor = dispatched.revision;
        signal.throwIfAborted();
        requireAuthority();
        retryKey(dispatched);
        boundPermissions = permissions?.bind({
          attemptId, profileId: selectedProfile.profileId, authorityRef: state.authorityRef, signal,
          report: (event, reason) => trace(dispatched, event, reason, attemptId),
        });
        mayHaveSent = true;
        if (!handoff) trace(dispatched, 'controller.requested', 'DISPATCH_STARTED', attemptId);
        // Keep the dispatch decision and actual provider call in the same turn.
        const context = handoff ? {
          ...handoff, context: handoffContext(dispatched, action?.contextRefs ?? [], contextMaxBytes, lookups),
        } : {
          operationId: state.operationId, actionId: attemptId, kind: /** @type {const} */ ('controller'),
          objective: state.request.text, instructions: controllerInstructions, profile,
          workspaceContext: state.request.workspaceContext, userConstraints: state.request.userConstraints,
          context: controllerContext(dispatched, entries, correction, lookups, contextMaxBytes), authorityRef: state.authorityRef,
        };
        if (handoff && action) traceHandoff(dispatched, attemptId, action, context.context);
        const selected = action ? new Set(action.contextRefs) : undefined;
        contextOpen = true;
        const contextAccess = bindContextAccess({
          state: dispatched, store, maxBytes: contextMaxBytes, profileId: selectedProfile.profileId, attemptId,
          selected, allowShare: allowContextShare, newId: () => ids.newId(), now: () => clock.now(), receive,
          isActive: () => contextOpen && !signal.aborted &&
            authority.authorize(dispatched.authorityRef, selectedProfile.profileId) === 'ALLOWED',
        });
        /** @type {Set<string> | undefined} */
        let rawRefs;
        return { response: withinDeadline(executor.invoke(owned, {
          ...context, contextAccess, idempotencyKey, attachments, requiredCapabilities: [...requiredCapabilities], attemptId, timeoutMs: invocationTimeoutMs, signal,
          permissions: boundPermissions ? { request: boundPermissions.request } : undefined,
        }, item => {
          if (!acceptingObservations) return;
          const summary = item && typeof item === 'object' && 'kind' in item && item.kind === 'model_summary';
          if (summary) {
            const report = decodeSummaryReport(item);
            if (report && contextOpen && !signal.aborted) {
              rawRefs ??= evidenceRefs(dispatched.request.requestId, dispatched.events).rawObservations;
              if (report.coveredObservationRefs.every(ref =>
                ((!selected || selected.has(ref)) && rawRefs?.has(ref)) ||
                observations.some(item => item.ref === ref && !item.summary))) {
                const author = selectedProfile.profileId;
                receive(observation({
                  ref: 'summary:' + ids.newId(), completeness: 'complete', value: report.text,
                  summary: { author, coveredObservationRefs: report.coveredObservationRefs },
                }, { kind: 'model', sourceId: author, receivedAt: clock.now() }));
                return;
              }
            }
          } else {
            const received = receiveProviderObservation(item, clock.now());
            if (received) {
              receive(received);
              return;
            }
          }
          trace(dispatched, 'attempt.observation_invalid', 'PROTOCOL_ERROR', attemptId);
        }).then(acceptReply)) };
      });
      const reply = await invocation.response;
      signal.throwIfAborted();
      if (!reply) {
        outcome = failedOutcome(attemptId, 'PROTOCOL_ERROR', true);
        certainty = 'unknown';
      } else {
        ({ dispatchCertainty: certainty, output, findings: reportedFindings } = reply);
        outcome = attributeProviderOutputRefs(reply.outcome, observations);
      }
    } catch (error) {
      if (error instanceof OrchestrationError && ['STORE_CONFLICT', 'STORE_UNAVAILABLE'].includes(error.code)) throw error;
      const code = denied ?? (stop.aborted ? 'CANCELLED' : local.signal.aborted ? 'DEADLINE_EXCEEDED'
        : mayHaveSent ? 'PROVIDER_DISCONNECTED' : 'PROVIDER_START_FAILED');
      certainty = mayHaveSent ? 'unknown' : 'not_sent';
      outcome = failedOutcome(attemptId, code, mayHaveSent);
      if (signal.aborted) lateReply ??= receivedReply;
    } finally {
      // Decisions stop at abort. Facts remain attributable until the adapter
      // acknowledges detachment of this invocation's owned session.
      contextOpen = false;
      acceptingObservations = signal.aborted && mayHaveSent;
      boundPermissions?.close();
      clear();
      signal.removeEventListener('abort', abort);
      if (opening) {
        let closed = false;
        // A late open still transfers a session to this cleanup path.
        const detached = opening.then(owned => executor.close(owned), () => {}).then(() => {
          closed = true;
          acceptingObservations = false;
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
    return {
      outcome, certainty, output, contextCursor, recordLate, reportedFindings,
      observations: certainty === 'not_sent' ? observations.filter(item => !item.summary) : observations,
    };
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
        const active = new Set([...undetached, ...liveAttempts]);
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
        const reserved = await transition(state, { kind: 'attempt.reserved', attemptId, actionId: actionId ?? attemptId });
        liveAttempts.add(attemptId);
        return { attemptId, state: reserved };
      });
      if (!result.ready) return result;
      await result.ready;
    }
  }

  /** @param {Operation} state @param {Action} action @param {AbortSignal} stop
   * @param {ReadonlyMap<string, LookupStatus>} [lookups] */
  async function dispatchWorker(state, action, stop, lookups) {
    const current = await inspect(state.operationId);
    if (stop.aborted || current.status !== 'active') return false;
    const entries = await catalog.list();
    const handoff = prepareHandoff(current, action, entries);
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
      const response = await invoke(reserved.state, attemptId, stop, undefined, handoff.handoff, executor, lookups, action);
      await serialize(async () => {
        const current = await inspect(state.operationId);
        const receipt = {
          kind: /** @type {const} */ ('attempt.outcome'),
          outcome: response.outcome, dispatchCertainty: response.certainty, observations: response.observations,
        };
        return response.recordLate(await transition(current, {
          ...receipt, findings: receiveWorkerFindings(current, receipt, response.reportedFindings),
        }));
      });
      return true;
    } finally {
      releaseAttempt(attemptId);
    }
  }

  /**
   * @param {Operation} state
   * @param {OutcomeEvidence & {dispatchCertainty: import('../core/operation.js').DispatchCertainty}} receipt
   * @param {unknown} reported
   */
  function receiveWorkerFindings(state, receipt, reported) {
    if (reported === undefined) return undefined;
    const attemptId = receipt.outcome.attemptId;
    const author = state.attempts.find(item => item.attemptId === attemptId)?.route?.profileId;
    const parsed = decode(findings, reported);
    if (parsed.kind === 'accepted' && author && receipt.dispatchCertainty !== 'not_sent') {
      const refs = evidenceRefs(state.request.requestId, state.events);
      recordObservationRefs(refs, receipt);
      if (!admitFindings(refs, parsed.value, '$.findings', author)) return parsed.value;
    }
    trace(state, 'worker.findings_invalid_proposal', 'INVALID_PROPOSAL', attemptId);
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

  /** @param {string} operationId @param {AbortSignal} stop @param {Map<string, PendingAction>} pending
   * @param {ReadonlyMap<string, LookupStatus>} [lookups]
   */
  async function drive(operationId, stop, pending, lookups) {
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
      const response = await invoke(reserved.state, attemptId, stop, correction, undefined, provider, lookups)
        .catch(error => {
          releaseAttempt(attemptId);
          throw error;
        });
      const next = await serialize(async () => {
        let state = await transition(await inspect(operationId), {
          kind: 'attempt.outcome', outcome: response.outcome, dispatchCertainty: response.certainty, observations: response.observations,
        });
        if (state.status === 'active' && response.outcome.terminal !== 'completed') {
          state = await technicalWait(state, {
            code: response.outcome.diagnostics[0]?.code ?? 'PROTOCOL_ERROR',
            operationId, attemptId, actionId: attemptId, effect: response.outcome.effect, dispatchCertainty: response.certainty,
          });
        }
        state = await response.recordLate(state);
        if (state.status !== 'active') return state;
        const parsed = decodeDecision(response.output);
        correction = parsed.kind === 'rejected' ? parsed.reason : undefined;
        if (parsed.kind === 'accepted') {
          const value = parsed.value;
          const assessment = value.finalAssessment;
          const refs = evidenceRefs(state.request.requestId, state.events);
          const evidenceError = admitFindings(refs, value.findings ?? [], '$.findings', profile.profileId)
            ?? (assessment && checkAssessment(refs, assessment, profile.profileId));
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
          } else if (evidenceError) {
            correction = evidenceError;
          } else if (state.events.some(event => event.kind === 'controller.responded' && event.decision.decisionId === value.decisionId)) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.decisionId', expected: 'a fresh decision id' };
          } else {
            const round = planRound(state, value);
            if (round.error) correction = round.error;
            else {
              state = await transition(state, { kind: 'controller.responded', decision: value, attemptId, admissions: round.admissions });
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
      }).finally(() => releaseAttempt(attemptId));
      if (next.status !== 'active') return next;
      if (settleCancellation.length) await Promise.all(settleCancellation);
      if (selection) await runActionRound(selection.selected, selection.newlyAdmitted, selection.actions, next,
        (action, signal) => dispatchWorker(next, action, signal, lookups),
        (action, code, resource) => recordAction(operationId, action, 'action.deferred', code, resource),
        pending, selection.policy, selection.newResult);
    }
    return inspect(operationId);
  }

  return { submit, resume, inspect, inspectFinding, cancel };
}
