import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCatalog} from '../../../../src/application/configuration/catalog.js';
import {operationView, operationTrace} from '../../../../src/hosts/commands.js';
import {setup, final} from '../../fixtures/application.js';
import {decision, outcome, request} from '../../fixtures/core.js';

test('C11R.6 unsupported own effort surfaces durable failure, no fallback, explicit resume', async () => {
  const profile={profileId:'primary',providerId:'fixture',model:'same'};
  const trusted=createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',reasoningEffort:[
      {level:'low',effort:'low-native'}, {level:'high',effort:'high-native'}],defaultReasoningLevel:'low'}},
    controllerProfile:'primary'});
  let repaired=false;
  const catalog={...trusted,selectReasoning(id,level){
    return repaired ? trusted.selectReasoning(id) : trusted.selectReasoning(id,level);
  }};
  const {api,invocations}=setup({profile,catalog,maxInvocations:5,respond(i,n){
    if(n===1) return {dispatchCertainty:'sent',outcome:outcome(i.attemptId),
      output:decision({operationId:i.operationId,decisionId:'choose-unsupported',finalAssessment:undefined,
        nextController:{continue:true,reasoningLevel:'ultra'}})};
    return final(i,{decisionId:'corrected'});
  }});
  const waiting=await (await api.submit(request())).completion;
  assert.equal(waiting.status,'waiting');
  assert.equal(invocations.length,1,'failed selection must not open or invoke');
  assert.equal(waiting.waiting.reason.code,'CAPABILITY_UNAVAILABLE');
  assert.equal(waiting.waiting.reason.profileId,'primary');
  assert.equal(waiting.waiting.reason.reasoningLevel,'ultra');
  assert.deepEqual(waiting.waiting.reason.availableLevels,['high','low']);
  assert.equal(waiting.attempts[1].dispatchCertainty,'not_sent');
  assert.equal(waiting.attempts[1].outcome.effect,'none');
  assert.equal(operationView(waiting).waiting.reason.reasoningLevel,'ultra');
  assert.equal(operationTrace(waiting).waiting.reasoningLevel,'ultra');
  repaired=true;
  const resumed=await (await api.resume(waiting.operationId,{requestId:'followup-1',
    text:'Continue with corrected trusted provider settings'})).completion;
  assert.equal(resumed.status,'finished');
  assert.equal(invocations.length,2);
  assert.equal(invocations[1].reasoning.level,'low');
  assert.equal(resumed.attempts.length,3);
  assert.equal(resumed.attempts[1].outcome.effect,'none');
  await api.close();
});

test('C11R.6 unsupported configured Controller default fails before opening provider', async () => {
  const profile={profileId:'primary',providerId:'fixture',model:'same',
    reasoning:{mode:'selectable',levels:['one'],defaultLevel:'one'}};
  const {api,invocations}=setup({profile,maxInvocations:2});
  const result=await (await api.submit(request())).completion;
  assert.equal(result.waiting.reason.code,'CAPABILITY_UNAVAILABLE');
  assert.equal(result.waiting.reason.profileId,'primary');
  assert.deepEqual(result.waiting.reason.availableLevels,['one']);
  assert.equal(invocations.length,0);
  await api.close();
});
