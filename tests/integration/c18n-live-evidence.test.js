import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMcpBridge } from '../../src/adapters/mcp-bridge.js';
import { bindControllerPreflight } from '../../src/application/controller-preflight.js';
import { projectNativeMetadata } from '../../src/application/native-metadata.js';
import { boundContextItem, compactContext } from '../../src/application/context-bundle.js';
import { bindLiveEvidenceAccess } from '../../src/application/live-evidence.js';
import { providerEvidenceRef } from '../../src/application/evidence-identity.js';
import { materializeControllerIntent } from '../../src/application/controller-intent.js';
import { decodeControllerIntent } from '../../src/core/controller-intent.js';
import { contextItem, observation, receiveProviderObservation } from '../../src/core/observation.js';
import { decode } from '../../src/core/decode.js';
import { setup, final } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

/** @param {string} url @param {number} id @param {string} name @param {unknown} args */
async function call(url,id,name,args) {
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});
  return {status:response.status,body:await response.json()};
}
/** @param {string} url @param {number} id @param {unknown} [params] */
async function listTools(url,id,params={}) {
  return fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/list',params})}).then(r=>r.json());
}
const value = response => JSON.parse(response.body.result.content[0].text);
/** @param {string} ref @param {string | undefined} payload */
const sample=(ref,payload)=>observation({ref,completeness:payload===undefined?'truncated':'complete',
  ...(payload===undefined?{}:{value:payload})},
  {kind:'provider_tool',sourceId:'native-tool',receivedAt:123});

test('C18N.1/2 accepted live refs, native provenance, append-only cursor and bounded byte fetch',()=>{
  const nativeRef=providerEvidenceRef('operation','attempt','provider-call');
  const items=Array.from({length:17},(_,i)=>sample(i===0?nativeRef:'evidence:fixture:'+i,'Данные🌍 '+i));
  const port=bindLiveEvidenceAccess({observations:items,isActive:()=>true});
  assert.equal(providerEvidenceRef('operation','attempt','provider-call'),nativeRef);
  const first=port.list();
  assert.equal(first.kind,'available');
  assert.equal(first.items.length,12);
  assert.equal(first.items[0].ref,nativeRef);
  assert.equal(first.items[0].provenance?.kind,'provider_tool');
  assert.equal(first.items[0].source,'provider_reported');
  assert.equal(first.items[0].completeness,'complete');
  assert.equal(first.nextCursor,12);
  assert.equal(first.resumeCursor,12);
  items.push(sample('evidence:late','newly appended'));
  const second=port.list(first.nextCursor);
  assert.equal(second.kind,'available');
  assert.equal(second.items.length,6);
  assert.equal(second.items.at(-1).ref,'evidence:late');
  assert.equal(second.nextCursor,undefined);
  assert.equal(second.resumeCursor,18);
  assert.equal(port.list(18).items.length,0);
  assert.deepEqual(port.list(20),{kind:'unavailable',reason:'invalid_cursor'});
  assert.deepEqual(port.fetch('evidence:foreign'),{kind:'unavailable',reason:'missing'});
  const part1=port.fetch(nativeRef,{offset:0,maxBytes:5});
  assert.equal(part1.kind,'chunk');
  const part2=port.fetch(nativeRef,{offset:part1.nextOffset,maxBytes:100});
  assert.equal(part2.kind,'chunk');
  assert.equal(Buffer.concat([Buffer.from(part1.base64,'base64'),Buffer.from(part2.base64,'base64')]).toString('utf8'),'Данные🌍 0');
  assert.equal(part2.nextOffset,undefined);
  assert.deepEqual(port.fetch(nativeRef,{offset:999}),{kind:'unavailable',reason:'invalid_offset'});
});

