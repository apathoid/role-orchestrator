import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindContextAccess, materializeControllerHistory } from '../../src/application/context-access.js';
import { createOperation } from '../../src/core/operation.js';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { startMcpBridge } from '../../src/adapters/mcp-bridge.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
import { final, setup } from '../fixtures/application.js';
import { outcome, request } from '../fixtures/core.js';

function historyState(ref, value) {
  const state=createOperation('context-chunks',request(),'grant',{maxInvocations:12,maxConcurrentInvocations:2});
  state.events.push({
    kind:'attempt.outcome',eventId:'event-one',operationId:state.operationId,receivedAt:1,
    outcome:outcome('attempt-one'),dispatchCertainty:'sent',
    observations:[{ref,source:'provider_reported',completeness:'complete',value,
      provenance:{kind:'provider_report',sourceId:'source-report',receivedAt:1}}],
  });
  return state;
}
function portFor(state, maxBytes, store={}, active=()=>true, selected) {
  return bindContextAccess({state,store,maxBytes,captureMaxBytes:256*1024,
    profileId:'primary',attemptId:'test-read',isActive:active,selected,
    newId:()=> 'fixture-artifact',now:()=>1,receive(){}});
}
function readAll(port, ref, expectedBudget) {
  return (async()=>{
    const pieces=[];
    let offset=0,steps=0,original;
    do {
      const chunk=await port.fetch(ref,undefined,{offset});
      assert.equal(chunk.kind,'chunk',JSON.stringify(chunk).slice(0,300));
      assert.ok(Buffer.byteLength(JSON.stringify(chunk))<=expectedBudget);
      assert.equal(chunk.offset,offset);
      assert.equal(chunk.totalBytes>0,true);
      original=chunk;
      pieces.push(Buffer.from(chunk.base64,'base64'));
      if(chunk.nextOffset===undefined) break;
      assert.ok(chunk.nextOffset>offset);
      offset=chunk.nextOffset;
      assert.ok(++steps<20);
    } while(true);
    return {bytes:Buffer.concat(pieces),last:original,steps:steps+1};
  })();
}

for(const budget of [64*1024,128*1024]){
  test('C12R.9 P2: ' + budget + '-byte range retrieves all stored UTF-8 bytes without boundary loss',async()=>{
    const body=('🔬–é 😀\n' + 'abcdef'.repeat(47)).repeat(420);
    assert.ok(Buffer.byteLength(body)>120*1024);
    const port=portFor(historyState('large-inline',body),budget);
    const ordinary=await port.fetch('large-inline');
    assert.equal(ordinary.kind,'available');
    assert.equal(ordinary.item.completeness,'truncated');
    const all=await readAll(port,'large-inline',budget);
    assert.ok(all.steps>=2);
    assert.equal(all.last.format,'utf8');
    assert.equal(all.bytes.toString('utf8'),body);
    assert.equal((await port.fetch('large-inline',undefined,{offset:all.bytes.length+1})).reason,'invalid_offset');
    assert.equal((await port.fetch('missing',undefined,{offset:0})).reason,'missing');
    assert.equal((await port.fetch({revision:7,index:0},undefined,{offset:0})).reason,'missing');
    assert.equal((await port.fetch('large-inline',undefined,{offset:-1})).reason,'invalid_offset');
    assert.equal((await port.fetch('large-inline',undefined,{offset:1.5})).reason,'invalid_offset');
    assert.equal((await port.fetch('large-inline',undefined,{offset:0,other:1})).reason,'invalid_offset');
  });
}

