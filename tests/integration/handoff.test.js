import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffContext, prepareHandoff } from '../../src/application/handoff.js';
import { createOperation, decodeRequest } from '../../src/main/index.js';
import { request } from '../fixtures/core.js';

const operation = createOperation('op', decodeRequest(request({ userConstraints: ['Read only'] })).value,
  'trusted', { maxInvocations: 2, maxConcurrentInvocations: 1 });
const profile = { profileId: 'worker', providerId: 'other', model: 'other-model' };
const catalog = [
  { kind: 'profile', value: profile },
  { kind: 'role', value: { id: 'review', instructions: 'Review the result.' } },
  { kind: 'skill', value: { id: 'checks', instructions: 'Assess recorded checks.' } },
];
const action = {
  kind: 'delegate', actionId: 'review-id', objective: 'Inspect the requested result', expectedResult: 'A finding',
  profileId: 'worker', roleId: 'review', skills: ['checks'], contextRefs: ['selected', 'missing'], dependsOn: [],
};

test('delegate handoff retains the chosen profile, trusted authority and only selected context', () => {
  const selected = { ref: 'selected', source: 'provider_reported', completeness: 'complete', value: 'Recorded output' };
  const other = { ref: 'other', source: 'model_claim', completeness: 'complete', value: 'Unselected claim' };
  const state = { ...operation, events: [{
    kind: 'attempt.outcome', outcome: { attemptId: 'historical-attempt', outputRefs: [] }, observations: [other, selected],
  }] };
  const result = prepareHandoff(operation, action, catalog);
  assert.equal(result.kind, 'accepted');
  assert.deepEqual(handoffContext(state, action.contextRefs, 4096), [
    { ...selected, attemptId: 'historical-attempt', receivedSequence: { revision: 1, index: 1 } },
    { ref: 'missing', source: 'host_observed', completeness: 'unavailable', unavailableReason: 'missing' },
  ]);
  assert.equal(result.handoff.objective, action.objective);
  assert.equal(result.handoff.expectedResult, action.expectedResult);
  assert.deepEqual(result.handoff.instructions, ['Review the result.', 'Assess recorded checks.']);
  assert.deepEqual(result.handoff.userConstraints, ['Read only']);
  assert.equal(result.handoff.profile, profile);
  assert.equal(result.handoff.authorityRef, 'trusted');
});

test('missing catalog entries produce a scoped refusal before invocation', () => {
  const result = prepareHandoff(operation, { ...action, roleId: 'unavailable' }, catalog);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.resource, 'unavailable');
  assert.deepEqual(result.reason, {
    code: 'CAPABILITY_UNAVAILABLE', operationId: 'op', actionId: 'review-id',
    dispatchCertainty: 'not_sent', effect: 'none',
  });
});
