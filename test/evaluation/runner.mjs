// Deterministic, provider-free evaluation assertions over the actual runtime
// trace and the resulting authoritative repository/session state.
import assert from 'node:assert/strict';

export async function evaluateExecution({ runtime, sessionId, expectation, runId = null }) {
  const view = await runtime.getExecutionView(sessionId, runId);
  const events = await runtime.getExecutionTrace(sessionId, { runId, limit: 500 });
  assert.ok(view, 'ExecutionView is required');
  assert.ok(events.length, 'Execution trace is required');
  assert.equal(events[0].kind, 'run.started', 'Trace must include run creation');
  assert.equal(events.at(-1).kind, expectation.terminalEvent ?? 'run.finished', 'Trace terminal event');
  assert.equal(view.status, expectation.status ?? 'completed');
  if (expectation.resultStatus) assert.equal(view.resultStatus, expectation.resultStatus);
  if (expectation.requiredEvents) for (const kind of expectation.requiredEvents) {
    assert.ok(events.some((event) => event.kind === kind), `Missing ${kind}`);
  }
  if (expectation.forbiddenEvents) for (const kind of expectation.forbiddenEvents) {
    assert.ok(!events.some((event) => event.kind === kind), `Unexpected ${kind}`);
  }
  const starts = events.filter((event) => event.kind === 'role_start');
  const completions = events.filter((event) => ['role_done', 'role_error', 'role_cancelled'].includes(event.kind));
  for (const event of starts) {
    assert.ok(event.data.invocationId, 'Role invocation ID required');
    assert.ok(completions.some((end) => end.data.invocationId === event.data.invocationId),
      `Unaccounted invocation ${event.data.invocationId}`);
  }
  const sequence = events.map((event) => event.sequence);
  assert.deepEqual(sequence, sequence.map((_, i) => i + 1), 'Trace must have gapless sequence');
  return { view, events, metrics: {
    roleInvocations: starts.length,
    workspaceDrifts: events.filter((event) => event.kind === 'workspace_drift').length,
    fixRounds: events.filter((event) => event.kind === 'fix_round').length,
    droppedTelemetry: view.trace.droppedTelemetry,
    traceDegraded: view.trace.degraded,
  } };
}
