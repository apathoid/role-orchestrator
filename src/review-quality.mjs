// Review-only quality projection. Work Plan and checkpointed model reports own
// their own authority; risks are obligations, never verification evidence.
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validPath = value => typeof value === 'string' && value.length <= 400 &&
  !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..') && !/^[a-z]:/i.test(value) && value.length > 0;
const relatedFileUnits = (fileUnits, category) => {
  const match=category==='async_consistency' ? /(?:socket|stream|concurren|worker|thunk|queue|reconnect|lifecycle|abort|transaction)/i :
    category==='trust_boundary' ? /(?:auth|security|permissions?|crypto|payments?|migrations?|access-control)/i : null;
  const selected=match ? fileUnits.filter(u=>u.paths.some(p=>match.test(p))) : fileUnits;
  return selected.length ? selected : fileUnits;
};
const MAX_RISKS = 32;
const IMPACT = ['normal', 'high', 'critical'];
const STATUS = ['investigated', 'blocked'];
const OUTCOMES = ['issue_found', 'no_issue_supported', 'uncertain'];

// Deterministic source-anchored *questions*, not guesses that a defect exists.
// Path-name heuristics may identify candidate work, never certify its result.
export function initialReviewRisks(plan, workload = {}, contract = {}) {
  const fileUnits = (plan?.units ?? []).filter(unit => unit.kind === 'file-group');
  const flags = workload.riskFlags ?? {};
  const rules = [
    { flag: 'concurrency', category: 'async_consistency', question: 'Could event order, stale asynchronous responses, or reconnect cause loss of newer state?', impact: 'high' },
    { flag: 'crossSubsystem', category: 'integration_contract', question: 'Do other callers, views or lifecycle paths observe incompatible behavior after this change?', impact: 'high' },
    { flag: 'security', category: 'trust_boundary', question: 'Do changed input, authorization or integrity boundaries admit an unintended path?', impact: 'critical' },
  ];
  const results = [];
  for (const rule of rules) {
    if (!flags[rule.flag] || !fileUnits.length) continue;
    // Cross-subsystem contracts involve the whole changed scope. Others use
    // candidate paths; refusing an empty set avoids invented obligations.
    const selected = relatedFileUnits(fileUnits,rule.category);
    const sourceRefs = [...new Set(selected.slice(0,64).flatMap(u => u.paths))].slice(0, 64);
    const relatedUnitIds = selected.slice(0,64).map(u => u.id);
    const id = `RR-${digest([rule.category, plan.planKey, relatedUnitIds])}`;
    results.push({ id, category: rule.category, question: rule.question, source: 'structural',
      sourceRefs, relatedUnitIds, impact: rule.impact, status: 'open', outcome: null,
      evidence: '', evidenceLevel: null, findingRefs: [], resolutionReason: null });
  }
  return results.slice(0, MAX_RISKS);
}

export function validateReviewQualityState(state, plan, { policyVersion = 1 } = {}) {
  if (!state || state.version !== 1 || state.policyVersion !== policyVersion || !Array.isArray(state.risks) ||
      state.risks.length > MAX_RISKS || !Number.isSafeInteger(state.followUps) || state.followUps < 0 || state.followUps > 16 || !Number.isSafeInteger(state.coverageOverflow ?? 0) ||
      (state.coverageOverflow ?? 0) < 0 || (state.coverageOverflow ?? 0) > 1024)
    return null;
  const unitIds = new Set((plan?.units ?? []).map(u => u.id));
  const ids = new Set();
  const risks = [];
  for (const row of state.risks) {
    if (!row || typeof row.id !== 'string' || !/^RR-[a-f0-9]{20}$/.test(row.id) || ids.has(row.id) ||
        !['structural', 'reviewer_observation'].includes(row.source) ||
        !['open','resolved','rejected','blocked','disputed'].includes(row.status) ||
        !IMPACT.includes(row.impact) || !['async_consistency','integration_contract','trust_boundary','reviewer_hypothesis'].includes(row.category) ||
        typeof row.question !== 'string' || !row.question.trim() || row.question.length > 500 ||
        !Array.isArray(row.relatedUnitIds) || !row.relatedUnitIds.length || row.relatedUnitIds.length > 64 ||
        row.relatedUnitIds.some(id => !unitIds.has(id)) ||
        !Array.isArray(row.sourceRefs) || !row.sourceRefs.length || row.sourceRefs.length > 64 ||
        row.sourceRefs.some(path => !validPath(path)) ||
        !['', 'issue_found','no_issue_supported','uncertain'].includes(row.outcome ?? '') ||
        typeof row.evidence !== 'string' || row.evidence.length > 1000 ||
        !Array.isArray(row.findingRefs) || row.findingRefs.length > 20 ||
        row.findingRefs.some(x => typeof x !== 'string' || x.length > 140)) return null;
    // A model must never be able to claim trusted evidence levels.
    if (row.evidenceLevel !== null && row.evidenceLevel !== 'model_reported') return null;
    if (row.status === 'rejected' || (row.status === 'resolved' &&
        (row.evidenceLevel !== 'model_reported' || row.evidence.trim().length < 32 ||
          !['issue_found','no_issue_supported'].includes(row.outcome)))) return null;
    ids.add(row.id);
    risks.push(structuredClone(row));
  }
  return { version: 1, policyVersion, risks, followUps: state.followUps, coverageOverflow:state.coverageOverflow ?? 0 };
}

