import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOrchestratorRuntime } from '../src/orchestrator-runtime.mjs';
import { planDigest } from '../src/implementation-stages.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-runtime-'));
const repo = join(scratch, 'repo');
const oldDir = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
const cfg = { roles: { router: 'balanced' }, profiles: { balanced: { model: 'mock', provider: 'mock' } }, providers: { mock: { type: 'mock' } } };
const log = [];
const planDoc={steps:['First step'],acceptanceCriteria:['Done']};
const planId=planDigest(planDoc);
let running;
const stubAttachmentStore = {
  persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
  buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }),
  cleanupSessionAttachments: async () => {},
};
const factory = () => createOrchestratorRuntime({
  getConfig: async () => cfg,
  attachments: stubAttachmentStore,
  createRegistry: async () => ({ close: async () => {} }),
  workflow: async (params) => {
    log.push({ task: params.task, checkpoint: params.implementationCheckpoint, plan: params.authoritativePlan });
    if (params.task === 'Plan') {
      assert.equal(params.planOnly, true);
      return { status: 'planned', planArtifact: { version: 1, planId, repoRoot: repo, plan: planDoc }, responseText: 'plan created' };
    }
    if (params.task === 'Implement saved plan') {
      const selected=await params.onSelectSavedImplementation({mode:'current_implementation'});
      assert.equal(selected?.plan?.planId, planId);
      await params.onImplementationCheckpoint({ version: 1, planId, status: 'in_progress', completedStages: ['I1'] });
      return { status: 'changed', responseText: 'stage one' };
    }
    if (params.task === 'continue') {
      const selected=await params.onSelectSavedImplementation({mode:'current_implementation'});
      assert.deepEqual(selected?.checkpoint?.completedStages, ['I1']);
      return { status: 'changed', responseText: 'resumed' };
    }
    if (params.task === 'slow') {
      await new Promise((resolve, reject) => {
        if (params.signal.aborted) return reject(params.signal.reason);
        params.signal.addEventListener('abort', () => reject(params.signal.reason), { once: true });
        running();
      });
    }
    return { status: 'investigated', responseText: params.task };
  },
});
try {
  await mkdir(repo, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  let runtime = factory();
  const { sessionId } = await runtime.createSession({ cwd: repo });
  const run = (task, options = {}) => runtime.runTurn({
    sessionId, invocation: { task }, rawText: task, reporter: { event: async () => {} }, ...options,
  });
  await run('Plan', { controls: { planOnly: true } });
  await run('Implement saved plan');
  runtime = factory();
  const restored = await runtime.restoreSession({ sessionId, cwd: repo });
  assert.equal(restored.implementationPlan.planId, planId);
  assert.deepEqual(restored.implementationCheckpoint.completedStages, ['I1']);
  assert.equal((await run('continue')).assistantText, 'resumed');
  assert.deepEqual(restored.transcript.map((entry) => entry.assistant), ['plan created', 'stage one', 'resumed']);

  const started = new Promise((resolve) => { running = resolve; });
  const slow = run('slow');
  await started;
  const fast = run('fast');
  await assert.rejects(slow, (error) => error.cancellationReason === 'SUPERSEDED_BY_NEW_TURN');
  assert.equal((await fast).assistantText, 'fast');
  assert.equal(restored.transcript.length, 4, 'superseded turn is not appended');

  const host = new AbortController();
  host.abort();
  await assert.rejects(run('never started', { signal: host.signal }), (error) => error.cancellationReason === 'CLIENT_REQUEST_CANCELLED');
  assert.equal(log.some((entry) => entry.task === 'never started'), false);
  console.log('orchestrator-runtime: passed (headless lifecycle, persistence, resume, cancellation, supersession)');
} finally {
  if (oldDir === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = oldDir;
  await rm(scratch, { recursive: true, force: true });
}
