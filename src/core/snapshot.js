import { admitFindings, eventFindings, evidenceRefs, findingRef, findings, recordObservationRefs } from './finding.js';
import { action, assessment, decision, followup, outcome, reasonCode, request } from './contracts.js';
import { arrayOf, count, decode, id, invalid, measurement, oneOf, optional, record, text } from './decode.js';
import { contextItem } from './observation.js';
import { resolveOutcome, sameRecord } from './operation.js';

/** @import {Decoder, FieldError} from './decode.js' */
/** @import {Attempt, Event, Operation} from './operation.js' */
/** @import {Admission} from './action-graph.js' */

/** @typedef {{kind: 'accepted', value: Operation} |
 *   {kind: 'corrupt', reason: FieldError} | {kind: 'unsupported_version', version: number}} SnapshotResult
 */

/**
 * @template {Record<string, Decoder<unknown>>} Variants
 * @param {string} discriminator @param {Variants} variants
 * @returns {Decoder<ReturnType<Variants[keyof Variants]>>}
 */
function tagged(discriminator, variants) {
  return (input, path) => {
    if (!input || typeof input !== 'object') return invalid(path, 'an object');
    const kind = Object.getOwnPropertyDescriptor(input, discriminator)?.value;
    if (typeof kind !== 'string' || !Object.hasOwn(variants, kind)) {
      return invalid(path + '.' + discriminator, Object.keys(variants).join(' | '));
    }
    return /** @type {ReturnType<Variants[keyof Variants]>} */ (variants[kind](input, path));
  };
}

const version = oneOf(1);
const cancellation = oneOf('client', 'user', 'shutdown', 'superseded', 'provider');
const certainty = oneOf('sent', 'not_sent', 'unknown');
const status = oneOf('active', 'waiting', 'finished', 'cancelled');
const effect = oneOf('none', 'possible', 'confirmed', 'unknown');
const reason = record({
  code: reasonCode, operationId: id, actionId: optional(id), attemptId: optional(id),
  dispatchCertainty: optional(certainty), effect: optional(effect),
  profileId: optional(id), reasoningLevel: optional(id), availableLevels: optional(arrayOf(id)),
  reasoningCause: optional(id),
});
const waiting = tagged('kind', {
  question: record({ kind: oneOf('question'), questionId: id, question: id }),
  technical: record({ kind: oneOf('technical'), reason }),
});
/** @type {Decoder<number>} */
const limit = (input, path) => count(input, path) || invalid(path, 'a positive safe integer');
const limits = record({ maxInvocations: limit, maxConcurrentInvocations: limit });
const trusted = record({ authorityRef: id, configurationRef: id, limits });
const reasoning = tagged('mode', {
  native: record({mode: oneOf('native')}),
  selectable: record({mode: oneOf('selectable'), level: id, nativeValue: id,
    selectionSource: oneOf('model','default')}),
});
const route = record({ configurationRef: id, profileId: id, providerId: id, model: id,
  idempotencyKey: optional(id), requestHash: optional(id), reasoning: optional(reasoning) });
