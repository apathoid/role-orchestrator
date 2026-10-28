// Explicit review continuation intent; unrelated chat turns never resume work.
// Continuation is session-bound and requires a validated persisted operation.
export function isReviewContinuationRequest(spec) {
  return spec && typeof spec==='object' && spec.operation === 'review' &&
    ['current_review','saved_review'].includes(spec.continuation?.mode);
}

export function reviewOperationCompatible(checkpoint, { repoRoot, sourceTask } = {}) {
  if (![3,4].includes(checkpoint?.version) || checkpoint.status !== 'in_progress') return false;
  const op = checkpoint.operation;
  return typeof op?.id === 'string' && /^[a-f0-9-]{20,64}$/i.test(op.id) &&
    typeof op.task === 'string' && op.task.trim().length >= 1 && op.task.length <= 8192 &&
    (!sourceTask || op.task === sourceTask) && op.repoRoot === repoRoot &&
    op.contract && typeof op.contract === 'object' && op.workPlan?.version === 1 &&
    op.workPlan.planKey === checkpoint.planKey && Array.isArray(op.workPlan.units) &&
    op.workPlan.units.length <= 1024 && op.workPlan.units.length > 0;
}

export function reviewScopeReconciliationRequest(text) {
  const match = typeof text === 'string' ? text.trim().match(/^\/review-reconcile\s+merge-parent\s*[:=]\s*(\d{1,2})$/i) : null;
  const parent = match ? Number(match[1]) : null;
  return parent !== null && parent >= 1 && parent <= 16 ? parent : null;
}

// Reuse only unchanged, independently evidenced file groups. Criteria cannot
// be reused when the full file dependency set can have changed. Missing or
// non-verifiable evidence always remains pending.
export function reconcileReviewUnits(previousPlan, nextPlan, previous) {
  const sig = (u) => JSON.stringify({ kind: u.kind, subsystem: u.subsystem, paths: u.paths, changes: u.changes });
  const oldUnits = new Map(previousPlan.units.map(u => [u.id, u]));
  const newBySig = new Map(nextPlan.units.filter(u => u.kind === 'file-group').map(u => [sig(u), u]));
  const priorRows = new Map((previous.records ?? []).map(r => [r.id, r]));
  const map = new Map();
  for (const [id, unit] of oldUnits) {
    if (unit.kind !== 'file-group' || !priorRows.has(id)) continue;
    const target = newBySig.get(sig(unit));
    if (target) map.set(id, target.id);
  }
  // Dependencies must still be validated in the new graph. A newly introduced
  // dependency invalidates reuse of the dependent unit.
  const valid = new Set(map.values());
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of nextPlan.units) if (valid.has(unit.id) && unit.dependencies.some(id => !valid.has(id))) {
      valid.delete(unit.id); changed = true;
    }
  }
  const reverse = new Map([...map].filter(([, next]) => valid.has(next)));
  const rows = [...reverse].map(([oldId, newId]) => ({ ...priorRows.get(oldId), id: newId }));
  // Scope-wide risk follow-ups have no unit IDs: [].every(...) would otherwise
  // incorrectly treat stale risk assessments as independently verified. They
  // require a fresh review after any scope reconciliation.
  const reports = (previous.reports ?? [])
    .filter(report => Array.isArray(report?.unitIds) && report.unitIds.length > 0 &&
      report.kind !== 'risk_follow_up' && report.unitIds.every(id => reverse.has(id)))
    .map(report => ({ ...report, unitIds: report.unitIds.map(id => reverse.get(id)) }));
  const reportIds = new Set(reports.flatMap(report => report.unitIds));
  return { records: rows.filter(r => reportIds.has(r.id)), reports,
    invalidated: previous.records.length - rows.filter(r => reportIds.has(r.id)).length };
}
