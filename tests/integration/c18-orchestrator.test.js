import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, final } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

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
