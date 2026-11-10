import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, createOperation, decodeRequest } from '../../../../src/main/index.js';
import { assessment, decision, outcome, request } from '../../fixtures/core.js';

function run(steps, maxConcurrentInvocations = 2) {
  let state = createOperation('op-1', decodeRequest(request()).value, 'authority',
    { maxInvocations: 6, maxConcurrentInvocations });
  const timeline = [];
  for (const [index, [kind, fields]] of steps.entries()) {
    const updated = applyEvent(state, {
      kind, ...fields, operationId: 'op-1', eventId: 'e' + index, receivedAt: index + 1,
    });
    assert.equal(updated.kind, 'applied', kind);
    state = updated.state;
    const { eventName, reasonCode, operationId, attemptId, actionId, details } = updated.diagnostic;
    timeline.push({ eventName, reasonCode, operationId, attemptId, actionId,
      subject: details?.subject, next: details?.next });
  }
  return timeline;
}
const reserved = (attemptId, actionId = attemptId) => ['attempt.reserved', { attemptId, actionId }];
const dispatched = attemptId => ['attempt.dispatched', { attemptId }];
const finished = (attemptId, terminal = 'completed', effect = 'confirmed', certainty = 'sent') =>
  ['attempt.outcome', { outcome: outcome(attemptId, { terminal, effect }), dispatchCertainty: certainty }];

test('C11.1 semantic trace: direct answer is correlated without unstable ids or timestamps', () => {
  const trace = run([
    reserved('controller'), dispatched('controller'), finished('controller'),
    ['controller.responded', { attemptId: 'controller', decision: decision() }],
    ['operation.finished', { assessment: assessment() }],
  ]);
  assert.deepEqual(trace.map(({ eventName, reasonCode, attemptId }) =>
    [eventName, reasonCode, attemptId ?? null]), [
    ['attempt.reserved', 'RESERVED', 'controller'], ['attempt.dispatched', 'DISPATCH_STARTED', 'controller'],
    ['attempt.outcome', 'COMPLETED', 'controller'], ['controller.responded', 'ACCEPTED', 'controller'],
    ['operation.finished', 'ASSESSMENT_RECORDED', null],
  ]);
  assert.ok(trace.every(x => x.operationId === 'op-1'));
});

test('C11.1 semantic trace: concurrent reservations have separate attempt and action ids', () => {
  const trace = run([reserved('a', 'worker-a'), reserved('b', 'worker-b'),
    dispatched('a'), dispatched('b'), finished('b'), finished('a')]);
  assert.deepEqual(trace.map(x => [x.eventName, x.actionId]), [
    ['attempt.reserved', 'worker-a'], ['attempt.reserved', 'worker-b'],
    ['attempt.dispatched', 'worker-a'], ['attempt.dispatched', 'worker-b'],
    ['attempt.outcome', 'worker-b'], ['attempt.outcome', 'worker-a'],
  ]);
});

test('C11.1 semantic trace: denial and defer identify subject and next route', () => {
  const trace = run([
    ['action.rejected', { actionId: 'denied', code: 'PERMISSION_DENIED' }],
    ['action.deferred', { actionId: 'pending', code: 'RESOURCE_LIMIT', resource: 'concurrency' }],
    ['operation.waiting', { waiting: { kind: 'technical', reason: { code: 'RESOURCE_LIMIT', operationId: 'op-1' } } }],
  ]);
  assert.deepEqual(trace.map(x => [x.reasonCode, x.actionId, x.subject, x.next]), [
    ['PERMISSION_DENIED', 'denied', 'action', 'controller_replan'],
    ['RESOURCE_LIMIT', 'pending', 'action', 'retry_when_capacity_allows'],
    ['RESOURCE_LIMIT', undefined, 'operation', 'explicit_resume'],
  ]);
});

test('C11.1 semantic trace: recovery, unknown effect and cancellation stay distinct', () => {
  const trace = run([
    reserved('a'), dispatched('a'),
    ['operation.recovered', { trusted: { authorityRef: 'authority', configurationRef: 'cfg',
      limits: { maxInvocations: 6, maxConcurrentInvocations: 2 } } }],
    finished('a', 'unknown', 'unknown', 'unknown'),
    ['operation.cancelled', { source: 'client' }],
  ]);
  assert.deepEqual(trace.map(x => [x.eventName, x.reasonCode, x.subject, x.next]), [
    ['attempt.reserved', 'RESERVED', undefined, undefined],
    ['attempt.dispatched', 'DISPATCH_STARTED', undefined, undefined],
    ['operation.recovered', 'RECOVERED', 'operation', 'controller_dispatch'],
    ['attempt.late_outcome', 'UNKNOWN', 'attempt', 'inspect'],
    ['operation.cancelled', 'CANCELLED', 'operation', 'inspect'],
  ]);
});
