import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAuthorityGrant} from '../../src/main/index.js';
import {createCatalog} from '../../src/application/configuration/catalog.js';
import {setup,final} from '../fixtures/application.js';
import {decision,outcome,request} from '../fixtures/core.js';

test('C11R.11 direct native Controller replans from worker failure and changes worker efforts',async()=>{
  const profile={profileId:'primary',providerId:'fixture',model:'default-native'};
  const catalog=createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'default-native'},
      worker:{provider:'fixture',model:'reviewer',reasoningEffort:[
        {level:'low',effort:'small'}, {level:'high',effort:'large'},
      ],defaultReasoningLevel:'low'}},controllerProfile:'primary'});
  const worker=(id,level)=>({actionId:id,kind:'delegate',profileId:'worker',reasoningLevel:level,
    objective:'Investigate '+id,expectedResult:'Evidence',contextRefs:[],dependsOn:[]});
  const propose=(i,actions)=>({dispatchCertainty:'sent',outcome:outcome(i.attemptId),output:decision({
    operationId:i.operationId,decisionId:'plan-'+i.attemptId,finalAssessment:undefined,additions:actions,
    waitPolicy:{kind:'all_requested',targets:actions.map(item=>({kind:'action',id:item.actionId}))},
  })});
  const {api,invocations}=setup({profile,catalog,maxInvocations:9,maxConcurrentInvocations:3,
    authority:createAuthorityGrant({reference:'fixture-authority',origin:'user',profileIds:['primary','worker']}),
    respond(i){
      if(i.kind==='delegate'){
        if(i.actionId==='first')throw Error('disconnected worker, effect unknown');
        return {dispatchCertainty:'sent',outcome:outcome(i.attemptId),output:'Observed '+i.actionId};
      }
      const outcomes=new Set(i.context[1].value.outcomes.map(item=>item.actionId));
      if(!outcomes.has('first'))return propose(i,[worker('first','high'),worker('second','low')]);
      if(!outcomes.has('third'))return propose(i,[worker('third','low')]);
      return final(i,{decisionId:'completed-replan'});
    },
  });
  const state=await(await api.submit(request())).completion;
  assert.equal(state.status,'finished');
  assert.deepEqual(invocations.filter(i=>i.kind==='controller').map(i=>i.reasoning.mode),
    ['native','native','native']);
  assert.deepEqual(invocations.filter(i=>i.kind==='delegate').map(i=>[i.actionId,i.reasoning.nativeValue]).sort(),
    [['first','large'],['second','small'],['third','small']]);
  assert.equal(state.attempts.find(item=>item.actionId==='first').outcome.effect,'unknown');
  assert.equal(state.events.filter(event=>event.kind==='controller.responded').length,3);
  assert.equal(state.attempts.length,6);
  assert.equal(state.attempts.find(item=>item.actionId==='third').route.reasoning.level,'low');
  await api.close();
});

test('C11R.11 provider without selectable contract rejects before open; native still executes',async()=>{
  let opens=0;
  const profile={profileId:'primary',providerId:'fixture',model:'same'};
  const endpoint={
    async describe(){return {providerId:'fixture',maxConcurrency:2,capabilities:{}};},
    async open(){opens++;return {sessionId:'one'};},
    async invoke(_session,i){return final(i);},
    async cancel(){},async close(){},
  };
  const selectable=createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',reasoningEffort:[
      {level:'low',effort:'native-low'}]}},controllerProfile:'primary'});
  const blocked=setup({profile,catalog:selectable,provider:endpoint,maxInvocations:2});
  const failed=await(await blocked.api.submit(request({requestId:'blocked'}))).completion;
  assert.equal(failed.status,'waiting');
  assert.equal(failed.waiting.reason.code,'CAPABILITY_UNAVAILABLE');
  assert.equal(failed.waiting.reason.profileId,'primary');
  assert.equal(opens,0);
  await blocked.api.close();
  const native=setup({profile,provider:endpoint,maxInvocations:2});
  const finished=await(await native.api.submit(request({requestId:'native'}))).completion;
  assert.equal(finished.status,'finished');
  assert.equal(opens,1);
  await native.api.close();
});
