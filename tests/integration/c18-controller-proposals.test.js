import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPendingControllerDecisions } from '../../src/adapters/controller-proposals.js';
import { startMcpBridge } from '../../src/adapters/mcp-bridge.js';

const intent = answer => ({finalAssessment:{overall:'complete',answer}});
const make = attemptId => createPendingControllerDecisions({attemptId,signal:new AbortController().signal});

test('C18.4 proposals are deferred, explicit same-lineage replacements last-win by registration',async()=>{
 const registry=make('one');
 const a=await registry.register({intent:intent('A')});
 assert.equal(a.kind,'proposal_pending');
 const [b,c]=await Promise.all([
   registry.register({intent:intent('B'),replaces:a.proposalRef}),
   registry.register({intent:intent('C'),replaces:a.proposalRef}),
 ]);
 assert.equal(b.kind,'proposal_pending');
 assert.equal(c.kind,'proposal_pending');
 assert.equal((await registry.finalize()).value.finalAssessment.answer,'C');
 assert.deepEqual(await registry.register({intent:intent('late')}),{kind:'unavailable',reason:'closed'});
});

test('C18.4 unrelated conflict can be corrected in same native turn; observed invalid replacement cannot fall back',async()=>{
 const r=make('two');
 const a=await r.register({intent:intent('A')});
 const unrelated=await r.register({intent:intent('B')});
 assert.equal(unrelated.kind,'rejected');
 const c=await r.register({intent:intent('C'),replaces:a.proposalRef});
 assert.equal(c.kind,'proposal_pending');
 assert.equal((await r.finalize()).value.finalAssessment.answer,'C');
 const s=make('three');
 const valid=await s.register({intent:intent('before')});
 const invalid=await s.register({intent:{finalAssessment:{overall:'impossible',answer:'x'}},
   replaces:valid.proposalRef});
 assert.equal(invalid.kind,'rejected');
 assert.equal(invalid.reason.path,'$.finalAssessment.overall');
 assert.equal((await s.finalize()).kind,'invalid');
 const t=make('four');
 const first=await t.register({intent:intent('first')});
 const wrong=await t.register({intent:intent('bad'),replaces:'proposal:foreign'});
 assert.equal(wrong.kind,'rejected');
 assert.equal((await t.finalize()).value.finalAssessment.answer,'first');
});

test('C18.4 registered in-flight validation is included before native finality barrier',async()=>{
 const registry=make('race');
 const received=registry.register({intent:intent('live')});
 const finalized=registry.finalize();
 assert.equal((await received).kind,'proposal_pending');
 assert.equal((await finalized).value.finalAssessment.answer,'live');
 const stop=new AbortController();
 const canceled=createPendingControllerDecisions({attemptId:'stop',signal:stop.signal});
 await canceled.register({intent:intent('not admitted')});
 stop.abort();
 assert.equal((await canceled.finalize()).kind,'unavailable');
});

async function call(url,id,name,args){
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});
 return {status:response.status,body:await response.json()};
}
const value=r=>JSON.parse(r.body.result.content[0].text);

