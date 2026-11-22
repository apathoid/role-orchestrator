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
