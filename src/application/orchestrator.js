import { admitFindings, checkAssessment, evidenceRefs, findings, recordObservationRefs } from '../core/finding.js';
import { decodeDecision, decodeOutcome, decodeRequest, followup } from '../core/contracts.js';
import { decode, jsonValue } from '../core/decode.js';
import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { acceptedWorkerAllowed, applyEvent, controllerFailureWaiting, createOperation, pendingControllerReasoning, resourceSnapshot, sameRecord, workspaceContextFor } from '../core/operation.js';
import { admitActions } from '../core/action-graph.js';
import { controllerContext, controllerInstructions, pendingControllerHistoryRequest } from './controller-context.js';
import { handoffContext, materializeSkillInstructions, prepareHandoff } from './handoff.js';
import { workerRequestHash } from './worker-request-identity.js';
import { findingHistory } from './finding-history.js';
import { bindContextAccess, materializeControllerHistory } from './context-access.js';
import { defaultContextBudgets, maximumContextBudgetBytes } from './context-bundle.js';
import { lookupAttempt } from './recovery.js';
import { resolveRequestedReasoning, unavailableCapabilities } from './configuration/catalog.js';
import { runActionRound } from './action-round.js';
import { bindAssessmentEvidence, bindFindingEvidence, bindOutcomeEvidence, evidenceAliases, providerEvidenceRef,
  reservedEvidenceRef, scopedEvidenceAliases } from './evidence-identity.js';
import { decodeSummaryReport, observation, receiveProviderObservation } from '../core/observation.js';

/** @import {Action, CancellationSource, Decision, Outcome, ReasonCode} from '../core/contracts.js' */
/** @import {OutcomeEvidence} from '../core/finding.js' */
/** @import {FieldError} from '../core/decode.js' */
/** @import {Clock, DiagnosticEvent, DiagnosticPort, IdFactory} from '../core/diagnostics.js' */
/** @import {ContextItem, Observation} from '../core/observation.js' */
/** @import {Attempt, Event, Limits, Operation, Reason} from '../core/operation.js' */
/** @import {Lookup, LookupStatus} from './recovery.js' */
/** @import {PendingAction} from './action-round.js' */
/** @import {Handoff} from './handoff.js' */
/** @import {AttemptPermissions, AuthorityPort, Catalog, ContextShare, PermissionPort, Profile, ProviderPort, ProviderResult, ProviderSession, RetryApproval, StateListEntry, StateStore} from '../core/ports.js' */

/**
 * @typedef {{provider: ProviderPort, catalog: Catalog, profile: Profile, limits: Limits, invocationTimeoutMs: number}} Execution
 * @typedef {(workspace: Operation['request']['workspaceContext']) => Promise<Execution>} ResolveExecution
 * @typedef {{
 *   store: StateStore, clock: Clock, ids: IdFactory, limits: Limits,
 *   context?: {maxBytes?: number, controllerMaxBytes?: number, handoffMaxBytes?: number, fetchMaxBytes?: number,
 *     captureMaxBytes?: number, skillInstructionsMaxBytes?: number, toolOutputMaxBytes?: number}, allowContextShare?: ContextShare,
 *   providerFor?: (profile: Profile) => ProviderPort | undefined,
 *   approveRetry?: RetryApproval, tools?: import('../core/ports.js').ToolPort,
 *   diagnostics?: DiagnosticPort, authority: AuthorityPort, permissions?: PermissionPort, configurationRef: string,
 *   schedule?: (timeoutMs: number, expire: () => void) => () => void
 * } & (Execution & {resolveExecution?: undefined} | {resolveExecution: ResolveExecution})} Dependencies
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

/** @param {((id: string) => void) | undefined} listener @param {string} id */
function notifyAccepted(listener, id) {
  try { listener?.(id); } catch { /* Delivery cannot prevent a committed operation from starting. */ }
}

