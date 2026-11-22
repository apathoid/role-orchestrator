import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, final } from '../fixtures/application.js';
import { request, outcome } from '../fixtures/core.js';
import { createOperation, applyEvent } from '../../src/core/operation.js';
import { materializeControllerIntent } from '../../src/application/controller-intent.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';

test('C18.2 model-owned ControllerIntent uses unchanged Operation admission and a trusted context revision',async()=>{
 const answer='# Hello 🌿\n\nDirect result';
 const {api,invocations}=setup({respond(invocation){
   const base=final(invocation);
   return {...base,output:'Native final text is not the Decision',
     controllerDeclaration:{kind:'intent',value:{finalAssessment:{overall:'complete',answer}}}};
 }});
 try{
   const state=await (await api.submit(request())).completion;
   assert.equal(state.status,'finished');
   assert.equal(state.assessment.answer,answer);
   const responded=state.events.find(e=>e.kind==='controller.responded');
   assert.ok(responded);
   assert.equal(responded.decision.operationId,state.operationId);
   assert.equal(responded.decision.finalAssessment.author,invocations[0].profile.profileId);
   assert.ok(responded.decision.decisionId.startsWith('controller:'));
   assert.equal(state.events.filter(e=>e.kind==='controller.invalid_proposal').length,0);
 }finally{await api.close();}
});

test('C18.3 clean missing Intent is model-invalid, not a disconnected provider',async()=>{
 let calls=0;
 const {api}=setup({maxInvocations:1,respond(invocation){
   calls++;
   return {...final(invocation),output:'ordinary native message',controllerDeclaration:{kind:'missing'}};
 }});
 try{
   const state=await (await api.submit(request())).completion;
   assert.equal(calls,1);
   assert.equal(state.events.filter(e=>e.kind==='controller.invalid_proposal').length,1);
   const rejection=state.events.find(e=>e.kind==='controller.invalid_proposal');
   assert.equal(rejection.reason.path,'$');
   assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,0);
 }finally{await api.close();}
});

test('C18.3 invalid final ControllerIntent keeps existing correction path',async()=>{
 const {api}=setup({maxInvocations:1,respond(invocation){
   return {...final(invocation),output:'ordinary final',
     controllerDeclaration:{kind:'invalid',reason:{code:'INVALID_PROPOSAL',path:'$.finalAssessment.overall',expected:'complete | partial | unresolved'}}};
 }});
 try{
   const state=await (await api.submit(request())).completion;
   const rejection=state.events.find(e=>e.kind==='controller.invalid_proposal');
   assert.equal(rejection.reason.path,'$.finalAssessment.overall');
 }finally{await api.close();}
});

test('C18.6 crash-gap after durable completed outcome does not replay prior Controller attempt or invent admission',async()=>{
 const saved=new Map();
 let failedReceipt=false;
 const store={
   async open(){},async close(){},
   async list(){return structuredClone([...saved.values()]);},
   async load(id){return structuredClone(saved.get(id));},
   async commit(id,revision,next){
     if((saved.get(id)?.revision??null)!==revision)return {kind:'conflict'};
     if(!failedReceipt && next.events.at(-1)?.kind==='controller.responded'){
       failedReceipt=true;return {kind:'unavailable'};
     }
     saved.set(id,structuredClone(next));return {kind:'committed'};
   },
 };
 const semantic={finalAssessment:{overall:'complete',answer:'Interrupted receipt'}};
 const before=setup({store,maxInvocations:3,respond(invocation){
   return {...final(invocation),output:semantic,
     controllerDeclaration:{kind:'intent',value:semantic}};
 }});
 let operationId;
 try{
   const started=await before.api.submit(request({requestId:'c18-gap',text:'Review state'}));
   operationId=started.operation.operationId;
   await assert.rejects(started.completion,error=>error.code==='STORE_UNAVAILABLE');
   assert.equal(failedReceipt,true);
   const durable=await store.load(operationId);
   assert.equal(durable.status,'active');
   assert.equal(durable.attempts.length,1);
   assert.equal(durable.attempts[0].outcome.terminal,'completed');
   assert.equal(durable.events.filter(e=>e.kind==='controller.responded').length,0);
   const original=durable.events.flatMap(e=>e.kind==='attempt.outcome'?e.observations??[]:[])
     .find(o=>o.value?.finalAssessment?.answer==='Interrupted receipt');
   assert.ok(original,'the original model intent observation remains durable');
   assert.equal(original.source,'model_claim');
   assert.equal(before.invocations.length,1);
 }finally{await before.api.close();}
 const after=setup({store,idPrefix:'c18-recovered-',maxInvocations:3,
   respond(invocation){return final(invocation);}});
 try{
   const state=await (await after.api.resume(operationId)).completion;
   assert.equal(state.status,'finished');
   assert.equal(after.invocations.length,1,'recovery uses a fresh Controller decision, not re-dispatch of old attempt');
   assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,1);
   assert.equal(state.events.filter(e=>e.kind==='operation.recovered').length,1);
   assert.equal(state.attempts.length,2);
   assert.notEqual(state.attempts[0].attemptId,state.attempts[1].attemptId);
   assert.ok(state.events.flatMap(e=>e.kind==='attempt.outcome'?e.observations??[]:[])
     .some(o=>o.value?.finalAssessment?.answer==='Interrupted receipt'));
 }finally{await after.api.close();}
});

