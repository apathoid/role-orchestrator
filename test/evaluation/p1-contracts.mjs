import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionObserver } from '../../src/observability/execution-observer.mjs';
import { executionRunsMarkdown, executionTraceMarkdown } from '../../src/acp-presentation.mjs';

const root = await mkdtemp(join(tmpdir(), 'p1-contracts-'));
const sessionId = 'observability-eval';
try {
  const observer = createExecutionObserver({ root });
  const first = observer.begin(sessionId);
  const received = [];
  const opening = observer.watchWithSnapshot(sessionId, (view) => received.push({
    runId: view.runId, sequence: view.lastSequence, status: view.status,
  }), { getSession: () => ({ implementationCheckpoint: {
    planId: 'p1', status: 'interrupted', completedStages: ['I0'],
  } }) });
  // Publish while an asynchronous initial snapshot may still be loading.
  first.running();
  const stop = await opening;
  first.event({ type: 'role_start', role: 'explorer', invocationId: 'exp-1', provider: 'mock' });
  first.event({ type: 'workspace_drift', role: 'explorer', gitFields: ['index'], changedPaths: ['private/path'] });
  first.event({ type: 'workspace_drift', role: 'explorer', gitFields: ['index'], changedPaths: ['private/path'] });
  first.event({ type: 'workspace_drift_reconciled', role: 'explorer', gitFields: ['index'] });
  first.event({ type: 'role_done', role: 'explorer', invocationId: 'exp-1' });
  first.event({ type: 'implementation_stage_start', stage: 'I1', index: 1, total: 2 });
  first.event({ type: 'role_start', role: 'coderHigh', invocationId: 'coder-1' });
  first.event({ type: 'fix_round', round: 1, maxRounds: 2 });
  first.event({ type: 'fix_resolution', decision: 'needs_user_decision', reason: 'outside_scope' });
  first.event({ type: 'role_done', role: 'coderHigh', invocationId: 'coder-1' });
  first.event({ type: 'implementation_stage_done', stage: 'I1', index: 1, total: 2 });
  const run1 = await observer.getTrace(sessionId);
  const drift = run1.filter((e) => e.kind === 'workspace_drift');
  assert.deepEqual(drift.map((e) => e.correlation.attempt), [1, 2]);
  assert(drift.every((e) => e.correlation.invocationId === 'exp-1'));
  assert(drift.every((e) => e.correlation.parentId === 'exp-1'));
  assert(drift.every((e) => e.correlation.reasonCode === 'SEMANTIC_WORKSPACE_DRIFT'));
  assert.equal(run1.find((e) => e.kind === 'role_start' && e.data.role === 'coderHigh')?.correlation.stageId, 'I1');
  assert.equal(run1.find((e) => e.kind === 'fix_round')?.correlation.attempt, 1);
  assert.match(executionTraceMarkdown(run1), /attempt 2/);
  const snap = await observer.getView(sessionId, { session: { implementationCheckpoint: {
    planId: 'p1', status: 'interrupted', completedStages: ['I0'],
  } } });
  assert.equal(snap.checkpoint.completedStages.length, 1);
  assert.equal(snap.activity.reconciliationChecks, 2);
  const firstReceived = received.filter((v) => v.runId === first.runId).map((v) => v.sequence);
  assert.deepEqual(firstReceived, [...new Set(firstReceived)].sort((a, b) => a - b), 'snapshot and subscriptions never duplicate or regress');
  // The second run supersedes the first; an old terminal event must not
  // repaint the live UI with a previous run's state.
  const second = observer.begin(sessionId);
  second.running();
  await first.finish({ resultStatus: 'investigated' });
  assert.equal(received.at(-1).runId, second.runId);
  await second.finish({ resultStatus: 'investigated' });
  stop();
  const runs = await observer.listRuns(sessionId);
  assert.equal(runs.length, 2);
  assert.match(executionRunsMarkdown(runs), /Recent executions/);
  assert.equal((await observer.getView(sessionId)).runId, second.runId);
  const historical = await observer.getView(sessionId, { runId: first.runId,
    session: { implementationCheckpoint: { planId: 'p1', status: 'complete', completedStages: ['I1'] } },
  });
  assert.equal(historical.historicalSnapshot, true);
  assert.equal(historical.checkpoint, undefined, 'current checkpoint must never rewrite a historical snapshot');
  const stored = await readFile(join(root, sessionId, `${first.runId}.jsonl`), 'utf8');
  assert(!stored.includes('private/path'));
  assert(stored.includes('SEMANTIC_WORKSPACE_DRIFT'));
  assert.equal((await createExecutionObserver({ root }).getTrace(sessionId, { runId: first.runId })).length, run1.length + 1);
  console.log('evaluation/p1-contracts: passed (causality, snapshots, supersession, history, replay)');
} finally { await rm(root, { recursive: true, force: true }); }
