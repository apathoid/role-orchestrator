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
 const workerStop=new AbortController();
 const worker=await startMcpBridge({signal:workerStop.signal,externalTools});
 try{
   assert.equal(worker.decisionToolName,undefined);
   assert.equal(value(await call(worker.url,5,'submit_decision',{})).output,'submit_decision');
 }finally{workerStop.abort();worker.close();}
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

test('C18R.5 Decision control budget exhaustion cannot resurrect earlier proposal',async()=>{
 const stop=new AbortController();
 const bridge=await startMcpBridge({signal:stop.signal,attemptId:'r5-budget',controllerDelivery:'intent_mcp'});
 try{
   const a=value(await call(bridge.url,1,'submit_decision',{intent:intent('first')}));
   assert.equal(a.kind,'proposal_pending');
   for(let i=2;i<=128;i++){
     const result=value(await call(bridge.url,i,'submit_decision',{
       intent:intent('candidate-'+i),replaces:a.proposalRef}));
     assert.equal(result.kind,'proposal_pending');
   }
   const over=value(await call(bridge.url,129,'submit_decision',{
     intent:intent('overflow'),replaces:a.proposalRef}));
   assert.equal(over.kind,'unavailable');
   assert.equal(over.reason,'budget');
   assert.deepEqual(await bridge.finalizeDecision(),{kind:'unavailable',reason:'budget'});
   const late=value(await call(bridge.url,130,'submit_decision',{intent:intent('late')}));
   assert.equal(late.kind,'unavailable');
 }finally{stop.abort();bridge.close();}
});

test('C18R.5 cross-invocation cancel and late callbacks cannot admit pending proposals',async()=>{
 const stop=new AbortController();
 const another=new AbortController();
 const old=await startMcpBridge({signal:stop.signal,attemptId:'r5-cancelled',controllerDelivery:'intent_mcp'});
 const live=await startMcpBridge({signal:another.signal,attemptId:'r5-active',controllerDelivery:'intent_mcp'});
 try{
   const proposal=value(await call(old.url,1,'submit_decision',{intent:intent('old')}));
   assert.equal(proposal.kind,'proposal_pending');
   stop.abort();
   assert.equal((await old.finalizeDecision()).kind,'unavailable');
   const failed=await call(live.url,2,'submit_decision',{intent:intent('not-replacement'),
     replaces:proposal.proposalRef});
   assert.equal(value(failed).kind,'rejected');
   assert.equal((await live.finalizeDecision()).kind,'invalid');
   // The old endpoint is not a channel into the other, even if its URL is retained.
   const blocked=await fetch(old.url,{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{
       name:'submit_decision',arguments:{intent:intent('late')},
     }})});
   assert.equal(blocked.status,410);
 }finally{stop.abort();another.abort();old.close();live.close();}
});

test('C22 F3 actual wire distinguishes allocated ref from registered lineage; unchanged selected result',async()=>{
  const stop=new AbortController();
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'c22-receipts',controllerDelivery:'intent_mcp'});
  try{
    const a=value(await call(bridge.url,1,'submit_decision',{intent:intent('A')}));
    assert.equal(a.registered,true);
    const bad=value(await call(bridge.url,2,'submit_decision',{intent:intent('bad'),replaces:'foreign'}));
    assert.equal(bad.kind,'rejected');
    assert.equal(bad.registered,false);
    const wrong=value(await call(bridge.url,3,'submit_decision',{intent:intent('bad'),replaces:bad.proposalRef}));
    assert.equal(wrong.registered,false);
    assert.equal(wrong.reason.expected,'a known proposalRef in this invocation');
    const invalid=value(await call(bridge.url,4,'submit_decision',{intent:{...intent('bad'),extra:true},replaces:a.proposalRef}));
    assert.equal(invalid.kind,'rejected');
    assert.equal(invalid.registered,true);
    assert.ok(invalid.reason.allowedFields.includes('finalAssessment'));
    const repaired=value(await call(bridge.url,5,'submit_decision',{intent:intent('repaired'),replaces:invalid.proposalRef}));
    assert.equal(repaired.kind,'proposal_pending');
    assert.equal(repaired.registered,true);
    const selected=await bridge.finalizeDecision();
    assert.equal(selected.kind,'intent');
    assert.equal(selected.proposalRef,repaired.proposalRef);
    assert.equal(selected.value.finalAssessment.answer,'repaired');
  }finally{stop.abort();bridge.close();}
});

