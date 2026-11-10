import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalStateStore} from '../../../../src/adapters/state/local-store.js';
import {createCatalog} from '../../../../src/application/configuration/catalog.js';
import {applyEvent,createOperation,pendingControllerReasoning,sameRecord} from '../../../../src/core/operation.js';
import {decodeSnapshot,encodeSnapshot} from '../../../../src/core/snapshot.js';
import {final,setup} from '../../fixtures/application.js';
import {decision,outcome,request} from '../../fixtures/core.js';

const route={configurationRef:'config:a',profileId:'primary',providerId:'fixture',model:'same',
  idempotencyKey:'idempotency-a',reasoning:{mode:'selectable',level:'high',nativeValue:'native-high',
    selectionSource:'model'}};
function apply(state, kind, n, extra={}) {
  const result=applyEvent(state,{kind,eventId:state.operationId+'-'+n,receivedAt:n,
    operationId:state.operationId,...extra});
  assert.equal(result.kind,'applied',JSON.stringify(result.reason));
  return result.state;
}

test('C11R.9 file-store crash barriers preserve pending/consumed selection, routes and unknowns',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'role-orchestrator-c11r-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createLocalStateStore(directory);
  await store.open();
  const checkpoints=[];
  for(let step=0;step<=4;step++){
    const id='crash-at-'+step;
    let state=createOperation(id,request({requestId:'request-'+step}),'grant',{maxInvocations:8,maxConcurrentInvocations:2});
    if(step>=1)state=apply(state,'controller.responded',1,{decision:decision({
      decisionId:'select-'+step,finalAssessment:undefined,
      nextController:{continue:true,reasoningLevel:'high'}})});
    if(step>=2)state=apply(state,'attempt.reserved',2,{attemptId:'attempt-'+step,
      actionId:'attempt-'+step,reasoningDecisionId:'select-'+step});
    if(step>=3)state=apply(state,'attempt.dispatched',3,{attemptId:'attempt-'+step,route});
    if(step>=4)state=apply(state,'attempt.outcome',4,{outcome:outcome('attempt-'+step),dispatchCertainty:'sent'});
    checkpoints.push(state);
    assert.deepEqual(await store.commit(id,null,state),{kind:'committed'});
  }
  await store.close();
  const reopened=createLocalStateStore(directory);
  t.after(()=>reopened.close());
  await reopened.open();
  for(let i=0;i<checkpoints.length;i++){
    const restored=await reopened.load(checkpoints[i].operationId);
    assert.ok(sameRecord(restored,checkpoints[i]),'checkpoint '+i);
    const pending=pendingControllerReasoning(restored);
    assert.equal(pending?.reasoningLevel,i===1?'high':undefined);
    if(i>=2)assert.equal(restored.attempts[0].reasoningDecisionId,'select-'+i);
    if(i>=3)assert.deepEqual(restored.attempts[0].route.reasoning,route.reasoning);
  }
  const incomplete=JSON.parse(encodeSnapshot(checkpoints[3]));
  incomplete.attempts[0].status='reserved';
  assert.equal(decodeSnapshot(JSON.stringify(incomplete)).kind,'corrupt');
  // A recorded dispatch remains uncertain after a crash: it cannot become an
  // unsent reservation merely by rewriting the summary status.
  assert.equal((await reopened.load('crash-at-3')).attempts[0].status,'dispatched');
});

test('C11R.9 changed mapping denies old idempotency key; unrelated worker runs',async()=>{
  let nativeValue='native-old';
  const config=createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',
      reasoningEffort:[{level:'fast',effort:'native-old'}]}},controllerProfile:'primary'});
  const catalog={...config,selectReasoning(id,level){
    const result=config.selectReasoning(id,level);
    return result.kind==='selected'&&result.selection.mode==='selectable'
      ? {kind:'selected',selection:Object.freeze({...result.selection,nativeValue})} : result;
  }};
  const action=(id,objective,rest={})=>({actionId:id,kind:'delegate',profileId:'primary',reasoningLevel:'fast',
    objective,expectedResult:'Evidence',contextRefs:[],dependsOn:[],...rest});
  const proposal=(invocation,...actions)=>final(invocation,{finalAssessment:undefined,additions:actions,
    waitPolicy:{kind:'all_requested',targets:actions.map(item=>({kind:'action',id:item.actionId}))}});
  let effects=0;
  const {api,invocations}=setup({catalog,profile:{profileId:'primary',providerId:'fixture',model:'same'},
    supportsIdempotency:true,maxInvocations:10,maxConcurrentInvocations:2,
    capabilities:{'attempt.idempotency':{support:'supported',source:'configured'}},
    respond(invocation){
      if(invocation.kind==='delegate'){
        if(invocation.actionId==='original'){effects++;throw Error('lost result after possible effect');}
        assert.notEqual(invocation.actionId,'replacement','changed mapping must not cause retry');
        return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),output:'Read-only result'};
      }
      const context=invocation.context[1].value;
      const prior=context.outcomes.find(item=>item.actionId==='original');
      if(!prior)return proposal(invocation,action('original','effect'));
      if(!invocation.context.some(item=>item.ref==='followup-9'))
        return final(invocation,{finalAssessment:undefined,clarification:{question:'Continue?'}});
      if(!context.outcomes.some(item=>item.actionId==='independent'))
        return proposal(invocation,action('replacement','effect',{
          retryOf:prior.attemptId,retryBasis:'provider_idempotency',
        }),action('independent','inspect'));
      return final(invocation);
    },
  });
  const first=await (await api.submit(request())).completion;
  assert.equal(first.status,'waiting');
  const old=first.attempts.find(item=>item.actionId==='original');
  assert.equal(old.outcome.effect,'unknown');
  assert.equal(old.route.reasoning.nativeValue,'native-old');
  nativeValue='native-updated';
  const finished=await(await api.resume(first.operationId,{
    requestId:'followup-9',text:'Use updated mapping and examine evidence',questionId:first.waiting.questionId,
  })).completion;
  assert.equal(finished.status,'finished');
  assert.equal(effects,1);
  assert.deepEqual(invocations.filter(item=>item.kind==='delegate').map(item=>item.actionId),
    ['original','independent']);
  const refused=finished.attempts.find(item=>item.actionId==='replacement');
  assert.equal(refused.outcome.diagnostics[0].code,'RETRY_NOT_AUTHORIZED');
  assert.equal(refused.outcome.effect,'none');
  assert.equal(refused.dispatchCertainty,'not_sent');
  assert.equal(finished.attempts.find(item=>item.actionId==='independent').route.reasoning.nativeValue,'native-updated');
  assert.equal(finished.attempts.find(item=>item.actionId==='original').route.reasoning.nativeValue,'native-old');
  await api.close();
});