test('C18.5 real MCP control tool works without context/external tools and exceeds old 32KiB/64-call budget',async()=>{
 const stop=new AbortController();
 const bridge=await startMcpBridge({attemptId:'large',controllerDelivery:'intent_mcp',
   signal:stop.signal,isActive:()=>true});
 try {
   const listing=await fetch(bridge.url,{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(r=>r.json());
   assert.ok(listing.result.tools.some(tool=>tool.name==='submit_decision'));
   const long='🌍'.repeat(20_000);
   const first=await call(bridge.url,10,'submit_decision',{intent:intent(long)});
   assert.equal(first.status,200);
   assert.equal(value(first).kind,'proposal_pending');
   const same=await call(bridge.url,10,'submit_decision',{intent:intent(long)});
   assert.deepEqual(same.body,first.body);
   const reuse=await call(bridge.url,10,'submit_decision',{intent:intent('different')});
   assert.equal(reuse.body.error.code,-32602);
   for(let i=0;i<64;i++){
     const other=await call(bridge.url,100+i,'does_not_exist',{});
     assert.equal(other.status,200);
   }
   const last=await call(bridge.url,200,'submit_decision',{intent:intent('final'),replaces:value(first).proposalRef});
   assert.equal(value(last).kind,'proposal_pending');
   const result=await bridge.finalizeDecision();
   assert.equal(result.value.finalAssessment.answer,'final');
   assert.equal((await call(bridge.url,201,'submit_decision',{intent:intent('late')})).status,200);
 }finally{stop.abort();bridge.close();}
});

test('C18.5 a previous bridge URL never writes into another invocation',async()=>{
 const stop=new AbortController();
 const one=await startMcpBridge({attemptId:'one',controllerDelivery:'intent_mcp',signal:stop.signal});
 const two=await startMcpBridge({attemptId:'two',controllerDelivery:'intent_mcp',signal:stop.signal});
 try{
   const result=await call(one.url,1,'submit_decision',{intent:intent('one')});
   assert.equal(value(result).kind,'proposal_pending');
   assert.equal((await two.finalizeDecision()).kind,'missing');
   assert.equal((await one.finalizeDecision()).kind,'intent');
 }finally{stop.abort();one.close();two.close();}
});


test('C18.4 observed malformed replacement invalidates its proven lineage without erasing unrelated conflicts',async()=>{
 const r=make('extra');
 const first=await r.register({intent:intent('A')});
 const malformed=await r.register({intent:intent('B'),replaces:first.proposalRef,unexpected:true});
 assert.equal(malformed.kind,'rejected');
 assert.equal(malformed.reason.path,'$.unexpected');
 assert.equal((await r.finalize()).kind,'invalid');
 const other=make('lineage');
 const a=await other.register({intent:intent('A')});
 const bad=await other.register({intent:intent('B')});
 assert.equal(bad.kind,'rejected');
 const unknown=await other.register({intent:{},replaces:'unknown'});
 assert.equal(unknown.kind,'rejected');
 assert.equal((await other.finalize()).kind,'conflict');
});

test('C18R.0 RED: observed duplicate JSON-RPC id replacement invalidates candidate; identical replay is inert',async()=>{
 const stop=new AbortController();
 const bridge=await startMcpBridge({signal:stop.signal,attemptId:'r2-reuse',controllerDelivery:'intent_mcp'});
 try{
   const a=await call(bridge.url,10,'submit_decision',{intent:intent('A')});
   assert.equal(value(a).kind,'proposal_pending');
   const identical=await call(bridge.url,10,'submit_decision',{intent:intent('A')});
   assert.deepEqual(identical.body,a.body);
   const changed=await call(bridge.url,10,'submit_decision',{
     intent:intent('B'),replaces:value(a).proposalRef});
   assert.equal(changed.body.error?.code,-32602);
   assert.deepEqual(await bridge.finalizeDecision(),{kind:'unavailable',reason:'request_id_conflict'});
 }finally{stop.abort();bridge.close();}
});

test('C18R.0 RED: rejected replacement can be corrected without additional native turn',async()=>{
 const stop=new AbortController();
 const bridge=await startMcpBridge({signal:stop.signal,attemptId:'r2-correct',controllerDelivery:'intent_mcp'});
 try{
   const a=await call(bridge.url,10,'submit_decision',{intent:intent('A')});
   const ref=value(a).proposalRef;
   assert.equal((await call(bridge.url,10,'submit_decision',{intent:intent('BAD'),replaces:ref})).body.error?.code,-32602);
   const c=await call(bridge.url,11,'submit_decision',{intent:intent('C'),replaces:ref});
   assert.equal(value(c).kind,'proposal_pending');
   assert.equal((await bridge.finalizeDecision()).value.finalAssessment.answer,'C');
 }finally{stop.abort();bridge.close();}
});

test('C18R.2 unknown, unrelated and malformed JSON-RPC calls cannot invalidate a known proposal',async()=>{
 const stop=new AbortController();
 const one=await startMcpBridge({signal:stop.signal,attemptId:'r2-scoped',controllerDelivery:'intent_mcp'});
 const two=await startMcpBridge({signal:stop.signal,attemptId:'r2-other',controllerDelivery:'intent_mcp'});
 try{
   const a=value(await call(one.url,10,'submit_decision',{intent:intent('A')}));
   const unrelated=await call(one.url,10,'submit_decision',{intent:intent('unrelated')});
   assert.equal(unrelated.body.error.code,-32602);
   const foreign=await call(one.url,10,'submit_decision',{intent:intent('foreign'),replaces:'proposal:r2-other:1'});
   assert.equal(foreign.body.error.code,-32602);
   const malformed=await fetch(one.url,{method:'POST',headers:{'content-type':'application/json'},body:'{malformed'});
   assert.equal(malformed.status,400);
   const b=value(await call(two.url,1,'submit_decision',{intent:intent('B')}));
   assert.notEqual(a.proposalRef,b.proposalRef);
   assert.equal((await one.finalizeDecision()).value.finalAssessment.answer,'A');
   assert.equal((await two.finalizeDecision()).value.finalAssessment.answer,'B');
 }finally{stop.abort();one.close();two.close();}
});

test('C18R.3 built-in Decision control name never shadows external submit_decision',async()=>{
 const stop=new AbortController();
 const calls=[];
 const externalTools={
   list:()=>['submit_decision','role_orchestrator_submit_decision'].map(id=>({
     id,description:'External tool '+id,effect:'read',inputSchema:{type:'object',additionalProperties:true},
   })),
   async call(name,args){calls.push({name,args});return {status:'completed',effect:'none',output:name};},
 };
 const bridge=await startMcpBridge({signal:stop.signal,attemptId:'collision',controllerDelivery:'intent_mcp',externalTools});
 try{
   const listing=await fetch(bridge.url,{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(r=>r.json());
   const advertised=listing.result.tools.map(t=>t.name);
   assert.deepEqual(new Set(advertised).size,advertised.length);
   assert.ok(advertised.includes('submit_decision'));
   assert.ok(advertised.includes('role_orchestrator_submit_decision'));
   assert.equal(bridge.decisionToolName,'role_orchestrator_submit_decision_1');
   assert.ok(advertised.includes(bridge.decisionToolName));
   assert.equal(value(await call(bridge.url,2,'submit_decision',{hello:'external'})).output,'submit_decision');
   assert.equal(value(await call(bridge.url,3,'role_orchestrator_submit_decision',{})).output,'role_orchestrator_submit_decision');
   const pending=value(await call(bridge.url,4,bridge.decisionToolName,{intent:intent('correct')}));
   assert.equal(pending.kind,'proposal_pending');
   assert.deepEqual(calls.map(x=>x.name),['submit_decision','role_orchestrator_submit_decision']);
   assert.equal((await bridge.finalizeDecision()).value.finalAssessment.answer,'correct');
 }finally{stop.abort();bridge.close();}
 const worker=await startMcpBridge({signal:stop.signal,externalTools});
 try{
   assert.equal(worker.decisionToolName,undefined);
   assert.equal(value(await call(worker.url,5,'submit_decision',{})).output,'submit_decision');
 }finally{worker.close();}
});

test('C18R.5 near-2MiB UTF-8 Control submission remains intact; oversize is refused explicitly',async()=>{
 const stop=new AbortController();
 const bridge=await startMcpBridge({signal:stop.signal,attemptId:'near-limit',controllerDelivery:'intent_mcp'});
 try{
   const answer='界'.repeat(650_000);
   const body=JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',
     params:{name:'submit_decision',arguments:{intent:intent(answer)}}});
   assert.ok(Buffer.byteLength(body,'utf8')>1_900_000);
   assert.ok(Buffer.byteLength(body,'utf8')<2*1024*1024);
   const response=await fetch(bridge.url,{method:'POST',headers:{'content-type':'application/json'},body});
   assert.equal(response.status,200);
   const reply=await response.json();
   const ref=JSON.parse(reply.result.content[0].text).proposalRef;
   assert.ok(ref);
   const overflow=await fetch(bridge.url,{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({jsonrpc:'2.0',id:10,method:'tools/call',params:{
       name:'submit_decision',arguments:{intent:intent('界'.repeat(705_000)),replaces:ref}}})});
   assert.equal(overflow.status,413);
   assert.equal((await bridge.finalizeDecision()).value.finalAssessment.answer,answer);
 }finally{stop.abort();bridge.close();}
});