test('C22 bounded wire annotation omission preserves primary rejection and registered lineage',async()=>{
  const stop=new AbortController();
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'c22-wire-bound',controllerDelivery:'intent_mcp'});
  try{
    const primary={kind:'rejected',proposalRef:'proposal:c22-wire-bound:1',
      reason:{code:'INVALID_PROPOSAL',path:'$.unknown',expected:'a model-owned ControllerIntent field (Host-owned metadata must be omitted)'}};
    const envelope={jsonrpc:'2.0',id:'',result:{content:[{type:'text',text:JSON.stringify(primary)}],isError:true}};
    const id='x'.repeat(256*1024-Buffer.byteLength(JSON.stringify(envelope)));
    const response=await call(bridge.url,id,'submit_decision',{intent:{unknown:true}});
    assert.equal(response.status,200);
    assert.deepEqual(value(response),primary);
    const corrected=value(await call(bridge.url,2,'submit_decision',{intent:intent('corrected'),replaces:primary.proposalRef}));
    assert.equal(corrected.registered,true);
    assert.equal((await bridge.finalizeDecision()).value.finalAssessment.answer,'corrected');
  }finally{stop.abort();bridge.close();}
});

test('C22 larger own descriptions do not hide a previously deliverable external tool page',async()=>{
  const stop=new AbortController();
  const description='x'.repeat(261000);
  const inputSchema={type:'object',additionalProperties:true};
  const externalTools={list:()=>[{id:'external',description,effect:'read',inputSchema}],
    async call(){return {status:'completed',effect:'none',output:'external'};}};
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'c22-page-bound',
    controllerDelivery:'intent_mcp',externalTools});
  try{
    const response=await fetch(bridge.url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    assert.equal(response.status,200);
    const page=(await response.json()).result;
    assert.deepEqual(page.tools.map(t=>t.name),[bridge.decisionToolName,'external']);
    assert.deepEqual(page.tools[1],{name:'external',description,inputSchema,annotations:{readOnlyHint:true}});
    assert.deepEqual(page.tools[0].inputSchema,{type:'object',properties:{intent:{},replaces:{type:'string'}},
      required:['intent'],additionalProperties:false});
    assert.ok(!page.tools[0].description.includes('Model-owned top-level fields'));
    assert.equal(value(await call(bridge.url,2,'external',{})).output,'external');
    const proposal=value(await call(bridge.url,3,bridge.decisionToolName,{intent:intent('done')}));
    assert.equal(proposal.registered,true);
    assert.equal((await bridge.finalizeDecision()).value.finalAssessment.answer,'done');
  }finally{stop.abort();bridge.close();}
});

test('C22-R context selection hint is optional at the existing control wire limit, not a lineage change',async()=>{
  const stop=new AbortController();
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'c22r-wire',controllerDelivery:'intent_mcp'});
  const malformed={nextController:{continue:true,contextRequest:{refs:[false]}}};
  try{
    const first=value(await call(bridge.url,1,'submit_decision',{intent:malformed}));
    const reason={code:'INVALID_PROPOSAL',path:'$.nextController.contextRequest.refs[0]',expected:'an object'};
    assert.equal(first.registered,true);
    assert.match(first.reason.hint,/non-empty reference string.*\{revision, index\}.*\{ref, offset\}/);
    const {hint,...primaryReason}=first.reason;
    assert.deepEqual(primaryReason,reason);
    const primary={kind:'rejected',proposalRef:'proposal:c22r-wire:2',reason};
    const envelope={jsonrpc:'2.0',id:'',result:{content:[{type:'text',text:JSON.stringify(primary)}],isError:true}};
    const id='x'.repeat(256*1024-Buffer.byteLength(JSON.stringify(envelope)));
    const response=await call(bridge.url,id,'submit_decision',{intent:malformed,replaces:first.proposalRef});
    assert.equal(response.status,200);
    assert.deepEqual(value(response),primary);
    const corrected=value(await call(bridge.url,3,'submit_decision',{intent:intent('corrected'),replaces:primary.proposalRef}));
    assert.equal(corrected.registered,true);
    assert.equal((await bridge.finalizeDecision()).value.finalAssessment.answer,'corrected');
  }finally{stop.abort();bridge.close();}
});

