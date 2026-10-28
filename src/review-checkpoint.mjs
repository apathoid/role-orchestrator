import { projectReviewEvidence } from './evidence/graph.mjs';
// Durable Review Work checkpoints. v3 persists the immutable operation/work
// plan; v2 remains valid only against a freshly established identical plan.
import { assessReviewUnits } from './review-work-plan.mjs';
import { reviewOperationCompatible } from './review-continuity.mjs';
import { validateReviewQualityState, initialReviewRisks, newReviewQualityState } from './review-quality.mjs';
import { assessReviewWorkload } from './execution/workload.mjs';

// A retry may contain fresh source evidence even when the work Unit remains
// unchecked. Preserve previous raw observations and the host-owned attempt
// provenance; never replace an earlier risk assessment with "latest wins".
export function mergeReviewAttempt(existing, incoming, { batchId, unitIds } = {}) {
  const oldOutput=existing?.output ?? {};
  if (!Array.isArray(oldOutput.issues) || !Array.isArray(incoming?.issues) ||
      typeof batchId !== 'string' || !Array.isArray(unitIds))
    throw new Error('review_retry_invalid_report');
  const tag=(issue, sourceBatchId, sourceUnitIds) => {
    const { reportedBatchId:_claimedBatch, reportedUnitIds:_claimedUnits, ...clean }=issue;
    return { ...clean, reportedBatchId:sourceBatchId, reportedUnitIds:[...sourceUnitIds] };
  };
  const existingIssues=oldOutput.issues.map(issue=>tag(issue,
    typeof issue.reportedBatchId==='string' ? issue.reportedBatchId : existing.batchId,
    Array.isArray(issue.reportedUnitIds) ? issue.reportedUnitIds : existing.unitIds));
  const incomingIssues=incoming.issues.map(issue=>tag(issue,batchId,unitIds));
  // Deduplicate an identical report replay, but keep different source evidence
  // for the same underlying defect. The original batch attribution is retained.
  const seen=new Set(), issues=[];
  for (const item of [...existingIssues,...incomingIssues]) {
    const {reportedBatchId,reportedUnitIds,...claim}=item;
    const key=JSON.stringify(Object.keys(claim).sort().map(k=>[k,claim[k]]));
    if (seen.has(key)) continue;
    seen.add(key);issues.push(item);
  }
  if (issues.length>60) throw new Error('review_retry_finding_limit_exceeded');
  const unique=(a,bound,key) => {
    const rows=[], seen=new Set();
    for (const value of [...(oldOutput[a]??[]),...(incoming[a]??[])]) {
      const id=JSON.stringify(value);
      if (!seen.has(id)) {seen.add(id);rows.push(value);}
    }
    if (rows.length>bound) throw new Error(`review_retry_${key}_limit_exceeded`);
    return rows;
  };
  const riskAssessments=unique('riskAssessments',32,'risk_assessment');
  const openQuestions=unique('openQuestions',8,'open_question');
  const ranking={escalate:4,fix:3,unknown:2,pass:1};
  const verdict=(ranking[oldOutput.verdict]??0)>=(ranking[incoming.verdict]??0)?oldOutput.verdict:incoming.verdict;
  const oldSummary=String(oldOutput.summary??'');
  const newSummary=String(incoming.summary??'');
  const summary=[oldSummary,newSummary].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i).join(' | ').slice(0,600);
  return {...incoming,verdict,summary,issues,
    riskAssessments,openQuestions};
}

