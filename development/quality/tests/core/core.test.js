import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyEvent, createOperation, decodeDecision, decodeOutcome, decodeRequest, emitDiagnostic, resourceSnapshot,
} from '../../../../src/main/index.js';
import { assessment, decision, outcome, request } from '../../fixtures/core.js';

const initial = (limits = { maxInvocations: 3, maxConcurrentInvocations: 1 }) =>
  createOperation('op-1', decodeRequest(request()).value, 'test-authority', limits);
const event = (eventId, kind, fields) => ({ eventId, kind, operationId: 'op-1', receivedAt: 100, ...fields });
const reserve = (id, overrides) => event('reserve-' + id, 'attempt.reserved', { attemptId: id, actionId: 'a-' + id, ...overrides });
const dispatch = id => event('dispatch-' + id, 'attempt.dispatched', { attemptId: id });
const finish = (id, report = outcome(id), certainty = 'sent', eventId = 'finish-' + id) =>
  event(eventId, 'attempt.outcome', { outcome: report, dispatchCertainty: certainty });
const apply = (state, value) => {
  const result = applyEvent(state, value);
  assert.equal(result.kind, 'applied', JSON.stringify(result.reason));
  return result.state;
};
const field = (result, path) => {
  assert.equal(result.kind, 'rejected');
  assert.equal(result.reason.path, path);
};

test('decoders reject exact fields and preserve literal request without workspace', () => {
  const prompt = '  буквальный запрос\n';
  assert.equal(decodeRequest(request({ text: prompt })).value.text, prompt);
  assert.equal(decodeRequest(request()).value.workspaceContext, undefined);
  field(decodeRequest(request({ requestId: undefined })), '$.requestId');
  field(decodeRequest(request({ workspaceContext: { cwd: false } })), '$.workspaceContext.cwd');
  field(decodeRequest(request({ schemaVersion: 2 })), '$.schemaVersion');
  field(decodeRequest(request({ authority: 'forged' })), '$.authority');
  assert.equal(decodeDecision(decision()).kind, 'accepted');
  field(decodeDecision(decision({ finalAssessment: assessment({ overall: 'pass' }) })), '$.finalAssessment.overall');
  field(decodeDecision(decision({ clarification: { question: 'Which one?' } })), '$.finalAssessment');
  field(decodeDecision(decision({ finalAssessment: undefined })), '$');
  field(decodeOutcome(outcome('a', { terminal: 'tool_failed' })), '$.terminal');
  field(decodeOutcome(outcome('a', { usage: { inputTokens: 0, outputTokens: -1, cost: null } })), '$.usage.outputTokens');
});

test('events and decisions are idempotent, scoped, and leave earlier snapshots intact', () => {
  const state = initial();
  const reservation = reserve('first');
  const next = apply(state, reservation);
  assert.equal(state.revision, 0);
  assert.equal(state.attempts.length, 0);
  assert.equal(next.revision, 1);
  assert.equal(applyEvent(next, reservation).kind, 'duplicate');
  assert.equal(applyEvent(next, { ...reservation, actionId: 'different' }).reason.code, 'IDENTITY_CONFLICT');
  assert.equal(applyEvent(next, finish('unrelated')).kind, 'rejected');
  assert.equal(applyEvent(next, { ...dispatch('first'), operationId: 'other' }).kind, 'rejected');

  const answer = event('decision', 'controller.responded', { decision: decodeDecision(decision()).value });
  const decided = apply(next, answer);
  assert.equal(applyEvent(decided, { ...answer, eventId: 'redelivery' }).kind, 'duplicate');
  const modified = { ...answer.decision, contextCursor: 4 };
  assert.equal(applyEvent(decided, { ...answer, eventId: 'conflict', decision: modified }).reason.code, 'IDENTITY_CONFLICT');
});

