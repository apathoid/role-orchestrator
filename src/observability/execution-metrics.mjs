// Deterministic aggregate metrics over a sanitized execution trace. No model
// scoring, hidden reasoning, file contents, or guessed causality.
export function deriveExecutionMetrics(events = []) {
  const started = new Map();
  const completed = new Set();
  let orphanFinishes = 0;
  let missingSequence = 0;
  let totalRetries = 0;
  let maxReconciliationAttempt = 0;
  let fixRounds = 0;
  let failedVerification = 0;
  let terminalEvent = null;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.sequence !== i + 1) missingSequence++;
    const id = event.correlation?.invocationId ?? event.data?.invocationId;
    if (event.kind === 'role_start' && id) started.set(id, event.timestamp);
    if (['role_done', 'role_error', 'role_cancelled'].includes(event.kind)) {
      if (id && started.has(id)) completed.add(id);
      else orphanFinishes++;
    }
    if (event.kind === 'workspace_drift') {
      totalRetries++;
      maxReconciliationAttempt = Math.max(maxReconciliationAttempt, event.correlation?.attempt ?? 0);
    }
    if (event.kind === 'fix_round') fixRounds++;
    if (event.kind === 'verification_done' && event.data?.ok === false) failedVerification++;
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.kind)) terminalEvent = event.kind;
  }
  const start = Date.parse(events[0]?.timestamp ?? '');
  const end = Date.parse(events.at(-1)?.timestamp ?? '');
  return {
    controlEvents: events.length,
    roleInvocations: started.size,
    completedRoleInvocations: completed.size,
    unfinishedRoleInvocations: started.size - completed.size,
    orphanRoleFinishes: orphanFinishes,
    sequenceViolations: missingSequence,
    reconciliationTurns: totalRetries,
    maxReconciliationAttempt,
    fixRounds,
    failedVerifications: failedVerification,
    terminalEvent,
    durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
  };
}

// Baselines are scenario-specific, never arbitrary quality grades. A metric
// is checked only when the scenario declares a bound for it.
export function compareExecutionBaseline(metrics, limits) {
  const failures = [];
  for (const [key, bound] of Object.entries(limits)) {
    const actual = metrics[key];
    if (!Number.isFinite(actual)) { failures.push(`${key}: unavailable`); continue; }
    if (Number.isFinite(bound.min) && actual < bound.min) failures.push(`${key}: ${actual} < min ${bound.min}`);
    if (Number.isFinite(bound.max) && actual > bound.max) failures.push(`${key}: ${actual} > max ${bound.max}`);
  }
  return { ok: failures.length === 0, failures };
}