/** Raw JSON avoids client-side serialization of the nested fixture. */
function deepReplacementBody(id,name,replaces) {
  return '{"jsonrpc":"2.0","id":'+JSON.stringify(id)+',"method":"tools/call","params":{"name":'+JSON.stringify(name)+
    ',"arguments":{"intent":{"unknown":'+'['.repeat(15000)+'0'+']'.repeat(15000)+'}'+
    (replaces===undefined?'':',"replaces":'+JSON.stringify(replaces))+'}}}';
}
async function rawCall(url,body){
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});
  const raw=await response.text();
  return {status:response.status,body:raw?JSON.parse(raw):undefined};
}
test('C22-R2 F1 actual parsed replacement cannot resurrect previous selection on fingerprint failure',async t=>{
  const stop=new AbortController();
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'c22r2-deep',controllerDelivery:'intent_mcp'});
  try{
    const a=value(await call(bridge.url,1,bridge.decisionToolName,{intent:intent('A')}));
    const body=deepReplacementBody(2,bridge.decisionToolName,a.proposalRef);
    assert.ok(Buffer.byteLength(body)<2*1024*1024);
    const parsed=JSON.parse(body);
    assert.equal(parsed.params.arguments.replaces,a.proposalRef);
    let serializationError;
    try{JSON.stringify([parsed.params.name,parsed.params.arguments]);}
    catch(error){serializationError=error.name;}
    const reply=await rawCall(bridge.url,body);
    const final=await bridge.finalizeDecision();
    t.diagnostic(JSON.stringify({node:process.version,v8:process.versions.v8,bytes:Buffer.byteLength(body),
      serializationError:serializationError??null,http:reply.status,finalKind:final.kind,finalReason:final.reason??null}));
    if(serializationError){
      assert.equal(serializationError,'RangeError');
      assert.equal(reply.status,200);
      assert.deepEqual(reply.body.error,{code:-32603,message:'Request fingerprint serialization failed'});
      assert.deepEqual(final,{kind:'unavailable',reason:'serialization_failed'});
    }else{
      assert.equal(value(reply).kind,'rejected');
      assert.equal(final.kind,'invalid');
    }
  }finally{stop.abort();bridge.close();}
});

test('C22-R2 F1 actual failed fingerprint is lineage-scoped; correction, correlation and cancellation remain available',async()=>{
  const stop=new AbortController();
  const bridges=[];
  let externalCalls=0;
  const open=async attemptId=>{
    const bridge=await startMcpBridge({signal:stop.signal,attemptId,controllerDelivery:'intent_mcp',
      externalTools:{list:()=>[{id:'ordinary',description:'fixture',effect:'read',inputSchema:{type:'object'}}],
        async call(){externalCalls++;return {status:'completed',effect:'none'};}}});
    bridges.push(bridge);
    const a=value(await call(bridge.url,10,bridge.decisionToolName,{intent:intent('A')}));
    return {bridge,a};
  };
  try{
    const {bridge,a}=await open('c22r2-scoped');
    for(const replaces of [undefined,'proposal:foreign:1']){
      const reply=await rawCall(bridge.url,deepReplacementBody(replaces?12:11,bridge.decisionToolName,replaces));
      assert.ok(reply.status===200);
    }
    const ordinary=await rawCall(bridge.url,deepReplacementBody(13,'ordinary',a.proposalRef));
    if(ordinary.status===500)assert.equal(externalCalls,0);
    else assert.equal(externalCalls,1);
    assert.equal((await rawCall(bridge.url,'{malformed')).status,400);
    assert.equal((await bridge.finalizeDecision()).value.finalAssessment.answer,'A');
    const other=await open('c22r2-correction');
    const deep=await rawCall(other.bridge.url,deepReplacementBody(10,other.bridge.decisionToolName,other.a.proposalRef));
    assert.ok([-32602,-32603].includes(deep.body.error?.code));
    const correctedArgs={intent:intent('C'),replaces:other.a.proposalRef};
    const corrected=await call(other.bridge.url,20,other.bridge.decisionToolName,correctedArgs);
    assert.equal(value(corrected).kind,'proposal_pending');
    const replay=await rawCall(other.bridge.url,JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',
      params:{name:other.bridge.decisionToolName,arguments:correctedArgs}},null,2));
    assert.deepEqual(replay.body,corrected.body,'unchanged fingerprint equivalence for parsed arguments');
    assert.equal((await other.bridge.finalizeDecision()).value.finalAssessment.answer,'C');
    const canceled=await open('c22r2-canceled');
    await rawCall(canceled.bridge.url,deepReplacementBody(11,canceled.bridge.decisionToolName,canceled.a.proposalRef));
    stop.abort();
    assert.deepEqual(await canceled.bridge.finalizeDecision(),{kind:'unavailable',reason:'closed'});
  }finally{stop.abort();for(const bridge of bridges)bridge.close();}
});

