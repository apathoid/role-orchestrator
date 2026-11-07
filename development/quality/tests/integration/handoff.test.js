import assert from 'node:assert/strict';
import { test } from 'node:test';
import { materializeHandoff } from '../../../../src/application/handoff.js';
import { createOperation, decodeRequest } from '../../../../src/main/index.js';
import { request } from '../../fixtures/core.js';

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
  const result = materializeHandoff(operation, action, catalog, [other, selected]);
  assert.equal(result.kind, 'accepted');
  assert.deepEqual(result.handoff.context, [selected, { ref: 'missing', source: 'host_observed', completeness: 'unavailable' }]);
  assert.equal(result.handoff.objective, action.objective);
  assert.equal(result.handoff.expectedResult, action.expectedResult);
  assert.deepEqual(result.handoff.instructions, ['Review the result.', 'Assess recorded checks.']);
  assert.deepEqual(result.handoff.userConstraints, ['Read only']);
  assert.equal(result.handoff.profile, profile);
  assert.equal(result.handoff.authorityRef, 'trusted');
});

test('missing catalog entries produce a scoped refusal before invocation', () => {
  const result = materializeHandoff(operation, { ...action, roleId: 'unavailable' }, catalog, []);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.resource, 'unavailable');
  assert.deepEqual(result.reason, {
    code: 'CAPABILITY_UNAVAILABLE', operationId: 'op', actionId: 'review-id',
    dispatchCertainty: 'not_sent', effect: 'none',
  });
});