test('C12R.9 P2: positional oversized ref remains retrievable and selected Worker visibility applies',async()=>{
  const longRef='source-'+('r'.repeat(4000));
  const state=historyState(longRef,'an attributed saved value');
  const port=portFor(state,4096);
  const listed=port.list();
  assert.equal(listed.kind,'available');
  const position=listed.items.find(item=>typeof item.ref==='object')?.ref;
  assert.deepEqual(position,{revision:1,index:0});
  const selected=await port.fetch(position);
  assert.equal(selected.item.value,'an attributed saved value');
  const material=await materializeControllerHistory(port,{refs:[position]},4096);
  assert.equal(material[0].value,'an attributed saved value');
  assert.equal(material[0].ref,'host:history-position:1:0');
  assert.equal(material[0].provenance.sourceId,'source-report');
  assert.ok(!JSON.stringify(material).includes(longRef));
  const restricted=portFor(state,4096,{},()=>true,new Set(['unrelated']));
  assert.deepEqual(await restricted.fetch(position),{kind:'unavailable',reason:'denied'});
  assert.deepEqual(await port.fetch(position,'foreign-operation'),{kind:'unavailable',reason:'denied'});
  assert.deepEqual(await port.fetch({revision:99,index:0}),{kind:'unavailable',reason:'missing'});
  let active=true;
  const cancelling=portFor(state,4096,{},()=>active);
  active=false;
  assert.deepEqual(await cancelling.fetch(position,undefined,{offset:0}),{kind:'unavailable',reason:'closed'});
});

test('C12R.9 P2: artifact chunks verify integrity, retention, capture truncation and reopen',()=> 
  withOwnedRun('C12R9-artifact-chunks',async cwd=>{
    let store=createLocalStateStore(cwd);
    await store.open();
    const data=Buffer.from('🧩 DATA\n'.repeat(20000));
    const ref=await store.writeArtifact(data,256*1024);
    assert.equal(ref.truncated,false);
    const truncated=await store.writeArtifact(data,64*1024);
    assert.equal(truncated.truncated,true);
    const state=historyState('artifact-source',undefined);
    state.events[0].observations[0]={ref:'artifact-source',source:'provider_reported',
      completeness:'complete',artifact:ref,provenance:{kind:'provider_report',sourceId:'fixture',receivedAt:1}};
    state.events[0].observations.push({ref:'artifact-truncated',source:'provider_reported',
      completeness:'truncated',artifact:truncated,provenance:{kind:'provider_report',sourceId:'fixture',receivedAt:1}});
    const first=portFor(state,64*1024,store);
    assert.equal((await first.fetch('artifact-source')).reason,'budget');
    const zero=await first.fetch('artifact-source',undefined,{offset:0});
    assert.equal(zero.kind,'chunk');
    assert.equal(zero.format,'binary');
    assert.equal(zero.item.artifact.truncated,false);
    await store.close();
    store=createLocalStateStore(cwd);
    await store.open();
    try {
      const after=portFor(state,64*1024,store);
      const chunks=await readAll(after,'artifact-source',64*1024);
      assert.deepEqual(chunks.bytes,data);
      assert.equal(chunks.last.item.artifact.originalSize,data.length);
      const truncatedResult=await readAll(after,'artifact-truncated',64*1024);
      assert.equal(truncatedResult.bytes.length,64*1024);
      assert.equal(truncatedResult.last.item.artifact.originalSize,data.length);
      assert.equal(truncatedResult.last.item.artifact.truncated,true);
      const high=portFor(state,128*1024,store);
      const highChunks=await readAll(high,'artifact-source',128*1024);
      assert.deepEqual(highChunks.bytes,data);
      assert.ok(highChunks.steps<=chunks.steps);
      const hash=ref.ref.slice('sha256:'.length);
      const file=join(cwd,'artifact-'+hash+'.blob');
      await writeFile(file,Buffer.from('tampered'));
      assert.deepEqual(await after.fetch('artifact-source',undefined,{offset:0}),
        {kind:'unavailable',reason:'integrity_error'});
      await writeFile(file,data);
      const validFirst=await after.fetch('artifact-source',undefined,{offset:0});
      assert.equal(validFirst.kind,'chunk');
      assert.ok(validFirst.nextOffset>0);
      await unlink(file);
      assert.deepEqual(await after.fetch('artifact-source',undefined,{offset:validFirst.nextOffset}),
        {kind:'unavailable',reason:'payload'},
        'an artifact deleted between chunks must not silently return fabricated bytes');
      await writeFile(join(cwd,'artifact-'+hash+'.retention'),'');
      assert.deepEqual(await after.fetch('artifact-source',undefined,{offset:validFirst.nextOffset}),
        {kind:'unavailable',reason:'retention'});
    } finally { await store.close(); }
  }));

