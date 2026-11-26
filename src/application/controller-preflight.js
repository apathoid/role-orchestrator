import { admitFindings, checkAssessment, evidenceRefs, findingRef } from '../core/finding.js';
import { bindAssessmentEvidence, bindFindingEvidence, reservedEvidenceRef } from './evidence-identity.js';

/** @import {Event} from '../core/operation.js' */
/** @import {Observation} from '../core/observation.js' */
/** @import {ControllerPreflight, PreflightResult} from '../core/ports.js' */

/**
 * Advisory technical reference check, called only AFTER the pending proposal
 * has been registered. No durable mutation, admission, or secondary journal.
 *
 * Historical refs are indexed once. Live accepted observations are indexed
 * monotonically; each new item is read at most once regardless of the number
 * of same-turn corrections. For each Intent we project just the referenced
 * identities into a temporary index so admitFindings cannot mutate shared
 * state. Nothing is indexed by relevance, content, effect or tool type.
 *
 * @param {{requestId:string,attachments?:readonly {ref:string}[],events:readonly Event[],observations:readonly Observation[],
 *   profileId:string,isActive:()=>boolean}} scope
 * @returns {ControllerPreflight}
 */
export function bindControllerPreflight({requestId, attachments = [], events, observations, profileId, isActive}) {
  const historical = evidenceRefs(requestId, events);
  // Attachment identities are context selections, not evidence references.
  const attachmentRefs = new Set(attachments.map(item=>item.ref));
  const live = new Set();
  const rawLive = new Set();
  const aliases = new Map();
  let indexed = 0;
  /** @param {unknown} candidate @returns {PreflightResult} */
  return candidate => {
    if (!isActive()) return {kind:'unchecked',reason:'closed',advisory:true};
    try {
      const value = /** @type {import('../core/contracts.js').Decision} */ (candidate);
      const assessment = value.finalAssessment;
      const requirements = assessment?.requirements ?? [];
      const count = (value.findings ?? []).reduce((sum, item) => sum + item.supports.length + (item.supersedes ? 1 : 0), 0) +
        value.additions.reduce((sum, item) => sum + item.contextRefs.length, 0) +
        (assessment?.observationRefs.length ?? 0) + (assessment?.findingRefs.length ?? 0) +
        requirements.reduce((sum,item)=>sum + item.observationRefs.length + item.findingRefs.length,0);
      // The advisory check cannot impose an independent model-action quota.
      if (count > 512 || (value.findings?.length ?? 0) > 128 ||
          value.additions.length > 128 || requirements.length > 128) {
        return {kind:'unchecked',reason:'budget',advisory:true};
      }
      // The original accepted array remains the owner of each observation.
      // Index only the suffix not visited by an earlier preflight.
      for (const end = observations.length; indexed < end; indexed++) {
        const item = observations[indexed];
        live.add(item.ref);
        if (!item.summary) rawLive.add(item.ref);
        if (item.providerRef !== undefined && !reservedEvidenceRef(item.providerRef)) {
          // Match evidenceAliases' last-accepted-wins provider-local lookup.
          aliases.set(item.providerRef,item.ref);
        }
      }
      let ambiguous = false;
      /** @param {string} ref */
      const resolve = ref => {
        const mapped = aliases.get(ref) ?? ref;
        if (mapped !== ref && (historical.observations.has(ref) || historical.findings.has(ref) || live.has(ref))) {
          ambiguous = true;
        }
        return mapped;
      };
      const findings = bindFindingEvidence(value.findings ?? [], resolve)
        .map(item => ({...item,author:profileId}));
      const assessmentValue = assessment && {
        ...bindAssessmentEvidence(assessment,resolve),author:profileId,
      };
      const actions = value.additions.map(item => ({
        ...item,contextRefs:item.contextRefs.map(resolve),
      }));
      // admitFindings mutates its passed sets. Materialize only the canonical
      // refs that this Intent can possibly read or collide with.
      const relevant = new Set();
      for (const item of findings) {
        relevant.add(findingRef(item));
        for (const ref of item.supports) relevant.add(ref);
        if (item.supersedes) relevant.add(item.supersedes);
      }
      if (assessmentValue) for (const entry of [assessmentValue, ...assessmentValue.requirements]) {
        for (const ref of entry.observationRefs) relevant.add(ref);
        for (const ref of entry.findingRefs) relevant.add(ref);
      }
      for (const action of actions) for (const ref of action.contextRefs) relevant.add(ref);
      /** @type {import('../core/finding.js').EvidenceRefs} */
      const refs = {observations:new Set(),rawObservations:new Set(),findings:new Set(),findingOutputs:new Set()};
      for (const ref of relevant) {
        if (historical.observations.has(ref) || live.has(ref)) refs.observations.add(ref);
        if (historical.rawObservations.has(ref) || rawLive.has(ref)) refs.rawObservations.add(ref);
        if (historical.findings.has(ref)) refs.findings.add(ref);
        if (historical.findingOutputs.has(ref)) refs.findingOutputs.add(ref);
      }
      /** @type {Extract<PreflightResult,{kind:'checked'}>['issues']} */
      const issues = [];
      const findingError = admitFindings(refs,findings,'$.findings',profileId);
      if (findingError) issues.push({
        path:findingError.path,expected:findingError.expected,
      });
      if (!findingError && assessmentValue) {
        const assessmentError = checkAssessment(refs,assessmentValue,profileId);
        if (assessmentError) issues.push({
          path:assessmentError.path,expected:assessmentError.expected,
        });
      }
      // Shared admission validators report addressable errors (including
      // identity/uniqueness), not an availability classification. Only the
      // explicit reference check here can supply that additional fact.
      if (!issues.length) for (const [i,action] of actions.entries()) {
        const j = action.contextRefs.findIndex(ref=>!refs.observations.has(ref) && !refs.findings.has(ref) && !attachmentRefs.has(ref));
        if (j >= 0) {
          issues.push({path:'$.additions['+i+'].contextRefs['+j+']',
            expected:'a visible observation, finding or attachment reference',availability:'not_in_snapshot'});
          break;
        }
      }
      if (ambiguous) issues.push({
        path:'$',expected:'explicit internal references for ambiguous evidence names',availability:'ambiguous',
      });
      return {kind:'checked',issues,omittedCount:0,advisory:true};
    } catch {
      // Any failure loses only optional feedback, not the registered proposal.
      return {kind:'unchecked',reason:'unavailable',advisory:true};
    }
  };
}