test('C18N.2 closed, empty, capture gap and independent historical cursor',()=>{
  let active=true;
  const items=[];
  const port=bindLiveEvidenceAccess({observations:items,isActive:()=>active});
  assert.deepEqual(port.list(),{kind:'available',cursor:0,items:[],resumeCursor:0});
  items.push(sample('evidence:unavailable',undefined));
  assert.equal(port.list().items[0].completeness,'truncated');
  assert.deepEqual(port.fetch('evidence:unavailable'),{kind:'unavailable',reason:'payload'});
  active=false;
  assert.deepEqual(port.list(),{kind:'unavailable',reason:'closed'});
  assert.deepEqual(port.fetch('evidence:unavailable'),{kind:'unavailable',reason:'closed'});
});

test('C18N.2/4 actual MCP list/fetch, nonblocking preflight and same-turn correction',async()=>{
  const stop=new AbortController();
  let active=true, external=0;
  const observations=[];
  const access=bindLiveEvidenceAccess({observations,isActive:()=>active});
  const preflight=bindControllerPreflight({requestId:'request',events:[],observations,
    profileId:'controller',isActive:()=>active});
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'correction',controllerDelivery:'intent_mcp',
    isActive:()=>active,evidenceAccess:access,preflightIntent:preflight,
    externalTools:{list:()=>[{id:'echo',description:'fixture',effect:'read',inputSchema:{type:'object'}}],
      async call(){external++;return {status:'completed',effect:'none'};}}});
  try{
    const names=(await listTools(bridge.url,1)).result.tools.map(t=>t.name);
    assert.ok(names.includes('evidence_list'));
    assert.ok(names.includes('evidence_fetch'));
    const listed=await call(bridge.url,2,'evidence_list',{});
    assert.deepEqual(value(listed),{kind:'available',cursor:0,items:[],resumeCursor:0});
    const unknown='evidence:future';
    const intent=(ref,answer)=>({finalAssessment:{overall:'complete',answer,
      requirements:[{requirementId:'r',status:'fulfilled',observationRefs:[ref]}]}});
    const first=await call(bridge.url,3,'submit_decision',{intent:intent(unknown,'before')});
    assert.equal(value(first).kind,'proposal_pending');
    assert.equal(value(first).preflight.kind,'checked');
    assert.equal(value(first).preflight.issues[0].path,'$.finalAssessment.requirements[0].observationRefs[0]');
    assert.equal((await call(bridge.url,4,'echo',{})).status,200);
    assert.equal(external,1);
    observations.push(sample(unknown,'tool complete'));
    const page=value(await call(bridge.url,5,'evidence_list',{cursor:0}));
    assert.equal(page.items[0].ref,unknown);
    const fetched=value(await call(bridge.url,6,'evidence_fetch',{ref:unknown}));
    assert.equal(Buffer.from(fetched.base64,'base64').toString('utf8'),'tool complete');
    const corrected=await call(bridge.url,7,'submit_decision',{
      intent:intent(unknown,'after'),replaces:value(first).proposalRef});
    assert.equal(value(corrected).kind,'proposal_pending');
    assert.deepEqual(value(corrected).preflight.issues,[]);
    const result=await bridge.finalizeDecision();
    assert.equal(result.kind,'intent');
    assert.equal(result.value.finalAssessment.answer,'after');
    active=false;
    assert.deepEqual(value(await call(bridge.url,8,'evidence_list',{})),{kind:'unavailable',reason:'closed'});
  }finally{stop.abort();bridge.close();}
});

test('C18N.4 preflight uses a fresh finding index and cannot veto a registered proposal',async()=>{
  const observations=[sample('evidence:known','confirmed receipt')];
  const preflight=bindControllerPreflight({requestId:'request',events:[],observations,
    profileId:'controller',isActive:()=>true});
  const intent={findings:[{findingId:'one',claim:'claim',subject:'subject',supports:['evidence:known']}],
    finalAssessment:{overall:'complete',answer:'done',findingRefs:['finding:one']}};
  const parsed=decodeControllerIntent(intent);
  assert.equal(parsed.kind,'accepted');
  assert.deepEqual(preflight(parsed.value).issues,[]);
  assert.deepEqual(preflight(parsed.value).issues,[]);
  const stop=new AbortController();
  const bridge=await startMcpBridge({attemptId:'fallback',controllerDelivery:'intent_mcp',
    signal:stop.signal,preflightIntent:()=>{throw Error('optional failed');}});
  try{
    const result=value(await call(bridge.url,1,'submit_decision',{intent}));
    assert.equal(result.kind,'proposal_pending');
    assert.equal(result.preflight.kind,'unchecked');
    assert.equal((await bridge.finalizeDecision()).kind,'intent');
  }finally{stop.abort();bridge.close();}
});

