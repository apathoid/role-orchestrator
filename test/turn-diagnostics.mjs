import assert from 'node:assert/strict';
import { AcpTurnDiagnostics } from '../src/providers/acp/turn-diagnostics.mjs';
import { normalizeProviderError, providerCancelledError } from '../src/providers/errors.mjs';

let now = 1_000;
const diagnostics = new AcpTurnDiagnostics({ now: () => now });
const empty = diagnostics.snapshot();
assert.equal(empty.turnNumber, 0);
assert.equal(empty.acpUpdateCount, 0);
assert.equal(empty.msSinceLastAcpUpdate, null);
assert.equal(empty.outgoingCancelCount, 0);
assert.deepEqual(empty.outgoingCancels, []);

diagnostics.beginTurn({ idleTimeoutMs: 600_000, turnDeadlineMs: 2_700_000 });
now += 120;
diagnostics.recordUpdate('agent_thought_chunk');
now += 40;
diagnostics.recordUpdate('tool_call_update');
now += 100;
const active = diagnostics.snapshot();
assert.deepEqual(active.configuredTiming, { idleTimeoutMs: 600_000, turnDeadlineMs: 2_700_000 });
assert.equal(active.turnElapsedMs, 260);
assert.equal(active.lastAcpUpdateType, 'tool_call_update');
assert.equal(active.msSinceLastAcpUpdate, 100);
assert.equal(active.acpUpdateCount, 2);

const cancelled = providerCancelledError({
  provider: 'subscription', profileName: 'strong', role: 'reviewerMedium',
  innerSessionId: 'inner-id', elapsedMs: 316_938, diagnostics: active,
});
assert.equal(cancelled.diagnostics?.reason, 'PROVIDER_CANCELLED');
assert.equal(cancelled.diagnostics?.innerAcp?.outgoingCancelCount, 0);
assert.equal(cancelled.diagnostics?.innerAcp?.configuredTiming?.turnDeadlineMs, 2_700_000);
assert.equal(cancelled.diagnostics?.innerAcp?.lastAcpUpdateType, 'tool_call_update');

const requests = [];
const connection = { agent: { notify: async (method, params) => {
  requests.push([method, params]);
} } };
diagnostics.sendCancel(connection, 'session/cancel', 'inner-id', 'outer_signal', 'SESSION_CANCELLED');
await Promise.resolve();
assert.equal(diagnostics.snapshot().outgoingCancelCount, 1);
assert.deepEqual(diagnostics.snapshot().outgoingCancels[0], {
  reason: 'outer_signal', outerReason: 'SESSION_CANCELLED', elapsedMs: 260,
  turnNumber: 1, notificationStatus: 'submitted',
});
assert.deepEqual(requests, [['session/cancel', { sessionId: 'inner-id' }]]);

// The notification was submitted locally, but no provider acknowledgement exists.
diagnostics.sendCancel({ agent: { notify: () => Promise.reject(new Error('closed')) } }, 'session/cancel', 'inner-id', 'turn_deadline');
await Promise.resolve();
await Promise.resolve();
assert.equal(diagnostics.snapshot().outgoingCancels.at(-1).notificationStatus, 'failed');
diagnostics.sendCancel(null, 'session/cancel', 'inner-id', 'idle_timeout');
assert.equal(diagnostics.snapshot().outgoingCancels.at(-1).notificationStatus, 'connection_unavailable');

const error = Object.assign(new Error('turn exceeded absolute turn deadline of 300 ms.'), { timeoutKind: 'deadline' });
diagnostics.recordTimeout(error);
assert.equal(diagnostics.timeoutError, error);
assert.equal(diagnostics.snapshot().localTimeout.kind, 'deadline');
error.diagnostics = { source: 'orchestrator_timing', innerAcp: diagnostics.snapshot() };
const timeout = normalizeProviderError(error, 'subscription');
assert.equal(timeout.code, 'TIMEOUT');
assert.equal(timeout.diagnostics?.source, 'orchestrator_timing');
assert.equal(timeout.diagnostics?.innerAcp?.outgoingCancelCount, 3);

// Reconciliation starts a distinct ACP prompt turn without losing session-level cancellation history.
now += 300;
diagnostics.beginTurn({ idleTimeoutMs: 99, turnDeadlineMs: 999 });
assert.equal(diagnostics.timeoutError, null);
assert.equal(diagnostics.snapshot().turnNumber, 2);
assert.equal(diagnostics.snapshot().acpUpdateCount, 0);
assert.equal(diagnostics.snapshot().lastAcpUpdateType, null);
assert.equal(diagnostics.snapshot().outgoingCancelCount, 3);

for (let i = 0; i < 5; i += 1) diagnostics.sendCancel(null, 'session/cancel', 'inner-id', 'outer_signal');
assert.equal(diagnostics.snapshot().outgoingCancelCount, 8);
assert.equal(diagnostics.snapshot().outgoingCancels.length, 4, 'keep a bounded diagnostic history');
assert.equal(JSON.stringify(diagnostics.snapshot()).includes('prompt'), false, 'diagnostics must never capture prompt content');
console.log('turn-diagnostics: passed');
