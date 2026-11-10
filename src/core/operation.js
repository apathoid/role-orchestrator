/** @import {Assessment, CancellationSource, Decision, Outcome, ReasonCode, Request} from './contracts.js' */
/** @import {DiagnosticEvent} from './diagnostics.js' */
/** @import {Observation} from './observation.js' */
/** @import {Finding} from './finding.js' */
/** @import {Admission} from './action-graph.js' */

/**
 * @typedef {'not_sent' | 'sent' | 'unknown'} DispatchCertainty
 * @typedef {{configurationRef: string, profileId: string, providerId: string, model: string, idempotencyKey?: string,
 *   reasoning?: import('./ports.js').ReasoningSelection}} DispatchRoute
 * @typedef {{authorityRef: string, configurationRef: string, limits: Limits}} ResumeAuthority
 * @typedef {{attemptId: string, actionId: string, generation: number, reservedAt: number, reasoningDecisionId?: string,
 *   dispatchedAt?: number, route?: DispatchRoute, dispatchCertainty: DispatchCertainty, cancellation?: CancellationSource}} AttemptRecord
 * @typedef {AttemptRecord & (
 *   {status: 'reserved' | 'dispatched', outcome?: never, endedAt?: never} |
 *   {status: 'terminal', outcome: Outcome, endedAt: number}
 * )} Attempt
 * @typedef {{maxInvocations: number, maxConcurrentInvocations: number}} Limits
 * @typedef {{code: ReasonCode, operationId: string, actionId?: string, attemptId?: string,
 *   dispatchCertainty?: DispatchCertainty, effect?: Outcome['effect'],
 *   profileId?: string, reasoningLevel?: string, availableLevels?: readonly string[], reasoningCause?: string}} Reason
 * @typedef {{kind: 'question', questionId: string, question: string} | {kind: 'technical', reason: Reason}} Waiting
 * @typedef {{schemaVersion: 1, operationId: string, request: Request, generation: number, revision: number,
 *   authorityRef: string, acceptedAt?: number, transcriptRefs: readonly string[], limits: Limits, attempts: readonly Attempt[],
 *   events: readonly Event[], assessment?: Assessment, waiting?: Waiting,
 *   cancellation?: CancellationSource, status: 'active' | 'waiting' | 'finished' | 'cancelled'}} Operation
 *
 * @typedef {{eventId: string, receivedAt: number, operationId: string} & (
 *   {kind: 'attempt.reserved', actionId: string, attemptId: string, reasoningDecisionId?: string} |
 *   {kind: 'attempt.dispatched', attemptId: string, route?: DispatchRoute} |
 *   {kind: 'attempt.cancel_requested', attemptId: string, source: CancellationSource} |
 *   {kind: 'attempt.outcome', outcome: Outcome, dispatchCertainty: DispatchCertainty, observations?: readonly Observation[], findings?: readonly Finding[], late?: true} |
 *   {kind: 'controller.responded', decision: Decision, attemptId?: string, admissions?: readonly Admission[]} |
   {kind: 'action.rejected' | 'action.deferred', actionId: string, code: ReasonCode, resource?: string} |
   {kind: 'action.cancelled', actionId: string, source: CancellationSource} |
 *   {kind: 'operation.waiting', waiting: Waiting} |
 *   {kind: 'operation.continued', input: ReturnType<typeof import('./contracts.js').followup>, trusted?: ResumeAuthority} |
 *   {kind: 'operation.recovered', trusted: ResumeAuthority} |
 *   {kind: 'operation.finished', assessment: Assessment} |
 *   {kind: 'operation.cancelled', source: CancellationSource}
 * )} Event
 * @typedef {{kind: 'cancel', attemptId: string, source: CancellationSource}} Intent
 * @typedef {{kind: 'applied', state: Operation, diagnostic: DiagnosticEvent, intents: Intent[]} |
 *   {kind: 'duplicate', state: Operation} | {kind: 'rejected', state: Operation, reason: Reason}} Transition
 */

/** @param {string} operationId @param {Request} request @param {string} authorityRef @param {Limits} limits @param {number} [acceptedAt] @returns {Operation} */
export function createOperation(operationId, request, authorityRef, limits, acceptedAt) {
  for (const value of [limits.maxInvocations, limits.maxConcurrentInvocations]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Operation limits must be positive safe integers');
  }
  return {
    schemaVersion: 1, operationId, request, authorityRef, limits: { ...limits },
    ...(acceptedAt === undefined ? {} : { acceptedAt }), generation: 0, revision: 0,
    status: 'active', transcriptRefs: [], attempts: [], events: [],
  };
}

