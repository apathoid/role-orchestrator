import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCatalog} from '../../../../src/application/configuration/catalog.js';
import {setup, final} from '../../fixtures/application.js';
import {decision, outcome, request} from '../../fixtures/core.js';

test('C11R.5 single Controller can choose high, then medium, then high without workers or external events', async () => {
  const profile={profileId:'primary',providerId:'fixture',model:'same'};
  const config={schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',reasoningEffort:[
      {level:'medium',effort:'normal'}, {level:'high',effort:'deep'},
    ],defaultReasoningLevel:'medium'}},controllerProfile:'primary'};
  const catalog=createCatalog(config);
  const levels=['high','medium','high'];
  const {api,invocations}=setup({profile,catalog,maxInvocations:8,
    respond(invocation,index) {
      if (index<=3) return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),
        output:decision({operationId:invocation.operationId,decisionId:'shift-'+index,
          finalAssessment:undefined,nextController:{continue:true,reasoningLevel:levels[index-1]}})};
      return final(invocation,{decisionId:'final-choice'});
    },
  });
  const result=await (await api.submit(request())).completion;
  assert.equal(result.status,'finished');
  assert.equal(result.attempts.length,4);
  assert.deepEqual(invocations.map(i=>i.reasoning.nativeValue),['normal','deep','normal','deep']);
  assert.deepEqual(result.attempts.map(i=>i.route.reasoning.selectionSource),['default','model','model','model']);
  assert.equal(result.events.filter(e=>e.kind==='controller.responded').length,4);
  assert.equal(result.events.filter(e=>e.kind==='action.rejected').length,0);
  await api.close();
});

test('C11R.5 continue with no explicit level uses default, no sticky selection', async () => {
  const profile={profileId:'primary',providerId:'fixture',model:'same'};
  const catalog=createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',reasoningEffort:[
      {level:'high',effort:'high'}, {level:'low',effort:'low'}],defaultReasoningLevel:'low'}},controllerProfile:'primary'});
  const {api,invocations}=setup({profile,catalog,maxInvocations:4,respond(i,n){
    if(n===1)return {dispatchCertainty:'sent',outcome:outcome(i.attemptId),output:decision({
      operationId:i.operationId,decisionId:'one',finalAssessment:undefined,
      nextController:{continue:true,reasoningLevel:'high'}})};
    if(n===2)return {dispatchCertainty:'sent',outcome:outcome(i.attemptId),output:decision({
      operationId:i.operationId,decisionId:'two',finalAssessment:undefined,nextController:{continue:true}})};
    return final(i,{decisionId:'three'});
  }});
  const result=await (await api.submit(request())).completion;
  assert.equal(result.status,'finished');
  assert.deepEqual(invocations.map(i=>i.reasoning.level),['low','high','low']);
  await api.close();
});
