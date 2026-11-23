import { admitFindings, checkAssessment, evidenceRefs } from '../core/finding.js';
import { bindAssessmentEvidence, bindFindingEvidence, scopedEvidenceAliases } from './evidence-identity.js';

/** @import {Event} from '../core/operation.js' */
/** @import {Observation} from '../core/observation.js' */
/** @import {ControllerPreflight, PreflightResult} from '../core/ports.js' */

/**
 * Optional technical snapshot check AFTER structural proposal registration.
 * It neither mutates the durable reference index nor decides admission.
 * The authoritative check still happens at the Operation journal boundary.
 * @param {{requestId:string,events:readonly Event[],observations:readonly Observation[],
 *   profileId:string,isActive:()=>boolean}} scope
 * @returns {ControllerPreflight}
 */
export function bindControllerPreflight({requestId, events, observations, profileId, isActive}) {
  const historical = evidenceRefs(requestId, events);
  /** @param {unknown} candidate @returns {PreflightResult} */
  return candidate => {
    if (!isActive()) return {kind:'unchecked',reason:'closed',advisory:true};
    try {
      // The registry calls this only with a decoded ControllerIntent.
      const value = /** @type {import('../core/contracts.js').Decision} */ (candidate);
      const assessment = value.finalAssessment;
      const requirements = assessment?.requirements ?? [];
      const count = (value.findings ?? []).reduce((sum, item) => sum + item.supports.length, 0) +
        value.additions.reduce((sum, item) => sum + item.contextRefs.length, 0) +
        (assessment?.observationRefs.length ?? 0) + (assessment?.findingRefs.length ?? 0) +
        requirements.reduce((sum,item)=>sum + item.observationRefs.length + item.findingRefs.length,0);
      // A large intent is still registered and may be admitted. Optional
      // preflight must not add an unbounded synchronous burden.
      if (count > 512 || (value.findings?.length ?? 0) > 128 || requirements.length > 128) {
        return {kind:'unchecked',reason:'budget',advisory:true};
      }
      /** @type {import('../core/finding.js').EvidenceRefs} */
      const refs = {
        observations:new Set(historical.observations),
        rawObservations:new Set(historical.rawObservations),
        findings:new Set(historical.findings),
        findingOutputs:new Set(historical.findingOutputs),
      };
      for (const item of observations) {
        refs.observations.add(item.ref);
        if (!item.summary) refs.rawObservations.add(item.ref);
      }
      const aliases = scopedEvidenceAliases(observations, [], refs);
      const findings = bindFindingEvidence(value.findings ?? [], aliases.resolve)
        .map(item => ({...item,author:profileId}));
      const assessmentValue = assessment && {
        ...bindAssessmentEvidence(assessment,aliases.resolve),author:profileId,
      };
      const actions = value.additions.map(item => ({
        ...item,contextRefs:item.contextRefs.map(aliases.resolve),
      }));
      /** @type {Extract<PreflightResult,{kind:'checked'}>['issues']} */
      const issues = [];
      const findingError = admitFindings(refs, findings, '$.findings', profileId);
      if (findingError) issues.push({
        path:findingError.path,expected:findingError.expected,availability:'not_in_snapshot',
      });
      if (!findingError && assessmentValue) {
        const assessmentError = checkAssessment(refs,assessmentValue,profileId);
        if (assessmentError) issues.push({
          path:assessmentError.path,expected:assessmentError.expected,availability:'not_in_snapshot',
        });
      }
      if (!issues.length) for (const [i,action] of actions.entries()) {
        const j = action.contextRefs.findIndex(ref=>!refs.observations.has(ref) && !refs.findings.has(ref));
        if (j >= 0) {
          issues.push({path:'$.additions['+i+'].contextRefs['+j+']',
            expected:'a visible observation or finding reference',availability:'not_in_snapshot'});
          break;
        }
      }
      if (aliases.ambiguous) issues.push({
        path:'$',expected:'explicit internal references for ambiguous evidence names',availability:'ambiguous',
      });
      return {kind:'checked',issues,omittedCount:0,advisory:true};
    } catch {
      // A failed advisory check cannot revoke a registered proposal.
      return {kind:'unchecked',reason:'unavailable',advisory:true};
    }
  };
}
