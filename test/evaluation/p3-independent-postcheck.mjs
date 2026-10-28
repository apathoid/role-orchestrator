import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { saveSession, loadSession } from '../../src/session-store.mjs';
import { historicalEfficiency } from '../../src/efficiency/history.mjs';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { efficiencyView } from '../../src/efficiency/analytics.mjs';
import { researchHandoff } from '../../src/efficiency/context.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'p3-postcheck-'));
const prev = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
try {
  const repo = join(scratch, 'repo');
  await mkdir(repo);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const poisoned = { cwd: repo, repoRoot: repo, transcript: [], history: [], efficiencyRuns: [{
    version: 1, runId: 'run-p3', status: 'completed', leakedPrompt: 'SECRET_NOT_TO_STORE', invocations: [{
      invocationId: 'i', role: 'explorer', model: 'fake', leakedRawOutput: 'PASSWORD_PRIVATE',
      usage: { inputTokens: 30, extraSensitive: 'SENSITIVE' }, elapsedMs: 3,
    }],
  }] };
  await saveSession('p3-test', poisoned);
  const raw = await readFile(join(scratch, 'state', 'sessions', 'p3-test.json'), 'utf8');
  assert(!raw.includes('SECRET_NOT_TO_STORE') && !raw.includes('PASSWORD_PRIVATE') && !raw.includes('SENSITIVE'), 'strict persisted allowlist');
  assert.equal((await loadSession('p3-test')).efficiencyRuns[0].invocations[0].usage.inputTokens, 30);
  assert.equal(efficiencyView({ efficiencyRuns: [poisoned.efficiencyRuns[0], poisoned.efficiencyRuns[0]] }).roles[0].calls, 1, 'no live/persisted duplication');
  assert.equal((await historicalEfficiency(repo, { enabled: true })).roles.length, 1);
  const outside = join(scratch, 'outsider');
  await writeFile(outside, 'private');
  await symlink(outside, join(scratch, 'state', 'sessions', 'fake-symlink.json'));
  const history = await historicalEfficiency(repo, { enabled: true });
  assert.equal(history.sessions, 1, 'historical read refuses symlink even with safe-looking basename');
  assert.equal(researchHandoff({ summary: 'x', existingPatterns: [], customContext: 'IMPORTANT' }), null, 'unknown report fields never discarded');

  const cfg = { roles: {}, profiles: {}, providers: {} };
  const runtime = createOrchestratorRuntime({
    getConfig: async () => cfg,
    attachments: {
      persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
      buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {},
    },
    createRegistry: async () => ({ close: async () => {} }),
    workflow: async ({ reporter }) => {
      await reporter({ type: 'role_start', invocationId: 'broken', role: 'coderMedium', provider: 'fake', model: 'fake' });
      await reporter({ type: 'role_usage', invocationId: 'broken', usage: { inputTokens: 14, outputTokens: 5 } });
      throw new Error('Synthetic failure');
    },
  });
  const { sessionId } = await runtime.createSession({ cwd: repo });
  await assert.rejects(runtime.runTurn({ sessionId, invocation: { task: 'fail' }, rawText: 'fail' }), /Synthetic failure/);
  assert.equal(runtime.getEfficiencyView(sessionId).roles[0].knownInputTokens, 14);
  const restored = await loadSession(sessionId);
  assert.equal(restored.efficiencyRuns[0].status, 'failed');
  assert.equal(restored.efficiencyRuns[0].invocations[0].status, 'incomplete');
} finally {
  if (prev === undefined) delete process.env.AGENT_STATE_DIR; else process.env.AGENT_STATE_DIR = prev;
  await rm(scratch, { recursive: true, force: true });
}
console.log('evaluation/p3-independent-postcheck: PASS (strict privacy, idempotence, malicious symlinks, failed-turn usage recovery, safe handoff)');