/** Structural equality for decoded records and internal events, with object keys unordered.
 * @param {unknown} left @param {unknown} right @returns {boolean}
 */
export function sameRecord(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const other = /** @type {Record<string, unknown>} */ (right);
  const entries = Object.entries(left).filter(([, value]) => value !== undefined);
  return entries.length === Object.values(other).filter(value => value !== undefined).length &&
    entries.every(([key, value]) => Object.hasOwn(other, key) && sameRecord(value, other[key]));
}

/** @param {Operation} state */
export function resourceSnapshot(state) {
  const active = state.attempts.filter(attempt => attempt.status !== 'terminal').length;
  const charged = state.attempts.filter(attempt =>
    !(attempt.outcome?.terminal === 'cancelled' && attempt.dispatchCertainty === 'not_sent')).length;
  const settled = state.attempts.flatMap(attempt => attempt.outcome ? [attempt.outcome.usage] : []);
  /** @param {keyof Outcome['usage']} key */
  function total(key) {
    let known = 0;
    let unknown = 0;
    for (const usage of settled) {
      const value = usage[key];
      if (value === null) unknown++;
      else known += value;
    }
    return { known, unknown };
  }
  return {
    active, charged, remaining: Math.max(0, state.limits.maxInvocations - charged),
    usage: { inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), cost: total('cost') },
  };
}

/**
 * A decision's one-shot Controller preference is pending only until the next
 * Controller reservation. Technical recovery may advance the generation, but
 * only explicit user continuation supersedes the model's pending choice.
 * @param {Operation} operation
 * @returns {{decisionId: string, reasoningLevel?: string} | undefined}
 */
export function pendingControllerReasoning(operation) {
  const events = operation.events;
  const boundary = events.findLastIndex(event => event.kind === 'operation.continued');
  const current = events.slice(boundary + 1);
  const index = current.findLastIndex(event => event.kind === 'controller.responded');
  if (index < 0) return undefined;
  const candidate = current[index];
  if (candidate.kind !== 'controller.responded' || !candidate.decision.nextController) return undefined;
  if (current.slice(index + 1).some(event =>
    event.kind === 'attempt.reserved' && event.actionId === event.attemptId)) return undefined;
  return {decisionId: candidate.decision.decisionId, reasoningLevel: candidate.decision.nextController.reasoningLevel};
}

/** @param {Operation} operation */
export function workspaceContextFor(operation) {
  const latest = operation.events.findLast(event => event.kind === 'operation.continued' && event.input.workspaceContext);
  return latest?.kind === 'operation.continued' ? latest.input.workspaceContext : operation.request.workspaceContext;
}

/**
 * Resolve terminal evidence against the current ledger. A late report can
 * fill unknown fields, but cannot replace an earlier incompatible fact.
 * @param {Attempt} prior @param {Extract<Event, {kind: 'attempt.outcome'}>} event
 */
export function resolveOutcome(prior, event) {
  const { outcome, dispatchCertainty } = event;
  if (prior.status !== 'terminal') return { outcome, dispatchCertainty };
  const current = prior.outcome;
  if (!event.late) {
    if (current.terminal === 'unknown' && outcome.terminal !== 'unknown' &&
        (prior.dispatchCertainty === 'unknown' || prior.dispatchCertainty === dispatchCertainty)) {
      return { outcome, dispatchCertainty };
    }
    return undefined;
  }
  if (current.terminal !== 'unknown' && outcome.terminal !== 'unknown' && current.terminal !== outcome.terminal) return undefined;
  if (prior.dispatchCertainty !== 'unknown' && dispatchCertainty !== 'unknown' &&
      prior.dispatchCertainty !== dispatchCertainty) return undefined;
  if ((current.effect === 'none' && outcome.effect === 'confirmed') ||
      (current.effect === 'confirmed' && outcome.effect === 'none')) return undefined;

  const terminal = current.terminal === 'unknown' ? outcome.terminal : current.terminal;
  const effect = current.effect === 'unknown' || (current.effect === 'possible' && outcome.effect !== 'unknown')
    ? outcome.effect : current.effect;
  const certainty = prior.dispatchCertainty === 'unknown' ? dispatchCertainty : prior.dispatchCertainty;
  const usage = {
    inputTokens: current.usage.inputTokens ?? outcome.usage.inputTokens,
    outputTokens: current.usage.outputTokens ?? outcome.usage.outputTokens,
    cost: current.usage.cost ?? outcome.usage.cost,
  };
  const outputRefs = [...current.outputRefs];
  for (const ref of outcome.outputRefs) {
    if (!outputRefs.some(item => sameRecord(item, ref))) outputRefs.push(ref);
  }
  if (terminal === current.terminal && effect === current.effect && certainty === prior.dispatchCertainty &&
      sameRecord(usage, current.usage) && outputRefs.length === current.outputRefs.length) return undefined;
  const base = terminal !== current.terminal ? outcome : current;
  return { outcome: { ...base, terminal, effect, usage, outputRefs }, dispatchCertainty: certainty };
}

