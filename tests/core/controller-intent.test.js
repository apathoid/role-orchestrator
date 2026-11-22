import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeControllerIntent } from '../../src/core/controller-intent.js';
import { materializeControllerIntent } from '../../src/application/controller-intent.js';
import { decodeDecision } from '../../src/core/contracts.js';

const binding = { operationId: 'op-18', attemptId: 'attempt-18', contextCursor: 7, profileId: 'controller-profile' };
const simple = answer => ({finalAssessment: {overall: 'complete', answer}});
const field = (value, path) => {
  assert.equal(value.kind, 'rejected');
  assert.equal(value.reason.path, path);
};

test('C18.1 minimal model-owned intent preserves unicode, Markdown and trust binding', () => {
  const answer = '# Готово 🎯\n\n{"answer":true}';
  const decoded = decodeControllerIntent(simple(answer));
  assert.equal(decoded.kind, 'accepted');
  assert.deepEqual(decoded.value.additions, []);
  assert.deepEqual(decoded.value.cancellations, []);
  assert.deepEqual(decoded.value.finalAssessment.requirements, []);
  assert.deepEqual(decoded.value.finalAssessment.observationRefs, []);
  assert.deepEqual(decoded.value.finalAssessment.findingRefs, []);
  assert.deepEqual(decoded.value.finalAssessment.unresolvedQuestions, []);
  assert.ok(!Object.hasOwn(decoded.value.finalAssessment, 'author'));
  const a = materializeControllerIntent(simple(answer), binding);
  const b = materializeControllerIntent(simple(answer), binding);
  assert.equal(a.kind, 'accepted');
  assert.deepEqual(a, b);
  assert.equal(decodeDecision(a.value).kind, 'accepted');
  assert.equal(a.value.operationId, binding.operationId);
  assert.equal(a.value.contextCursor, 7);
  assert.equal(a.value.finalAssessment.author, binding.profileId);
  assert.equal(a.value.finalAssessment.answer, answer);
  assert.notEqual(materializeControllerIntent(simple(answer + '!'), binding).value.decisionId, a.value.decisionId);
  assert.notEqual(materializeControllerIntent(simple(answer), {...binding,attemptId:'other'}).value.decisionId, a.value.decisionId);
});

test('C18.1 preserves full Decision v1 model combinations and nested references', () => {
  const action = {
    actionId: 'a1', kind: 'delegate', objective: 'Review 🧭', expectedResult: 'Report', profileId: 'worker',
    skills: ['skill'], requiredCapabilities: ['input.text'], roleId: 'reviewer',
    reasoningLevel: 'high', continuationReference: 'ctx', retryOf: 'old-attempt', retryBasis: 'no_effect',
    dependsOn: [{actionId:'prior',kind:'after_model_acceptance'}],
  };
  const input = {
    additions:[action], cancellations:['old-action'], acceptedActionIds:['prior'],
    waitPolicy:{kind:'next_completion',targets:[{kind:'action',id:'a1'}]},
    findings:[{findingId:'f1',claim:'Found',subject:'module',supersedes:'finding:before'}],
  };
  const output = materializeControllerIntent(input,binding);
  assert.equal(output.kind, 'accepted');
  assert.deepEqual(output.value.additions[0].dependsOn, action.dependsOn);
  assert.deepEqual(output.value.additions[0].contextRefs, []);
  assert.deepEqual(output.value.findings[0].supports, []);
  assert.equal(output.value.findings[0].author, binding.profileId);
  const follow = materializeControllerIntent({
    nextController:{continue:true,reasoningLevel:'high',
      contextRequest:{refs:[{ref:{revision:3,index:2},offset:4}],cursor:{revision:4,index:5},workCursor:0}},
    findings: [{findingId:'f2',claim:'Needs evidence',subject:'test',supports:['evidence:1'],uncertainties:['uncertain']}],
  },binding);
  assert.equal(follow.kind,'accepted');
  assert.equal(follow.value.nextController.contextRequest.cursor.revision,4);
  const partial=materializeControllerIntent({
    finalAssessment:{overall:'partial', answer:'Partly done',
      requirements:[{requirementId:'r1',status:'unverified',reason:'Missing observed check'}],
      unresolvedQuestions:['Did the check run?']},
  },binding);
  assert.equal(partial.kind,'accepted');
  assert.deepEqual(partial.value.finalAssessment.requirements[0].findingRefs,[]);
});

test('C18.1 rejects Host fields, unknowns, nulls and canonical semantic conflicts addressably', () => {
  field(decodeControllerIntent({...simple('text'),schemaVersion:1}),'$.schemaVersion');
  field(decodeControllerIntent({...simple('text'),operationId:'spoof'}),'$.operationId');
  field(decodeControllerIntent({...simple('text'),unexpected:true}),'$.unexpected');
  field(decodeControllerIntent({finalAssessment:{...simple('x').finalAssessment,author:'spoof'}}),'$.finalAssessment.author');
  field(decodeControllerIntent({findings:[{findingId:'f',claim:'x',subject:'y',author:'spoof'}],
    nextController:{continue:true}}),'$.findings[0].author');
  field(decodeControllerIntent({...simple('x'),cancellations:null}),'$.cancellations');
  field(decodeControllerIntent({finalAssessment:{overall:'complete',answer:'ok',
    requirements:[{requirementId:'r',status:'fulfilled',findingRefs:null}]}}),
  '$.finalAssessment.requirements[0].findingRefs');
  field(decodeControllerIntent({finalAssessment:{overall:'complete',answer:'done'},
    additions:[{actionId:'a',kind:'delegate',profileId:'x',objective:'y',expectedResult:'z'}]}),
  '$.finalAssessment');
  field(decodeControllerIntent({additions:[{actionId:'a',kind:'delegate',profileId:'x',
    objective:'y',expectedResult:'z',retryBasis:'no_effect'}],
    nextController:{continue:true}}),'$.additions[0].retryOf');
});

test('C18.1 large fully valid model Assessment is not truncated in decoding/materialization', () => {
  const text = 'Δ🧩'.repeat(28_000);
  const result = materializeControllerIntent(simple(text),binding);
  assert.equal(result.kind,'accepted');
  assert.equal(result.value.finalAssessment.answer,text);
});
