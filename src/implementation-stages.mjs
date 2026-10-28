import { createHash } from 'node:crypto';

// Keep the plan's text canonical across the Markdown and ACP presentations.
export function cleanPlanStep(value) {
  return String(value ?? '').replace(/^\s*(?:\d+[.)]\s+)+/u, '').trim();
}

export function normalizeImplementationPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || !Array.isArray(plan.acceptanceCriteria)) return null;
  const steps = plan.steps.map(cleanPlanStep);
  const acceptanceCriteria = plan.acceptanceCriteria.map((item) => String(item ?? '').trim());
  if (!steps.length || !acceptanceCriteria.length || steps.some((step) => !step) || acceptanceCriteria.some((criterion) => !criterion)) return null;
  if (plan.acceptanceChecks !== undefined && (!Array.isArray(plan.acceptanceChecks) ||
      plan.acceptanceChecks.length !== acceptanceCriteria.length ||
      plan.acceptanceChecks.some((entry, index) => entry?.id !== `A${index + 1}` || !Array.isArray(entry.commands)))) return null;
  if (plan.acceptanceReviews !== undefined && (!Array.isArray(plan.acceptanceReviews) ||
      plan.acceptanceReviews.length !== acceptanceCriteria.length ||
      plan.acceptanceReviews.some((entry, index) => entry?.id !== `A${index + 1}` ||
        !Array.isArray(entry.paths) || !entry.paths.length || entry.paths.length > 8 ||
        entry.paths.some((p) => typeof p !== 'string' || !p.trim() || p.length > 500 ||
          p.includes('\0') || p.startsWith('/') || p.split(/[\\/]/).includes('.git') ||
          p.split(/[\\/]/).includes('..'))))) return null;
  return { ...plan, steps, acceptanceCriteria };
}

export function planDigest(plan) {
  return createHash('sha256').update(JSON.stringify({
    goal: plan.goal, steps: plan.steps, acceptanceCriteria: plan.acceptanceCriteria,
    risks: plan.risks, expectedFiles: plan.expectedFiles, engineeringFrame: plan.engineeringFrame,
    acceptanceChecks: plan.acceptanceChecks,
    acceptanceReviews: plan.acceptanceReviews,
  })).digest('hex');
}

