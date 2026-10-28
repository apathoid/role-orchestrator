import assert from 'node:assert/strict';
import { TurnTimingGuard, resolveTurnTiming } from '../src/providers/turn-timing.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.deepEqual(
  resolveTurnTiming({ idleTimeoutMs: 11, turnDeadlineMs: 22 }, { idleTimeoutMs: 33, turnDeadlineMs: 44 }),
  { idleTimeoutMs: 11, turnDeadlineMs: 22 },
  'profile timing overrides provider timing',
);
assert.deepEqual(
  resolveTurnTiming({}, { timeoutMs: 77 }),
  { idleTimeoutMs: 77, turnDeadlineMs: 77 },
  'legacy timeoutMs preserves the old fixed-timeout behavior when used alone',
);

{
  const guard = new TurnTimingGuard({ idleTimeoutMs: 55, turnDeadlineMs: 400 });
  const timeout = guard.start();
  for (let i = 0; i < 4; i += 1) {
    await sleep(35);
    guard.touch();
  }
  const stillAlive = await Promise.race([
    timeout.then(() => false, () => false),
    sleep(25).then(() => true),
  ]);
  assert.equal(stillAlive, true, 'regular activity must refresh the idle timeout');
  guard.dispose();
}

{
  const guard = new TurnTimingGuard({ idleTimeoutMs: 45, turnDeadlineMs: 400 });
  await assert.rejects(guard.start(), /idle timeout after 45 ms/i);
}

{
  const guard = new TurnTimingGuard({ idleTimeoutMs: 60, turnDeadlineMs: 130 });
  const interval = setInterval(() => guard.touch(), 25);
  try {
    await assert.rejects(guard.start(), /absolute turn deadline of 130 ms/i);
  } finally {
    clearInterval(interval);
    guard.dispose();
  }
}

{
  const guard = new TurnTimingGuard({ idleTimeoutMs: 45, turnDeadlineMs: 250 });
  const timeout = guard.start();
  guard.pauseIdle();
  await sleep(80);
  guard.resumeIdle();
  const stillAlive = await Promise.race([
    timeout.then(() => false, () => false),
    sleep(25).then(() => true),
  ]);
  assert.equal(stillAlive, true, 'idle timing must pause while awaiting outer user interaction');
  guard.dispose();
}

console.log('turn-timing: passed');