/**
 * Subject and next technical route for transitions that can stop, defer or
 * resume work. IDs stay in the event's dedicated correlation fields.
 * @param {Event} event
 * @returns {{details?: Readonly<Record<string, string>>}}
 */
function diagnosticContext(event) {
  switch (event.kind) {
    case 'action.deferred':
      return { details: { subject: 'action', next: 'retry_when_capacity_allows' } };
    case 'action.rejected':
      return { details: { subject: 'action', next: 'controller_replan' } };
    case 'action.cancelled':
      return { details: { subject: 'action', next: 'inspect' } };
    case 'attempt.cancel_requested':
      return { details: { subject: 'attempt', next: 'await_terminal_or_unknown' } };
    case 'operation.waiting':
      return { details: { subject: event.waiting.kind === 'question' ? 'question' :
        event.waiting.reason.attemptId ? 'attempt' : 'operation', next: 'explicit_resume' } };
    case 'operation.continued':
    case 'operation.recovered':
      return { details: { subject: 'operation', next: 'controller_dispatch' } };
    case 'operation.cancelled':
      return { details: { subject: 'operation', next: 'inspect' } };
    case 'attempt.outcome':
      return { details: { subject: 'attempt', next: 'inspect' } };
    default:
      return {};
  }
}

/**
 * Technical reason for a recorded journal transition. Both the reducer and
 * durable export use this one mapping. Exceptional late/discrepancy
 * diagnostics are transient classifications, not stored journal kinds.
 * @param {Event} event
 * @returns {string}
 */
export function journalReasonCode(event) {
  switch (event.kind) {
    case 'attempt.reserved': return 'RESERVED';
    case 'attempt.dispatched': return 'DISPATCH_STARTED';
    case 'attempt.cancel_requested':
    case 'action.cancelled':
    case 'operation.cancelled': return 'CANCELLED';
    case 'attempt.outcome': return event.outcome.diagnostics[0]?.code ?? event.outcome.terminal.toUpperCase();
    case 'controller.responded': return 'ACCEPTED';
    case 'action.rejected':
    case 'action.deferred': return event.code;
    case 'operation.waiting': return event.waiting.kind === 'question' ? 'USER_INPUT' : event.waiting.reason.code;
    case 'operation.continued': return 'USER_INPUT';
    case 'operation.recovered': return 'RECOVERED';
    case 'operation.finished': return 'ASSESSMENT_RECORDED';
  }
}

