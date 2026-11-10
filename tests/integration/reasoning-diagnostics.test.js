import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCatalog} from '../../src/application/configuration/catalog.js';
import {operationTrace,operationView} from '../../src/hosts/commands.js';
import {setup,final} from '../fixtures/application.js';
import {decision,outcome,request} from '../fixtures/core.js';
import {applyEvent,createOperation} from '../../src/core/operation.js';
import {observation} from '../../src/core/observation.js';
import {decodeSnapshot,encodeSnapshot} from '../../src/core/snapshot.js';

test('C11R.10 redact native mapping from Controller context, preserve bounded per-attempt trace facts',async()=>{
  const profile={profileId:'primary',providerId:'fixture',model:'same'};
  const catalog=createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',reasoningEffort:[
      {level:'low',effort:'internal-low-token'}, {level:'high',effort:'internal-high-token'},
    ],defaultReasoningLevel:'low'}},controllerProfile:'primary'});
  const {api,invocations}=setup({profile,catalog,maxInvocations:4,emit(){throw Error('disconnected sink');},
    respond(invocation,n){
      if(n===1)return{dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),output:decision({
        operationId:invocation.operationId,decisionId:'select-high',finalAssessment:undefined,
        nextController:{continue:true,reasoningLevel:'high'},
      })};
      return final(invocation,{decisionId:'done'});
    },
  });
  const state=await(await api.submit(request())).completion;
  assert.equal(state.status,'finished');
  assert.deepEqual(invocations.map(i=>i.reasoning.nativeValue),['internal-low-token','internal-high-token']);
  assert.ok(!JSON.stringify(invocations[1].context).includes('internal-low-token'));
  assert.ok(!JSON.stringify(invocations[1].context).includes('internal-high-token'));
  assert.equal(invocations[1].context[1].value.controllerReasoning.current.level,'high');
  const trace=operationTrace(state);
  assert.equal(trace.attempts.length,2);
  assert.equal(trace.attempts[0].reasoning.effective.nativeValue,'internal-low-token');
  assert.equal(trace.attempts[0].reasoning.requestedLevel,undefined);
  assert.equal(trace.attempts[1].reasoning.requestedLevel,'high');
  assert.equal(trace.attempts[1].reasoning.source,'model');
  assert.equal(trace.attempts[1].reasoning.submission,'sent');
  assert.equal(trace.attempts[1].reasoning.nativeConfigAcknowledgment,'not_recorded');
  assert.deepEqual(trace.controllerReasoning.consumed,[{attemptId:state.attempts[1].attemptId,decisionId:'select-high'}]);
  assert.equal(trace.controllerReasoning.pending,null);
  assert.equal(operationView(state).pendingControllerReasoning,null);
  const scrubbed=operationTrace(state,{secrets:['internal-high-token']});
  assert.ok(!JSON.stringify(scrubbed).includes('internal-high-token'));
  assert.ok(!JSON.stringify(trace).includes('model content from provider'));
  await api.close();
});

test('C11R.10 native historical route is explicitly unrecorded, not presumed acknowledged',async()=>{
  const profile={profileId:'primary',providerId:'fixture',model:'same'};
  const {api}=setup({profile,respond:i=>final(i)});
  const state=await(await api.submit(request({requestId:'trace-native'}))).completion;
  const trace=operationTrace(state);
  assert.equal(trace.attempts[0].reasoning.effective.mode,'native');
  assert.equal(trace.attempts[0].reasoning.nativeConfigAcknowledgment,'not_recorded');
  assert.equal(trace.attempts[0].reasoning.submission,'sent');
  assert.equal(trace.attempts[0].reasoning.configurationRef,'test-config');
  await api.close();
});

test('C11R review P2: late outcome cannot erase durable ACP reasoning ACK in trace',()=>{
  let state=createOperation('ack-operation',request(),'grant',{maxInvocations:3,maxConcurrentInvocations:1});
  const add=(kind,fields,n)=>{
    const event={eventId:'ack-'+n,receivedAt:n,operationId:'ack-operation',kind,...fields};
    const accepted=applyEvent(state,event);
    assert.equal(accepted.kind,'applied',JSON.stringify(accepted.reason));
    state=accepted.state;
  };
  add('attempt.reserved',{attemptId:'worker',actionId:'worker'},1);
  add('attempt.dispatched',{attemptId:'worker',route:{
    configurationRef:'cfg',profileId:'primary',providerId:'acp',model:'m',
    reasoning:{mode:'selectable',level:'high',nativeValue:'deep',selectionSource:'default'},
  }},2);
  const ack={...observation({ref:'ack-observation',value:{
    status:'config_option_confirmed',level:'high',profileId:'primary'},
    completeness:'complete'},{
    kind:'host_transport',sourceId:'worker',receivedAt:3,
  }),providerRef:'acp-reasoning-ack'};
  add('attempt.outcome',{outcome:outcome('worker',{terminal:'unknown',effect:'unknown'}),
    dispatchCertainty:'sent',observations:[ack]},3);
  assert.equal(operationTrace(state).attempts[0].reasoning.nativeConfigAcknowledgment,'adapter_confirmed');
  add('attempt.outcome',{outcome:outcome('worker',{terminal:'completed',effect:'confirmed'}),
    dispatchCertainty:'sent',late:true,observations:[]},4);
  assert.equal(decodeSnapshot(encodeSnapshot(state)).kind,'accepted');
  assert.equal(operationTrace(state).attempts[0].reasoning.nativeConfigAcknowledgment,'adapter_confirmed');
  assert.equal(operationTrace(state).attempts[0].reasoning.effective.level,'high');
});