const attemptFields = {
  attemptId: id, actionId: id, generation: count, reservedAt: measurement, reasoningDecisionId: optional(id),
  dispatchedAt: optional(measurement), route: optional(route), dispatchCertainty: certainty, cancellation: optional(cancellation),
};
/** @type {Decoder<Attempt>} */
const attempt = tagged('status', {
  reserved: record({ ...attemptFields, status: oneOf('reserved') }),
  dispatched: record({ ...attemptFields, status: oneOf('dispatched') }),
  terminal: record({ ...attemptFields, status: oneOf('terminal'), outcome, endedAt: measurement }),
});
/** @type {Decoder<Admission>} */
const admission = tagged('kind', {
  accepted: record({ kind: oneOf('accepted'), action }),
  duplicate: record({ kind: oneOf('duplicate'), actionId: id }),
  rejected: record({
    kind: oneOf('rejected'), actionId: id, code: reasonCode, dependencyId: optional(id),
    reason: oneOf('identity', 'unknown_dependency', 'unavailable_dependency', 'cyclic_dependency'),
  }),
});
const eventFields = { eventId: id, operationId: id, receivedAt: measurement };
/** @type {Decoder<Event>} */
const event = tagged('kind', {
  'attempt.reserved': record({ ...eventFields, kind: oneOf('attempt.reserved'), attemptId: id, actionId: id, reasoningDecisionId: optional(id) }),
  'attempt.dispatched': record({ ...eventFields, kind: oneOf('attempt.dispatched'), attemptId: id, route: optional(route) }),
  'attempt.cancel_requested': record({
    ...eventFields, kind: oneOf('attempt.cancel_requested'), attemptId: id, source: cancellation,
  }),
  'attempt.outcome': record({
    ...eventFields, kind: oneOf('attempt.outcome'), outcome, dispatchCertainty: certainty,
    observations: optional(arrayOf(contextItem)), findings: optional(findings), late: optional((input, path) => input === true ? /** @type {const} */ (true) : invalid(path, 'true')),
  }),
  'controller.responded': record({
    ...eventFields, kind: oneOf('controller.responded'), decision, attemptId: optional(id), admissions: optional(arrayOf(admission)),
  }),
  'action.rejected': record({
    ...eventFields, kind: oneOf('action.rejected'), actionId: id, code: reasonCode, resource: optional(id),
  }),
  'action.deferred': record({
    ...eventFields, kind: oneOf('action.deferred'), actionId: id, code: reasonCode, resource: optional(id),
  }),
  'action.cancelled': record({ ...eventFields, kind: oneOf('action.cancelled'), actionId: id, source: cancellation }),
  'operation.waiting': record({ ...eventFields, kind: oneOf('operation.waiting'), waiting }),
  'operation.continued': record({ ...eventFields, kind: oneOf('operation.continued'), input: followup, trusted: optional(trusted) }),
  'operation.recovered': record({ ...eventFields, kind: oneOf('operation.recovered'), trusted }),
  'operation.finished': record({ ...eventFields, kind: oneOf('operation.finished'), assessment }),
  'operation.cancelled': record({ ...eventFields, kind: oneOf('operation.cancelled'), source: cancellation }),
});
const operation = record({
  schemaVersion: version, operationId: id, request, generation: count, revision: count,
  authorityRef: id, transcriptRefs: arrayOf(id), acceptedAt: optional(measurement),
  limits,
  attempts: arrayOf(attempt), events: arrayOf(event), assessment: optional(assessment),
  waiting: optional(waiting), cancellation: optional(cancellation), status,
});

