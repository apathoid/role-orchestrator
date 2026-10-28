// Read-only, allowlisted projection of the *authoritative* workflow result.
// Telemetry does not interpret model prose or substitute for P2 verification.
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
const verdicts = new Set(['pass', 'fix', 'escalate', 'unknown']);
const statuses = new Set(['PASS', 'TEST_FAILED', 'TOOL_UNAVAILABLE', 'ENVIRONMENT_ERROR', 'INFRA_FAILURE', 'UNVERIFIED']);
const dispositions = new Set(['PASS','CODE_FAILURE','ENVIRONMENT_ERROR','TOOL_UNAVAILABLE','UNVERIFIED','INFRA_FAILURE','TEST_FAILED']);
const outcomeKinds = new Set(['success', 'findings', 'incomplete', 'blocked', 'read_only', 'failed', 'unknown']);
const successful = new Set(['applied','no_change','review_passed']);
const findings = new Set(['review_findings','completed_with_findings','completed_with_unresolved_review']);
const incomplete = new Set(['review_incomplete','review_unresolved','review_interrupted','implementation_incomplete','completed_with_unverified_checks']);
const blocked = new Set(['implementation_blocked','needs_user_decision']);
const safeStatus = s => typeof s === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(s) ? s : 'unknown';
const project = value => {
  const v=value&&typeof value==='object'?value:{};
  return {
    category: outcomeKinds.has(v.category)?v.category:'unknown',
    routeMode: ['investigate','review','change','plan'].includes(v.routeMode)?v.routeMode:null,
    reviewVerdict: verdicts.has(v.reviewVerdict)?v.reviewVerdict:null,
    reviewFindings:count(v.reviewFindings),
    reviewFindingsRaw:count(v.reviewFindingsRaw),reviewFindingsUnique:count(v.reviewFindingsUnique),
    reviewFindingsPotentialDuplicates:count(v.reviewFindingsPotentialDuplicates), reviewFindingsReported:count(v.reviewFindingsReported),
    reviewFindingsReconciled:count(v.reviewFindingsReconciled),
    reviewObservations:count(v.reviewObservations), reviewCanonicalFindings:count(v.reviewCanonicalFindings),
    reviewConfirmedMerges:count(v.reviewConfirmedMerges), reviewPotentialDuplicatePairs:count(v.reviewPotentialDuplicatePairs),
    reviewScopeStatus:['resolved','partial','unresolved'].includes(v.reviewScopeStatus)?v.reviewScopeStatus:null,
    reviewScopeReason:typeof v.reviewScopeReason==='string' && /^[a-z_]{1,80}$/.test(v.reviewScopeReason)?v.reviewScopeReason:null,
    reviewFilesTotal:count(v.reviewFilesTotal),reviewFilesVerified:count(v.reviewFilesVerified),
    reviewFilesCoverageSource:['model_reported','tool_observed'].includes(v.reviewFilesCoverageSource)?v.reviewFilesCoverageSource:null,
    reviewVerificationSource:['workflow','observed','unverified'].includes(v.reviewVerificationSource)?v.reviewVerificationSource:null,
    reviewObservedExecuteCalls:count(v.reviewObservedExecuteCalls),
    reviewChecked:count(v.reviewChecked),reviewTotal:count(v.reviewTotal),
    reviewComplete:typeof v.reviewComplete==='boolean'?v.reviewComplete:null,
    verificationDisposition:dispositions.has(v.verificationDisposition)?v.verificationDisposition:null,
    verificationChecks:count(v.verificationChecks),verificationPassed:count(v.verificationPassed),
    verificationFailed:count(v.verificationFailed),verificationUnavailable:count(v.verificationUnavailable),
    completedStages:count(v.completedStages),totalStages:count(v.totalStages),
    implementationComplete:typeof v.implementationComplete==='boolean'?v.implementationComplete:null,
    acceptanceVerified:count(v.acceptanceVerified),acceptanceTotal:count(v.acceptanceTotal),
    qualityVerified:count(v.qualityVerified),qualityTotal:count(v.qualityTotal),
  };
};
export const normalizeExecutionOutcome = project;
export function summarizeExecutionOutcome(result) {
  if (!result || typeof result !== 'object') return project(null);
  const status=safeStatus(result.status);
  const category = successful.has(status) ? 'success' : findings.has(status) ? 'findings' :
    incomplete.has(status) ? 'incomplete' : blocked.has(status) ? 'blocked' :
    ['investigated','planned'].includes(status) ? 'read_only' : status === 'failed' ? 'failed' : 'unknown';
  const checks=Array.isArray(result.verification)?result.verification: null;
  const coverage=result.reviewCoverage;
  const stages=result.implementationCoverage;
  const acceptance=result.acceptanceCoverage;
  const quality=result.qualityAssessment;
  const validation=(result.review?.verdict ?? result.finalValidation?.verdict);
  const reviewVerdict = coverage && coverage.complete !== true && validation === 'pass' ? 'unknown' : validation;
  return project({
    category,routeMode:result.route?.policy?.mode ?? result.route?.classification?.mode,
    reviewVerdict,
    reviewFindings:Array.isArray(result.review?.issues)?result.review.issues.length:null,
    reviewFindingsRaw:result.reviewFindingsReport?.raw,
    reviewFindingsUnique:result.reviewFindingsReport?.unique,
    reviewFindingsPotentialDuplicates:result.reviewFindingsReport?.potentialDuplicates,
    reviewFindingsReconciled:result.reviewFindingsReport?.reconciledDuplicates,
    reviewFindingsReported:result.reviewFindingsReport?.reported,
    reviewObservations:result.reviewFindingsReport?.raw,
    reviewCanonicalFindings:result.reviewFindingsReport?.canonicalFindings ?? result.reviewFindingsReport?.unique,
    reviewConfirmedMerges:result.reviewFindingsReport?.confirmedMerges ?? result.reviewFindingsReport?.reconciledDuplicates,
    reviewPotentialDuplicatePairs:result.reviewFindingsReport?.potentialDuplicatePairs ?? result.reviewFindingsReport?.potentialDuplicates,
    reviewScopeStatus:coverage?.scope?.status,
    reviewScopeReason:coverage?.scope?.reason,
    reviewFilesTotal:coverage?.files?.total,reviewFilesVerified:coverage?.files?.verified,
    reviewFilesCoverageSource:coverage?'model_reported':null,
    reviewVerificationSource:result.verificationEvidence?.source,
    reviewObservedExecuteCalls:result.verificationEvidence?.observedExecuteCalls,
    reviewChecked:coverage?.checked,reviewTotal:coverage?.total,reviewComplete:coverage?.complete,
    verificationDisposition:result.verificationDisposition,
    verificationChecks:checks?.length,
    verificationPassed:checks?.filter(c=>c?.status==='PASS').length,
    verificationFailed:checks?.filter(c=>['TEST_FAILED','CODE_FAILURE'].includes(c?.status)).length,
    verificationUnavailable:checks?.filter(c=>['TOOL_UNAVAILABLE','ENVIRONMENT_ERROR','INFRA_FAILURE'].includes(c?.status)).length,
    completedStages:stages?.completedStages?.length,totalStages:stages?.totalStages,
    // A review plan is coverage, not an implementation plan.
    implementationComplete:(result.route?.policy?.mode ?? result.route?.classification?.mode)==='change'
      ? (stages?.complete ?? (typeof result.planCompleted==='boolean' ? result.planCompleted : null)) : null,
    acceptanceVerified:acceptance?.results?.filter(c=>c?.status==='verified').length,
    acceptanceTotal:acceptance?.results?.length,
    qualityVerified:quality?.results?.filter(c=>['verified','verified_current_run'].includes(c?.state)).length,
    qualityTotal:quality?.results?.length,
  });
}
// Do not infer task continuity from similar prompts, repo paths or historical
// discussion. Only a task ID already selected by the authoritative task registry
// can establish cross-run identity. Independent runs remain their own groups.
export function executionGroupId({ runId, taskId, reviewOperationId }={}) {
  const review = typeof reviewOperationId === 'string' && /^[a-f0-9-]{20,64}$/i.test(reviewOperationId) ? reviewOperationId : null;
  const id = typeof taskId==='string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(taskId)?taskId:null;
  return id ? `task:${id}` : review ? `review:${review}` : `run:${runId}`;
}
