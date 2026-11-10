import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyEvent, createOperation, pendingControllerReasoning} from '../../../../src/core/operation.js';
import {decodeSnapshot, encodeSnapshot} from '../../../../src/core/snapshot.js';
import {decision, request, outcome} from '../../fixtures/core.js';

function apply(state, event, n) {
  const result = applyEvent(state, {eventId:'evt-'+n,operationId:'op-1',receivedAt:n,...event});
  assert.equal(result.kind,'applied', JSON.stringify(result.reason));
  return result.state;
}
test('C11R.3 one-shot selection comes only from accepted durable decision', () => {
  let state=createOperation('op-1',request(),'grant',{maxInvocations:5,maxConcurrentInvocations:2});
  const d=decision({finalAssessment:undefined,nextController:{continue:true,reasoningLevel:'high'}});
  state=apply(state,{kind:'controller.responded',decision:d},1);
  assert.deepEqual(pendingControllerReasoning(state),{decisionId:'decision-1',reasoningLevel:'high'});
  const invalid=applyEvent(state,{eventId:'bad',operationId:'op-1',receivedAt:2,
    kind:'attempt.reserved',attemptId:'ctl',actionId:'ctl'});
  assert.equal(invalid.kind,'rejected');
  state=apply(state,{kind:'attempt.reserved',attemptId:'ctl',actionId:'ctl',
    reasoningDecisionId:'decision-1'},2);
  assert.equal(pendingControllerReasoning(state),undefined);
  const route={configurationRef:'cfg',profileId:'primary',providerId:'p',model:'m',
    reasoning:{mode:'selectable',level:'high',nativeValue:'ultra',selectionSource:'model'}};
  state=apply(state,{kind:'attempt.dispatched',attemptId:'ctl',route},3);
  assert.equal(decodeSnapshot(encodeSnapshot(state)).kind,'accepted');
  const damaged=JSON.parse(encodeSnapshot(state));
  damaged.events[2].route.reasoning.level='low';
  assert.equal(decodeSnapshot(JSON.stringify(damaged)).kind,'corrupt');
  const different=JSON.parse(encodeSnapshot(state));
  different.events[1].reasoningDecisionId='unknown';
  assert.equal(decodeSnapshot(JSON.stringify(different)).reason.path,'$.events[1].reasoningDecisionId');
});

test('C11R.3 generation boundary discards unused choice and preserves legacy route', () => {
  let state=createOperation('op-1',request(),'grant',{maxInvocations:5,maxConcurrentInvocations:2});
  state=apply(state,{kind:'controller.responded',decision:decision({finalAssessment:undefined,
    nextController:{continue:true,reasoningLevel:'low'}})},1);
  state=apply(state,{kind:'operation.waiting',waiting:{kind:'question',questionId:'q',question:'Next?'}},2);
  state=apply(state,{kind:'operation.continued',input:{requestId:'r2',text:'Continue'}},3);
  assert.equal(pendingControllerReasoning(state),undefined);
  state=apply(state,{kind:'attempt.reserved',attemptId:'old',actionId:'old'},4);
  state=apply(state,{kind:'attempt.dispatched',attemptId:'old',route:{
    configurationRef:'prior',profileId:'primary',providerId:'p',model:'m',
  }},5);
  assert.equal(decodeSnapshot(encodeSnapshot(state)).kind,'accepted');
  assert.equal(decodeSnapshot(encodeSnapshot(state)).value.attempts[0].route.reasoning,undefined);
});

test('C11R review P2: worker route is bound to the admitted Action, even if both route copies are tampered',()=>{
  let state=createOperation('op-1',request(),'grant',{maxInvocations:5,maxConcurrentInvocations:2});
  const selected={actionId:'w1',kind:'delegate',objective:'Analyze',profileId:'worker',
    reasoningLevel:'high',contextRefs:[],dependsOn:[],expectedResult:'Findings'};
  state=apply(state,{kind:'controller.responded',
    decision:decision({finalAssessment:undefined,additions:[selected],
      waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:'w1'}]}}),
    admissions:[{kind:'accepted',action:selected}]},1);
  state=apply(state,{kind:'attempt.reserved',attemptId:'worker-attempt',actionId:'w1'},2);
  state=apply(state,{kind:'attempt.dispatched',attemptId:'worker-attempt',
    route:{configurationRef:'cfg',profileId:'worker',providerId:'p',model:'m',
      reasoning:{mode:'selectable',level:'high',nativeValue:'ultra',selectionSource:'model'}}},3);
  assert.equal(decodeSnapshot(encodeSnapshot(state)).kind,'accepted');
  const tampered=JSON.parse(encodeSnapshot(state));
  tampered.events[2].route.reasoning.level='low';
  tampered.attempts[0].route.reasoning.level='low';
  assert.equal(decodeSnapshot(JSON.stringify(tampered)).reason.path,'$.events[2].route.reasoning.level');
  const wrongSource=JSON.parse(encodeSnapshot(state));
  wrongSource.events[2].route.reasoning.selectionSource='default';
  wrongSource.attempts[0].route.reasoning.selectionSource='default';
  assert.equal(decodeSnapshot(JSON.stringify(wrongSource)).reason.path,'$.events[2].route.reasoning.selectionSource');
  const missing=JSON.parse(encodeSnapshot(state));
  missing.events[2].route.reasoning.mode='native';
  delete missing.events[2].route.reasoning.level;
  delete missing.events[2].route.reasoning.nativeValue;
  delete missing.events[2].route.reasoning.selectionSource;
  missing.attempts[0].route.reasoning={mode:'native'};
  assert.equal(decodeSnapshot(JSON.stringify(missing)).reason.path,'$.events[2].route.reasoning.level');
});
