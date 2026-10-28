// Read-only optimization proposals. These do not grant authority to skip
// verification/review, edit files or switch models outside an active preset.
export function assessReviewImpact({ changedPaths = [], knownDependencies = [], dependencyClosureComplete = false, contractChanged = false, securitySensitive = false, findings = [] } = {}) {
  const reasons = [];
  if (!dependencyClosureComplete) reasons.push('dependency_closure_unknown');
  if (contractChanged) reasons.push('contract_changed');
  if (securitySensitive) reasons.push('security_sensitive');
  if (!Array.isArray(changedPaths) || !changedPaths.length) reasons.push('no_changed_paths');
  if ((findings ?? []).some(f => f.taskImpact === 'blocking' && f.lifecycle !== 'resolved')) reasons.push('blocking_finding');
  return { mode: reasons.length ? 'full_review' : 'targeted_candidate', reasons,
    impactPaths: [...new Set([...(changedPaths ?? []), ...(knownDependencies ?? [])])],
    // Even targeted candidates retain the independent review and full suite.
    mandatoryVerification: true, independentReviewRequired: true };
}
export function assessRetryProgress(before, after) {
  if (!before || !after) return { state: 'unknown', reasons: ['missing_snapshot'] };
  const fields = ['checkoutFingerprint', 'evidenceRevision', 'findingRevision', 'blockerCode', 'strategyId', 'observationDigest'];
  const changes = fields.filter(key => before[key] != null && after[key] != null && before[key] !== after[key]);
  if (changes.length) return { state: 'progress_observed', reasons: changes };
  if (fields.some(key => before[key] == null || after[key] == null)) return { state: 'unknown', reasons: ['incomplete_provenance'] };
  return { state: 'no_material_progress', reasons: ['identical_state_and_strategy'] };
}
export function suggestRoleEscalation({ role, failureCode, allowed = [], currentModel, progress, samples = 0 } = {}) {
  const infrastructure = /PROVIDER_|RATE_LIMIT|ENVIRONMENT|TOOL_UNAVAILABLE|INFRA|CANCELLED/.test(String(failureCode ?? ''));
  if (infrastructure) return { action: 'diagnose_provider', reason: 'infrastructure_not_model_quality' };
  if (progress?.state !== 'no_material_progress') return { action: 'preserve_assignment', reason: 'no_repeated_stagnation_evidence' };
  if (samples < 10) return { action: 'review_manually', reason: 'insufficient_quality_baseline' };
  const fallback = allowed.find(x => x.model && x.model !== currentModel && x.role === role);
  return fallback ? { action: 'suggest_escalation', role, model: fallback.model, reason: 'policy_allowed_model_with_quality_baseline' }
    : { action: 'preserve_assignment', reason: 'no_authorized_alternative' };
}
