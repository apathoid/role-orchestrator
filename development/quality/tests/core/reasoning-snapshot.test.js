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
