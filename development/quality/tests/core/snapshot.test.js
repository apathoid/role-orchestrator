import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, createOperation, resourceSnapshot, sameRecord } from '../../../../src/core/operation.js';
import { decodeSnapshot, encodeSnapshot, SnapshotFormatError } from '../../../../src/core/snapshot.js';
import { decision, outcome, request } from '../../fixtures/core.js';

const initial = () => createOperation('op-1', request(), 'authority-ref', {
  maxInvocations: 4, maxConcurrentInvocations: 2,
});

function withHistory(observationValue = { exitCode: 0, details: ['possibly written', null] }) {
  const action = {
    actionId: 'worker', kind: 'delegate', objective: 'Execute', profileId: 'worker',
    contextRefs: ['request-1'], dependsOn: [], expectedResult: 'Report',
  };
  const unknown = outcome('worker-attempt', {
    terminal: 'unknown', effect: 'unknown', diagnostics: [{ code: 'DEADLINE_EXCEEDED' }],
    outputRefs: [{ ref: 'artifact-1', kind: 'output', source: 'provider_reported' }],
    usage: { inputTokens: 0, outputTokens: null, cost: null },
  });
  const events = [
    { kind: 'controller.responded', decision: decision({ additions: [action], finalAssessment: undefined }),
      admissions: [{ kind: 'accepted', action }] },
    { kind: 'attempt.reserved', actionId: 'worker', attemptId: 'worker-attempt' },
    { kind: 'attempt.dispatched', attemptId: 'worker-attempt' },
    { kind: 'attempt.outcome', outcome: unknown, dispatchCertainty: 'unknown',
      observations: [{ ref: 'obs-1', source: 'provider_reported', completeness: 'truncated', value: observationValue }] },
    { kind: 'attempt.reserved', actionId: 'other', attemptId: 'other-attempt' },
    { kind: 'operation.waiting', waiting: { kind: 'question', questionId: 'question-1', question: 'Continue?' } },
    { kind: 'operation.continued', input: { requestId: 'reply-1', questionId: 'question-1', text: 'Continue.' } },
  ];
  return events.reduce((state, event, index) => {
    const result = applyEvent(state, { ...event, eventId: 'event-' + index, receivedAt: index, operationId: 'op-1' });
    assert.equal(result.kind, 'applied');
    return result.state;
  }, initial());
}

test('snapshot v1 preserves pending reservations, model decisions and exact unknown outcomes', () => {
  const state = withHistory();
  const encoded = encodeSnapshot(state);
  assert.equal(JSON.parse(encoded).schemaVersion, 1);
  const restored = decodeSnapshot(encoded);
  assert.equal(restored.kind, 'accepted');
  assert.ok(sameRecord(restored.value, state));
  assert.equal(encodeSnapshot(restored.value), encoded);
  assert.equal(restored.value.attempts[0].dispatchCertainty, 'unknown');
  assert.equal(restored.value.attempts[0].outcome.terminal, 'unknown');
  assert.equal(restored.value.attempts[0].outcome.effect, 'unknown');
  assert.equal(restored.value.attempts[1].status, 'reserved');
  assert.equal(resourceSnapshot(restored.value).remaining, 2);
  assert.deepEqual(resourceSnapshot(restored.value).usage, {
    inputTokens: { known: 0, unknown: 0 },
    outputTokens: { known: 0, unknown: 1 },
    cost: { known: 0, unknown: 1 },
  });
});

test('omitted optional fields remain absent and a future major is identified before validating v1 fields', () => {
  const wire = JSON.parse(encodeSnapshot(initial()));
  assert.equal(Object.hasOwn(wire, 'waiting'), false);
  assert.equal(Object.hasOwn(wire.request, 'workspaceContext'), false);
  const restored = decodeSnapshot(JSON.stringify(wire));
  assert.equal(restored.kind, 'accepted');
  assert.equal(restored.value.assessment, undefined);
  assert.deepEqual(decodeSnapshot('{"schemaVersion":2,"future":"state"}'), { kind: 'unsupported_version', version: 2 });
  assert.equal(decodeSnapshot('{"schemaVersion":"1"}').reason.path, '$.schemaVersion');
  assert.equal(decodeSnapshot('{"schemaVersion":').kind, 'corrupt');
});

test('snapshot rejects malformed ledger records and cannot coerce unknown usage into zero', () => {
  const wire = JSON.parse(encodeSnapshot(withHistory()));
  delete wire.attempts[0].outcome.usage.cost;
  const absentUsage = decodeSnapshot(JSON.stringify(wire));
  assert.equal(absentUsage.kind, 'corrupt');
  assert.equal(absentUsage.reason.path, '$.attempts[0].outcome.usage.cost');
  wire.attempts[0].outcome.usage.cost = null;
  wire.attempts[0].outcome.attemptId = 'foreign';
  assert.equal(decodeSnapshot(JSON.stringify(wire)).reason.path, '$.attempts[0].outcome.attemptId');
});

test('snapshot rejects runtime handles instead of invoking their serializers', () => {
  const state = withHistory({ signal: new AbortController().signal });
  assert.throws(() => encodeSnapshot(state), error =>
    error instanceof SnapshotFormatError && error.reason.path === '$.events[3].observations[0].value.signal');
  const circular = {};
  circular.self = circular;
  assert.throws(() => encodeSnapshot(withHistory(circular)), SnapshotFormatError);
  assert.throws(() => encodeSnapshot({ ...initial(), permissions: { token: 'secret' } }), SnapshotFormatError);
});

test('snapshot rejects lifecycle regressions and fabricated no-effect outcomes', () => {
  const wire = () => JSON.parse(encodeSnapshot(withHistory()));
  const edits = [
    state => { state.attempts[0].status = 'reserved'; delete state.attempts[0].outcome; delete state.attempts[0].endedAt; },
    state => { delete state.attempts[0].dispatchedAt; },
    state => { state.attempts[0].route = { configurationRef: 'c', profileId: 'p', providerId: 'x', model: 'm' }; },
    state => { state.attempts[0].dispatchCertainty = 'sent'; },
    state => { state.attempts[0].outcome.effect = 'none'; state.attempts[0].outcome.terminal = 'failed'; },
    state => { [state.events[1], state.events[2]] = [state.events[2], state.events[1]]; },
  ];
  for (const edit of edits) {
    const damaged = wire();
    edit(damaged);
    assert.equal(decodeSnapshot(JSON.stringify(damaged)).kind, 'corrupt');
  }
});
