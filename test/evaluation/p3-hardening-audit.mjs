// Independent follow-up regressions for the two P3 stability audits.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEfficiencyRun, efficiencyView, retainEfficiencyRun } from '../../src/efficiency/analytics.mjs';
import { historicalEfficiency } from '../../src/efficiency/history.mjs';
import { loadSession, saveSession } from '../../src/session-store.mjs';

// P3 pass 1: context occupancy is not billed token consumption, and the
// invocation cap must be visible instead of implying complete accounting.
const tracked = createEfficiencyRun('cap-test');
for (let i = 0; i < 129; ++i) {
  tracked.onEvent({ type: 'role_start', invocationId: `invoke-${i}`, role: 'explorer', model: 'm1' });
  tracked.onEvent({ type: 'role_usage', invocationId: `invoke-${i}`, usage: { totalTokens: null, contextUsedTokens: 9000 } });
}
const capSession = {};
retainEfficiencyRun(capSession, tracked.finish());
const capped = efficiencyView(capSession);
assert.equal(capped.truncatedInvocations, 1);
assert.equal(capped.truncated, true);
assert.equal(capped.roles[0].calls, 128);
assert.equal(capped.roles[0].inputCoverage, 0);
assert.equal(capped.roles[0].knownInputTokens, 0);
const localModel = createEfficiencyRun('local-tag');
localModel.onEvent({ type: 'role_start', invocationId: 'local-1', role: 'explorer', model: 'qwen3:32b' });
assert.equal(localModel.finish().invocations[0].model, 'qwen3:32b', 'legitimate local model tags remain reportable');

// P3 pass 2: metadata in a disk record is untrusted even when its field name
// is allowlisted. Never echo URL credentials or arbitrary event strings.
const scratch = await mkdtemp(join(tmpdir(), 'p3-hardening-audit-'));
const oldState = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
try {
  const repoRoot = join(scratch, 'repo');
  await mkdir(repoRoot);
  const bad = {
    repoRoot, cwd: repoRoot, history: [], transcript: [], efficiencyRuns: [{
      version: 1, runId: 'safe-run', status: 'secret=CANARY_PRIVATE', completedAt: '2026-01-01Tsecret:password',
      invocations: [{ invocationId: 'i1', role: 'router', provider: 'http://secret:password@domain',
        model: 'model?api_key=CANARY_PRIVATE', usage: { inputTokens: 9 } }],
    }],
  };
  await saveSession('metadata-private', bad);
  const payload = await readFile(join(scratch, 'state', 'sessions', 'metadata-private.json'), 'utf8');
  assert(!payload.includes('CANARY_PRIVATE') && !payload.includes('secret:password'));
  const safe = await loadSession('metadata-private');
  assert.equal(safe.efficiencyRuns[0].status, 'unknown');
  assert.equal(safe.efficiencyRuns[0].completedAt, null);
  assert.equal(safe.efficiencyRuns[0].invocations[0].provider, null);
  assert.equal(safe.efficiencyRuns[0].invocations[0].model, null);

  // More than 200 sessions, with the newest five written last. Historical
  // aggregation must select recent sessions, not arbitrary readdir order.
  const sessions = join(scratch, 'state', 'sessions');
  for (let i = 0; i < 205; i++) {
    const value = {
      repoRoot, efficiencyRuns: [{ version: 1, runId: `run-${i}`, status: 'investigated',
        invocations: [{ invocationId: `inv-${i}`, role: 'explorer', model: 'm', status: 'completed',
          usage: { inputTokens: i === 204 ? 4321 : 1, outputTokens: null } }],
      }],
    };
    const file = join(sessions, `session-${String(i).padStart(3, '0')}.json`);
    await writeFile(file, JSON.stringify(value));
    const time = new Date(Date.UTC(2026, 0, 1) + i * 2000);
    await utimes(file, time, time);
  }
  const history = await historicalEfficiency(repoRoot, { enabled: true });
  assert.equal(history.truncated, true);
  assert.equal(history.sessions, 200);
  const row = history.roles.find(x => x.role === 'explorer');
  assert.equal(row.calls, 199);
  assert.equal(row.knownInputTokens, 4321 + 198, 'newest sessions are included');

  // An externally modified JSON file cannot bypass normalization and inject
  // arbitrary role/model values into the historical read-only UI.
  const poisoned = join(sessions, 'session-204.json');
  const data = JSON.parse(await readFile(poisoned, 'utf8'));
  data.efficiencyRuns[0].invocations[0].model = 'model://secret:password@private';
  await writeFile(poisoned, JSON.stringify(data));
  await utimes(poisoned, new Date('2027-01-01'), new Date('2027-01-01'));
  const sanitized = await historicalEfficiency(repoRoot, { enabled: true });
  assert(!JSON.stringify(sanitized).includes('secret:password'));
} finally {
  if (oldState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = oldState;
  await rm(scratch, { recursive: true, force: true });
}
console.log('evaluation/p3-hardening-audit: PASS (context usage, telemetry cap, sanitized metadata, recent session history)');