test('C18N.2 built-ins never shadow colliding native external names',async()=>{
  const stop=new AbortController();
  const observations=[sample('evidence:one','body')];
  const port=bindLiveEvidenceAccess({observations,isActive:()=>true});
  const builtin=['submit_decision','context_list','context_fetch','evidence_list','evidence_fetch'];
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'collision',controllerDelivery:'intent_mcp',
    evidenceAccess:port,contextAccess:{
      list:()=>({kind:'available',cursor:{revision:0,index:0},items:[]}),
      fetch:async()=>({kind:'unavailable',reason:'missing'}),
      captureArtifact:async()=>undefined,
    },externalTools:{
      list:()=>builtin.map(id=>({id,description:'external '+id,effect:'read',inputSchema:{type:'object'}})),
      async call(name){return {source:'external',name};},
    }});
  try{
    const names=[];
    let cursor;
    do {
      const response=await listTools(bridge.url,100+names.length,cursor===undefined?{}:{cursor});
      names.push(...response.result.tools.map(t=>t.name));
      cursor=response.result.nextCursor;
    }while(cursor!==undefined);
    assert.equal(new Set(names).size,names.length);
    for(const name of builtin)assert.ok(names.includes(name));
    for(const name of [bridge.decisionToolName,bridge.contextListToolName,bridge.contextFetchToolName,
      bridge.evidenceListToolName,bridge.evidenceFetchToolName])assert.ok(name.startsWith('role_orchestrator_'));
    const ext=value(await call(bridge.url,1,'evidence_list',{}));
    assert.deepEqual(ext,{source:'external',name:'evidence_list'});
    assert.equal(value(await call(bridge.url,2,bridge.evidenceListToolName,{})).items[0].ref,'evidence:one');
    assert.equal(value(await call(bridge.url,3,bridge.contextListToolName,{})).kind,'available');
  }finally{stop.abort();bridge.close();}
});

test('C18N.2 existing context/external tools remain on first MCP page when evidence discovery is added',async()=>{
  const stop=new AbortController();
  const bridge=await startMcpBridge({signal:stop.signal,contextAccess:{
    list:()=>({kind:'available',cursor:{revision:0,index:0},items:[]}),
    fetch:async()=>({kind:'unavailable',reason:'missing'}),
    captureArtifact:async()=>undefined,
  },evidenceAccess:bindLiveEvidenceAccess({observations:[],isActive:()=>true}),
  externalTools:{list:()=>[{id:'echo_text',description:'fixture',effect:'read',inputSchema:{type:'object'}}],
    async call(){return {status:'completed',effect:'none'};}}});
  try{
    const first=(await listTools(bridge.url,1)).result;
    assert.deepEqual(first.tools.map(t=>t.name),['context_list','context_fetch','echo_text','evidence_list']);
    const later=(await listTools(bridge.url,2,{cursor:first.nextCursor})).result;
    assert.deepEqual(later.tools.map(t=>t.name),['evidence_fetch']);
  }finally{stop.abort();bridge.close();}
});

test('C18N.7 parsed Unicode Markdown answer survives Intent materialization unchanged',()=>{
  const answer=['# Заголовок','','🌍 🚀 `code`','> цитата','"quoted"'].join('\n');
  const result=materializeControllerIntent({finalAssessment:{overall:'complete',answer}},
    {operationId:'op',attemptId:'attempt',contextCursor:0,profileId:'controller'});
  assert.equal(result.kind,'accepted');
  assert.equal(result.value.finalAssessment.answer,answer);
});

