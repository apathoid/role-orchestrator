// Independent P3 repeat-audit regressions: cross-project history and usage consistency.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historicalEfficiency } from '../../src/efficiency/history.mjs';
import { createEfficiencyRun, efficiencyView } from '../../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../../src/session-store.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'p3-round2-'));
const savedState = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
try {
  const sessions = join(scratch, 'state', 'sessions');
  await mkdir(sessions, { recursive: true });
  const myRepo = join(scratch, 'myrepo');
  const otherRepo = join(scratch, 'otherrepo');
  // All of our repo's sessions are older than 200 newer sessions from another repo.
  // Historic reporting still must include our saved records if the candidate cap permits.
  for (let i = 0; i < 203; i++) {
    const file = join(sessions, `mix-${String(i).padStart(4, '0')}.json`);
    await writeFile(file, JSON.stringify({ repoRoot: i < 3 ? myRepo : otherRepo,
      efficiencyRuns: [{ version: 1, runId: `run-${i}`, status: 'completed',
        invocations: [{ invocationId: `inv-${i}`, role: 'coderLow', model: 'model1',
          status: 'completed', usage: { inputTokens: 10, outputTokens: 2 } }] }],
    }));
    const time = new Date(Date.UTC(2026, 1, 1) + i * 2000);
    await utimes(file, time, time);
  }
  const view = await historicalEfficiency(myRepo, { enabled: true });
  assert.equal(view.sessions, 3, 'recent unrelated repositories must not hide retained history for this repo');
  assert.equal(view.roles[0]?.calls, 3);
  for (let i = 0; i < 2; i++) {
    const file = join(sessions, `big-${i}.json`);
    await writeFile(file, JSON.stringify({ repoRoot: myRepo,
      efficiencyRuns: [{ version: 1, runId: `big-run-${i}`, invocations: [{
        invocationId: `big-inv-${i}`, role: 'coderLow', model: 'model1',
        usage: { inputTokens: Number.MAX_SAFE_INTEGER },
      }] }],
    }));
    const time = new Date(Date.UTC(2028, 0, 1) + i * 1000);
    await utimes(file, time, time);
  }
  const historicalOverflow = await historicalEfficiency(myRepo, { enabled: true });
  assert.equal(historicalOverflow.roles[0]?.knownInputTokens, null, 'cross-session overflow must not be rendered as exact');
  assert.equal(historicalOverflow.roles[0]?.numericOverflow, true);

  const run = createEfficiencyRun('usage-consistency');
  run.onEvent({ type: 'role_start', invocationId: 'one', role: 'explorer', model: 'model1' });
  run.onEvent({ type: 'role_usage', invocationId: 'one', usage: {
    inputTokens: 10, outputTokens: 5, cachedInputTokens: 25, reasoningOutputTokens: 9, totalTokens: 100,
  }});
  const observed = run.finish().invocations[0].usage;
  assert.equal(observed.cachedInputTokens, null, 'cached input must not exceed all input tokens');
  assert.equal(observed.reasoningOutputTokens, null, 'reasoning output must not exceed all output tokens');
  assert.equal(observed.totalTokens, null, 'incompatible total must not be reported as measured');
  // Streaming usage may temporarily be partial: do not discard a subset
  // counter when a later cumulative snapshot makes it coherent.
  const partial = createEfficiencyRun('partial-usage');
  partial.onEvent({ type: 'role_start', invocationId: 'two', role: 'explorer', model: 'model1' });
  partial.onEvent({ type: 'role_usage', invocationId: 'two', usage: { inputTokens: 10, cachedInputTokens: 25 } });
  partial.onEvent({ type: 'role_usage', invocationId: 'two', usage: { inputTokens: 30, cachedInputTokens: 25 } });
  assert.equal(partial.finish().invocations[0].usage.cachedInputTokens, 25);
  // Provider counters are individually safe integers but aggregating two of
  // them must never silently cross JavaScript's exact-integer boundary.
  const huge = createEfficiencyRun('huge');
  for (let i = 0; i < 2; i++) {
    huge.onEvent({ type: 'role_start', invocationId: `big-${i}`, role: 'explorer', model: 'model1' });
    huge.onEvent({ type: 'role_usage', invocationId: `big-${i}`, usage: { inputTokens: Number.MAX_SAFE_INTEGER } });
  }
  const large = efficiencyView({ efficiencyRuns: [huge.finish()] }).roles[0];
  assert.equal(large.knownInputTokens, null, 'overflow must not look like an exact token count');
  assert.equal(large.numericOverflow, true);
  const restored = normalizeEfficiencyRuns([{
    version: 1, runId: 'saved', invocations: [{ invocationId: 'one', role: 'explorer',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 25,
        reasoningOutputTokens: 9, totalTokens: 100 },
    }],
  }]);
  assert.equal(restored[0].invocations[0].usage.cachedInputTokens, null, 'persisted observations get same validation');
  assert.equal(restored[0].invocations[0].usage.totalTokens, null);
} finally {
  if (savedState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = savedState;
  await rm(scratch, { recursive: true, force: true });
}
console.log('evaluation/p3-stability-round2: PASS');