/** @param {Operation} state @param {Event} event @returns {Transition} */
export function applyEvent(state, event) {
  const attemptId = event.kind === 'attempt.outcome' ? event.outcome.attemptId
    : event.kind === 'action.cancelled'
      ? state.attempts.find(item => item.actionId === event.actionId && item.status !== 'terminal')?.attemptId
      : 'attemptId' in event ? event.attemptId : undefined;
  const attempt = state.attempts.find(item => item.attemptId === attemptId);
  const actionId = attempt?.actionId ?? ('actionId' in event ? event.actionId : undefined);
  const decisionId = event.kind === 'controller.responded' ? event.decision.decisionId : undefined;
  const duplicate = /** @type {const} */ ({ kind: 'duplicate', state });

  /** @param {ReasonCode} code @returns {Transition} */
  function reject(code) {
    return {
      kind: 'rejected', state, reason: {
        code, operationId: state.operationId, attemptId, actionId,
        dispatchCertainty: attempt?.dispatchCertainty, effect: attempt?.outcome?.effect,
      },
    };
  }

  /** @param {Partial<Operation>} patch @param {string} reasonCode @param {Intent[]} [intents]
   * @param {string} [eventName] @returns {Transition} */
  function apply(patch, reasonCode, intents = [], eventName = event.kind) {
    const revision = state.revision + 1;
    return {
      kind: 'applied', state: { ...state, ...patch, revision, events: [...state.events, event] }, intents,
      diagnostic: {
        schemaVersion: 1, eventId: event.eventId, receivedAt: event.receivedAt, sequence: revision,
        level: eventName.endsWith('discrepancy') ? 'warn' : 'info', component: 'core', eventName,
        reasonCode: eventName === event.kind ? journalReasonCode(event) : reasonCode,
        operationId: state.operationId, attemptId, actionId, decisionId,
        // Taxonomy is technical only; never persist questions, proposals or tool bodies.
        ...diagnosticContext(event),
      },
    };
  }

  /** @param {Attempt} updated */
  const updateAttempt = updated => ({ attempts: state.attempts.map(item => item === attempt ? updated : item) });
  if (event.operationId !== state.operationId) return reject('INVALID_PROPOSAL');
  const prior = state.events.find(item => item.eventId === event.eventId);
  if (prior) return sameRecord(prior, event) ? duplicate : reject('IDENTITY_CONFLICT');

  switch (event.kind) {
    case 'attempt.reserved': {
      if (attempt) return reject('IDENTITY_CONFLICT');
      const pendingReasoning = pendingControllerReasoning(state);
      if (event.actionId === event.attemptId) {
        if (event.reasoningDecisionId !== pendingReasoning?.decisionId) return reject('INVALID_PROPOSAL');
      } else if (event.reasoningDecisionId !== undefined) return reject('INVALID_PROPOSAL');
      if (state.events.some(item => item.kind === 'action.cancelled' && item.actionId === event.actionId)) return reject('CANCELLED');
      if (state.status !== 'active') return reject(state.status === 'cancelled' ? 'CANCELLED' : 'INVALID_PROPOSAL');
      const resources = resourceSnapshot(state);
      if (resources.remaining <= 0 || resources.active >= state.limits.maxConcurrentInvocations) {
        return reject('RESOURCE_LIMIT');
      }
      return apply({ attempts: [...state.attempts, {
        attemptId: event.attemptId, actionId: event.actionId, generation: state.generation,
        reservedAt: event.receivedAt, reasoningDecisionId: event.reasoningDecisionId,
        status: 'reserved', dispatchCertainty: 'not_sent',
      }] }, 'RESERVED');
    }
    case 'attempt.dispatched':
      if (!attempt || attempt.status !== 'reserved') return reject('INVALID_PROPOSAL');
      if (state.status === 'cancelled' || attempt.cancellation) return reject('CANCELLED');
      if (state.status === 'finished') return reject('INVALID_PROPOSAL');
      return apply(updateAttempt({
        ...attempt, status: 'dispatched', dispatchedAt: event.receivedAt, route: event.route, dispatchCertainty: 'unknown',
      }), 'DISPATCH_STARTED');
    case 'attempt.cancel_requested':
      if (!attempt) return reject('INVALID_PROPOSAL');
      if (attempt.cancellation || attempt.status === 'terminal') return duplicate;
      return apply(updateAttempt({ ...attempt, cancellation: event.source }), 'CANCELLED',
        attempt.status === 'dispatched' ? [{ kind: 'cancel', attemptId: attempt.attemptId, source: event.source }] : []);
    case 'attempt.outcome': {
      if (!attempt) return reject('INVALID_PROPOSAL');
      if (attempt.status === 'terminal') {
        const recorded = state.events.some(item => item.kind === 'attempt.outcome' &&
          item.dispatchCertainty === event.dispatchCertainty && sameRecord(item.outcome, event.outcome) &&
          sameRecord(item.observations, event.observations) && sameRecord(item.findings, event.findings));
        if (recorded) return duplicate;
        if (sameRecord(attempt.outcome, event.outcome) && attempt.dispatchCertainty === event.dispatchCertainty) {
          return (event.observations?.length || event.findings?.length) ? apply({}, 'OBSERVATIONS_RECEIVED', [], 'attempt.late_outcome') : duplicate;
        }
      }
      const resolved = resolveOutcome(attempt, event);
      if (!resolved) return apply({}, 'IDENTITY_CONFLICT', [], 'attempt.outcome_discrepancy');
      if ((attempt.status === 'reserved' && resolved.dispatchCertainty !== 'not_sent') ||
          (resolved.dispatchCertainty === 'not_sent' && resolved.outcome.effect !== 'none')) {
        return reject('INVALID_PROPOSAL');
      }
      /** @type {Partial<Operation>} */
      const patch = updateAttempt({
        ...attempt, ...resolved, status: 'terminal', endedAt: event.receivedAt,
      });
      if (state.waiting?.kind === 'technical' && state.waiting.reason.attemptId === attempt.attemptId) {
        patch.waiting = { kind: 'technical', reason: {
          ...state.waiting.reason, dispatchCertainty: resolved.dispatchCertainty, effect: resolved.outcome.effect,
        } };
      }
      return apply(patch, event.outcome.diagnostics[0]?.code ?? event.outcome.terminal.toUpperCase(), [],
      attempt.status === 'terminal' || state.status === 'cancelled' || attempt.generation !== state.generation
        ? 'attempt.late_outcome' : 'attempt.outcome');
    }
    case 'controller.responded': {
      if (event.decision.operationId !== state.operationId) return reject('INVALID_PROPOSAL');
      const known = state.events.find(item => item.kind === 'controller.responded' &&
        item.decision.decisionId === event.decision.decisionId);
      if (known?.kind === 'controller.responded') {
        return sameRecord(known.decision, event.decision) ? duplicate : reject('IDENTITY_CONFLICT');
      }
      if (state.status !== 'active') return reject(state.status === 'cancelled' ? 'CANCELLED' : 'INVALID_PROPOSAL');
      return apply({}, 'ACCEPTED');
    }
    case 'action.cancelled': {
      if (state.events.some(item => item.kind === 'action.cancelled' && item.actionId === event.actionId)) return duplicate;
      const current = state.attempts.find(item => item.actionId === event.actionId && item.status !== 'terminal');
      if (!current || current.cancellation) return apply({}, 'CANCELLED');
      const attempts = state.attempts.map(item => item === current ? { ...item, cancellation: event.source } : item);
      return apply({ attempts }, 'CANCELLED', current.status === 'dispatched'
        ? [{ kind: 'cancel', attemptId: current.attemptId, source: event.source }] : []);
    }
    case 'action.rejected':
    case 'action.deferred':
      return apply({}, event.code);
    case 'operation.waiting':
      if (state.status !== 'active') return reject('INVALID_PROPOSAL');
      return apply({ status: 'waiting', waiting: event.waiting }, event.waiting.kind === 'question' ? 'USER_INPUT' : event.waiting.reason.code);
    case 'operation.continued':
      if (state.status !== 'waiting' && state.status !== 'finished') return reject('INVALID_PROPOSAL');
      return apply({
        ...resumeAuthority(event.trusted), status: 'active', waiting: undefined, generation: state.generation + 1,
        transcriptRefs: [...state.transcriptRefs, event.input.requestId],
      }, 'USER_INPUT');
    case 'operation.recovered':
      if (state.status !== 'active') return reject('INVALID_PROPOSAL');
      return apply({ ...resumeAuthority(event.trusted), generation: state.generation + 1 }, 'RECOVERED');
    case 'operation.finished':
      if (state.status !== 'active') return reject('INVALID_PROPOSAL');
      if (state.attempts.some(item => item.status !== 'terminal')) return reject('INVALID_PROPOSAL');
      return apply({ status: 'finished', assessment: event.assessment }, 'ASSESSMENT_RECORDED');
    case 'operation.cancelled': {
      if (state.status === 'cancelled') return duplicate;
      if (state.status === 'finished') return reject('INVALID_PROPOSAL');
      /** @type {Intent[]} */
      const intents = [];
      const attempts = state.attempts.map(item => {
        if (item.status === 'terminal' || item.cancellation) return item;
        if (item.status === 'dispatched') {
          intents.push({ kind: 'cancel', attemptId: item.attemptId, source: event.source });
        }
        return { ...item, cancellation: event.source };
      });
      return apply({ status: 'cancelled', cancellation: event.source, waiting: undefined, attempts }, 'CANCELLED', intents);
    }
  }
}

/** @param {ResumeAuthority | undefined} trusted */
function resumeAuthority(trusted) {
  return trusted ? { authorityRef: trusted.authorityRef, limits: { ...trusted.limits } } : {};
}