test('C22-R2 F1 registry byte-accounting failure is ordered before finality without fabricating a proposal',async()=>{
  const registry=make('c22r2-accounting');
  const a=await registry.register({intent:intent('A')});
  const input=JSON.parse(deepReplacementBody(2,'submit_decision',a.proposalRef)).params.arguments;
  let failed=false;
  try{JSON.stringify(input);}catch{failed=true;}
  const observed=registry.register(input);
  const finalizing=registry.finalize();
  const reply=await observed;
  const final=await finalizing;
  if(failed){
    assert.deepEqual(reply,{kind:'unavailable',reason:'serialization_failed'});
    assert.deepEqual(final,{kind:'unavailable',reason:'serialization_failed'});
  }else{
    // On a V8 with a nonrecursive fast path this is still an invalid
    // replacement. An accounting failure at its deeper call stack is also
    // a valid technical outcome, never an accepted stale proposal.
    assert.ok(['rejected','unavailable'].includes(reply.kind));
    assert.ok(['invalid','unavailable'].includes(final.kind));
  }
});

test('C22-R2 H1 conflict receipt reports existing selected ref without constraining correction and preserves wire bound',async()=>{
  const stop=new AbortController();
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'c22r2-conflict',controllerDelivery:'intent_mcp'});
  try{
    const first=value(await call(bridge.url,1,bridge.decisionToolName,{intent:intent('A')}));
    const second=value(await call(bridge.url,2,bridge.decisionToolName,{intent:intent('B')}));
    assert.equal(second.kind,'rejected');
    assert.equal(second.registered,true);
    assert.equal(second.selectedProposalRef,first.proposalRef);
    const primary={kind:'rejected',proposalRef:'proposal:c22r2-conflict:3',
      reason:{code:'INVALID_PROPOSAL',path:'$.replaces',expected:'a proposalRef from the currently selected lineage'}};
    const envelope={jsonrpc:'2.0',id:'',result:{content:[{type:'text',text:JSON.stringify(primary)}],isError:true}};
    const id='x'.repeat(256*1024-Buffer.byteLength(JSON.stringify(envelope)));
    assert.deepEqual(value(await call(bridge.url,id,bridge.decisionToolName,{intent:intent('D')})),primary);
    // Preserve the actual conflict rule: while A is selected, a valid
    // replacement of the other registered lineage still conflicts.
    const other=value(await call(bridge.url,4,bridge.decisionToolName,{intent:intent('C'),replaces:second.proposalRef}));
    assert.equal(other.kind,'rejected');
    assert.equal(other.registered,true);
    assert.equal(other.selectedProposalRef,first.proposalRef);
    const corrected=value(await call(bridge.url,5,bridge.decisionToolName,{intent:intent('corrected'),replaces:first.proposalRef}));
    assert.equal(corrected.kind,'proposal_pending');
    assert.equal(corrected.selectedProposalRef,undefined);
    assert.equal((await bridge.finalizeDecision()).value.finalAssessment.answer,'corrected');
  }finally{stop.abort();bridge.close();}
});

