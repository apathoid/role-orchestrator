import { createHash } from 'node:crypto';
import { attributeProviderOutputRefs } from '../core/observation.js';

/** @import {Assessment, Outcome} from '../core/contracts.js' */
/** @import {Finding} from '../core/finding.js' */
/** @import {Observation} from '../core/observation.js' */

/** @param {string} ref */
export const reservedEvidenceRef = ref =>
  /^(evidence|artifact|summary|decision|assessment|assessment-progress|finding|attempt-output|controller-output|attempt-status|question|host):/u.test(ref);

/** @param {string} operationId @param {string} attemptId @param {string} providerRef */
export function providerEvidenceRef(operationId, attemptId, providerRef) {
  return 'evidence:' + createHash('sha256').update(JSON.stringify([operationId, attemptId, providerRef])).digest('hex');
}

/** @param {readonly Observation[]} items @param {readonly Outcome['outputRefs'][number][]} [pointers] */
export function evidenceAliases(items, pointers = []) {
  const aliases = new Map([...pointers, ...items].flatMap(item =>
    item.providerRef === undefined || reservedEvidenceRef(item.providerRef) ? [] : [[item.providerRef, item.ref]]));
  return /** @param {string} ref */ ref => aliases.get(ref) ?? ref;
}

/**
 * A legacy context ref can coincide with a current provider-local name.
 * Require an explicit internal ref rather than choosing between the two.
 * @param {readonly Observation[]} items @param {readonly Outcome['outputRefs'][number][]} pointers
 * @param {import('../core/finding.js').EvidenceRefs} refs
 */
export function scopedEvidenceAliases(items, pointers, refs) {
  const bind = evidenceAliases(items, pointers);
  let ambiguous = false;
  return {
    /** @param {string} ref */
    resolve(ref) {
      const bound = bind(ref);
      if (bound !== ref && (refs.observations.has(ref) || refs.findings.has(ref))) ambiguous = true;
      return bound;
    },
    get ambiguous() { return ambiguous; },
  };
}

/** @param {readonly Finding[]} items @param {(ref: string) => string} resolve */
export const bindFindingEvidence = (items, resolve) => items.map(item => ({ ...item, supports: item.supports.map(resolve) }));

/** @param {Assessment} value @param {(ref: string) => string} resolve */
export function bindAssessmentEvidence(value, resolve) {
  return { ...value, observationRefs: value.observationRefs.map(resolve), findingRefs: value.findingRefs.map(resolve),
    requirements: value.requirements.map(item => ({ ...item, observationRefs: item.observationRefs.map(resolve),
      findingRefs: item.findingRefs.map(resolve) })) };
}

/**
 * A provider pointer can refer to an observation or capture on this attempt.
 * An output reported without an observation still gets an attempt-scoped ref.
 * @param {string} operationId @param {Outcome} outcome @param {readonly Observation[]} items
 */
export function bindOutcomeEvidence(operationId, outcome, items) {
  const resolve = evidenceAliases(items);
  const known = new Set(items.map(item => item.ref));
  const outputRefs = outcome.outputRefs.map(output => {
    const ref = resolve(output.ref);
    if (known.has(ref) && ref === output.ref) return { ...output, providerRef: undefined };
    return {
      ...output, providerRef: output.ref,
      ref: known.has(ref) ? ref : providerEvidenceRef(operationId, outcome.attemptId, output.ref),
    };
  });
  const resolveResult = evidenceAliases(items, outputRefs);
  return attributeProviderOutputRefs({
    ...outcome, outputRefs,
    diagnostics: outcome.diagnostics.map(item => ({ ...item, ref: item.ref === undefined ? undefined : resolveResult(item.ref) })),
  }, items);
}
