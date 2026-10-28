// Provider-neutral profiling: no prompt changes, no model calls and no raw data retention.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileRolePrompt, normalizeContextProfile } from '../../src/efficiency/profiling.mjs';
import { createEfficiencyRun, efficiencyView, retainEfficiencyRun } from '../../src/efficiency/analytics.mjs';
import { saveSession, loadSession, normalizeEfficiencyRuns } from '../../src/session-store.mjs';

const canary = 'SECRET_USER_TEXT_CANARY';
const sections = [`ROLE CONTRACT:\n${canary}`, `History ${canary}`, '', 'Task content', 'Check'];
const prompt = sections.filter(Boolean).join('\n\n');
const profile = profileRolePrompt({ sections, prompt,
  promptBlocks: [{ type: 'image', data: canary }],
  contextSubsections: { project_instructions_and_skills: `Rules ${canary}`, session_history: 'Some previous turn' } });
assert.equal(profile.promptCharacters, prompt.length);
assert.equal(profile.promptUtf8Bytes, Buffer.byteLength(prompt));
assert.equal(profile.sections[1].characters, sections[1].length);
assert.equal(profile.sections[2].included, false);
assert.equal(profile.supplementalBlocks, 1);
assert.equal(profile.tokenEstimate, null);
assert.equal(profile.providerAddedContext, 'unknown');
assert.equal(profile.contextSubsections.length, 2);
assert(!JSON.stringify(profile).includes(canary), 'no prompt, instruction or attachment payload persisted');
assert.deepEqual(normalizeContextProfile(profile), profile);
assert.equal(normalizeContextProfile({ ...profile, malicious: canary }).malicious, undefined);
assert.equal(normalizeContextProfile({ ...profile, sections: [{ kind: canary }] }), null);

const run = createEfficiencyRun('run-monitor-1');
run.onEvent({ type: 'implementation_stage_start', stage: 'I2' });
run.onEvent({ type: 'role_start', invocationId: 'invoke-1', role: 'explorer', provider: 'acp', model: 'm' });
run.onEvent({ type: 'role_context_profile', invocationId: 'invoke-1', profile });
run.onEvent({ type: 'role_usage', invocationId: 'invoke-1', usage: { contextUsedTokens: 150, contextWindow: 2048, inputTokens: null } });
run.onEvent({ type: 'role_usage', invocationId: 'invoke-1', usage: { contextUsedTokens: 450, contextWindow: 2048, inputTokens: 30, outputTokens: 5 } });
run.onEvent({ type: 'role_usage', invocationId: 'invoke-1', usage: { contextUsedTokens: 320, contextWindow: 2048, inputTokens: 30, outputTokens: 5 } });
run.onEvent({ type: 'role_tool_event', invocationId: 'invoke-1', update: { sessionUpdate: 'tool_call', toolCallId: 'secret-call', title: canary } });
run.onEvent({ type: 'role_tool_event', invocationId: 'invoke-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'secret-call', raw: canary } });
run.onEvent({ type: 'role_done', invocationId: 'invoke-1', elapsedMs: 98 });
run.onEvent({ type: 'implementation_stage_done', stage: 'I2' });
run.onEvent({ type: 'role_start', invocationId: 'invoke-2', role: 'reviewerHigh', model: 'm' });
run.onEvent({ type: 'role_error', invocationId: 'invoke-2', elapsedMs: 17 });
const report = run.finish({ status: 'failed', taskId: 'task-1' });
assert.deepEqual(report.invocations[0].contextOccupancy, { first: 150, peak: 450, last: 320, window: 2048, updates: 3 });
assert.equal(report.invocations[0].usage.inputTokens, 30, 'cumulative token snapshots must not sum');
assert.equal(report.invocations[0].toolCalls, 1, 'updates of same ACP tool call count once');
assert.equal(report.invocations[0].toolEvents, 2);
assert.equal(report.invocations[0].stageId, 'I2');
assert.equal(report.invocations[1].stageId, null);
assert(!JSON.stringify(report).includes(canary));
assert(!JSON.stringify(report).includes('secret-call'));
const session = { efficiencyRuns: [] };
retainEfficiencyRun(session, report);
const summary = efficiencyView(session);
assert.equal(summary.roles.find(r => r.role === 'explorer').preparedCharacters, prompt.length);
assert.equal(summary.roles.find(r => r.role === 'explorer').contextProfileCoverage, 1);
assert.equal(summary.roles.find(r => r.role === 'explorer').peakContextTokens, 450);
assert.equal(summary.roles.find(r => r.role === 'explorer').toolCalls, 1);
assert.equal(summary.roles.find(r => r.role === 'reviewerHigh').contextCoverage, 0);
assert.equal(normalizeEfficiencyRuns([{ ...report, runId: 'bad' }])[0].invocations[0].contextProfile.promptCharacters, prompt.length);

const root = await mkdtemp(join(tmpdir(), 'p3-context-monitor-'));
const prev = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = root;
try {
  await mkdir(join(root, 'repo'));
  await saveSession('monitored-session', { ...session, cwd: join(root, 'repo') });
  const savedText = await readFile(join(root, 'sessions', 'monitored-session.json'), 'utf8');
  assert(!savedText.includes(canary));
  assert(!savedText.includes('secret-call'));
  const restored = await loadSession('monitored-session');
  assert.equal(restored.efficiencyRuns[0].invocations[0].contextOccupancy.peak, 450);
  assert.equal(restored.efficiencyRuns[0].invocations[0].contextProfile.contextSubsections[0].kind, 'project_instructions_and_skills');
  // Neither imported JSON nor externally manipulated records can bypass the allowlist.
  const poisoned = structuredClone(report);
  poisoned.invocations[0].contextProfile.sections[0].kind = canary;
  poisoned.invocations[0].contextProfile.sections[0].rawText = canary;
  poisoned.invocations[0].contextOccupancy.raw = canary;
  const cleaned = normalizeEfficiencyRuns([poisoned]);
  assert.equal(cleaned[0].invocations[0].contextProfile, null);
  assert(!JSON.stringify(cleaned).includes(canary));
} finally {
  if (prev === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = prev;
  await rm(root, { recursive: true, force: true });
}
console.log('evaluation/p3-context-monitoring: PASS');
