import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCatalog} from '../../src/application/configuration/catalog.js';
import {setup, final} from '../fixtures/application.js';
import {decision, outcome, request} from '../fixtures/core.js';

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

test('C12R.1 single slot serves ready Workers and repeated independent Controller turns', async () => {
  const worker=id=>({kind:'delegate',actionId:id,profileId:'primary',objective:id,
    contextRefs:[],dependsOn:[],expectedResult:'Result'});
  let turns=0;
  const {api,invocations}=setup({maxInvocations:12,maxConcurrentInvocations:1,respond(i){
    if(i.kind==='delegate')return {dispatchCertainty:'sent',outcome:outcome(i.attemptId),output:i.actionId};
    if(++turns===1)return final(i,{finalAssessment:undefined,additions:[worker('a'),worker('b'),worker('c')],
      nextController:{continue:true}});
    const completed=i.context[1].value.outcomes.filter(o=>['a','b','c'].includes(o.actionId));
    if(completed.length===3)return final(i);
    return final(i,{finalAssessment:undefined,nextController:{continue:true}});
  }});
  const state=await(await api.submit(request())).completion;
  assert.equal(state.status,'finished');
  const order=invocations.map(i=>i.kind==='controller'?'controller':i.actionId);
  assert.equal(order.filter(x=>x!=='controller').length,3);
  assert.ok(order.indexOf('a')<order.lastIndexOf('controller'));
  assert.ok(order.length<12);
  await api.close();
});
