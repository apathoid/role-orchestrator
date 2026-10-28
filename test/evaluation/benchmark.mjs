// Opt-in empirical baseline; observations are not a correctness threshold.
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionObserver } from '../../src/observability/execution-observer.mjs';
const root = await mkdtemp(join(tmpdir(), 'p1-eval-bench-'));
try {
  const observer = createExecutionObserver({ root });
  const run = observer.begin('benchmark');
  run.running();
  const times = [];
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) {
    const t = performance.now();
    run.event({ type: 'fix_round', round: i, maxRounds: 600 });
    times.push(performance.now() - t);
  }
  const publishingMs = performance.now() - t0;
  await run.finish({ status: 'completed', resultStatus: 'benchmark' });
  const totalMs = performance.now() - t0;
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ controlEvents: 600, publishMs: +publishingMs.toFixed(2),
    publishP50Ms: +times[299].toFixed(3), publishP95Ms: +times[569].toFixed(3),
    includingDiskFlushMs: +totalMs.toFixed(2) }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
