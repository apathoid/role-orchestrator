import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createEfficiencyRun, retainEfficiencyRun, efficiencyView } from '../../src/efficiency/analytics.mjs';
import { compileRoleHistory, researchHandoff } from '../../src/efficiency/context.mjs';
import { assessReviewImpact, assessRetryProgress, suggestRoleEscalation } from '../../src/efficiency/optimization.mjs';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { historicalEfficiency } from '../../src/efficiency/history.mjs';

const sample = createEfficiencyRun('r1');
sample.onEvent({ type: 'role_start', invocationId: 'i1', role: 'explorer', provider: 'fake', model: 'm1' });
sample.onEvent({ type: 'role_usage', invocationId: 'i1', usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 40 } });
sample.onEvent({ type: 'role_usage', invocationId: 'i1', usage: { inputTokens: 120, outputTokens: 6, cachedInputTokens: 50 } });
sample.onEvent({ type: 'role_done', invocationId: 'i1', usage: { inputTokens: 120, outputTokens: 6 }, elapsedMs: 99 });
let record = sample.finish({ status: 'completed', taskId: 'task-one' });
let session = { efficiencyRuns: [] };
retainEfficiencyRun(session, record); retainEfficiencyRun(session, record);
assert.equal(session.efficiencyRuns.length, 1, 'run idempotence');
assert.equal(efficiencyView(session).roles[0].knownInputTokens, 120, 'cumulative snapshots are not summed');
assert.equal(efficiencyView(session).roles[0].knownOutputTokens, 6);
assert.equal(efficiencyView(session).roles[0].inputCoverage, 1);
assert.equal(efficiencyView(session).roles[0].elapsedMs, 99);
assert.equal(JSON.stringify(record).includes('secret prompt'), false);
const noUsage = createEfficiencyRun('r2');
noUsage.onEvent({ type: 'role_start', invocationId: 'i2', role: 'reviewerHigh', model: 'unknown' });
noUsage.onEvent({ type: 'role_error', invocationId: 'i2', elapsedMs: 7 });
retainEfficiencyRun(session, noUsage.finish({ status: 'failed' }));
const missing = efficiencyView(session).roles.find(x => x.role === 'reviewerHigh');
assert.equal(missing.inputCoverage, 0);
assert.equal(missing.knownInputTokens, 0);

const transcript = Array.from({ length: 30 }, (_, i) => ({ user: `Historic user detail ${i} ${'a'.repeat(600)}`, assistant: `Result ${i}` }));
const ctx = { transcript, history: [] };
assert.equal(compileRoleHistory(ctx, 'router', { mode: 'conservative', savedPlan: false }).manifest.mode, 'legacy');
const short = compileRoleHistory(ctx, 'router', { mode: 'conservative', savedPlan: true });
assert.equal(short.manifest.mode, 'bounded_historical');
assert(short.manifest.includedChars < short.manifest.originalChars);
assert.equal(compileRoleHistory(ctx, 'coderMedium', { mode: 'conservative', savedPlan: true }).manifest.mode, 'legacy');
const exploration = { summary: 'Source', relevantFiles: ['x'], constraints: ['permission'], existingPatterns: ['hook'], likelyVerification: ['test'], unknowns: ['risk'] };
assert.match(researchHandoff(exploration).text, /permission/);
assert.match(researchHandoff(exploration).text, /likelyVerification/);
assert.equal(researchHandoff({ ...exploration, unrecognizedField: 'do not lose me' }), null);
assert.equal(assessReviewImpact({ changedPaths: ['a'] }).mode, 'full_review');
assert.equal(assessReviewImpact({ changedPaths: ['a'], dependencyClosureComplete: true }).mode, 'targeted_candidate');
assert.equal(assessRetryProgress({ checkoutFingerprint: 'same' }, { checkoutFingerprint: 'same' }).state, 'unknown');
assert.equal(assessRetryProgress({ checkoutFingerprint: 'a' }, { checkoutFingerprint: 'b' }).state, 'progress_observed');
assert.equal(suggestRoleEscalation({ failureCode: 'PROVIDER_CRASH' }).action, 'diagnose_provider');
assert.equal(suggestRoleEscalation({ role: 'reviewerHigh', failureCode: 'VALIDATION_FAILED', progress: { state: 'no_material_progress' }, samples: 20, currentModel: 'old', allowed: [{ role: 'reviewerHigh', model: 'new' }] }).action, 'suggest_escalation');

const scratch = await mkdtemp(join(tmpdir(), 'p3-efficiency-'));
const repo = join(scratch, 'repo');
const previous = process.env.AGENT_STATE_DIR;
const hist = process.env.AGENT_P3_HISTORY;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
process.env.AGENT_P3_HISTORY = '1';
try {
  await mkdir(repo);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const config = { roles: {}, profiles: {}, providers: {}, policy: {} };
  const attachments = {
    persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
    buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {},
  };
  const registry = { close: async () => {} };
  const create = () => createOrchestratorRuntime({
    getConfig: async () => config, attachments, createRegistry: async () => registry,
    workflow: async ({ reporter }) => {
      await reporter({ type: 'role_start', invocationId: 'outer-i1', role: 'explorer', provider: 'fake', model: 'm1' });
      await reporter({ type: 'role_usage', invocationId: 'outer-i1', usage: { inputTokens: 20, outputTokens: 4 } });
      await reporter({ type: 'role_usage', invocationId: 'outer-i1', usage: { inputTokens: 20, outputTokens: 4 } });
      await reporter({ type: 'role_done', invocationId: 'outer-i1', role: 'explorer', elapsedMs: 3 });
      return { status: 'investigated', responseText: 'Done' };
    },
  });
  let runtime = create();
  const { sessionId } = await runtime.createSession({ cwd: repo });
  await runtime.runTurn({ sessionId, invocation: { task: 'Test' }, rawText: 'Test' });
  assert.equal(runtime.getEfficiencyView(sessionId).roles[0].knownInputTokens, 20);
  runtime = create();
  await runtime.restoreSession({ sessionId, cwd: repo });
  assert.equal(runtime.getEfficiencyView(sessionId).roles[0].knownInputTokens, 20, 'durable after restart');
  const history = await historicalEfficiency(repo, { enabled: true });
  assert.equal(history.sessions, 1);
  assert.equal(history.roles[0].knownOutputTokens, 4);
  assert.equal((await historicalEfficiency(repo, { enabled: false })).enabled, false);
} finally {
  if (previous === undefined) delete process.env.AGENT_STATE_DIR; else process.env.AGENT_STATE_DIR = previous;
  if (hist === undefined) delete process.env.AGENT_P3_HISTORY; else process.env.AGENT_P3_HISTORY = hist;
  await rm(scratch, { recursive: true, force: true });
}
console.log('evaluation/p3-efficiency: PASS (usage snapshots, persistence, history opt-in, context, handoff, conservative impact and escalation)');