export function validateReviewCheckpoint(previous, { scopeKey, plan, repoKey }) {
  const v3 = [3, 4].includes(previous?.version);
  if (![2, 3, 4].includes(previous?.version) || previous.status !== 'in_progress' ||
      previous.scopeKey !== scopeKey || previous.planKey !== plan.planKey || previous.repoKey !== repoKey ||
      (v3 && (!reviewOperationCompatible(previous, { repoRoot: previous.operation?.repoRoot }) ||
        previous.operation.workPlan.planKey !== plan.planKey)) ||
      !Array.isArray(previous.records) || !Array.isArray(previous.reports) ||
      previous.records.length > plan.units.length ||
      previous.reports.length > plan.units.length + (previous.version === 4 ? 4 : 0)) return null;
  const hard = previous.operation?.reviewHardLimits;
  if (hard !== undefined && (hard === null || typeof hard !== 'object' || Array.isArray(hard) ||
      Object.keys(hard).some(key => !['maxOperationInvocations','maxOperationElapsedMs',
        'maxOperationInputTokens','maxOperationOutputTokens'].includes(key) ||
        (hard[key] !== null && (!Number.isSafeInteger(hard[key]) || hard[key] < 1))))) return null;
  const qualityState = previous.version === 4 ? validateReviewQualityState(previous.qualityState, plan) : null;
  if (previous.version === 4 && (!qualityState || !['observe','enforce'].includes(previous.operation?.qualityPolicy?.mode) ||
      previous.reports.filter(r=>r?.kind==='risk_follow_up').length > qualityState.followUps)) return null;
  if (previous.version === 4) {
    // A damaged or selectively truncated checkpoint cannot erase mandatory
    // structural risk questions and thereby turn incomplete work into PASS.
    const changedPaths = plan.units.filter(u=>u.kind==='file-group').flatMap(u=>u.paths.map(path=>({path})));
    const workload = assessReviewWorkload({available:true,status:plan.scope.status,paths:changedPaths},
      previous.operation.classification,previous.operation.contract);
    const expected = initialReviewRisks(plan,workload,previous.operation.contract);
    if (qualityState.coverageOverflow < newReviewQualityState(plan,workload,previous.operation.contract).coverageOverflow) return null;
    if (expected.some(risk => !qualityState.risks.some(row=>row.id===risk.id &&
        row.category===risk.category && row.impact===risk.impact &&
        JSON.stringify(row.relatedUnitIds)===JSON.stringify(risk.relatedUnitIds) &&
        JSON.stringify(row.sourceRefs)===JSON.stringify(risk.sourceRefs)))) return null;
    // Resolved risks must be backed by the checkpointed raw model assessment;
    // the mutable quality projection cannot self-certify a conclusion.
    for (const risk of qualityState.risks) if (risk.status==='resolved') {
      const witnessed=previous.reports.some(report => (report.output?.riskAssessments ?? []).some(row =>
        row.riskId===risk.id && row.status==='investigated' && row.outcome===risk.outcome &&
        String(row.evidence ?? '').trim().slice(0,1000)===risk.evidence));
      if (!witnessed) return null;
    }
  }
  const units = new Map(plan.units.map((unit) => [unit.id, unit]));
  const unique = new Set();
  for (const row of previous.records) {
    const unit = units.get(row?.id);
    if (!unit || unique.has(row.id) || row.status !== 'checked' ||
        typeof row.evidence !== 'string' || row.evidence.trim().length < 16 || row.evidence.length > 1800) return null;
    const assessment = assessReviewUnits([unit], { outputFormat: 'structured', output: { coverage: [row] } });
    if (assessment.problems.length || assessment.records[0].status !== 'checked') return null;
    unique.add(row.id);
  }
  if ([...unique].some((id) => units.get(id).dependencies.some((dependency) => !unique.has(dependency)))) return null;
  const ids = new Set();
  for (const report of previous.reports) {
    if (!report || typeof report.batchId !== 'string' || !/^[a-zA-Z0-9._-]{1,90}$/.test(report.batchId) ||
        ids.has(report.batchId) || report.outputFormat !== 'structured' ||
        !Array.isArray(report.unitIds) || (report.unitIds.length === 0 && (previous.version !== 4 || report.kind !== 'risk_follow_up')) || report.unitIds.length > 8 ||
        report.unitIds.some((id) => !units.has(id)) ||
        !report.output || !['pass', 'fix', 'escalate', 'unknown'].includes(report.output.verdict) ||
        typeof report.output.summary !== 'string' || !Array.isArray(report.output.issues) ||
        report.output.issues.length > 60 || report.output.issues.some(issue=>
          !issue || typeof issue!=='object' || Array.isArray(issue) ||
          (issue.reportedBatchId !== undefined && (!/^[a-zA-Z0-9._-]{1,90}$/.test(issue.reportedBatchId) ||
            !Array.isArray(issue.reportedUnitIds) ||
            JSON.stringify(issue.reportedUnitIds)!==JSON.stringify(report.unitIds))))) return null;
    ids.add(report.batchId);
  }
  const reportIds = new Set(previous.reports.flatMap((r) => r.unitIds));
  if ([...unique].some((id) => !reportIds.has(id))) return null;
  return { qualityState, records: previous.records.map((r) => ({ ...r })),
    reports: previous.reports.map((r) => ({ outputFormat: 'structured', output: r.output,
      unitIds: r.unitIds, batchId: r.batchId, kind: r.kind ?? 'unit' })) };
}