test('C19 optional metadata snapshots current provider fields and omits invalid or oversized fields without rejecting evidence',()=>{
  const report={ref:'native-start',sourceId:'call',kind:'provider_tool',completeness:'complete',
    value:{raw:'原本🧪'},native:{eventKind:'tool_call',nativeToolCallId:'call',title:'inspect',status:'in_progress'}};
  const first=receiveProviderObservation(report,100);
  assert.deepEqual(first.native,report.native);
  report.native.status='completed';
  assert.equal(first.native.status,'in_progress');
  const later=receiveProviderObservation({...report,ref:'native-update',
    native:{eventKind:'tool_call_update',nativeToolCallId:'call'}},101);
  assert.deepEqual(later.native,{eventKind:'tool_call_update',nativeToolCallId:'call'});
  const invalid=receiveProviderObservation({...report,native:{eventKind:'tool_call_update',
    title:'界'.repeat(3000),status:42}},102);
  assert.deepEqual(invalid.native,{eventKind:'tool_call_update',omittedFields:['title','status']});
  assert.deepEqual(invalid.value,report.value);
  assert.equal(invalid.completeness,'complete');
  const restored=decode(contextItem,JSON.parse(JSON.stringify(invalid)));
  assert.equal(restored.kind,'accepted');
  assert.deepEqual(restored.value.native,invalid.native);
  const old=receiveProviderObservation({ref:'old',sourceId:'old',kind:'provider_tool',
    completeness:'complete',value:'old'},103);
  assert.equal(decode(contextItem,JSON.parse(JSON.stringify(old))).value.native,undefined);
  const claim=receiveProviderObservation({...report,kind:'model'},104);
  assert.equal(claim.source,'model_claim');
  assert.equal(claim.native,undefined);
});

test('C19 bounded metadata keeps prior refs/provenance and raw retrieval; omissions and continuation remain explicit',()=>{
  const records=Array.from({length:13},(_,i)=>receiveProviderObservation({
    ref:'evidence:fixture:'+i,sourceId:'tool',kind:'provider_tool',completeness:'complete',
    value:'原本🧪 '+i,native:{eventKind:'tool_call_update',nativeToolCallId:'tool',
      title:'界'.repeat(900),status:'completed'}},123));
  const port=bindLiveEvidenceAccess({observations:records,isActive:()=>true});
  const first=port.list();
  assert.equal(first.kind,'available');
  assert.equal(first.items.length,12);
  for(const row of first.items){
    assert.ok(Buffer.byteLength(JSON.stringify(row))<=1536);
    assert.equal(row.provenance.kind,'provider_tool');
    assert.equal(row.native.status,'completed');
    assert.ok(row.omittedMetadataFields.includes('native.title'));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(first))<=24*1024);
  const next=port.list(first.resumeCursor);
  assert.equal(next.items[0].ref,records.at(-1).ref);
  const fetched=port.fetch(records[0].ref);
  assert.equal(fetched.item.ref,records[0].ref);
  assert.equal(Buffer.from(fetched.base64,'base64').toString('utf8'),records[0].value);
});

test('C19 equivalent provider reports keep first metadata and canonical ref; historical list/fetch retains metadata',async()=>{
  let ref;
  const {api,respondErrors}=setup({maxInvocations:2,async respond(invocation,count,observe){
    if(count===1){
      const report={ref:'native-report',kind:'provider_tool',sourceId:'call',completeness:'complete',
        value:'original body',native:{eventKind:'tool_call',nativeToolCallId:'call',status:'in_progress'}};
      ref=observe(report);
      assert.match(ref,/^evidence:[a-f0-9]{64}$/);
      assert.equal(observe({...report,native:{eventKind:'tool_call',nativeToolCallId:'call'}}),ref);
      assert.equal(observe({...report,value:'conflicting payload'}),undefined);
      return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
    }
    const page=invocation.contextAccess.list();
    assert.equal(page.kind,'available');
    const item=page.items.find(item=>item.ref===ref);
    assert.equal(item.native.status,'in_progress');
    const fetched=await invocation.contextAccess.fetch(ref,invocation.operationId,{offset:0});
    assert.equal(fetched.kind,'chunk');
    assert.equal(fetched.item.native.status,'in_progress');
    assert.equal(Buffer.from(fetched.base64,'base64').toString('utf8'),'original body');
    return final(invocation);
  }});
  try{
    const state=await(await api.submit(request())).completion;
    assert.equal(state.status,'finished',respondErrors.map(String).join('\n'));
    const accepted=state.events.flatMap(e=>e.observations??[]).filter(o=>o.ref===ref);
    assert.equal(accepted.length,1);
    assert.equal(accepted[0].native.status,'in_progress');
  }finally{await api.close();}
});

