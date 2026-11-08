import { arrayOf, id, optional, record, text } from './decode.js';

/** @import {Event} from './operation.js' */
/** @import {FieldError} from './decode.js' */

const finding = record({
  findingId: id, author: id, claim: id, subject: id,
  supports: arrayOf(id), uncertainties: arrayOf(text), supersedes: optional(id),
});

export const findings = arrayOf(finding);

/** @typedef {ReturnType<typeof finding>} Finding */
/** @typedef {{observations: Set<string>, findings: Set<string>, findingOutputs: Set<string>}} EvidenceRefs */
/** @typedef {Pick<Extract<Event, {kind: 'attempt.outcome'}>, 'kind' | 'outcome' | 'observations'>} OutcomeEvidence */

/** @param {Finding} item */
export const findingRef = item => 'finding:' + item.findingId;

/** @param {Event} event */
export function eventFindings(event) {
  if (event.kind === 'attempt.outcome') return event.findings;
  if (event.kind === 'controller.responded') return event.decision.findings;
}

/** @param {EvidenceRefs} refs @param {Event | OutcomeEvidence} event */
export function recordObservationRefs(refs, event) {
  if (event.kind === 'attempt.outcome') {
    for (const item of event.observations ?? []) refs.observations.add(item.ref);
    for (const item of event.outcome.outputRefs) {
      refs.observations.add(item.ref);
      if (item.kind === 'finding') refs.findingOutputs.add(item.ref);
    }
  } else if (event.kind === 'operation.continued') {
    refs.observations.add(event.input.requestId);
  } else if (event.kind === 'operation.waiting' && event.waiting.kind === 'question') {
    refs.observations.add(event.waiting.questionId);
  } else if (event.kind === 'controller.responded') {
    refs.observations.add('decision:' + event.decision.decisionId);
  } else if (event.kind === 'operation.finished') {
    refs.observations.add('assessment:' + event.eventId);
  }
}

/** @param {string} requestId @param {readonly Event[]} [events] @returns {EvidenceRefs} */
export function evidenceRefs(requestId, events = []) {
  /** @type {EvidenceRefs} */
  const refs = { observations: new Set([requestId]), findings: new Set(), findingOutputs: new Set() };
  for (const event of events) {
    recordObservationRefs(refs, event);
    for (const item of eventFindings(event) ?? []) refs.findings.add(findingRef(item));
  }
  return refs;
}

/**
 * Adds a whole batch to the temporary reference index only after all entries
 * are valid. Supports may cite earlier entries, so revisions cannot form cycles.
 * @param {EvidenceRefs} refs @param {readonly Finding[]} batch @param {string} path
 * @param {string} [author] @returns {FieldError | undefined}
 */
export function admitFindings(refs, batch, path, author) {
  const added = new Set();
  for (const [index, item] of batch.entries()) {
    const at = path + '[' + index + ']';
    /** @param {string} field @param {string} expected @returns {FieldError} */
    const error = (field, expected) => ({ code: 'INVALID_PROPOSAL', path: at + field, expected });
    if (author !== undefined && item.author !== author) return error('.author', 'the reporting model profile id');
    const ref = findingRef(item);
    if (refs.findings.has(ref) || refs.observations.has(ref) || added.has(ref)) {
      return error('.findingId', 'a new finding id in this operation');
    }
    /** @param {string} ref */
    const hasFinding = ref => refs.findings.has(ref) || added.has(ref);
    for (const [index, support] of item.supports.entries()) {
      if (!hasFinding(support) && !refs.observations.has(support)) {
        return error('.supports[' + index + ']', 'an available observation or earlier finding in this operation');
      }
    }
    if (item.supersedes && !hasFinding(item.supersedes)) {
      return error('.supersedes', 'an earlier finding reference in this operation');
    }
    added.add(ref);
  }
  for (const ref of added) refs.findings.add(ref);
}

/** @param {EvidenceRefs} refs @param {import('./contracts.js').Assessment} assessment */
export function checkAssessmentRefs(refs, assessment) {
  const items = [
    { value: assessment, path: '$.finalAssessment' },
    ...assessment.requirements.map((value, index) => ({ value, path: '$.finalAssessment.requirements[' + index + ']' })),
  ];
  for (const { value, path } of items) {
    const observation = value.observationRefs.findIndex(ref => !refs.observations.has(ref));
    const finding = value.findingRefs.findIndex(ref => !refs.findings.has(ref) && !refs.findingOutputs.has(ref));
    if (observation >= 0) return {
      code: /** @type {const} */ ('INVALID_PROPOSAL'),
      path: path + '.observationRefs[' + observation + ']', expected: 'an available observation in this operation',
    };
    if (finding >= 0) return {
      code: /** @type {const} */ ('INVALID_PROPOSAL'),
      path: path + '.findingRefs[' + finding + ']', expected: 'an available finding in this operation',
    };
  }
}