test('C12R.9 P2: MCP context_fetch accepts byte offsets and positional identity',async()=>{
  const input='🚀'.repeat(40000);
  const state=historyState('mcp-saved',input);
  const stop=new AbortController();
  const bridge=await startMcpBridge({contextAccess:portFor(state,64*1024),signal:stop.signal});
  async function call(id,args){
    const response=await fetch(bridge.url,{method:'POST',
      headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18'},
      body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',
        params:{name:'context_fetch',arguments:args}})});
    assert.equal(response.status,200);
    return JSON.parse((await response.json()).result.content[0].text);
  }
  try {
    let page=await call(1,{ref:{revision:1,index:0},offset:0});
    assert.equal(page.kind,'chunk');
    assert.equal(page.item.receivedSequence.revision,1);
    const chunks=[Buffer.from(page.base64,'base64')];
    let id=2;
    while(page.nextOffset!==undefined){
      page=await call(id++,{ref:'mcp-saved',offset:page.nextOffset});
      assert.equal(page.kind,'chunk');
      chunks.push(Buffer.from(page.base64,'base64'));
    }
    assert.equal(Buffer.concat(chunks).toString('utf8'),input);
    assert.deepEqual(await call(id++,{ref:'mcp-saved',offset:-1}),
      {kind:'unavailable',reason:'invalid_input'});
  } finally {stop.abort();bridge.close();}
});

test('C12R.9 P2: optional Controller continuation reads successive chunks without MCP',async()=>{
  const body=('Ǎ🧪-'.repeat(45)+'\n').repeat(650);
  assert.ok(Buffer.byteLength(body)>120*1024);
  let ref,controllers=0,nextOffset=0;
  const chunks=[];
  const {api,respondErrors}=setup({maxInvocations:9,
    context:{controllerMaxBytes:128*1024,fetchMaxBytes:64*1024},
    respond(invocation,_,observe) {
      controllers++;
      if(controllers===1){
        observe({ref:'original-large',kind:'provider_report',sourceId:'fixture',completeness:'complete',value:body});
        return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
      }
      if(controllers===2){
        ref=invocation.contextAccess.list().items.find(item=>item.providerRef==='original-large').ref;
        return final(invocation,{finalAssessment:undefined,
          nextController:{continue:true,contextRequest:{refs:[{ref,offset:0}]}}});
      }
      const chunk=invocation.context.find(item=>item.ref==='host:history-chunk:0');
      assert.ok(chunk,'chunk not delivered');
      assert.equal(chunk.provenance.sourceId,'fixture');
      const value=chunk.value;
      chunks.push(Buffer.from(value.base64,'base64'));
      if(value.nextOffset!==undefined) {
        assert.ok(value.nextOffset>nextOffset);
        nextOffset=value.nextOffset;
        return final(invocation,{finalAssessment:undefined,
          nextController:{continue:true,contextRequest:{refs:[{ref,offset:nextOffset}]}}});
      }
      assert.equal(Buffer.concat(chunks).toString('utf8'),body);
      return final(invocation);
    }});
  const done=await (await api.submit(request())).completion;
  assert.equal(done.status,'finished',respondErrors.map(err=>String(err.stack??err)).join('\n'));
  assert.ok(controllers>=5 && controllers<=9);
  assert.equal(done.attempts.length,controllers);
  assert.equal(done.events.flatMap(event=>event.observations??[])
    .filter(item=>item.providerRef==='original-large').length,1);
});