/** @type {Decoder<Operation>} */
function snapshot(input, path) {
  const value = operation(input, path);
  if (value.revision !== value.events.length) invalid(path + '.revision', 'the committed event count');
  if ((value.status === 'waiting') !== Boolean(value.waiting)) invalid(path + '.waiting', 'a reason only for waiting');
  const final = value.events.findLast(item => item.kind === 'operation.finished');
  if ((value.status === 'finished' && !final) || !sameRecord(value.assessment, final?.assessment)) {
    invalid(path + '.assessment', 'the most recent recorded assessment, if any');
  }
  const attempts = new Set();
  for (const [index, item] of value.attempts.entries()) {
    const at = path + '.attempts[' + index + ']';
    if (attempts.has(item.attemptId)) invalid(at + '.attemptId', 'a unique attempt id');
    attempts.add(item.attemptId);
    if (item.status === 'terminal' && item.outcome.attemptId !== item.attemptId) {
      invalid(at + '.outcome.attemptId', 'the enclosing attempt id');
    }
    if (item.dispatchCertainty === 'not_sent' && item.outcome && item.outcome.effect !== 'none') {
      invalid(at + '.outcome.effect', 'none for an unsent attempt');
    }
  }
  const events = new Set();
  const refs = evidenceRefs(value.request.requestId);
  /** @type {Map<string, string | undefined>} */
  const identities = new Map([[value.request.requestId, undefined]]);
  const observations = new Set();

  /** @param {string} ref @param {string} field @param {string} [owner] */
  function register(ref, field, owner) {
    if (identities.has(ref) && (owner === undefined || identities.get(ref) !== owner)) {
      invalid(field, 'an unambiguous context reference in this operation');
    }
    identities.set(ref, owner);
  }
  /** @type {Map<string, Attempt>} */
  const ledger = new Map();
  let generation = 0;
  /** @type {{decisionId: string, reasoningLevel?: string} | undefined} */
  let pendingController;
  const decisions = new Map(value.events.flatMap(item => item.kind === 'controller.responded'
    ? [[item.decision.decisionId, item.decision]] : []));
  // Only admitted Actions are the historical authority for a worker route.
  // Never infer its logical request from the current catalog's native mapping.
  const acceptedActions = new Map(value.events.flatMap(item => item.kind === 'controller.responded'
    ? (item.admissions ?? []).flatMap(admission => admission.kind === 'accepted'
      ? [[admission.action.actionId, admission.action]] : []) : []));
  for (const [index, item] of value.events.entries()) {
    const at = path + '.events[' + index + ']';
    if (item.operationId !== value.operationId) invalid(at + '.operationId', 'the enclosing operation id');
    if (events.has(item.eventId)) invalid(at + '.eventId', 'a unique event id');
    events.add(item.eventId);
    if (item.kind === 'attempt.outcome') {
      for (const [index, pointer] of item.outcome.outputRefs.entries()) {
        register(pointer.ref, at + '.outcome.outputRefs[' + index + '].ref', item.outcome.attemptId);
      }
      for (const [index, observation] of (item.observations ?? []).entries()) {
        const refPath = at + '.observations[' + index + '].ref';
        if (observations.has(observation.ref)) invalid(refPath, 'a unique observation reference in this operation');
        observations.add(observation.ref);
        register(observation.ref, refPath, item.outcome.attemptId);
        const summary = observation.summary;
        if (!summary) {
          refs.rawObservations.add(observation.ref);
          continue;
        }
        const field = at + '.observations[' + index + '].summary';
        if (item.dispatchCertainty === 'not_sent' ||
            ledger.get(item.outcome.attemptId)?.route?.profileId !== summary.author) {
          invalid(field + '.author', 'the reporting model on the recorded route');
        }
        if (summary.coveredObservationRefs.some(ref => !refs.rawObservations.has(ref))) {
          invalid(field + '.coveredObservationRefs', 'earlier raw observations in this operation');
        }
      }
      recordObservationRefs(refs, item);
    }
    const batch = eventFindings(item);
    if (item.kind === 'operation.continued' || item.kind === 'operation.recovered') {
      generation++;
      // A crash/reopen is not a user decision to supersede an unconsumed choice.
      if (item.kind === 'operation.continued') pendingController = undefined;
    }
    if (item.kind === 'controller.responded') {
      pendingController = item.decision.nextController
        ? {decisionId: item.decision.decisionId, reasoningLevel: item.decision.nextController.reasoningLevel}
        : undefined;
    }
    const attemptId = item.kind === 'attempt.outcome' ? item.outcome.attemptId : 'attemptId' in item ? item.attemptId : undefined;
    if (batch?.length) {
      const worker = item.kind === 'attempt.outcome';
      const field = at + (worker ? '.findings' : '.decision.findings');
      const reporting = attemptId ? ledger.get(attemptId) : undefined;
      if (!reporting?.route || (worker && item.dispatchCertainty === 'not_sent') ||
          (!worker && (reporting.actionId !== attemptId || reporting.outcome?.terminal !== 'completed'))) {
        invalid(field, 'a reporting model on the recorded route');
      }
      const error = admitFindings(refs, batch, field, reporting.route.profileId);
      if (error) invalid(error.path, error.expected);
      for (const [index, finding] of batch.entries()) {
        register(findingRef(finding), field + '[' + index + '].findingId');
      }
    }
    if (item.kind === 'operation.continued') register(item.input.requestId, at + '.input.requestId');
    if (item.kind === 'operation.waiting' && item.waiting.kind === 'question') {
      register(item.waiting.questionId, at + '.waiting.questionId');
    }
    if (item.kind === 'controller.responded') register('decision:' + item.decision.decisionId, at + '.decision.decisionId');
    if (item.kind === 'operation.finished') register('assessment:' + item.eventId, at + '.eventId');
    if (item.kind !== 'attempt.outcome') recordObservationRefs(refs, item);
    if (!attemptId) continue;
    if (!attempts.has(attemptId)) invalid(at + '.attemptId', 'an attempt in this snapshot');
    const prior = ledger.get(attemptId);
    if (item.kind === 'attempt.reserved') {
      if (prior) invalid(at + '.attemptId', 'a single reservation per attempt');
      if (item.actionId === item.attemptId) {
        if (item.reasoningDecisionId !== pendingController?.decisionId) {
          invalid(at + '.reasoningDecisionId', 'the pending Controller selection, if any');
        }
        pendingController = undefined;
      } else if (item.reasoningDecisionId !== undefined) {
        invalid(at + '.reasoningDecisionId', 'a Controller reservation only');
      }
      ledger.set(attemptId, {
        attemptId, actionId: item.actionId, generation, reservedAt: item.receivedAt,
        reasoningDecisionId: item.reasoningDecisionId,
        status: 'reserved', dispatchCertainty: 'not_sent',
      });
    } else {
      if (!prior) invalid(at + '.attemptId', 'a preceding reservation');
      if (item.kind === 'attempt.dispatched') {
        if (prior.status !== 'reserved') invalid(at + '.kind', 'a dispatch of a reserved attempt');
        const routeReasoning = item.route?.reasoning;
        if (!routeReasoning && prior.actionId !== attemptId &&
            acceptedActions.get(prior.actionId)?.reasoningLevel) {
          invalid(at + '.route.reasoning', 'recorded reasoning for an explicitly selected worker level');
        }
        if (!routeReasoning && prior.actionId === attemptId && prior.reasoningDecisionId &&
            decisions.get(prior.reasoningDecisionId)?.nextController?.reasoningLevel) {
          invalid(at + '.route.reasoning', 'recorded reasoning for an explicitly selected Controller level');
        }
        if (routeReasoning) {
          if (prior.actionId === attemptId) {
            const selected = prior.reasoningDecisionId ? decisions.get(prior.reasoningDecisionId)?.nextController : undefined;
            if (routeReasoning.mode === 'selectable' &&
                (routeReasoning.selectionSource === 'model') !== Boolean(selected?.reasoningLevel)) {
              invalid(at + '.route.reasoning.selectionSource', 'the recorded Controller preference or default');
            }
            if (routeReasoning.mode === 'selectable' && selected?.reasoningLevel &&
                selected.reasoningLevel !== routeReasoning.level) {
              invalid(at + '.route.reasoning.level', 'the Controller decision requested level');
            }
          } else {
            const requested = acceptedActions.get(prior.actionId);
            if (!requested) invalid(at + '.route.reasoning', 'a previously admitted worker action');
            if (requested.reasoningLevel) {
              if (routeReasoning.mode !== 'selectable' || routeReasoning.level !== requested.reasoningLevel) {
                invalid(at + '.route.reasoning.level', 'the admitted worker action level');
              }
              if (routeReasoning.selectionSource !== 'model') {
                invalid(at + '.route.reasoning.selectionSource', 'model selection for the explicit worker level');
              }
            } else if (routeReasoning.mode === 'selectable' && routeReasoning.selectionSource !== 'default') {
              invalid(at + '.route.reasoning.selectionSource', 'the worker profile default');
            }
          }
        }
        ledger.set(attemptId, {
          ...prior, status: 'dispatched', dispatchCertainty: 'unknown', dispatchedAt: item.receivedAt, route: item.route,
        });
      } else if (item.kind === 'attempt.outcome') {
        const resolved = resolveOutcome(prior, item);
        if (!resolved) continue;
        if ((prior.status === 'reserved' && resolved.dispatchCertainty !== 'not_sent') ||
            (resolved.dispatchCertainty === 'not_sent' && resolved.outcome.effect !== 'none')) {
          invalid(at + '.dispatchCertainty', 'a dispatch certainty consistent with the recorded attempt');
        }
        ledger.set(attemptId, {
          ...prior, ...resolved, status: 'terminal', endedAt: item.receivedAt,
        });
      }
    }
  }
  for (const [index, item] of value.attempts.entries()) {
    const at = path + '.attempts[' + index + ']';
    const recorded = ledger.get(item.attemptId);
    if (!recorded) invalid(at + '.attemptId', 'a recorded reservation');
    for (const key of /** @type {const} */ ([
      'actionId', 'generation', 'reservedAt', 'reasoningDecisionId', 'status', 'dispatchCertainty', 'dispatchedAt', 'route', 'outcome', 'endedAt',
    ])) {
      if (!sameRecord(item[key], recorded[key])) invalid(at + '.' + key, 'a value consistent with the attempt history');
    }
  }
  return value;
}