export function repositoryFingerprint(state) {
  return createHash('sha256').update(JSON.stringify({
    head: state.head,
    headRef: state.gitMetadata?.headRef,
    index: state.gitMetadata?.stagedHash,
    paths: Object.entries(state.workspaceHashes ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
}

// Saved Plan intent is interpreted by the Router in task-spec.mjs.
// No exported helpers here accept natural language as an authorization signal.

// Bound the number of model calls without dropping any steps. A stage owns a
// contiguous group of work, not a rigid list of files (cross-cutting edits are
// sometimes necessary). Acceptance criteria remain global and are checked at
// the integration gate rather than artificially multiplying stage calls.
export function buildImplementationStages(plan, { maxStages = 12, preferredStepsPerStage = 3 } = {}) {
  const steps = plan?.steps ?? [];
  if (!steps.length) return [];
  const groupSize = Math.max(preferredStepsPerStage, Math.ceil(steps.length / maxStages));
  const stages = [];
  for (let i = 0; i < steps.length; i += groupSize) {
    stages.push({
      id: `I${stages.length + 1}`,
      steps: steps.slice(i, i + groupSize).map((description, offset) => ({ id: `S${i + offset + 1}`, description })),
    });
  }
  return stages;
}

// A stage may deliver code changes, execute verification, or establish read-only
// evidence. These are completion modes, not a license to claim unrun checks.
// Evidence must be structured; global acceptance is still independently
// verified by the configured verifier and reviewer.
export function assessImplementationStage(stage, output, outputFormat, { changedPaths = [] } = {}) {
  const expected = new Set(stage.steps.map((step) => step.id));
  const rows = outputFormat === 'structured' && Array.isArray(output?.stepResults) ? output.stepResults : [];
  const seen = new Set();
  const issues = [];
  const records = [];
  for (const row of rows) {
    if (!expected.has(row?.id) || seen.has(row.id)) {
      issues.push(`Unexpected or duplicate implementation step: ${String(row?.id)}`);
      continue;
    }
    seen.add(row.id);
    const checks = Array.isArray(row.checks) ? row.checks : [];
    const failedChecks = checks.filter((check) => check?.outcome === 'failed');
    const unavailableChecks = checks.filter((check) => check?.outcome === 'unavailable');
    const validChecks = checks.every((check) => typeof check?.command === 'string' && check.command.trim() &&
      ['passed', 'failed', 'unavailable'].includes(check.outcome) && typeof check.evidence === 'string' && check.evidence.trim().length >= 16);
    const proof = row.proofKind ?? (row.status === 'already_satisfied' ? 'existing' : 'change');
    const credible = ['implemented', 'already_satisfied'].includes(row.status) &&
      typeof row.evidence === 'string' && row.evidence.trim().length >= 16 &&
      ['change', 'verification', 'analysis', 'existing'].includes(proof) && validChecks;
    records.push({ id: row.id, status: credible && !failedChecks.length && !unavailableChecks.length ? 'implemented' : 'unverified', evidence: String(row.evidence ?? '') });
    if (!credible) issues.push(`${row.id}: not reported as implemented with valid evidence`);
    for (const check of failedChecks) issues.push(`${row.id}: verification_failed (${check.command})`);
    for (const check of unavailableChecks) issues.push(`${row.id}: verification_unavailable (${check.command})`);
    if (!changedPaths.length && row.status === 'implemented') {
      // A no-change stage must explicitly prove it was non-mutating. The
      // presence of a generic evidence sentence is never sufficient.
      if (proof === 'change' || proof === 'existing') issues.push(`${row.id}: no file changes for a code-change claim`);
      if (proof === 'verification' && (!checks.length || !validChecks))
        issues.push(`${row.id}: verification evidence requires explicit executed check outcomes`);
    }
  }
  for (const id of expected) if (!seen.has(id)) {
    issues.push(`${id}: missing from coder result`);
    records.push({ id, status: 'unverified', evidence: '' });
  }
  return { complete: !issues.length, records, issues };
}

export function validateImplementationCheckpoint(checkpoint, { planId, scopeKey, repoKey, stages }) {
  if (checkpoint?.version !== 1 || checkpoint.planId !== planId || checkpoint.scopeKey !== scopeKey || checkpoint.repoKey !== repoKey) return false;
  const completed = checkpoint.completedStages;
  if (!Array.isArray(completed) || completed.length > stages.length || completed.some((id, index) => id !== stages[index]?.id)) return false;
  if (!Array.isArray(checkpoint.records) || checkpoint.records.length !== completed.flatMap((id) => stages.find((stage) => stage.id === id).steps).length) return false;
  return checkpoint.records.every((record, i) => record.id === stages.flatMap((stage) => stage.steps).at(i)?.id && record.status === 'implemented');
}

export function assessImplementationAcceptance(criteria, review, outputFormat) {
  const expected = criteria.map((_, index) => `A${index + 1}`);
  const rows = outputFormat === 'structured' && Array.isArray(review?.acceptanceResults) ? review.acceptanceResults : [];
  const seen = new Set();
  const results = [];
  const issues = [];
  for (const row of rows) {
    if (!expected.includes(row?.id) || seen.has(row.id)) {
      issues.push(`Unexpected or duplicate acceptance criterion: ${String(row?.id)}`);
      continue;
    }
    seen.add(row.id);
    const verified = row.status === 'verified' && typeof row.evidence === 'string' && row.evidence.trim().length >= 16;
    results.push({ id: row.id, status: verified ? 'verified' : row.status === 'blocked' ? 'blocked' : 'not_verified', evidence: String(row.evidence ?? '') });
    if (!verified) issues.push(`${row.id}: not independently verified`);
  }
  for (const id of expected) if (!seen.has(id)) {
    issues.push(`${id}: missing independent acceptance report`);
    results.push({ id, status: 'not_verified', evidence: '' });
  }
  return { complete: issues.length === 0, results, issues };
}