test('C12R.9 P2: accepted positional offset request survives snapshot reopen and operation recovery',()=> 
  withOwnedRun('C12R9-history-restart',async cwd=>{
    let store=createLocalStateStore(cwd);
    await store.open();
    const {createOperation,applyEvent}=await import('../../src/core/operation.js');
    const {decision}=await import('../fixtures/core.js');
    let state=createOperation('recovered-context',request(),'fixture-authority',
      {maxInvocations:5,maxConcurrentInvocations:1});
    assert.deepEqual(await store.commit(state.operationId,null,state),{kind:'committed'});
    let n=0;
    const append=async event=>{
      const next=applyEvent(state,{eventId:'pre-'+(++n),operationId:state.operationId,receivedAt:n,...event});
      assert.equal(next.kind,'applied',JSON.stringify(next.reason));
      assert.deepEqual(await store.commit(state.operationId,state.revision,next.state),{kind:'committed'});
      state=next.state;
    };
    await append({kind:'attempt.reserved',attemptId:'prior-controller',actionId:'prior-controller'});
    await append({kind:'attempt.dispatched',attemptId:'prior-controller'});
    const body=('₽✨'.repeat(20)+'\n').repeat(2000);
    assert.ok(Buffer.byteLength(body)>64*1024);
    await append({kind:'attempt.outcome',outcome:outcome('prior-controller'),
      dispatchCertainty:'sent',observations:[{ref:'restored-data',source:'provider_reported',
        completeness:'complete',value:body,
        provenance:{kind:'provider_report',sourceId:'historic-provider',receivedAt:n}}]});
    await append({kind:'controller.responded',attemptId:'prior-controller',decision:decision({
      operationId:state.operationId,decisionId:'restored-next',finalAssessment:undefined,
      additions:[],cancellations:[],nextController:{continue:true,
        contextRequest:{refs:[{ref:{revision:3,index:0},offset:0}]}}})});
    const originalRevision=state.revision;
    await store.close();
    store=createLocalStateStore(cwd);
    await store.open();
    try {
      let read=false;
      const {api,respondErrors,invocations}=setup({store,maxInvocations:5,idPrefix:'after-restart-',
        context:{controllerMaxBytes:128*1024,fetchMaxBytes:64*1024},
        respond(invocation) {
          read=true;
          const chunk=invocation.context.find(item=>item.ref==='host:history-chunk:0');
          assert.ok(chunk,'accepted Decision request must survive restart');
          assert.equal(chunk.provenance.sourceId,'historic-provider');
          assert.equal(chunk.value.offset,0);
          const bytes=Buffer.from(chunk.value.base64,'base64');
          assert.deepEqual(bytes,Buffer.from(body).subarray(0,bytes.length));
          assert.equal(chunk.value.sourceCompleteness,'complete');
          return final(invocation);
        }});
      const restored=await(await api.resume(state.operationId)).completion;
      assert.equal(restored.status,'finished',respondErrors.map(err=>String(err.stack??err)).join('\n'));
      assert.equal(read,true);
      assert.equal(invocations.length,1);
      assert.ok(restored.revision>originalRevision);
      assert.equal(restored.events.filter(event=>event.kind==='controller.responded' &&
        event.decision.decisionId==='restored-next').length,1);
      await api.close();
    } finally {await store.close();}
  }));

test('C12R.9 P2: malformed UTF-16 stored JSON strings round-trip without replacement',async()=>{
  const body='valid 🚀 '+String.fromCharCode(0xd800)+' edge '+String.fromCharCode(0xdc00);
  assert.equal(body.isWellFormed(),false);
  const port=portFor(historyState('unpaired-string',body),512);
  const result=await readAll(port,'unpaired-string',512);
  assert.equal(result.last.format,'json');
  assert.equal(JSON.parse(result.bytes.toString('utf8')),body);
});

test('C12R.9 P2: mid-read cancellation closes chunk delivery after authenticated read',async()=>{
  const bytes=Buffer.alloc(120*1024,42);
  const ref='sha256:'+createHash('sha256').update(bytes).digest('hex');
  let release;
  let active=true;
  const state=historyState('delayed-artifact',undefined);
  state.events[0].observations[0]={ref:'delayed-artifact',source:'provider_reported',
    completeness:'complete',artifact:{ref,size:bytes.length,originalSize:bytes.length,truncated:false}};
  const store={async readArtifact(){
    return new Promise(resolve=>{release=()=>resolve({kind:'available',bytes});});
  }};
  const port=portFor(state,64*1024,store,()=>active);
  const pending=port.fetch('delayed-artifact',undefined,{offset:0});
  while(!release) await Promise.resolve();
  active=false;
  release();
  assert.deepEqual(await pending,{kind:'unavailable',reason:'closed'});
});