for (const reason of ['serialization_failed','request_id_conflict']) {
  test('C22-R2 review P2.1: actual MCP conflict followed by '+reason+' retains the transport cause',async()=>{
    const stop=new AbortController();
    const bridge=await startMcpBridge({signal:stop.signal,attemptId:'c22r2-mixed-'+reason,controllerDelivery:'intent_mcp'});
    try{
      const a=value(await call(bridge.url,1,bridge.decisionToolName,{intent:intent('A')}));
      assert.equal(a.kind,'proposal_pending');
      const b=value(await call(bridge.url,2,bridge.decisionToolName,{intent:intent('B')}));
      assert.equal(b.kind,'rejected');
      assert.equal(b.registered,true);
      assert.equal(b.selectedProposalRef,a.proposalRef);
      const failed=reason==='serialization_failed'
        ? await rawCall(bridge.url,deepReplacementBody(3,bridge.decisionToolName,a.proposalRef))
        : await call(bridge.url,1,bridge.decisionToolName,{intent:intent('replacement'),replaces:a.proposalRef});
      assert.equal(failed.status,200);
      assert.equal(failed.body.error?.code,reason==='serialization_failed'?-32603:-32602);
      assert.deepEqual(await bridge.finalizeDecision(),{kind:'unavailable',reason},
        'a stale conflict must not mask '+reason);
    }finally{stop.abort();bridge.close();}
  });
}

for (const reason of ['serialization_failed','request_id_conflict']) {
  test('C22-R2 review P2.1: '+reason+' clears only the invalidated selection conflict',async()=>{
    const open=async suffix=>{
      const stop=new AbortController();
      const registry=createPendingControllerDecisions({attemptId:'mixed-'+reason+'-'+suffix,signal:stop.signal});
      const a=await registry.register({intent:intent('A')});
      assert.equal(a.kind,'proposal_pending');
      const b=await registry.register({intent:intent('B')});
      assert.equal(b.kind,'rejected');
      assert.equal(b.registered,true);
      assert.equal(b.selectedProposalRef,a.proposalRef);
      return {registry,a,b,stop};
    };

    // A queued conflict and subsequent transport observation must both be
    // accounted for before finalization, even without awaiting the former.
    const queued=make('mixed-queued-'+reason);
    const a=await queued.register({intent:intent('A')});
    const b=queued.register({intent:intent('B')});
    queued.observeRejectedReplacement({replaces:a.proposalRef},reason);
    const finalizing=queued.finalize();
    assert.equal((await b).kind,'rejected');
    assert.deepEqual(await finalizing,{kind:'unavailable',reason});

    const unrelated=await open('unrelated');
    for(const input of [{replaces:unrelated.b.proposalRef},{replaces:'unknown'},{}]){
      unrelated.registry.observeRejectedReplacement(input,reason);
    }
    assert.deepEqual(await unrelated.registry.finalize(),{kind:'conflict'});

    // The observed failure does not remove known lineage identities. A
    // correction of A clears its unresolved transport; B can also be selected
    // by a valid new submission once no selected candidate remains.
    for(const source of ['a','b']){
      const corrected=await open('correct-'+source);
      corrected.registry.observeRejectedReplacement({replaces:corrected.a.proposalRef},reason);
      const c=await corrected.registry.register({intent:intent('corrected'),replaces:corrected[source].proposalRef});
      assert.equal(c.kind,'proposal_pending');
      const final=await corrected.registry.finalize();
      assert.equal(final.kind,'intent');
      assert.equal(final.proposalRef,c.proposalRef);
      assert.equal(final.value.finalAssessment.answer,'corrected');
    }

    // The old transport observation must NOT outrank a genuine new conflict
    // involving a later selected lineage (the old A failure is still retained).
    const fresh=await open('fresh');
    fresh.registry.observeRejectedReplacement({replaces:fresh.a.proposalRef},reason);
    const c=await fresh.registry.register({intent:intent('C'),replaces:fresh.b.proposalRef});
    assert.equal(c.kind,'proposal_pending');
    const d=await fresh.registry.register({intent:intent('D')});
    assert.equal(d.kind,'rejected');
    assert.equal(d.selectedProposalRef,c.proposalRef);
    assert.deepEqual(await fresh.registry.finalize(),{kind:'conflict'});

    const bounded=await open('budget');
    bounded.registry.observeRejectedReplacement({replaces:bounded.a.proposalRef},reason);
    bounded.registry.exceedLimit();
    assert.deepEqual(await bounded.registry.finalize(),{kind:'unavailable',reason:'budget'});

    const canceled=await open('cancel');
    canceled.registry.observeRejectedReplacement({replaces:canceled.a.proposalRef},reason);
    canceled.stop.abort();
    assert.deepEqual(await canceled.registry.finalize(),{kind:'unavailable',reason:'closed'});
  });
}
