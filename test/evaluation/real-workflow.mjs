import {emptyTaskSpec} from '../../src/routing/task-spec.mjs';
// End-to-end evaluation against the real host-neutral workflow with a
// deterministic fake provider boundary. No Zed/ACP client or live model needed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config.mjs';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { evaluateExecution } from './runner.mjs';
import { deriveExecutionMetrics, compareExecutionBaseline } from '../../src/observability/execution-metrics.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-eval-real-'));
const repo = join(scratch, 'repo');
const oldState = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
const commands = [];
const git = (...args) => {
  const child = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
};
try {
  await mkdir(repo);
  git('init', '-q');
  git('config', 'user.email', 'agent@example.invalid');
  git('config', 'user.name', 'Agent');
  await writeFile(join(repo, 'example.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const config = await loadConfig({ repoRoot: repo, home: join(scratch, 'home'), env: {} });
  const runtime = createOrchestratorRuntime({
    getConfig: async () => config,
    createRegistry: async () => ({
      resolveRole: (role) => ({ role, profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } }),
      invokeRole: async (role, request) => {
        commands.push({ role, sandboxMode: request.sandboxMode, promptLength: request.prompt.length });
        await request.onProgress?.({ type: 'usage', usage: {
          contextUsedTokens: role === 'router' ? 120 : 400,
          contextWindow: 32000,
        } });
        if (role === 'explorer') {
          await request.onProgress?.({ type: 'tool_call', update: {
            sessionUpdate: 'tool_call', toolCallId: 'tool-eval', title: 'Read file',
          } });
          await request.onProgress?.({ type: 'tool_call', update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'tool-eval', status: 'completed',
          } });
        }
        const output = role === 'router'
          ? { mode: 'investigate', writeIntent: 'not_requested', complexity: 'low', risk: 'normal', reason: 'Question only', task:emptyTaskSpec('investigate') }
          : role === 'explorer'
            ? { summary: 'One file holds the greeting.', relevantFiles: ['example.txt'], constraints: [], existingPatterns: [], likelyVerification: [], unknowns: [] }
            : 'The repository contains example.txt with a greeting.';
        return {
          output,
          resolved: { profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } },
          meta: { elapsedMs: 10, structuredOutput: { format: typeof output === 'string' ? 'text' : 'structured' } },
        };
      },
      close: async () => {},
    }),
    attachments: {
      persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
      buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {},
    },
  });
  const { sessionId } = await runtime.createSession({ cwd: repo });
  const response = await runtime.runTurn({ sessionId, invocation: { task: 'What is in this repository?' }, rawText: 'What is in this repository?' });
  assert.equal(response.result.status, 'investigated');
  assert.deepEqual(commands.map((c) => c.role), ['router', 'explorer', 'investigator']);
  assert(commands.every((c) => c.sandboxMode === 'read-only'));
  const report = runtime.getEfficiencyReport(sessionId);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].invocations.length, 3);
  for (let i = 0; i < commands.length; ++i) {
    assert.equal(report.runs[0].invocations[i].contextProfile.promptCharacters, commands[i].promptLength,
      'instrumentation must account for exact role prompt without changing it');
  }
  const profile = report.runs[0].invocations[0].contextProfile;
  assert(profile.sections.some(section => section.kind === 'role_contract' && section.included));
  assert(profile.sections.some(section => section.kind === 'task_body' && section.included));
  assert.equal(report.runs[0].invocations[0].contextOccupancy.peak, 120);
  assert.equal(report.runs[0].invocations[1].toolCalls, 1, 'tool updates are not additional tool calls');
  assert.equal(runtime.getEfficiencyRunIndex(sessionId).length, 1);
  const { metrics, events, view } = await evaluateExecution({ runtime, sessionId, expectation: {
    resultStatus: 'investigated', requiredEvents: ['route', 'role_start', 'role_done', 'complete'],
    forbiddenEvents: ['implementation_stage_start', 'fix_round'],
  } });
  assert.equal(metrics.roleInvocations, 3);
  const baselines = JSON.parse(await readFile(new URL('./baselines.json', import.meta.url), 'utf8'));
  const comparison = compareExecutionBaseline(deriveExecutionMetrics(events), baselines.readOnlyRealWorkflow);
  assert.equal(comparison.ok, true, comparison.failures.join('\n'));
  assert.equal(view.phase, 'investigate');
  const started = events.filter((x) => x.kind === 'role_start');
  assert.equal(new Set(started.map((x) => x.data.invocationId)).size, 3, 'independent invocations correlate');
  console.log('evaluation/real-workflow: passed (real core, fake provider, read-only route, invocation correlation)');
} finally {
  if (oldState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = oldState;
  await rm(scratch, { recursive: true, force: true });
}