export class SnapshotFormatError extends Error {
  /** @param {FieldError} reason */
  constructor(reason) {
    super(reason.path + ' must be ' + reason.expected);
    this.reason = reason;
  }
}

/** @param {Operation} value */
export function encodeSnapshot(value) {
  const checked = decode(snapshot, value);
  if (checked.kind === 'rejected') throw new SnapshotFormatError(checked.reason);
  return JSON.stringify(checked.value);
}

/** @param {string} serialized @returns {SnapshotResult} */
export function decodeSnapshot(serialized) {
  /** @type {unknown} */
  let input;
  try {
    input = JSON.parse(serialized);
  } catch {
    return { kind: 'corrupt', reason: { code: 'INVALID_PROPOSAL', path: '$', expected: 'a JSON snapshot' } };
  }
  const major = input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input, 'schemaVersion')?.value;
  if (Number.isSafeInteger(major) && major > 0 && major !== 1) {
    return { kind: 'unsupported_version', version: major };
  }
  try {
    const checked = decode(snapshot, input);
    return checked.kind === 'accepted' ? checked : { kind: 'corrupt', reason: checked.reason };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { kind: 'corrupt', reason: { code: 'INVALID_PROPOSAL', path: '$', expected: 'a decodable snapshot' } };
  }
}
