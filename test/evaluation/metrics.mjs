import assert from 'node:assert/strict';
import { deriveExecutionMetrics, compareExecutionBaseline } from '../../src/observability/execution-metrics.mjs';
const events = [
  { sequence: 1, kind: 'run.started', timestamp: '2026-01-01T00:00:00.000Z' },
  { sequence: 2, kind: 'role_start', data: { invocationId: 'a' }, timestamp: '2026-01-01T00:00:00.005Z' },
  { sequence: 3, kind: 'workspace_drift', correlation: { invocationId: 'a', attempt: 1 }, timestamp: '2026-01-01T00:00:00.007Z' },
  { sequence: 4, kind: 'role_done', data: { invocationId: 'a' }, timestamp: '2026-01-01T00:00:00.009Z' },
  { sequence: 5, kind: 'verification_done', data: { ok: false }, timestamp: '2026-01-01T00:00:00.010Z' },
  { sequence: 6, kind: 'run.finished', timestamp: '2026-01-01T00:00:00.012Z' },
];
const metrics = deriveExecutionMetrics(events);
assert.equal(metrics.roleInvocations, 1);
assert.equal(metrics.unfinishedRoleInvocations, 0);
assert.equal(metrics.reconciliationTurns, 1);
assert.equal(metrics.failedVerifications, 1);
assert.equal(metrics.durationMs, 12);
assert.equal(compareExecutionBaseline(metrics, { reconciliationTurns: { max: 1 }, roleInvocations: { min: 1, max: 2 } }).ok, true);
assert.equal(compareExecutionBaseline(metrics, { reconciliationTurns: { max: 0 } }).ok, false);
assert.equal(deriveExecutionMetrics(events.slice(0, -1)).terminalEvent, null);
console.log('evaluation/metrics: passed (metrics, scenario-specific baselines, incomplete runs)');
