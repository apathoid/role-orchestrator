// End-to-end host-neutral integration test with a real production provider
// adapter and a deterministic local Codex CLI protocol fixture. No ACP SDK,
// Zed process, fake registry, or injected workflow is involved.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { createOrchestratorRuntime } from '../src/orchestrator-runtime.mjs';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const cli = join(testDir, 'fake-codex.mjs');
const base = await mkdtemp(join(tmpdir(), 'role-orchestrator-real-headless-'));
const repo = join(base, 'repo');
const priorState = process.env.AGENT_STATE_DIR;
const priorLog = process.env.FAKE_CODEX_LOG;
process.env.AGENT_STATE_DIR = join(base, 'state');
process.env.FAKE_CODEX_LOG = join(base, 'codex.log');
function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
try {
  await mkdir(repo);
  await writeFile(join(repo, 'greeting.txt'), 'hello\n');
  git('init', '-q');
  git('config', 'user.email', 'headless@example.invalid');
  git('config', 'user.name', 'Headless Integration');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const cfg = await loadConfig({ repoRoot: repo });
  cfg.providers.subscription = {
    ...cfg.providers.subscription,
    adapter: 'codex-cli', auth: 'none', binary: cli,
    envAllowlist: ['FAKE_CODEX_LOG'],
  };
  // Deliberately leave a never-used ACP adapter configured, proving that the
  // host can execute with only the selected CLI implementation available.
  cfg.providers.unusedAcp = { adapter: 'acp-agent', command: '/no-such-agent', workspaceModes: { readOnly: 'read', write: 'write' } };
  const makeRuntime = () => createOrchestratorRuntime({ getConfig: async () => cfg });
  let runtime = makeRuntime();
  const { sessionId } = await runtime.createSession({ cwd: repo });
  const events = [];
  const invoke = async (task, opts = {}) => runtime.runTurn({
    sessionId, invocation: { task }, rawText: task,
    reporter: async (event) => events.push(event), ...opts,
  });
  const planned = await invoke('Change greeting.txt to hello world', { controls: { planOnly: true } });
  assert.equal(planned.result.status, 'planned');
  assert.ok(runtime.sessions.get(sessionId).implementationPlan);
  const implemented = await invoke('Implement saved plan');
  assert.ok(['applied', 'no_change', 'implementation_incomplete'].includes(implemented.result.status), implemented.result.status);
  assert.equal((await readFile(join(repo, 'greeting.txt'), 'utf8')).trim(), 'hello world');
  runtime = makeRuntime();
  const restored = await runtime.restoreSession({ sessionId, cwd: repo });
  assert.ok(restored.implementationPlan);
  assert.ok(restored.transcript.length >= 2);
  const resumed = await invoke('Implement saved plan');
  assert.ok(['applied', 'no_change', 'implementation_incomplete'].includes(resumed.result.status), resumed.result.status);
  assert.equal((await readFile(join(repo, 'greeting.txt'), 'utf8')).trim(), 'hello world');
  const investigated = await invoke('INVESTIGATE_ONLY Inspect the greeting', { invocation: { task: 'INVESTIGATE_ONLY Inspect the greeting', modeOverride: 'investigate' } });
  assert.equal(investigated.result.status, 'investigated');
  assert.equal(restored.transcript.length, 4);
  assert.ok(events.some((e) => e.type === 'role_start'), 'real workflow publishes role events');
  const logs = (await readFile(process.env.FAKE_CODEX_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(logs.some((entry) => entry.role === 'coder'));
  assert.ok(logs.some((entry) => entry.role === 'planner'));
  assert.ok(logs.every((entry) => entry.role !== 'coder' ? entry.sandboxMode === 'read-only' : entry.sandboxMode === 'workspace-write'));
  console.log('headless-real-provider: passed (real workflow, CLI adapter, plan, change, restore, investigate, events, sandbox)');
} finally {
  if (priorState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = priorState;
  if (priorLog === undefined) delete process.env.FAKE_CODEX_LOG;
  else process.env.FAKE_CODEX_LOG = priorLog;
  await rm(base, { recursive: true, force: true });
}
