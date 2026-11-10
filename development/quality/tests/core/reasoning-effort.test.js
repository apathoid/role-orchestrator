import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeDecision } from '../../../../src/core/contracts.js';
import { applyEvent, createOperation } from '../../../../src/core/operation.js';
import { decision, request } from '../../fixtures/core.js';

const next = values => decision({ finalAssessment: undefined, ...values });
function field(value, path) {
  const result = decodeDecision(value);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.reason.path, path);
}

test('C11R.1 accepts legacy decisions, arbitrary trusted-level identifiers and independent continuation', () => {
  assert.equal(decodeDecision(decision()).kind, 'accepted');
  assert.equal(decodeDecision(next({ nextController: { continue: true } })).kind, 'accepted');
  assert.equal(decodeDecision(next({ nextController: { continue: true, reasoningLevel: 'custom-effort' } })).kind, 'accepted');
  assert.equal(decodeDecision(next({ nextController: { reasoningLevel: 'high' }, waitPolicy: {
    kind: 'next_completion', targets: [{kind: 'attempt', id: 'running'}],
  } })).kind, 'accepted');
  const action = { actionId: 'a', kind: 'delegate', objective: 'Check', profileId: 'worker',
    reasoningLevel: 'xhigh', contextRefs: [], dependsOn: [], expectedResult: 'Evidence' };
  assert.equal(decodeDecision(next({additions: [action], nextController: {continue: true}})).kind, 'accepted');
});

test('C11R.1 rejects malformed field paths and incompatible Controller choices', () => {
  field(next({nextController: {}}), '$.nextController');
  field(next({nextController: {continue: false}}), '$.nextController.continue');
  field(next({nextController: {reasoningLevel: ''}}), '$.nextController.reasoningLevel');
  field(next({nextController: {reasoningLevel: 'high'}}), '$.nextController.continue');
  field(decision({nextController: {continue: true}}), '$.nextController');
  field(next({clarification: {question: 'Why?'}, nextController: {continue: true}}), '$.nextController');
  field(next({nextController: {continue: true}, waitPolicy: {
    kind: 'next_completion', targets: [{kind: 'attempt', id: 'a'}],
  }}), '$.nextController.continue');
  field(next({additions: [{actionId: 'a', kind: 'delegate', objective: '', profileId: 'p',
    contextRefs: [], dependsOn: [], expectedResult: '', reasoningLevel: null}]}), '$.additions[0].reasoningLevel');
});

test('C11R.1 decision identity includes next effort, without a hidden extra action', () => {
  const state = createOperation('op-1', request(), 'authority', {maxInvocations: 3, maxConcurrentInvocations: 1});
  const choice = decodeDecision(next({ nextController: {continue: true, reasoningLevel: 'high'} })).value;
  const event = {eventId: 'd1', receivedAt: 1, operationId: 'op-1',
    kind: 'controller.responded', decision: choice};
  const applied = applyEvent(state, event);
  assert.equal(applied.kind, 'applied');
  assert.equal(applied.state.attempts.length, 0);
  assert.equal(applyEvent(applied.state, {...event, eventId: 'd2'}).kind, 'duplicate');
  const changed = applyEvent(applied.state, {...event, eventId: 'd3',
    decision: {...choice, nextController: {continue: true, reasoningLevel: 'low'}}});
  assert.equal(changed.kind, 'rejected');
  assert.equal(changed.reason.code, 'IDENTITY_CONFLICT');
});