export function makeReviewCheckpoint({ scopeKey, plan, repoKey, status, records, reports, operation = null, qualityState = null }) {
  if (reports.some((report) => !Array.isArray(report.output?.issues) || report.output.issues.length > 60))
    throw new Error('review_checkpoint_finding_limit_exceeded');
  const checkedQuality = qualityState ? validateReviewQualityState(qualityState, plan) : null;
  if (qualityState && !checkedQuality) throw new Error('review_quality_checkpoint_invalid');
  const snapshot = { version: operation ? (qualityState ? 4 : 3) : 2,
    ...(checkedQuality ? { qualityState: checkedQuality } : {}), scopeKey, planKey: plan.planKey, repoKey, status,
    unitsTotal: plan.totalUnits, records: records.map((r) => ({ id: r.id, status: 'checked',
      evidence: r.evidence.slice(0, 1800), reviewedPaths: r.reviewedPaths ?? [], fileEvidence: r.fileEvidence ?? [] })),
    reports: reports.map((r) => ({ batchId: r.batchId, unitIds: r.unitIds,
      ...(r.kind === 'risk_follow_up' ? { kind: 'risk_follow_up' } : {}),
      outputFormat: 'structured', output: {
        verdict: r.output?.verdict ?? 'unknown', summary: String(r.output?.summary ?? '').slice(0, 600),
        ...(checkedQuality ? { riskAssessments: (r.output?.riskAssessments ?? []).slice(0,32).map(row => ({
          riskId:String(row.riskId ?? '').slice(0,64), status:row.status, outcome:row.outcome,
          evidence:String(row.evidence ?? '').slice(0,1000), sourceRefs:(row.sourceRefs ?? []).slice(0,16) })),
          openQuestions:(r.output?.openQuestions ?? []).slice(0,8).map(row=>({
            statement:String(row.statement ?? '').slice(0,500), materiality:row.materiality,
            sourceRefs:(row.sourceRefs ?? []).slice(0,16), relatedUnitIds:(row.relatedUnitIds ?? []).slice(0,16) })) } : {}),
        issues: (r.output?.issues ?? []).map((issue) => ({
          severity: issue.severity,
          path: issue.path === null ? null : String(issue.path ?? '').slice(0, 120),
          message: String(issue.message ?? '').slice(0, 240),
          suggestedFix: issue.suggestedFix === null ? null : String(issue.suggestedFix ?? '').slice(0, 240),
          ...(issue.origin ? { origin: issue.origin } : {}),
          ...(issue.taskRelation ? { taskRelation: issue.taskRelation } : {}),
          ...(issue.remediationScope ? { remediationScope: issue.remediationScope } : {}),
          ...(issue.evidence ? { evidence: String(issue.evidence).slice(0, 180) } : {}),
          ...(issue.contractId ? { contractId: String(issue.contractId).slice(0, 100) } : {}),
          ...(issue.reproductionKey ? { reproductionKey: String(issue.reproductionKey).slice(0, 100) } : {}),
          ...(issue.failureMode ? { failureMode: String(issue.failureMode).slice(0, 180) } : {}),
          ...(issue.affectedBehavior ? { affectedBehavior: String(issue.affectedBehavior).slice(0, 180) } : {}),
          ...(typeof issue.reportedBatchId==='string' && /^[a-zA-Z0-9._-]{1,90}$/.test(issue.reportedBatchId)
            ? {reportedBatchId:issue.reportedBatchId,reportedUnitIds:Array.isArray(issue.reportedUnitIds)
              ? issue.reportedUnitIds.filter(x=>typeof x==='string').slice(0,8) : []} : {}),
        })),
      } })),
    ...(operation ? { operation: structuredClone(operation),
      evidenceProjection: (() => { const graph = projectReviewEvidence({ plan, records, reports, sourceKey: repoKey });
        return { version: graph.version, sourceKey: repoKey, satisfied: graph.obligations.filter(x => x.status === 'satisfied').map(x => x.id),
          reportCount: graph.evidence.length, persistence: 'derived_from_checkpoint' }; })() } : {}),
  };
  // Unlike optional telemetry, durable evidence cannot be silently truncated.
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 1_500_000)
    throw new Error('review_checkpoint_size_limit_exceeded');
  return snapshot;
}
