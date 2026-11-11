import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffContext, materializeSkillInstructions, prepareHandoff } from '../../src/application/handoff.js';
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
  assert.deepEqual(result.handoff.instructions, ['Review the result.']);
  assert.deepEqual(result.handoff.skillInstructions, [{id:'checks',status:'complete',instructions:'Assess recorded checks.'}]);
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

test('selected inline and loaded skills are attributed, bounded, and never duplicated or substituted', async () => {
  const selected = [{id:'inline',version:'v1',status:'complete',instructions:'abc'},
    {id:'loaded',version:'v2',status:'unavailable',reason:'not_loaded'},
    {id:'changed',version:'v1',status:'unavailable',reason:'not_loaded'},
    {id:'missing',status:'unavailable',reason:'not_loaded'}];
  const calls = [];
  const catalog = {async loadSkill(id) {
    calls.push(id);
    if (id === 'loaded') return {id,version:'v2',status:'complete',instructions:'😀😀'};
    if (id === 'changed') return {id,version:'v2',status:'complete',instructions:'wrong version'};
    return {id,status:'unavailable',reason:'resource_unavailable'};
  }};
  const signal = new AbortController().signal;
  const material = await materializeSkillInstructions(selected,catalog,8,signal);
  assert.deepEqual(calls,['loaded','changed','missing']);
  assert.deepEqual(material,[{id:'inline',version:'v1',status:'complete',instructions:'abc'},
    {id:'loaded',version:'v2',status:'truncated',instructions:'😀'},
    {id:'changed',version:'v1',status:'unavailable',reason:'version_changed'},
    {id:'missing',status:'unavailable',reason:'resource_unavailable'}]);
  assert.deepEqual(await materializeSkillInstructions([selected[1]],{},32,signal),
    [{id:'loaded',version:'v2',status:'unavailable',reason:'loader_unavailable'}]);
});

test('C12R.9.5: native execution needs no Host skill registration; explicit unknown Catalog skill rejects', () => {
  const operation=createOperation('native-skills', request(), 'grant',
    { maxInvocations: 3, maxConcurrentInvocations: 1 });
  const native={ actionId:'native-execution',kind:'delegate',profileId:'worker',
    objective:'Use available native project files, scripts, skills and terminal',
    contextRefs:[],dependsOn:[],expectedResult:'A provider report',skills:[] };
  const entries=[{kind:'profile',value:{profileId:'worker',providerId:'p',model:'m'}}];
  const allowed=prepareHandoff(operation,native,entries);
  assert.equal(allowed.kind,'accepted');
  assert.equal(allowed.handoff.skillInstructions,undefined);
  assert.match(allowed.handoff.objective,/native project files/);
  const rejected=prepareHandoff(operation,{...native,skills:['catalog-does-not-exist']},entries);
  assert.equal(rejected.kind,'rejected');
  assert.equal(rejected.category,'skill');
  assert.equal(rejected.reason.code,'CAPABILITY_UNAVAILABLE');
  assert.equal(rejected.reason.effect,'none');
});