export function newReviewQualityState(plan, workload, contract) {
  const risks = initialReviewRisks(plan, workload, contract);
  const fileUnits=(plan?.units ?? []).filter(u=>u.kind==='file-group');
  // Large linked scopes cannot be silently certified using truncated anchors.
  const coverageOverflow = risks.reduce((sum,r)=>sum+Math.max(0,
    relatedFileUnits(fileUnits,r.category).length-64),0);
  return { version: 1, policyVersion: 1, risks, followUps: 0, coverageOverflow };
}

export function risksForReviewBatch(state, units, { followUp = false } = {}) {
  const ids = new Set(units.map(u => u.id));
  return (state?.risks ?? []).filter(risk => ['open','blocked','disputed'].includes(risk.status) &&
    (followUp || risk.impact !== 'normal' || risk.relatedUnitIds.some(id => ids.has(id))));
}

export function applyReviewRiskReport(state, report, { plan, assignedRisks = [], unitIds = [], completedUnitIds = [] } = {}) {
  const next = structuredClone(state);
  const assigned = new Map(assignedRisks.map(risk => [risk.id, risk]));
  const allUnitIds = new Set((plan?.units ?? []).map(u => u.id));
  const activeUnitIds = new Set(unitIds);
  const completed = new Set(completedUnitIds);
  const sourcePaths = new Set((plan?.units ?? []).flatMap(u => u.paths ?? []));
  const issues = Array.isArray(report?.issues) ? report.issues : [];
  const problems = [];
  const seen = new Set();
  for (const row of Array.isArray(report?.riskAssessments) ? report.riskAssessments : []) {
    const original = assigned.get(row?.riskId);
    if (!original || seen.has(row.riskId)) {
      const previous=next.risks.find(r=>r.id===row?.riskId && r.status==='resolved');
      const anchored=previous && Array.isArray(row?.sourceRefs) && row.sourceRefs.some(p=>
        validPath(p) && (previous.sourceRefs.includes(p) || sourcePaths.has(p)));
      // A source-anchored contradictory observation changes the state to
      // disputed. It is NOT decided by 'latest model wins'. A follow-up from
      // another ordinary model cannot certify the conflict away.
      const foundIssue=row.outcome==='issue_found' && issues.some(issue=>
        Array.isArray(row.sourceRefs) && row.sourceRefs.includes(issue?.path) &&
        typeof issue.message==='string' && issue.message.trim().length>=20);
      if (anchored && OUTCOMES.includes(row.outcome) && row.outcome!==previous.outcome &&
          bounded(row.evidence,1000).length>=32 && (row.outcome!=='issue_found' || foundIssue)) {
        previous.status='disputed'; previous.resolutionReason='conflicting_model_observations';
        problems.push(`${row.riskId}: contradictory_evidence`);
      } else problems.push('unassigned_or_duplicate_risk');
      continue;
    }
    seen.add(row.riskId);
    const evidence = bounded(row.evidence, 1000);
    const anchors = Array.isArray(row.sourceRefs) ? row.sourceRefs : [];
    const anchored = anchors.length > 0 && anchors.length <= 16 && anchors.every(validPath) &&
      anchors.some(p => original.sourceRefs.includes(p) || sourcePaths.has(p));
    const valid = original.relatedUnitIds.every(id => completed.has(id)) &&
      STATUS.includes(row.status) && OUTCOMES.includes(row.outcome) &&
      evidence.length >= 32 && anchored &&
      (row.status !== 'blocked' || row.outcome === 'uncertain') &&
      (row.status !== 'investigated' || row.outcome !== 'uncertain');
    if (!valid) { problems.push(`${row.riskId}: unsupported_risk_assessment`); continue; }
    const found = row.outcome === 'issue_found' && issues.some(issue =>
      validPath(issue?.path) && anchors.includes(issue.path) &&
      typeof issue.message === 'string' && issue.message.trim().length >= 20);
    if (row.outcome === 'issue_found' && !found) { problems.push(`${row.riskId}: missing_finding`); continue; }
    const target = next.risks.find(x => x.id === row.riskId);
    if (target.status === 'disputed') {
      problems.push(`${row.riskId}: requires_independent_conflict_resolution`); continue;
    }
    // Never elevate model-authored text above model_reported provenance.
    target.status = row.status === 'blocked' ? 'blocked' : 'resolved';
    target.outcome = row.outcome;
    target.evidence = evidence;
    target.evidenceLevel = 'model_reported';
    target.findingRefs = row.outcome === 'issue_found' ? issues.filter(issue => anchors.includes(issue?.path))
      .slice(0, 20).map(issue => digest([issue.path, issue.message])) : [];
    target.resolutionReason = null;
  }
  const seenQuestions = new Set(next.risks.map(x => `${x.question.toLowerCase()}|${x.sourceRefs[0]}`));
  for (const row of Array.isArray(report?.openQuestions) ? report.openQuestions : []) {
    const question = bounded(row?.statement, 500);
    const anchor = (Array.isArray(row?.sourceRefs) ? row.sourceRefs : []).filter(validPath).slice(0, 16);
    const related = (Array.isArray(row?.relatedUnitIds) ? row.relatedUnitIds : [])
      .filter(id => allUnitIds.has(id) && (activeUnitIds.has(id) || unitIds.length === 0)).slice(0, 16);
    if (question.length < 24 || !anchor.length || !related.length ||
        !anchor.some(p => sourcePaths.has(p)) || !['normal','high','critical'].includes(row.materiality)) {
      problems.push('invalid_open_question'); continue;
    }
    const key = `${question.toLowerCase()}|${anchor[0]}`;
    if (seenQuestions.has(key)) continue;
    seenQuestions.add(key);
    const id = `RR-${digest(['reviewer_hypothesis', key, plan.planKey])}`;
    if (next.risks.some(risk => risk.id === id)) continue;
    if (next.risks.length >= MAX_RISKS) {
      next.coverageOverflow=Math.min(1024,(next.coverageOverflow ?? 0)+1);
      problems.push('risk_capacity_exhausted'); continue;
    }
    next.risks.push({ id, category: 'reviewer_hypothesis', question, source: 'reviewer_observation',
      sourceRefs: anchor.filter(p=>sourcePaths.has(p)), relatedUnitIds: related, impact: row.materiality, status: 'open', outcome: null,
      evidence: '', evidenceLevel: null, findingRefs: [], resolutionReason: null });
  }
  return { state: next, problems, assessed: seen.size };
}