test('C18R.4 same durable receipt is duplicate, altered content or provenance is IDENTITY_CONFLICT',()=>{
 const op='op-c18r-identity';
 let state=createOperation(op,request({requestId:'c18r-identity'}),'fixture-authority',
   {maxInvocations:3,maxConcurrentInvocations:2});
 let serial=0;
 const apply=data=>{
   const event={eventId:'c18r-'+(++serial),receivedAt:serial,operationId:op,...data};
   const r=applyEvent(state,event);
   assert.equal(r.kind,'applied',JSON.stringify(r.reason));state=r.state;
 };
 const attemptId='original-controller';
 apply({kind:'attempt.reserved',attemptId,actionId:attemptId});
 apply({kind:'attempt.dispatched',attemptId,route:{configurationRef:'test-config',
   profileId:'primary',providerId:'fixture',model:'fake'}});
 apply({kind:'attempt.outcome',dispatchCertainty:'sent',outcome:outcome(attemptId)});
 const action={actionId:'action-once',kind:'delegate',profileId:'primary',
   objective:'Run once',expectedResult:'One outcome'};
 const material=materializeControllerIntent({additions:[action],
   waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:action.actionId}]}},
 {operationId:op,attemptId,contextCursor:state.revision,profileId:'primary'});
 assert.equal(material.kind,'accepted');
 const value=material.value;
 const accepted=[{kind:'accepted',action:{...action,contextRefs:[],dependsOn:[]}}];
 apply({kind:'controller.responded',attemptId,decision:value,admissions:accepted});
 const snapshot=decodeSnapshot(encodeSnapshot(state));
 assert.equal(snapshot.kind,'accepted');
 const recovered=snapshot.value;
 const duplicate=applyEvent(recovered,{eventId:'c18r-received-again',receivedAt:100,
   operationId:op,kind:'controller.responded',attemptId,decision:structuredClone(value),admissions:accepted});
 assert.equal(duplicate.kind,'duplicate');
 assert.equal(duplicate.state.revision,recovered.revision);
 assert.equal(duplicate.state.events.filter(e=>e.kind==='controller.responded').length,1);
 assert.equal(duplicate.state.attempts.length,1);
 const conflict=applyEvent(recovered,{eventId:'c18r-corrupt',receivedAt:101,
   operationId:op,kind:'controller.responded',attemptId,
   decision:{...value,additions:[]},admissions:[]});
 assert.equal(conflict.kind,'rejected');
 assert.equal(conflict.reason.code,'IDENTITY_CONFLICT');
 const wrongAttempt=applyEvent(recovered,{eventId:'c18r-other-attempt',receivedAt:102,
   operationId:op,kind:'controller.responded',attemptId:'another-controller',
   decision:structuredClone(value),admissions:accepted});
 assert.equal(wrongAttempt.kind,'rejected');
 assert.equal(wrongAttempt.reason.code,'IDENTITY_CONFLICT');
 assert.equal(state.events.filter(e=>e.kind==='attempt.reserved'&&e.actionId===action.actionId).length,0);
 assert.equal(recovered.events.filter(e=>e.kind==='controller.responded').length,1);
});

// A stored Controller acknowledgement can be lost after the journal was
// updated. Restart never replays native provider calls from the old attempt.
test('C18R.4 lost ACK after durable controller.responded preserves one acceptance',async()=>{
 const saved=new Map();
 let ambiguous=false;
 const store={
   async open(){},async close(){},
   async list(){return structuredClone([...saved.values()]);},
   async load(id){return structuredClone(saved.get(id));},
   async commit(id,revision,next){
     if((saved.get(id)?.revision??null)!==revision)return {kind:'conflict'};
     saved.set(id,structuredClone(next));
     if(!ambiguous&&next.events.at(-1)?.kind==='controller.responded'){
       ambiguous=true;return {kind:'unavailable'};
     }
     return {kind:'committed'};
   },
 };
 const before=setup({store,maxInvocations:3,respond(invocation){
   const intent={finalAssessment:{overall:'complete',answer:'Original completed intent'}};
   return {...final(invocation),controllerDeclaration:{kind:'intent',value:intent},output:undefined};
 }});
 let operationId;
 try {
   const run=await before.api.submit(request({requestId:'c18r-ack'}));
   operationId=run.operation.operationId;
   await assert.rejects(run.completion,error=>error.code==='STORE_UNAVAILABLE');
   assert.equal(ambiguous,true);
   assert.equal(before.invocations.length,1);
   const durable=await store.load(operationId);
   assert.equal(durable.events.filter(e=>e.kind==='controller.responded').length,1);
   assert.equal(durable.attempts.length,1);
   assert.equal(durable.status,'active');
 }finally{await before.api.close();}
 const after=setup({store,idPrefix:'c18r-ack-recovered-',maxInvocations:3});
 try{
   const state=await (await after.api.resume(operationId)).completion;
   assert.equal(state.status,'finished');
   assert.equal(after.invocations.length,1,'only a fresh Controller invocation is permitted');
   assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,2);
   assert.equal(state.events.filter(e=>e.kind==='controller.responded'
     && e.decision.finalAssessment?.answer==='Original completed intent').length,1);
   assert.equal(state.attempts.length,2);
 }finally{await after.api.close();}
});
