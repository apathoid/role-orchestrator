import assert from 'node:assert/strict';
import { normalizeProviderError } from '../src/providers/errors.mjs';
import { AcpInvocationGuard, acpInvocationLimits } from '../src/providers/acp/invocation-guard.mjs';

const interrupts = [];
const controller = new AbortController();
const guard = new AcpInvocationGuard({ signal: controller.signal, label: 'fake', deadlineMs: 1000,
  preflightTimeoutMs: 500, onInterrupt: (phase, error) => interrupts.push([phase, error]) });
const unresolved = guard.run(() => new Promise(() => {}), 'session.new');
controller.abort('user cancellation');
await assert.rejects(unresolved, (error) => /abort|cancel/i.test(error.message));
assert.equal(interrupts.length, 1);
assert.equal(interrupts[0][0], 'session.new');
guard.dispose();

const timed = new AcpInvocationGuard({ label: 'fake', deadlineMs: 1000,
  preflightTimeoutMs: 15, onInterrupt: (phase, error) => interrupts.push([phase, error]) });
await assert.rejects(timed.run(() => new Promise(() => {}), 'session.configure'), (error) => {
  assert.equal(error.code, 'ACP_INVOCATION_TIMEOUT');
  assert.equal(error.phase, 'session.configure');
  const normalized = normalizeProviderError(error, 'test');
  assert.equal(normalized.code, 'TIMEOUT');
  assert.equal(normalized.timeoutKind, 'preflight');
  return true;
});
timed.dispose();

const closeGuard = new AcpInvocationGuard({ label: 'fake', deadlineMs: 1000 });
await assert.rejects(closeGuard.boundedClose(() => new Promise(() => {}), 15), /session_close/);
closeGuard.dispose();

assert.deepEqual(acpInvocationLimits({ turnDeadlineMs: 1000 }, { preflightTimeoutMs: 100 }),
  { deadlineMs: 4400, preflightTimeoutMs: 100, cleanupTimeoutMs: 3000 });
console.log('acp-invocation-guard: passed');
