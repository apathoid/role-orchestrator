import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { evaluateExecution } from './runner.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-eval-cancel-'));
const before = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
const repo = join(scratch, 'repo');
const config = { roles: { router: 'mock' }, profiles: { mock: { provider: 'mock', model: 'mock' } }, providers: { mock: { type: 'mock' } } };
let running;
try {
  await mkdir(repo);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const runtime = createOrchestratorRuntime({
    getConfig: async () => config,
    createRegistry: async () => ({ close: async () => {} }),
    attachments: {
      persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
      buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {},
    },
    workflow: async ({ task, signal }) => {
      if (task === 'slow') await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        running();
      });
      return { status: 'investigated', responseText: 'ok' };
    },
  });
  const { sessionId } = await runtime.createSession({ cwd: repo });
  const started = new Promise((resolve) => { running = resolve; });
  const slow = runtime.runTurn({ sessionId, invocation: { task: 'slow' }, rawText: 'slow' });
  await started;
  const firstRun = (await runtime.getExecutionView(sessionId)).runId;
  const fast = runtime.runTurn({ sessionId, invocation: { task: 'fast' }, rawText: 'fast' });
  await assert.rejects(slow, (error) => error.cancellationReason === 'SUPERSEDED_BY_NEW_TURN');
  assert.equal((await fast).result.status, 'investigated');
  const terminal = await evaluateExecution({ runtime, sessionId, runId: firstRun, expectation: {
    status: 'cancelled', terminalEvent: 'run.cancelled', forbiddenEvents: ['run.finished'],
  } });
  assert.equal(terminal.view.diagnostics[0].code, 'SUPERSEDED_BY_NEW_TURN');
  assert.equal(terminal.view.diagnostics[0].origin, 'workflow');
  assert.equal((await runtime.getExecutionView(sessionId)).status, 'completed');
  assert.equal(runtime.sessions.get(sessionId).transcript.length, 1);
  console.log('evaluation/cancellation: passed (supersession provenance, no false completion, durable turn)');
} finally {
  if (before === undefined) delete process.env.AGENT_STATE_DIR; else process.env.AGENT_STATE_DIR = before;
  await rm(scratch, { recursive: true, force: true });
}
