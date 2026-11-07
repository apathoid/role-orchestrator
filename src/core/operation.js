/** @import {Assessment, CancellationSource, Decision, Outcome, ReasonCode, Request} from './contracts.js' */
/** @import {DiagnosticEvent} from './diagnostics.js' */
/** @import {ContextItem} from './ports.js' */

/**
 * @typedef {'not_sent' | 'sent' | 'unknown'} DispatchCertainty
 * @typedef {{attemptId: string, actionId: string, generation: number, reservedAt: number,
 *   dispatchedAt?: number, dispatchCertainty: DispatchCertainty, cancellation?: CancellationSource}} AttemptRecord
 * @typedef {AttemptRecord & (
 *   {status: 'reserved' | 'dispatched', outcome?: never, endedAt?: never} |
 *   {status: 'terminal', outcome: Outcome, endedAt: number}
 * )} Attempt
 * @typedef {{maxInvocations: number, maxConcurrentInvocations: number}} Limits
 * @typedef {{code: ReasonCode, operationId: string, actionId?: string, attemptId?: string,
 *   dispatchCertainty?: DispatchCertainty, effect?: Outcome['effect']}} Reason
 * @typedef {{kind: 'question', questionId: string, question: string} | {kind: 'technical', reason: Reason}} Waiting
 * @typedef {{schemaVersion: 1, operationId: string, request: Request, generation: number, revision: number,
 *   authorityRef: string, transcriptRefs: readonly string[], limits: Limits, attempts: readonly Attempt[],
 *   events: readonly Event[], assessment?: Assessment, waiting?: Waiting,
 *   cancellation?: CancellationSource, status: 'active' | 'waiting' | 'finished' | 'cancelled'}} Operation
 *
 * @typedef {{eventId: string, receivedAt: number, operationId: string} & (
 *   {kind: 'attempt.reserved', actionId: string, attemptId: string} |
 *   {kind: 'attempt.dispatched', attemptId: string} |
 *   {kind: 'attempt.cancel_requested', attemptId: string, source: CancellationSource} |
 *   {kind: 'attempt.outcome', outcome: Outcome, dispatchCertainty: DispatchCertainty, observations?: readonly ContextItem[]} |
 *   {kind: 'controller.responded', decision: Decision} |
 *   {kind: 'operation.waiting', waiting: Waiting} |
 *   {kind: 'operation.continued', input: {requestId: string, text: string, questionId?: string}} |
 *   {kind: 'operation.finished', assessment: Assessment} |
 *   {kind: 'operation.cancelled', source: CancellationSource}
 * )} Event
 * @typedef {{kind: 'cancel', attemptId: string, source: CancellationSource}} Intent
 * @typedef {{kind: 'applied', state: Operation, diagnostic: DiagnosticEvent, intents: Intent[]} |
 *   {kind: 'duplicate', state: Operation} | {kind: 'rejected', state: Operation, reason: Reason}} Transition
 */

/** @param {string} operationId @param {Request} request @param {string} authorityRef @param {Limits} limits @returns {Operation} */
export function createOperation(operationId, request, authorityRef, limits) {
  for (const value of [limits.maxInvocations, limits.maxConcurrentInvocations]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Operation limits must be positive safe integers');
  }
  return {
    schemaVersion: 1, operationId, request, authorityRef, limits: { ...limits }, generation: 0, revision: 0,
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
    active, charged, remaining: state.limits.maxInvocations - charged,
    usage: { inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), cost: total('cost') },
  };
}

/** @param {Operation} state @param {Event} event @returns {Transition} */
export function applyEvent(state, event) {
  const attemptId = event.kind === 'attempt.outcome' ? event.outcome.attemptId
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
        reasonCode, operationId: state.operationId, attemptId, actionId, decisionId,
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
      if (state.status !== 'active') return reject(state.status === 'cancelled' ? 'CANCELLED' : 'INVALID_PROPOSAL');
      const resources = resourceSnapshot(state);
      if (resources.remaining <= 0 || resources.active >= state.limits.maxConcurrentInvocations) {
        return reject('RESOURCE_LIMIT');
      }
      return apply({ attempts: [...state.attempts, {
        attemptId: event.attemptId, actionId: event.actionId, generation: state.generation,
        reservedAt: event.receivedAt, status: 'reserved', dispatchCertainty: 'not_sent',
      }] }, 'RESERVED');
    }
    case 'attempt.dispatched':
      if (!attempt || attempt.status !== 'reserved') return reject('INVALID_PROPOSAL');
      if (state.status === 'cancelled' || attempt.cancellation) return reject('CANCELLED');
      if (state.status === 'finished') return reject('INVALID_PROPOSAL');
      return apply(updateAttempt({
        ...attempt, status: 'dispatched', dispatchedAt: event.receivedAt, dispatchCertainty: 'unknown',
      }), 'DISPATCH_STARTED');
    case 'attempt.cancel_requested':
      if (!attempt) return reject('INVALID_PROPOSAL');
      if (attempt.cancellation || attempt.status === 'terminal') return duplicate;
      return apply(updateAttempt({ ...attempt, cancellation: event.source }), 'CANCELLED',
        attempt.status === 'dispatched' ? [{ kind: 'cancel', attemptId: attempt.attemptId, source: event.source }] : []);
    case 'attempt.outcome': {
      if (!attempt) return reject('INVALID_PROPOSAL');
      if (attempt.status === 'terminal') {
        if (sameRecord(attempt.outcome, event.outcome) && attempt.dispatchCertainty === event.dispatchCertainty) {
          const recorded = state.events.find(item => item.kind === 'attempt.outcome' &&
            item.outcome.attemptId === event.outcome.attemptId && sameRecord(item.observations, event.observations));
          if (recorded || !event.observations?.length) return duplicate;
          return apply({}, 'OBSERVATIONS_RECEIVED', [], 'attempt.late_outcome');
        }
        const hasKnownUpdate = attempt.outcome.terminal === 'unknown' && event.outcome.terminal !== 'unknown' &&
          (attempt.dispatchCertainty === 'unknown' || attempt.dispatchCertainty === event.dispatchCertainty);
        if (!hasKnownUpdate) return apply({}, 'IDENTITY_CONFLICT', [], 'attempt.outcome_discrepancy');
      }
      if ((attempt.status === 'reserved' && event.dispatchCertainty !== 'not_sent') ||
          (event.dispatchCertainty === 'not_sent' && event.outcome.effect !== 'none')) {
        return reject('INVALID_PROPOSAL');
      }
      return apply(updateAttempt({
        ...attempt, status: 'terminal', endedAt: event.receivedAt, outcome: event.outcome,
        dispatchCertainty: event.dispatchCertainty,
      }), event.outcome.diagnostics[0]?.code ?? event.outcome.terminal.toUpperCase(), [],
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
    case 'operation.waiting':
      if (state.status !== 'active') return reject('INVALID_PROPOSAL');
      return apply({ status: 'waiting', waiting: event.waiting }, event.waiting.kind === 'question' ? 'USER_INPUT' : event.waiting.reason.code);
    case 'operation.continued':
      if (state.status !== 'waiting' && state.status !== 'finished') return reject('INVALID_PROPOSAL');
      return apply({
        status: 'active', waiting: undefined, generation: state.generation + 1,
        transcriptRefs: [...state.transcriptRefs, event.input.requestId],
      }, 'USER_INPUT');
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