/** @param {Dependencies} deps */
export function createOrchestrator(deps) {
  const {
    store, clock, ids, limits, authority, permissions, configurationRef,
    allowContextShare,
    diagnostics = noopDiagnostics, schedule = scheduleDeadline, approveRetry, tools,
    providerFor = selected => !deps.resolveExecution && selected.providerId === deps.profile.providerId ? deps.provider : undefined,
  } = deps;
  if (!deps.resolveExecution && (!Number.isSafeInteger(deps.invocationTimeoutMs) || deps.invocationTimeoutMs < 1 ||
      deps.invocationTimeoutMs > 2_147_483_647)) {
    throw new RangeError('invocationTimeoutMs must be an integer from 1 to 2147483647');
  }
  const suppliedBudgets = deps.context ?? {};
  if (suppliedBudgets.maxBytes !== undefined && suppliedBudgets.controllerMaxBytes !== undefined) {
    throw new RangeError('context.maxBytes and context.controllerMaxBytes cannot both be set');
  }
  const budgets = {
    ...defaultContextBudgets, ...suppliedBudgets,
    controllerMaxBytes: suppliedBudgets.controllerMaxBytes ?? suppliedBudgets.maxBytes ??
      defaultContextBudgets.controllerMaxBytes,
  };
  for (const [key, value] of Object.entries(budgets)) {
    if (key === 'maxBytes') continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximumContextBudgetBytes) {
      throw new RangeError('context.' + key + ' must be a positive integer at most ' + maximumContextBudgetBytes);
    }
  }
  const { controllerMaxBytes, handoffMaxBytes, fetchMaxBytes, captureMaxBytes,
    skillInstructionsMaxBytes, toolOutputMaxBytes } = budgets;
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
  /** @type {{operationId: string, actionId?: string, stop: AbortSignal}[]} */
  const reservationQueue = [];
  /** @type {ResolveExecution} */
  const resolveExecution = deps.resolveExecution ?? (async () => /** @type {Execution} */ (deps));
  /** @param {Execution} execution */
  const trusted = execution => ({ authorityRef: authority.reference, configurationRef, limits: execution.limits });

  /** @param {string} attemptId */
  function releaseAttempt(attemptId) {
    liveAttempts.delete(attemptId);
    releaseSlot();
  }
  let writes = Promise.resolve();
  /** @type {Promise<void> | undefined} */
  let closing;
  const shuttingDown = new AbortController();

  function requireRunning() {
    if (closing) throw new OrchestrationError('CANCELLED', 'Orchestrator is closing');
  }
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

  /** @param {string} requestId */
  async function findRequest(requestId) {
    const entries = await store.list();
    const operation = entries.filter(isAvailable).find(item => item.request.requestId === requestId ||
      item.events.some(event => event.kind === 'operation.continued' && event.input.requestId === requestId));
    if (!operation && entries.some(item => !isAvailable(item))) {
      throw new OrchestrationError('STORE_UNAVAILABLE', 'Cannot confirm request identity in an unreadable snapshot');
    }
    return operation;
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
      eventName, reasonCode, operationId: state.operationId, attemptId,
      ...(attemptId && { actionId: state.attempts.find(item => item.attemptId === attemptId)?.actionId }),
      ...context,
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

  /** @param {Operation} state @param {Execution} execution @param {boolean} [recover] @returns {Submission} */
  function launch(state, execution, recover = false) {
    const signal = new AbortController();
    const pending = workers.get(state.operationId) ?? new Map();
    workers.set(state.operationId, pending);
    const completion = (async () => {
      const lookups = recover ? await recoverAttempts(state.operationId, signal.signal, execution) : undefined;
      if (recover && !signal.signal.aborted) {
        const restored = await inspect(state.operationId);
        await runRecoveredWorkers(restored, pending, execution, lookups);
      }
      return drive(state.operationId, signal.signal, pending, execution, lookups);
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

  /** @param {unknown} input @param {(id: string) => void} [accepted] @returns {Promise<Submission>} */
  async function submit(input, accepted) {
    const parsed = decodeRequest(input);
    if (parsed.kind === 'rejected') {
      throw new OrchestrationError(parsed.reason.code, parsed.reason.expected, parsed.reason.path);
    }
    const request = parsed.value;
    if (request.configurationRef !== configurationRef) {
      throw new OrchestrationError('PERMISSION_DENIED', 'Unknown trusted configuration', '$.configurationRef');
    }
    return serialize(async () => {
      requireRunning();
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
      if (reservedEvidenceRef(request.requestId)) {
        throw new OrchestrationError('INVALID_PROPOSAL', 'Reserved context reference prefix', '$.requestId');
      }
      if (all.some(item => item.transcriptRefs.includes(request.requestId))) {
        throw new OrchestrationError('IDENTITY_CONFLICT', 'Request id reused');
      }
      if (entries.some(item => 'kind' in item && item.requestMatch === 'unknown')) {
        throw new OrchestrationError('STORE_UNAVAILABLE', 'An unreadable snapshot lacks a request reference');
      }
      const execution = await resolveExecution(request.workspaceContext);
      requireRunning();
      const state = createOperation(ids.newId(), request, authority.reference, execution.limits, clock.now());
      const failure = await commit(state, null);
      if (failure) throw failure.error;
      trace(state, 'operation.accepted', 'ACCEPTED');
      notifyAccepted(accepted, state.operationId);
      return launch(state, execution);
    });
  }

  /** @param {string} operationId @param {unknown} [input] @param {(id: string) => void} [accepted] @returns {Promise<Submission>} */
  async function resume(operationId, input, accepted) {
    if (input === undefined) {
      return serialize(async () => {
        requireRunning();
        const state = await inspect(operationId);
        if (running.has(operationId) || (state.status !== 'active' &&
            !(controllerFailureWaiting(state) && hasRecoverableWorkers(state)))) return activeSubmission(state);
        const execution = await resolveExecution(workspaceContextFor(state));
        requireRunning();
        const next = await transition(state, { kind: 'operation.recovered', trusted: trusted(execution) });
        notifyAccepted(accepted, operationId);
        return launch(next, execution, true);
      });
    }
    const parsed = decode(followup, input);
    if (parsed.kind === 'rejected') {
      throw new OrchestrationError(parsed.reason.code, parsed.reason.expected, parsed.reason.path);
    }
    const follow = parsed.value;
    return serialize(async () => {
      requireRunning();
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
      if (reservedEvidenceRef(follow.requestId) || evidenceRefs(state.request.requestId, state.events).observations.has(follow.requestId)) {
        throw new OrchestrationError('INVALID_PROPOSAL', 'Request id collides with a context reference', '$.requestId');
      }
      const question = state.waiting?.kind === 'question' ? state.waiting : undefined;
      if (follow.questionId !== question?.questionId) {
        throw new OrchestrationError('INVALID_PROPOSAL', 'Question is missing, closed or belongs to another operation', '$.questionId');
      }
      const execution = await resolveExecution(follow.workspaceContext ?? workspaceContextFor(state));
      requireRunning();
      const next = await transition(state, { kind: 'operation.continued', input: follow, trusted: trusted(execution) });
      notifyAccepted(accepted, operationId);
      return launch(next, execution, true);
    });
  }

  /** @param {Operation} state */
  function admittedWorkers(state) {
    return new Map(state.events.flatMap(event => event.kind === 'controller.responded'
      ? (event.admissions ?? []).flatMap(item => item.kind === 'accepted'
        ? [[item.action.actionId, item.action]] : []) : []));
  }

  /** @param {Operation} state */
  function recoverableWorkers(state) {
    const boundary = state.events.findLastIndex(event => event.kind === 'operation.finished');
    const candidates = state.events.slice(boundary + 1).flatMap(event => event.kind === 'controller.responded'
      ? (event.admissions ?? []).flatMap(item => item.kind === 'accepted' ? [item.action] : []) : []);
    const accepted = new Set(state.events.flatMap(event => event.kind === 'controller.responded'
      ? event.decision.acceptedActionIds ?? [] : []));
    return candidates.filter(action => acceptedWorkerAllowed(state, action.actionId) &&
      !state.attempts.some(attempt => attempt.actionId === action.actionId && attempt.status === 'terminal') &&
      !action.dependsOn.some(edge => edge.kind === 'after_model_acceptance' && !accepted.has(edge.actionId)));
  }

  /** @param {Operation} state */
  function hasRecoverableWorkers(state) {
    return recoverableWorkers(state).length > 0 || state.attempts.some(attempt =>
      attempt.actionId !== attempt.attemptId && attempt.status !== 'terminal' && !liveAttempts.has(attempt.attemptId));
  }

  /**
   * Restore the existing action round from durable admissions. Recovery does
   * not create actions, replace an unknown attempt or choose a new strategy.
   * @param {Operation} state @param {Map<string, PendingAction>} pending @param {Execution} execution
   * @param {ReadonlyMap<string, LookupStatus>} [lookups]
   */
  async function runRecoveredWorkers(state, pending, execution, lookups) {
    if (state.status !== 'active' && !controllerFailureWaiting(state)) return;
    const actions = admittedWorkers(state);
    const candidates = recoverableWorkers(state);
    const eligible = candidates.filter(action => !state.attempts.some(attempt =>
      attempt.actionId === action.actionId && attempt.status === 'dispatched' && !liveAttempts.has(attempt.attemptId)));
    const boundary = state.events.findLastIndex(event => event.kind === 'operation.continued');
    const last = state.events.slice(boundary + 1).findLast(event => event.kind === 'controller.responded');
    const decision = last?.kind === 'controller.responded' ? last.decision : undefined;
    const localWait = controllerFailureWaiting(state);
    const selected = localWait ? eligible : (decision?.waitPolicy?.targets ?? []).flatMap(target => {
      const actionId = target.kind === 'action' ? target.id :
        state.attempts.find(attempt => attempt.attemptId === target.id)?.actionId;
      const action = actionId === undefined ? undefined : actions.get(actionId);
      return action && acceptedWorkerAllowed(state, action.actionId) ? [action] : [];
    });
    const newResult = !decision?.waitPolicy || state.events.some((event,index) =>
      index + 1 > decision.contextCursor && event.kind === 'attempt.outcome' &&
      state.attempts.some(attempt => attempt.attemptId === event.outcome.attemptId &&
        selected.some(action => action.actionId === attempt.actionId)));
    if (eligible.length || selected.length) {
      await runActionRound(selected, eligible, actions, state,
        (action, signal) => dispatchWorker(state, action, signal, execution, lookups),
        (action, code, resource) => recordAction(state.operationId, action, 'action.deferred', code, resource),
        pending, localWait ? 'all_requested' : decision?.waitPolicy?.kind ?? 'next_completion', newResult);
    }
    if (localWait && pending.size) {
      const results = await Promise.allSettled([...pending.values()].map(task => task.completion));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  }

  /** @param {Operation} state @param {boolean} [recoverWorkers] */
  async function settleOrphans(state, recoverWorkers = false) {
    let current = state;
    for (const attempt of state.attempts) {
      if (attempt.status === 'terminal' || liveAttempts.has(attempt.attemptId)) continue;
      const dispatched = attempt.status === 'dispatched';
      if (recoverWorkers && !dispatched && !attempt.cancellation &&
          attempt.actionId !== attempt.attemptId && acceptedWorkerAllowed(current, attempt.actionId) &&
          recoverableWorkers(current).some(action => action.actionId === attempt.actionId) &&
          resourceSnapshot(current).charged <= current.limits.maxInvocations) continue;
      current = await transition(current, {
        kind: 'attempt.outcome', dispatchCertainty: dispatched ? 'unknown' : 'not_sent',
        outcome: failedOutcome(attempt.attemptId, attempt.cancellation ? 'CANCELLED' : 'PROVIDER_DISCONNECTED', dispatched),
      });
    }
    return current;
  }

  /** @param {string} operationId @param {AbortSignal} stop @param {Execution} execution */
  async function recoverAttempts(operationId, stop, { invocationTimeoutMs, catalog }) {
    const state = await serialize(async () => {
      const current = await inspect(operationId);
      return stop.aborted ? current : settleOrphans(current, true);
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
          if (result) {
            const recorded = current.events.flatMap(event => event.kind === 'attempt.outcome' &&
              event.outcome.attemptId === attempt.attemptId ? event.observations ?? [] : []);
            const outcome = bindOutcomeEvidence(current.operationId, result.outcome, recorded);
            await transition(current, {
              kind: 'attempt.outcome', outcome, dispatchCertainty: result.dispatchCertainty,
              observations: [observation({
                ref: 'attempt-status:' + ids.newId(), completeness: 'complete', value: { ...result, outcome },
              }, { kind: 'provider_report', sourceId: attempt.route?.providerId ?? attempt.attemptId, receivedAt })],
            });
          }
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
      if (source === 'shutdown' && state.status === 'finished') return state;
      const next = await transition(state, { kind: 'operation.cancelled', source }).finally(() => {
        if (source === 'shutdown') stopOperation(operationId, source);
      });
      if (source !== 'shutdown') stopOperation(operationId, source);
      return settleOrphans(next);
    });
  }

  /** @param {string} operationId @param {CancellationSource} source */
  function stopOperation(operationId, source) {
    running.get(operationId)?.signal.abort(source);
    for (const worker of workers.get(operationId)?.values() ?? []) worker.stop.abort(source);
    releaseSlot();
  }

  function close() {
    shuttingDown.abort('shutdown');
    return closing ??= (async () => {
      await writes;
      const active = [...new Set([...running.keys(), ...workers.keys()])].filter(id =>
        running.has(id) || workers.get(id)?.size);
      const completions = [...running.values()].map(item => item.completion);
      const cancelled = await Promise.allSettled(active.map(id => cancel(id, 'shutdown')));
      for (const id of active) stopOperation(id, 'shutdown');
      await Promise.allSettled([
        ...completions,
        ...[...workers.values()].flatMap(items => [...items.values()].map(item => item.completion)),
      ]);
      await writes;
      const failure = cancelled.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
  }

  /**
   * @param {Operation} state @param {string} attemptId @param {AbortSignal} stop
   * @param {Execution} execution @param {FieldError | undefined} correction @param {Handoff} [handoff] @param {ProviderPort} [executor]
   * @param {ReadonlyMap<string, LookupStatus>} [lookups] @param {Action} [action]
   */
  async function invoke(state, attemptId, stop, { catalog, profile, provider, invocationTimeoutMs }, correction, handoff, executor = provider, lookups, action) {
    const local = new AbortController();
    const signal = AbortSignal.any([stop, local.signal, shuttingDown.signal]);
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
    const toolStop = new AbortController();
    /** @type {Observation[]} */
    const lateObservations = [];
    /** @type {ProviderResult | undefined} */
    let receivedReply;
    /** @type {ProviderResult | undefined} */
    let lateReply;
    let recordingLate = false;
    let flushScheduled = false;

    /** @type {Map<string, Observation>} */
    const providerReports = new Map();
    /** @param {Observation} item */
    const reportContent = ({ provenance, ...item }) => ({
      ...item, provenance: provenance && { ...provenance, receivedAt: undefined },
    });

    /** @param {Observation} item @param {boolean} [late] */
    function receive(item, late = false) {
      if (!late && !signal.aborted) observations.push(item);
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
      const observations = [];
      for (const sample of samples) {
        if (known.some(item => item.ref === sample.ref)) continue;
        observations.push(sample);
        known.push(sample);
      }
      if (!reply && !observations.length) return current;
      const receipt = {
        kind: /** @type {const} */ ('attempt.outcome'),
        outcome: reply ? bindOutcomeEvidence(current.operationId, reply.outcome, known) : attempt.outcome,
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
      const validReasoningIssue = reply.reasoningUnavailable &&
        ['session_option_unavailable', 'session_option_rejected'].includes(reply.reasoningUnavailable) &&
        parsed.value.diagnostics[0]?.code === 'CAPABILITY_UNAVAILABLE' &&
        parsed.value.terminal === 'failed' && reply.dispatchCertainty === 'not_sent';
      const result = { outcome: parsed.value, dispatchCertainty: reply.dispatchCertainty,
        output: reply.output, findings: reply.findings,
        reasoningUnavailable: validReasoningIssue ? reply.reasoningUnavailable : undefined };
      if (acceptingObservations) {
        receivedReply = result;
        if (result.output !== undefined) {
          const output = decode(jsonValue, result.output);
          // Adapter-proven final message identity: a published observation
          // from this attempt with the same original bytes is already durable.
          // A parallel model claim or equal-text independent report is NOT an
          // identity proof. Keep the legacy synthetic output when unmatched.
          const original = reply.outputObservationRef && observations.find(item =>
            item.ref === reply.outputObservationRef &&
            item.source === 'model_claim' && item.provenance?.kind === 'model' &&
            item.completeness === 'complete' &&
            parsed.value.outputRefs.some(pointer => pointer.ref === item.ref || pointer.ref === item.providerRef));
          const alreadyRecorded = output.kind === 'accepted' && original &&
            typeof original.value === 'string' && typeof output.value === 'string' &&
            Buffer.from(original.value, 'utf8').equals(Buffer.from(output.value, 'utf8'));
          if (!alreadyRecorded) receive(observation({
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
    /** @type {{profileId: string, reasoningLevel?: string, availableLevels: string[], reasoningCause: string} | undefined} */
    let reasoningFailure;
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
      const binding = state.attempts.find(item => item.attemptId === attemptId)?.reasoningDecisionId;
      const selectedDecision = binding ? state.events.find(item =>
        item.kind === 'controller.responded' && item.decision.decisionId === binding) : undefined;
      const requestedLevel = selectedDecision?.kind === 'controller.responded'
        ? selectedDecision.decision.nextController?.reasoningLevel : undefined;
      const choice = handoff
        ? {kind: /** @type {const} */ ('selected'),
          selection: handoff.reasoning ?? /** @type {const} */ ({mode: 'native'})}
        : resolveRequestedReasoning(catalog, selectedProfile, requestedLevel);
      const adapterMissing = choice.kind === 'selected' && choice.selection.mode === 'selectable' &&
        executor.supportsReasoningSelection !== true;
      const selectableLevels = entries.find(item => item.kind === 'profile' &&
        item.value.profileId === selectedProfile.profileId);
      const unavailableChoice = choice.kind === 'rejected' ? choice : adapterMissing ? {
        profileId: selectedProfile.profileId,
        requestedLevel: choice.kind === 'selected' && choice.selection.mode === 'selectable' ? choice.selection.level : undefined,
        availableLevels: selectableLevels?.kind === 'profile' && selectableLevels.value.reasoning?.mode === 'selectable'
          ? selectableLevels.value.reasoning.levels : [],
      } : undefined;
      if (unavailableChoice) {
        const choice = unavailableChoice;
        const ref = 'host:reasoning:' + attemptId;
        observations.push(observation({ref, completeness: 'complete', value: {
          profileId: choice.profileId, requestedLevel: choice.requestedLevel,
          availableLevels: choice.availableLevels,
          reason: adapterMissing ? 'adapter_without_selectable_support' : 'unavailable_reasoning_level',
        }}, {kind:'host_transport', sourceId:selectedProfile.providerId, receivedAt:clock.now()}));
        const failure = failedOutcome(attemptId, 'CAPABILITY_UNAVAILABLE', false);
        failure.diagnostics[0].ref = ref;
        return {outcome: failure, certainty: /** @type {const} */ ('not_sent'),
          output, observations, contextCursor, recordLate,
          reasoningFailure: {profileId: choice.profileId, reasoningLevel: choice.requestedLevel,
            availableLevels: [...choice.availableLevels]}};
      }
      if (choice.kind !== 'selected') throw new OrchestrationError('CAPABILITY_UNAVAILABLE', 'Reasoning selection not admitted');
      const reasoning = choice.selection;
      function requireAuthority() {
        const decision = authority.authorize(state.authorityRef, selectedProfile.profileId);
        if (decision !== 'ALLOWED') {
          denied = decision;
          throw new OrchestrationError(decision, 'Invocation is outside the active grant');
        }
      }
      /** @param {Operation} current */
      /** @param {Operation} current @param {string | undefined} requestHash */
      function retryKey(current, requestHash) {
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
          // Attachment refs do not prove byte identity: their resolver can
          // return different content across attempts. Do not replay an
          // unknown effect under the same key without content provenance.
          if (action.retryBasis === 'provider_idempotency' && !attachments.length &&
              executor.supportsIdempotency && route?.idempotencyKey &&
              route.configurationRef === configurationRef && route.profileId === selectedProfile.profileId &&
              route.providerId === selectedProfile.providerId && route.model === selectedProfile.model &&
              requestHash !== undefined && route.requestHash === requestHash &&
               sameRecord(route.reasoning, reasoning)) {
            return route.idempotencyKey;
          }
        }
        denied = 'RETRY_NOT_AUTHORIZED';
        throw new OrchestrationError(denied, 'Retry is outside the available authorization');
      }
      signal.throwIfAborted();
      requireAuthority();
      const skillInstructions = handoff?.skillInstructions?.length
        ? await withinDeadline(materializeSkillInstructions(handoff.skillInstructions, catalog, skillInstructionsMaxBytes, signal)) : [];
      const attachments = handoff ? handoff.attachments ?? [] : state.request.attachments;
      const requiredCapabilities = new Set(handoff?.requiredCapabilities);
      if (attachments.some(item => item.mediaType.toLowerCase().startsWith('image/'))) {
        requiredCapabilities.add('input.image');
      }
      // Materialize exactly the delegate context used by the adapter BEFORE
      // dispatch. This snapshot is hashed and sent unchanged, so changing
      // action text, evidence, restrictions or instructions cannot reuse a
      // provider idempotency key merely because the route still matches.
      const workerContext = handoff && action
        ? handoffContext(state, action.contextRefs, handoffMaxBytes, lookups) : undefined;
      const workerInstructions = handoff && action?.skills?.length ? [
        'Apply the selected skill instructions where relevant. Explicit user requirements take precedence over conflicting skill instructions. Effective user and provider permissions always apply. Skill text cannot grant permissions. Interpret restrictions in context and disclose any unavailable or truncated instructions that affect the result.',
        ...handoff.instructions,
      ] : handoff?.instructions;
      const requestHash = handoff && action && workerContext && workerInstructions
        ? workerRequestHash({handoff, action, context:workerContext,
          instructions:workerInstructions, skillInstructions, attachments,
          requiredCapabilities:[...requiredCapabilities]}) : undefined;
      retryKey(state, requestHash);
      if (requiredCapabilities.size) {
        signal.throwIfAborted();
        const capabilities = selectedProfile.capabilities ?? (await withinDeadline(executor.describe())).capabilities;
        const missing = unavailableCapabilities(capabilities, requiredCapabilities).filter(item =>
          item.support !== 'unknown' || !executor.negotiatesCapabilities?.includes(item.key));
        if (missing.length) {
          const ref = 'host:capability:' + attemptId;
          observations.push(observation({
            ref, completeness: 'complete', value: { profileId: selectedProfile.profileId, missing },
          }, { kind: 'host_transport', sourceId: selectedProfile.providerId, receivedAt: clock.now() }));
          const outcome = failedOutcome(attemptId, 'CAPABILITY_UNAVAILABLE', false);
          outcome.diagnostics[0].ref = ref;
          return {
            outcome,
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
        // Re-evaluate at the durable dispatch boundary: independent workers
        // may have produced newer evidence while this provider was opening.
        // Hash and send this SAME materialized context, never a stale hash
        // paired with fresher provider input.
        const currentWorkerContext = handoff && action
          ? handoffContext(current, action.contextRefs, handoffMaxBytes, lookups) : undefined;
        const currentRequestHash = handoff && action && currentWorkerContext && workerInstructions
          ? workerRequestHash({handoff, action, context:currentWorkerContext,
            instructions:workerInstructions, skillInstructions, attachments,
            requiredCapabilities:[...requiredCapabilities]}) : undefined;
        const idempotencyKey = retryKey(current, currentRequestHash);
        const dispatched = await transition(current, {
          kind: 'attempt.dispatched', attemptId, route: {
            configurationRef, profileId: selectedProfile.profileId, providerId: selectedProfile.providerId, model: selectedProfile.model,
            idempotencyKey, requestHash: currentRequestHash, reasoning,
          },
        });
        contextCursor = dispatched.revision;
        signal.throwIfAborted();
        requireAuthority();
        retryKey(dispatched, currentRequestHash);
        boundPermissions = permissions?.bind({
          operationId: state.operationId, attemptId, profileId: selectedProfile.profileId, authorityRef: state.authorityRef, signal,
          report: (event, reason) => trace(dispatched, event, reason, attemptId),
        });
        // Keep the dispatch decision and actual provider call in the same turn.
        const context = handoff ? {
          ...handoff,
          ...(action?.skills?.length ? { instructions: workerInstructions } : {}),
          ...(skillInstructions.length ? { skillInstructions } : {}),
          context: currentWorkerContext ?? [],
        } : {
          operationId: state.operationId, actionId: attemptId, kind: /** @type {const} */ ('controller'),
          objective: state.request.text, instructions: controllerInstructions, profile,
          workspaceContext: workspaceContextFor(state), userConstraints: state.request.userConstraints,
          context: controllerContext(dispatched, entries, correction, lookups, controllerMaxBytes, catalog.preferences), authorityRef: state.authorityRef,
        };
        if (handoff && action) traceHandoff(dispatched, attemptId, action, context.context);
        const selected = action ? new Set(action.contextRefs) : undefined;
        contextOpen = true;
        const isActive = () => contextOpen && !signal.aborted &&
          authority.authorize(dispatched.authorityRef, selectedProfile.profileId) === 'ALLOWED';
        const contextAccess = bindContextAccess({
          state: dispatched, store, maxBytes: fetchMaxBytes, captureMaxBytes, profileId: selectedProfile.profileId, attemptId,
          selected, allowShare: allowContextShare, newId: () => ids.newId(), now: () => clock.now(), receive,
          isActive,
        });
        const externalTools = tools?.bind({
          attemptId, operationId: dispatched.operationId, isActive, signal: AbortSignal.any([signal, toolStop.signal]),
          permissions: boundPermissions, newId: () => ids.newId(), maxBytes: toolOutputMaxBytes,
          receive(toolId, receipt) {
            const ref = (receipt.late ? 'host:tool-late:' : 'host:tool:') + receipt.callId;
            receive(observation({ ref, completeness: receipt.status === 'truncated' ? 'truncated' : 'complete', value: receipt },
              { kind: 'host_transport', sourceId: toolId, receivedAt: clock.now() }), receipt.late);
            return ref;
          },
        });
        /** @type {Set<string> | undefined} */
        let rawRefs;
        return { response: withinDeadline((async () => {
          const requested = !handoff ? pendingControllerHistoryRequest(dispatched, attemptId) : undefined;
          if (requested) {
            const records = await materializeControllerHistory(contextAccess, requested, controllerMaxBytes);
            signal.throwIfAborted();
            requireAuthority();
            context.context = controllerContext(dispatched, entries, correction, lookups,
              controllerMaxBytes, catalog.preferences, records, requested.workCursor);
            const unavailable = records.filter(item => item.completeness === 'unavailable').length;
            trace(dispatched, 'context.history_requested', 'DELIVERY_OBSERVED', attemptId, {
              details: { requestedRefs: requested.refs?.length ?? 0,
                cursorRequested: requested.cursor !== undefined,
                representedRecords: records.length, unavailableRecords: unavailable,
                materializedBytes: Buffer.byteLength(JSON.stringify(records)) },
            });
          }
          signal.throwIfAborted();
          requireAuthority();
          const contextBytes = Buffer.byteLength(JSON.stringify(context.context));
          const hostFacts = !handoff ? context.context.find(item => item.ref === 'host:invocation-context')?.value : undefined;
          const map = hostFacts && typeof hostFacts === 'object' && 'workMap' in hostFacts
            ? hostFacts.workMap : undefined;
          const budget = hostFacts && typeof hostFacts === 'object' && 'historyBudget' in hostFacts
            ? hostFacts.historyBudget : undefined;
          trace(dispatched, 'context.host_prepared', 'SERIALIZED', attemptId, {
            details: { kind: handoff ? 'delegate' : 'controller', serializedContextBytes: contextBytes,
              recordCount: context.context.length,
              ...(map && typeof map === 'object' && 'total' in map && 'represented' in map && 'omitted' in map
                ? { workTotal: Number(map.total), workRepresented: Number(map.represented),
                  workOmitted: Number(map.omitted) } : {}),
              ...(budget && typeof budget === 'object' && 'omitted' in budget
                ? { historyOmitted: Number(budget.omitted) } : {}),
            },
          });
          mayHaveSent = true;
          if (!handoff) trace(dispatched, 'controller.requested', 'DISPATCH_STARTED', attemptId);
          return executor.invoke(owned, {
          ...context, reasoning, isActive, contextAccess, externalTools, idempotencyKey, attachments, requiredCapabilities: [...requiredCapabilities], attemptId, timeoutMs: invocationTimeoutMs, signal,
          permissions: boundPermissions ? { request: boundPermissions.request } : undefined,
        }, item => {
          if (!acceptingObservations) return;
          const summary = item && typeof item === 'object' && 'kind' in item && item.kind === 'model_summary';
          if (summary) {
            const report = decodeSummaryReport(item);
            if (report && contextOpen && !signal.aborted) {
              rawRefs ??= evidenceRefs(dispatched.request.requestId, dispatched.events).rawObservations;
              const covered = report.coveredObservationRefs.map(evidenceAliases(observations));
              if (new Set(covered).size === covered.length && covered.every((ref, index) =>
                !(ref !== report.coveredObservationRefs[index] && rawRefs?.has(report.coveredObservationRefs[index])) &&
                (((!selected || selected.has(ref)) && rawRefs?.has(ref)) ||
                  observations.some(item => item.ref === ref && !item.summary)))) {
                const author = selectedProfile.profileId;
                const ref = 'summary:' + ids.newId();
                receive(observation({
                  ref, completeness: 'complete', value: report.text,
                  summary: { author, coveredObservationRefs: covered },
                }, { kind: 'model', sourceId: author, receivedAt: clock.now() }));
                return ref;
              }
            }
          } else {
            const received = receiveProviderObservation(item, clock.now());
            if (received) {
              const providerRef = received.ref;
              const ref = providerEvidenceRef(state.operationId, attemptId, providerRef);
              const item = { ...received, ref, providerRef };
              const prior = providerReports.get(providerRef);
              if (!prior) {
                providerReports.set(providerRef, item);
                receive(item);
                return ref;
              }
              if (sameRecord(reportContent(prior), reportContent(item))) return ref;
            }
          }
          trace(dispatched, 'attempt.observation_invalid', 'PROTOCOL_ERROR', attemptId);
        });
        })().then(acceptReply)) };
      });
      const reply = await invocation.response;
      signal.throwIfAborted();
      if (!reply) {
        outcome = failedOutcome(attemptId, 'PROTOCOL_ERROR', true);
        certainty = 'unknown';
      } else {
        ({ dispatchCertainty: certainty, output, findings: reportedFindings } = reply);
        trace(state, 'provider.reply_observed', 'PROVIDER_REPLIED', attemptId, {
          details: { dispatchCertainty: certainty, terminal: reply.outcome.terminal,
            outputRefs: reply.outcome.outputRefs.length,
            inputTokens: reply.outcome.usage.inputTokens,
            outputTokens: reply.outcome.usage.outputTokens,
            cost: reply.outcome.usage.cost,
          },
        });
        outcome = bindOutcomeEvidence(state.operationId, reply.outcome, observations);
        if (!handoff && reply.reasoningUnavailable && reasoning.mode === 'selectable') {
          const catalogProfile = entries.find(item => item.kind === 'profile' &&
            item.value.profileId === selectedProfile.profileId);
          reasoningFailure = {
            profileId: selectedProfile.profileId, reasoningLevel: reasoning.level,
            availableLevels: catalogProfile?.kind === 'profile' && catalogProfile.value.reasoning?.mode === 'selectable'
              ? [...catalogProfile.value.reasoning.levels] : [],
            reasoningCause: reply.reasoningUnavailable,
          };
        }
      }
    } catch (error) {
      if (error instanceof OrchestrationError && ['STORE_CONFLICT', 'STORE_UNAVAILABLE'].includes(error.code)) throw error;
      const code = denied ?? (stop.aborted || shuttingDown.signal.aborted ? 'CANCELLED' : local.signal.aborted ? 'DEADLINE_EXCEEDED'
        : mayHaveSent ? 'PROVIDER_DISCONNECTED' : 'PROVIDER_START_FAILED');
      certainty = mayHaveSent ? 'unknown' : 'not_sent';
      outcome = failedOutcome(attemptId, code, mayHaveSent);
      if (signal.aborted) lateReply ??= receivedReply;
    } finally {
      // Decisions stop at abort. Facts remain attributable until the adapter
      // acknowledges detachment of this invocation's owned session.
      contextOpen = false;
      toolStop.abort();
      acceptingObservations = signal.aborted && mayHaveSent;
      boundPermissions?.close();
      clear();
      signal.removeEventListener('abort', abort);
      if (opening) {
        let closed = false;
        let cleanupFailed = false;
        // A late open still transfers a session to this cleanup path.
        const detached = opening.then(owned => executor.close(owned), () => {}).then(() => {
          closed = true;
          acceptingObservations = false;
          if (undetached.delete(attemptId)) {
            receive(observation({ref:'host:cleanup-detached:'+attemptId,completeness:'complete',
              value:{status:'detached'}},{kind:'host_transport',sourceId:attemptId,receivedAt:clock.now()}),true);
            releaseSlot();
          }
        }).catch(() => { cleanupFailed=true; trace(state, 'provider.cleanup', 'PROTOCOL_ERROR', attemptId); });
        /** @type {{promise: Promise<void>, resolve: () => void}} */
        const cleanupDeadline = Promise.withResolvers();
        const clearCleanup = schedule(invocationTimeoutMs, () => {
          trace(state, 'provider.cleanup', 'DEADLINE_EXCEEDED', attemptId);
          cleanupDeadline.resolve();
        });
        await Promise.race([detached, cleanupDeadline.promise]);
        clearCleanup();
        if (!closed) {
          undetached.add(attemptId);
          observations.push(observation({ref:'host:cleanup-pending:'+attemptId,completeness:'complete',
            value:{status:'not_confirmed',reason:cleanupFailed?'close_failed':'deadline',slotRetained:true}},
            {kind:'host_transport',sourceId:attemptId,receivedAt:clock.now()}));
        }
      }
    }
    return {
      outcome, certainty, output, contextCursor, recordLate, reportedFindings,
      reasoningFailure,
      observations: certainty === 'not_sent' ? observations.filter(item => !item.summary) : observations,
    };
  }

  /**
   * Technical admission only. Existing unsent Worker reservations retain
   * their identity and charge; an orphan dispatched attempt is never reused.
   * @param {Operation} state @param {string} [actionId]
   * @returns {{kind: 'denied' | 'known' | 'resource' | 'busy' | 'ready', existing?: Attempt, resource?: string}}
   */
  function reservationAvailability(state, actionId) {
    if (actionId ? !acceptedWorkerAllowed(state, actionId) : state.status !== 'active') return {kind:'denied'};
    const existing = actionId ? state.attempts.find(attempt => attempt.actionId === actionId) : undefined;
    if (existing && (existing.status !== 'reserved' || liveAttempts.has(existing.attemptId))) return {kind:'known'};
    if (existing?.cancellation) return {kind:'denied'};
    const resources = resourceSnapshot(state);
    if (existing ? resources.charged > state.limits.maxInvocations : resources.remaining <= 0) return {kind:'resource',resource:'invocation_budget'};
    const active = new Set([...undetached, ...liveAttempts]);
    const detachedPending = state.attempts.filter(attempt =>
      attempt.status === 'terminal' && undetached.has(attempt.attemptId)).length;
    if (undetached.size >= limits.maxConcurrentInvocations || detachedPending >= state.limits.maxConcurrentInvocations) {
      return {kind:'resource',resource:'provider_cleanup_pending'};
    }
    const localActive = existing ? state.attempts.filter(attempt =>
      attempt.status !== 'terminal' && liveAttempts.has(attempt.attemptId)).length : resources.active;
    if (active.size >= limits.maxConcurrentInvocations ||
        localActive + detachedPending >= state.limits.maxConcurrentInvocations) return {kind:'busy'};
    return {kind:'ready', existing};
  }

  /** @param {string} operationId @param {AbortSignal} stop @param {string} [actionId] */
  async function reserve(operationId, stop, actionId) {
    let notified = false;
    const ticket = {operationId, actionId, stop};
    reservationQueue.push(ticket);
    const wake = () => releaseSlot();
    stop.addEventListener('abort', wake, {once:true});
    try {
      while (true) {
        const result = await serialize(async () => {
          const state = await inspect(operationId);
          if (closing || stop.aborted) return {state};
          const available = reservationAvailability(state, actionId);
          if (available.kind === 'denied') return {state};
          if (available.kind === 'known') return {state, known:true};
          if (available.kind === 'resource') {
            return {state: actionId ? state : await technicalWait(state, {code:'RESOURCE_LIMIT', operationId, resource:available.resource}),
              resource:available.resource};
          }
          // FIFO among currently eligible reservation requests. A waiter
          // blocked by its own operation limit cannot hold unrelated slots.
          let earlierReady = false;
          if (available.kind === 'ready') {
            for (const earlier of reservationQueue) {
              if (earlier === ticket) break;
              if (earlier.stop.aborted) continue;
              const prior = earlier.operationId === operationId ? state : await store.load(earlier.operationId);
              if (prior && reservationAvailability(prior, earlier.actionId).kind === 'ready') {
                earlierReady = true;
                break;
              }
            }
          }
          if (available.kind === 'busy' || earlierReady) {
            if (!notified && actionId) {
              notified = true;
              await transition(state, {kind:'action.deferred', actionId, code:'RESOURCE_LIMIT', resource:'concurrency'});
            }
            return {state, ready:slot.promise};
          }
          if (available.existing) {
            liveAttempts.add(available.existing.attemptId);
            return {attemptId:available.existing.attemptId, state};
          }
          const attemptId = ids.newId();
          const reasoningDecisionId = actionId ? undefined : pendingControllerReasoning(state)?.decisionId;
          const reserved = await transition(state, {
            kind:'attempt.reserved', attemptId, actionId:actionId ?? attemptId, reasoningDecisionId,
          });
          liveAttempts.add(attemptId);
          return {attemptId, state:reserved};
        });
        if (!result.ready) return result;
        await result.ready;
      }
    } finally {
      stop.removeEventListener('abort', wake);
      reservationQueue.splice(reservationQueue.indexOf(ticket), 1);
      releaseSlot();
    }
  }

  /** @param {Operation} state @param {Action} action @param {AbortSignal} stop @param {Execution} execution
   * @param {ReadonlyMap<string, LookupStatus>} [lookups] */
  async function dispatchWorker(state, action, stop, execution, lookups) {
    const current = await inspect(state.operationId);
    if (stop.aborted || !acceptedWorkerAllowed(current, action.actionId)) return false;
    const entries = await execution.catalog.list();
    const handoff = prepareHandoff(current, action, entries);
    const choice = handoff.kind === 'accepted'
      ? resolveRequestedReasoning(execution.catalog, handoff.handoff.profile, action.reasoningLevel) : undefined;
    if (choice?.kind === 'rejected') {
      await recordAction(state.operationId, action, 'action.rejected', 'CAPABILITY_UNAVAILABLE',
        'reasoning:' + choice.profileId + ':' + (choice.requestedLevel ?? '(default)') +
        ' available=' + choice.availableLevels.join(','), 'reasoning');
      return false;
    }
    const executor = handoff.kind === 'accepted' ? providerFor(handoff.handoff.profile) : undefined;
    if (handoff.kind === 'rejected' || !executor) {
      await recordAction(state.operationId, action, 'action.rejected', 'CAPABILITY_UNAVAILABLE',
        handoff.kind === 'rejected' ? handoff.resource : action.profileId,
        handoff.kind === 'rejected' ? handoff.category : 'adapter');
      return false;
    }
    if (choice?.kind === 'selected' && choice.selection.mode === 'selectable' &&
        executor.supportsReasoningSelection !== true) {
      await recordAction(state.operationId, action, 'action.rejected', 'CAPABILITY_UNAVAILABLE',
        'reasoning:adapter_without_selectable_support:' + action.profileId, 'adapter');
      return false;
    }
    const reserved = await reserve(state.operationId, stop, action.actionId);
    if (!reserved.attemptId) {
      if (reserved.known) return true;
      if (!stop.aborted && acceptedWorkerAllowed(reserved.state, action.actionId)) {
        await recordAction(state.operationId, action, 'action.deferred', 'RESOURCE_LIMIT', reserved.resource, 'resource');
      }
      return false;
    }
    const attemptId = reserved.attemptId;
    try {
      const invocation = { ...handoff.handoff, reasoning: choice?.kind === 'selected' ? choice.selection : undefined,
        workspaceContext: workspaceContextFor(state) };
      const response = await invoke(reserved.state, attemptId, stop, execution, undefined, invocation, executor, lookups, action);
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
      const known = state.events.flatMap(event => event.kind === 'attempt.outcome' && event.outcome.attemptId === attemptId
        ? event.observations ?? [] : []);
      const scope = scopedEvidenceAliases([...known, ...(receipt.observations ?? [])], receipt.outcome.outputRefs, refs);
      const bound = bindFindingEvidence(parsed.value, scope.resolve);
      if (!scope.ambiguous && !admitFindings(refs, bound, '$.findings', author)) return bound;
    }
    trace(state, 'worker.findings_invalid_proposal', 'INVALID_PROPOSAL', attemptId);
  }

  /** @param {string} operationId @param {Action} action @param {'action.rejected' | 'action.deferred'} kind
   * @param {ReasonCode} code @param {string} [resource]
   * @param {import('../core/operation.js').ActionFailureCategory} [category]
   */
  async function recordAction(operationId, action, kind, code, resource, category) {
    await serialize(async () => {
      let current = await transition(await inspect(operationId), {kind, actionId:action.actionId, code, resource, category});
      const orphan = current.attempts.find(attempt => attempt.actionId === action.actionId &&
        attempt.status === 'reserved' && !liveAttempts.has(attempt.attemptId));
      if (orphan) {
        current = await transition(current, {kind:'attempt.outcome', dispatchCertainty:'not_sent',
          outcome:failedOutcome(orphan.attemptId, code, false)});
      }
      return current;
    });
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

  /** @param {string} operationId @param {AbortSignal} stop @param {Map<string, PendingAction>} pending @param {Execution} execution
   * @param {ReadonlyMap<string, LookupStatus>} [lookups]
   */
  async function drive(operationId, stop, pending, execution, lookups) {
    const { profile } = execution;
    /** @type {FieldError | undefined} */
    let correction;
    const lastCorrection = (await inspect(operationId)).events.findLast(event =>
      event.kind === 'controller.invalid_proposal' || event.kind === 'controller.responded' || event.kind === 'operation.continued');
    if (lastCorrection?.kind === 'controller.invalid_proposal') correction = lastCorrection.reason;
    while (!stop.aborted) {
      const reserved = await reserve(operationId, stop);
      if (!reserved.attemptId) return reserved.state;
      const attemptId = reserved.attemptId;
      /** @type {{selected: Action[], newlyAdmitted: Action[], actions: ReadonlyMap<string, Action>,
       *   policy: 'all_requested' | 'next_completion', newResult: boolean} | undefined} */
      let selection;
      /** @type {Promise<boolean>[]} */
      let settleCancellation = [];
      const response = await invoke(reserved.state, attemptId, stop, execution, correction, undefined, undefined, lookups)
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
            ...response.reasoningFailure,
          });
        }
        state = await response.recordLate(state);
        if (state.status !== 'active') return state;
        const parsed = decodeDecision(response.output);
        correction = parsed.kind === 'rejected' ? parsed.reason : undefined;
        if (parsed.kind === 'accepted') {
          const refs = evidenceRefs(state.request.requestId, state.events);
          const scope = scopedEvidenceAliases(response.observations, response.outcome.outputRefs, refs);
          const { resolve } = scope;
          const value = {
            ...parsed.value,
            additions: parsed.value.additions.map(action => ({ ...action, contextRefs: action.contextRefs.map(resolve) })),
            findings: parsed.value.findings && bindFindingEvidence(parsed.value.findings, resolve),
            finalAssessment: parsed.value.finalAssessment && bindAssessmentEvidence(parsed.value.finalAssessment, resolve),
          };
          const assessment = value.finalAssessment;
          const evidenceError = admitFindings(refs, value.findings ?? [], '$.findings', profile.profileId)
            ?? (assessment && checkAssessment(refs, assessment, profile.profileId));
          const live = new Set(pending.keys());
          if (value.operationId !== operationId) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.operationId', expected: 'the current operation id' };
          } else if (value.contextCursor > response.contextCursor) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.contextCursor', expected: 'an observed revision' };
          } else if ((value.waitPolicy && value.clarification) ||
            (value.additions.length && !value.waitPolicy && !value.nextController?.continue)) {
            correction = { code: 'INVALID_PROPOSAL', path: '$', expected: 'a clarification, final assessment or action wait policy' };
          } else if (assessment && !value.waitPolicy && [...live].some(id => !value.cancellations.includes(id))) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.finalAssessment', expected: 'an explicit wait or cancellation for each pending action' };
          } else if (value.acceptedActionIds?.some(id => !state.attempts.some(attempt =>
            attempt.actionId === id && attempt.status === 'terminal' && attempt.attemptId !== attempt.actionId))) {
            correction = { code: 'INVALID_PROPOSAL', path: '$.acceptedActionIds', expected: 'ids of terminal actions' };
          } else if (scope.ambiguous) {
            correction = { code: 'INVALID_PROPOSAL', path: '$', expected: 'explicit internal references for ambiguous evidence names' };
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
                kind: 'question', questionId: 'question:' + ids.newId(), question: value.clarification.question,
              } });
              if (value.waitPolicy) selection = {
                ...round, policy: value.waitPolicy.kind,
              };
              else if (value.nextController?.continue && round.newlyAdmitted.length) selection = {
                ...round, selected: [], policy: 'next_completion', newResult: true,
              };
              return state;
            }
          }
        }
        if (!correction) correction = {code:'INVALID_PROPOSAL',path:'$',expected:'a valid Decision'};
        // The decoder's path can contain an arbitrary unknown key. Keep the
        // technical correction bounded; never persist the rejected body here.
        correction = {...correction, path: correction.path.slice(0,512), expected: correction.expected.slice(0,512)};
        return transition(state, {kind:'controller.invalid_proposal', attemptId,
          decisionId:parsed.kind === 'accepted' ? parsed.value.decisionId : undefined, reason:correction});
      }).finally(() => releaseAttempt(attemptId));
      if (next.status !== 'active') {
        if (controllerFailureWaiting(next)) {
          await runRecoveredWorkers(next, pending, execution, lookups);
          return inspect(operationId);
        }
        return next;
      }
      if (settleCancellation.length) await Promise.all(settleCancellation);
      if (selection) await runActionRound(selection.selected, selection.newlyAdmitted, selection.actions, next,
        (action, signal) => dispatchWorker(next, action, signal, execution, lookups),
        (action, code, resource) => recordAction(operationId, action, 'action.deferred', code, resource),
        pending, selection.policy, selection.newResult);
    }
    return inspect(operationId);
  }

  return { submit, resume, inspect, inspectFinding, findRequest, cancel, close };
}