export function assessReviewQuality(state, { mode = 'off', coverageComplete = false } = {}) {
  const risks = state?.risks ?? [];
  const open = risks.filter(r => r.impact !== 'normal' && ['open','blocked','disputed'].includes(r.status));
  const contradictions = risks.filter(r => r.status === 'disputed');
  const enforced = mode === 'enforce';
  const satisfied = !enforced || (open.length === 0 && (state?.coverageOverflow ?? 0) === 0);
  return { status: !enforced ? 'not_enforced' : satisfied ? 'satisfied' : 'incomplete',
    coverageOverflow:state?.coverageOverflow ?? 0, total: risks.length, assessed: risks.filter(r => ['resolved','rejected'].includes(r.status)).length,
    open: open.length, contradictions: contradictions.length, preserved:risks.filter(r=>r.source==='reviewer_observation').length,
    followUps: state?.followUps ?? 0, openRiskIds: open.map(r => r.id),
    recommendedAction: !enforced || (!open.length && !(state?.coverageOverflow ?? 0)) ? 'finish' :
      (state?.coverageOverflow ?? 0) ? 'pause_incomplete' : !coverageComplete ? 'continue_review' : 'targeted_follow_up',
    reasons:[...open.map(r => `${r.id}:${r.status}`),
      ...((state?.coverageOverflow ?? 0) ? ['RISK_SCOPE_OVERFLOW'] : [])] };
}