test('terminal completion is distinct from assessment and provenance survives decoding', () => {
  let state = apply(initial(), reserve('first'));
  state = apply(state, dispatch('first'));
  const report = decodeOutcome(outcome('first', {
    outputRefs: [
      { ref: 'exit-1', source: 'host_observed', kind: 'agent_exit' },
      { ref: 'exit-2', source: 'provider_reported', kind: 'tool_exit' },
      { ref: 'exit-3', source: 'model_claim', kind: 'tool_exit' },
    ],
  })).value;
  state = apply(state, finish('first', report));
  assert.equal(state.status, 'active');
  assert.deepEqual(state.attempts[0].outcome.outputRefs, report.outputRefs);
  state = apply(state, event('final', 'operation.finished', { assessment: assessment() }));
  assert.equal(state.status, 'finished');
  assert.equal(state.assessment.overall, 'partial');
});

test('reservation enforces exact counts and keeps unknown usage separate from zero', () => {
  let state = apply(initial({ maxInvocations: 2, maxConcurrentInvocations: 1 }), reserve('first'));
  assert.equal(applyEvent(state, reserve('second')).reason.code, 'RESOURCE_LIMIT');
  state = apply(state, finish('first', outcome('first', { terminal: 'failed' }), 'not_sent'));
  state = apply(state, reserve('second'));
  state = apply(state, dispatch('second'));
  const report = finish('second', outcome('second', {
    usage: { inputTokens: 0, outputTokens: 2, cost: null }, terminal: 'failed', effect: 'possible',
  }));
  state = apply(state, report);
  assert.equal(applyEvent(state, { ...report, eventId: 'replayed' }).kind, 'duplicate');
  assert.deepEqual(resourceSnapshot(state), {
    active: 0, charged: 2, remaining: 0,
    usage: { inputTokens: { known: 0, unknown: 1 }, outputTokens: { known: 2, unknown: 1 }, cost: { known: 0, unknown: 2 } },
  });
  assert.equal(applyEvent(state, reserve('third')).reason.code, 'RESOURCE_LIMIT');
});

test('cancel records provenance and late results never reopen the operation', () => {
  let state = apply(initial({ maxInvocations: 3, maxConcurrentInvocations: 2 }), reserve('first'));
  state = apply(state, dispatch('first'));
  state = apply(state, reserve('second'));
  const cancelled = applyEvent(state, event('cancel', 'operation.cancelled', { source: 'user' }));
  assert.deepEqual(cancelled.intents, [{ kind: 'cancel', attemptId: 'first', source: 'user' }]);
  assert.equal(cancelled.state.attempts[0].status, 'dispatched');
  assert.equal(applyEvent(cancelled.state, dispatch('second')).reason.code, 'CANCELLED');
  const late = applyEvent(cancelled.state, finish('first', outcome('first', { terminal: 'unknown', effect: 'unknown' }), 'unknown'));
  assert.equal(late.diagnostic.eventName, 'attempt.late_outcome');
  assert.equal(late.state.status, 'cancelled');
  assert.equal(late.state.attempts[0].outcome.effect, 'unknown');
  const resolved = apply(late.state, finish('first', outcome('first', { terminal: 'completed', effect: 'confirmed' }), 'sent', 'late-confirmation'));
  assert.equal(resolved.status, 'cancelled');
  assert.equal(resolved.attempts[0].outcome.effect, 'confirmed');
});

test('contradictory terminal reports remain visible without replacing the original result', () => {
  let state = apply(initial(), reserve('first'));
  state = apply(state, dispatch('first'));
  state = apply(state, finish('first'));
  const contradictory = finish('first', outcome('first', { terminal: 'failed' }), 'sent', 'contradiction');
  const result = applyEvent(state, contradictory);
  assert.equal(result.diagnostic.eventName, 'attempt.outcome_discrepancy');
  assert.equal(result.diagnostic.attemptId, 'first');
  assert.equal(result.diagnostic.sequence, state.revision + 1);
  assert.equal(result.state.events.at(-1), contradictory);
  assert.equal(result.state.attempts[0].outcome.terminal, 'completed');
  assert.equal(applyEvent(result.state, contradictory).kind, 'duplicate');
  emitDiagnostic({ emit() { throw Error('sink offline'); }, flush() {} }, result.diagnostic);
  assert.equal(result.state.attempts[0].outcome.terminal, 'completed');
});
