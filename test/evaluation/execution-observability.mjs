import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createExecutionObserver, observableEventData } from '../../src/observability/execution-observer.mjs';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { executionOverviewMarkdown, executionTraceMarkdown } from '../../src/acp-presentation.mjs';
import { evaluateExecution } from './runner.mjs';

const dir = await mkdtemp(join(tmpdir(), 'orchestrator-observability-'));
const previous = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(dir, 'state');
const repo = join(dir, 'repo');
const traceRoot = join(dir, 'state', 'execution');
const config = { roles: { router: 'mock' }, profiles: { mock: { provider: 'mock', model: 'mock' } }, providers: { mock: { type: 'mock' } } };
const attachments = {
  persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
  buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {},
};
let called = [];
const observerErrors = [];
let workflowMode = 'success';
function makeRuntime(observer = createExecutionObserver({ root: traceRoot, onError: (error) => observerErrors.push(error) })) {
  return createOrchestratorRuntime({
    getConfig: async () => config,
    attachments,
    observer,
    createRegistry: async () => ({ close: async () => {} }),
    workflow: async ({ reporter, onImplementationPlan, onImplementationCheckpoint, authoritativePlan, task }) => {
      called.push(task);
      if (workflowMode === 'failure') throw Object.assign(new Error('scrub me token=secret-token'), { code: 'WORKSPACE_UNSTABLE' });
      if (workflowMode === 'cancel') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { status: 'investigated', responseText: 'No cancellation in fixture' };
      }
      await reporter({ type: 'route', policy: { mode: 'change', tier: 'high' } });
      await reporter({ type: 'role_start', role: 'coderHigh', invocationId: 'invocation-1', provider: 'mock', model: 'mock' });
      await reporter({ type: 'role_thought_chunk', text: 'PRIVATE chain of thought', role: 'coderHigh' });
      await reporter({ type: 'role_tool_event', update: { content: [{ type: 'text', text: 'API_KEY=very-secret' }] } });
      await onImplementationPlan({ version: 1, planId: 'plan-1', repoRoot: repo, plan: { goal: 'Fixture', steps: ['first', 'second'], acceptanceCriteria: ['correctness'] } });
      await reporter({ type: 'implementation_stage_start', stage: 'I1', index: 1, total: 2,
        steps: [{ id: 'S1', description: 'a'.repeat(8000) }] });
      await onImplementationCheckpoint({ version: 1, planId: 'plan-1', status: 'in_progress', completedStages: ['I1'] });
      await reporter({ type: 'implementation_stage_done', stage: 'I1', index: 1, total: 2, completedSteps: 1 });
      await reporter({ type: 'role_done', role: 'coderHigh', invocationId: 'invocation-1', elapsedMs: 230 });
      await reporter({ type: 'workspace_drift', role: 'explorer', gitFields: ['index'], changedPaths: ['private/path'], turns: 1 });
      await reporter({ type: 'workspace_drift_reconciled', role: 'explorer', gitFields: ['index'], changedPaths: ['private/path'], turns: 1 });
      await reporter({ type: 'verification_start' });
      await reporter({ type: 'verification_done', ok: false, changedPaths: [] });
      await reporter({ type: 'fix_resolution', decision: 'needs_user_decision', reason: 'outside_scope' });
      await reporter({ type: 'complete', result: { status: 'needs_user_decision', planCompleted: false } });
      return { status: 'needs_user_decision', responseText: 'Some work remains unverified' };
    },
  });
}
try {
  await mkdir(repo);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  assert.deepEqual(observableEventData({ type: 'role_tool_event', update: { secret: 'hi' } }), {});
  let runtime = makeRuntime();
  const { sessionId } = await runtime.createSession({ cwd: repo });
  const updates = [];
  const unsubscribe = runtime.subscribeExecution(sessionId, (view) => updates.push(view));
  const presented = [];
  const result = await runtime.runTurn({
    sessionId, invocation: { task: 'Change a file' }, rawText: 'Change a file',
    reporter: async (event) => presented.push(event.type),
  });
  assert.equal(result.result.status, 'needs_user_decision');
  assert(presented.includes('role_tool_event'), 'native tool payload must still reach host');
  assert(updates.some((v) => v.activeInvocations.some((i) => i.id === 'invocation-1')));
  unsubscribe();
  const evaluated = await evaluateExecution({ runtime, sessionId, expectation: {
    status: 'completed', resultStatus: 'needs_user_decision',
    requiredEvents: ['role_start', 'role_done', 'workspace_drift', 'implementation_stage_done', 'fix_resolution'],
  } });
  assert.equal(evaluated.view.stages[0].status, 'completed', 'checkpoint is authoritative');
  assert.equal(evaluated.view.verification.status, 'failed');
  assert.equal(evaluated.view.workspace.status, 'reconciled');
  assert.equal(evaluated.metrics.roleInvocations, 1);
  assert.match(executionOverviewMarkdown(evaluated.view), /needs_user_decision/);
  assert.match(executionTraceMarkdown(evaluated.events), /implementation_stage_done/);
  const traceFile = join(traceRoot, sessionId, `${evaluated.view.runId}.jsonl`);
  const persisted = await readFile(traceFile, 'utf8');
  for (const secret of ['PRIVATE chain', 'API_KEY', 'very-secret', 'private/path', 'a'.repeat(300)]) {
    assert(!persisted.includes(secret), `Trace leaked ${secret}`);
  }
  // Loading a trace after a process restart must not claim unfinished work was successful.
  runtime = makeRuntime();
  await runtime.restoreSession({ sessionId, cwd: repo });
  assert.equal((await runtime.getExecutionView(sessionId)).status, 'completed');
  assert.equal((await runtime.getExecutionView(sessionId)).checkpoint.completedStages.length, 1);
  const replay = await createExecutionObserver({ root: traceRoot }).getTrace(sessionId);
  assert.deepEqual(replay.map((x) => x.sequence), evaluated.events.map((x) => x.sequence));

  const dangling = createExecutionObserver({ root: traceRoot });
  const run = dangling.begin(sessionId);
  run.running();
  run.event({ type: 'role_start', role: 'explorer', invocationId: 'dangling' });
  await dangling.getTrace(sessionId, { runId: run.runId });
  // No finish simulates crash between provider invocation and terminal persistence.
  const pending = await createExecutionObserver({ root: traceRoot }).getView(sessionId);
  assert.equal(pending.status, 'interrupted');
  assert.equal(pending.activeInvocations.length, 0);

  workflowMode = 'failure';
  runtime = makeRuntime();
  await runtime.restoreSession({ sessionId, cwd: repo });
  await assert.rejects(runtime.runTurn({ sessionId, invocation: { task: 'fail' }, rawText: 'fail' }), /scrub me/);
  const failed = await runtime.getExecutionView(sessionId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.diagnostics[0].code, 'WORKSPACE_UNSTABLE');
  assert.equal(failed.diagnostics[0].origin, 'workspace');
  assert(!JSON.stringify(await runtime.getExecutionTrace(sessionId)).includes('secret-token'));

  // Read-only inspection must not call workflow, even when an unfinished Plan exists.
  const before = called.length;
  await runtime.getExecutionView(sessionId);
  await runtime.getExecutionTrace(sessionId, { limit: 5 });
  assert.equal(called.length, before);

  // Symlinked session trace directories must be refused (and no data leaked to target).
  const hostileRoot = join(dir, 'hostile');
  await mkdir(hostileRoot);
  await symlink(dir, join(hostileRoot, 'linked'));
  const bad = createExecutionObserver({ root: join(hostileRoot, 'linked'), onError: (err) => observerErrors.push(err) });
  const badRun = bad.begin(randomUUID());
  await badRun.finish();
  assert(observerErrors.some((err) => /Unsafe execution trace directory/.test(err.message)));

  // Session retention bounds disk usage without touching authoritative state.
  const retentionRoot = join(dir, 'retention');
  const retained = createExecutionObserver({ root: retentionRoot, maxRunsPerSession: 2 });
  const retentionIds = [];
  for (let i = 0; i < 4; i++) {
    const r = retained.begin('retention-session');
    r.running();
    await r.finish({ resultStatus: 'investigated', committed: true });
    retentionIds.push(r.runId);
  }
  const stored = (await readdir(join(retentionRoot, 'retention-session'))).filter((name) => name.endsWith('.jsonl'));
  assert.equal(stored.length, 2, 'retention must keep only configured number of runs');
  assert(stored.includes(`${retentionIds.at(-1)}.jsonl`), 'latest run must survive retention');

  console.log('evaluation/observability: passed (runtime, evidence, replay, isolation, recovery, trace privacy)');
} finally {
  if (previous === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = previous;
  await rm(dir, { recursive: true, force: true });
}