test('C19 synthetic directory/fetch representation cost compared with identical records without metadata',()=>{
  const withNative=Array.from({length:120},(_,i)=>receiveProviderObservation({
    ref:'evidence:fixture:'+i,kind:'provider_tool',sourceId:'tool-'+i,completeness:'complete',
    value:'body '+i,native:{eventKind:'tool_call_update',nativeToolCallId:'tool-'+i,
      title:'Native observation '+i,status:'completed'}},100));
  const withoutNative=withNative.map(({native,...base})=>base);
  function measure(records){
    const port=bindLiveEvidenceAccess({observations:records,isActive:()=>true});
    const start=performance.now();
    let cursor=0,pages=0,bytes=0,omissions=0;
    do{
      const page=port.list(cursor);
      assert.equal(page.kind,'available');
      pages++;bytes+=Buffer.byteLength(JSON.stringify(page));
      omissions+=page.items.reduce((sum,row)=>sum+(row.omittedMetadataFields?.length??0),0);
      cursor=page.nextCursor;
    }while(cursor!==undefined);
    const fetch=port.fetch(records[0].ref);
    return {pages,bytes,omissions,fetchBytes:Buffer.byteLength(JSON.stringify(fetch)),elapsedMs:performance.now()-start};
  }
  const baseline=measure(withoutNative),current=measure(withNative);
  const large=measure(withNative.map(item=>({...item,native:{...item.native,title:'界"\\\\'.repeat(250)}})));
  assert.equal(current.pages,baseline.pages);
  assert.equal(current.omissions,0);
  assert.equal(large.pages,baseline.pages);
  assert.equal(large.omissions,withNative.length);
  console.log('C19_DIRECTORY '+JSON.stringify({records:120,baseline,current,large,scope:'synthetic representation, not native model latency'}));
});

test('C19-R.2 complete native metadata fits without temporary partial omission overhead',()=>{
  const base={ref:'evidence:fixture',source:'provider_reported',completeness:'complete',
    provenance:{kind:'provider_tool',sourceId:'call',receivedAt:1},value:'body',
    omittedMetadataFields:['reportedContext']};
  const native={eventKind:'tool_call',status:'ok'};
  const full={...base,native};
  const budget=Buffer.byteLength(JSON.stringify(full));
  assert.deepEqual(projectNativeMetadata(base,native,budget),full);
  assert.deepEqual(projectNativeMetadata(base,undefined,budget),base);
});

test('C19-R.2 omission-only and exact budget boundaries preserve the existing representation',()=>{
  const base={ref:'evidence:fixture',source:'provider_reported',completeness:'complete',
    provenance:{kind:'provider_tool',sourceId:'call',receivedAt:1},value:'original 🧪',
    omittedMetadataFields:['reportedContext']};
  const native={title:'界"\\'.repeat(250)};
  const marker={...base,omittedMetadataFields:['reportedContext','native']};
  const bytes=item=>Buffer.byteLength(JSON.stringify(item));
  assert.deepEqual(projectNativeMetadata(base,native,bytes(marker)),marker);
  assert.deepEqual(projectNativeMetadata(base,native,bytes(marker)-1),base);
  assert.deepEqual(projectNativeMetadata(base,native,bytes(base)),base);
  const item={...base,native};
  assert.deepEqual(boundContextItem(item,bytes(marker)),marker);
  assert.deepEqual(boundContextItem(item,bytes(base)),base);
  assert.deepEqual(compactContext([item],bytes(base)+3,true).context,[base]);
  assert.deepEqual(item.native,native,'projection never mutates the stored snapshot');
});
