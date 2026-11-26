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
  assert.equal(port.list().items[0].hasCapturedValue,false);
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
    const tools=(await listTools(bridge.url,1)).result.tools;
    const list=tools.find(t=>t.name==='evidence_list');
    const fetch=tools.find(t=>t.name==='evidence_fetch');
    assert.deepEqual(list.inputSchema,{type:'object',properties:{cursor:{type:'integer',minimum:0}},additionalProperties:false});
    assert.deepEqual(Object.keys(fetch.inputSchema.properties),['ref','offset','maxBytes']);
    assert.match(list.description,/inheritedFields/);
    assert.match(list.description,/hasCapturedValue/);
    assert.match(list.description,/pass resumeCursor as cursor to read later, even after an empty\/exhausted page/);
    assert.match(list.description,/nextCursor signals more entries already captured/);
    assert.match(list.description,/canonical ref identifies a record, not proof/);
    assert.match(list.description,/source\/provenance attribute the report/);
    assert.match(list.description,/completeness describes capture, not tool success/);
    assert.match(list.description,/native\.omittedFields marks capture-metadata omissions/);
    assert.match(list.description,/omittedMetadataFields marks projection omissions/);
    assert.match(fetch.description,/not capture completeness or tool status/);
    assert.match(fetch.description,/do not establish full source capture or durable commit/);
    assert.match(fetch.description,/totalBytes/);
    assert.match(fetch.description,/format \(utf8\/json\)/);
    assert.match(fetch.description,/nextOffset \(byte offset for the next chunk\)/);
    assert.match(tools.find(t=>t.name==='submit_decision').description,/need not be repeated/);
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
    assert.equal(page.items[0].hasCapturedValue,true);
    observations.push(sample('evidence:payload-less',undefined));
    const resumed=value(await call(bridge.url,51,'evidence_list',{cursor:page.resumeCursor}));
    assert.equal(resumed.items[0].hasCapturedValue,false);
    assert.equal(resumed.items[0].completeness,'truncated');
    assert.deepEqual(value(await call(bridge.url,52,'evidence_fetch',{ref:'evidence:payload-less'})),
      {kind:'unavailable',reason:'payload'});
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
        value:'original body',native:{eventKind:'tool_call_update',nativeToolCallId:'call',status:'in_progress',
          title:'Earlier title',kind:'read',inheritedFields:['title','kind']}};
      ref=observe(report);
      assert.match(ref,/^evidence:[a-f0-9]{64}$/);
      assert.equal(observe({...report,native:{...report.native,title:'Later title'}}),ref);
      assert.equal(observe({...report,value:'conflicting payload'}),undefined);
      return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
    }
    const page=invocation.contextAccess.list();
    assert.equal(page.kind,'available');
    const item=page.items.find(item=>item.ref===ref);
    assert.equal(item.native.status,'in_progress');
    assert.equal(item.native.title,'Earlier title');
    assert.deepEqual(item.native.inheritedFields,['title','kind']);
    const fetched=await invocation.contextAccess.fetch(ref,invocation.operationId,{offset:0});
    assert.equal(fetched.kind,'chunk');
    assert.equal(fetched.item.native.status,'in_progress');
    assert.deepEqual(fetched.item.native.inheritedFields,['title','kind']);
    assert.equal(fetched.item.native.title,'Earlier title');
    assert.equal(Buffer.from(fetched.base64,'base64').toString('utf8'),'original body');
    return final(invocation);
  }});
  try{
    const state=await(await api.submit(request())).completion;
    assert.equal(state.status,'finished',respondErrors.map(String).join('\n'));
    const accepted=state.events.flatMap(e=>e.observations??[]).filter(o=>o.ref===ref);
    assert.equal(accepted.length,1);
    assert.equal(accepted[0].native.status,'in_progress');
    assert.equal(accepted[0].native.title,'Earlier title');
    assert.deepEqual(accepted[0].native.inheritedFields,['title','kind']);
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

test('C21 inherited identification is accepted immutably, validated and round-tripped',()=>{
  const report={ref:'sparse',kind:'provider_tool',sourceId:'call',completeness:'complete',
    value:{status:'completed'},native:{eventKind:'tool_call_update',nativeToolCallId:'call',
      title:'Earlier title',kind:'read',status:'completed',inheritedFields:['title','kind']}};
  const item=receiveProviderObservation(report,100);
  assert.deepEqual(item.native,report.native);
  report.native.inheritedFields.pop();
  report.native.title='changed';
  assert.deepEqual(item.native.inheritedFields,['title','kind']);
  assert.equal(item.native.title,'Earlier title');
  const reopened=decode(contextItem,JSON.parse(JSON.stringify(item)));
  assert.equal(reopened.kind,'accepted');
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.value)),JSON.parse(JSON.stringify(item)));
  const malformed=receiveProviderObservation({...report,native:{...report.native,inheritedFields:['status']}},101);
  assert.equal(malformed.native.title,undefined);
  assert.equal(malformed.native.kind,undefined);
  assert.equal(malformed.native.status,'completed');
  assert.ok(malformed.native.omittedFields.includes('inheritedFields'));
  assert.deepEqual(malformed.value,report.value);
  assert.equal(malformed.completeness,'complete');
  const long=receiveProviderObservation({...report,native:{...report.native,title:'界'.repeat(1025),
    inheritedFields:['title','kind']}},102);
  assert.equal(long.native.title,undefined);
  assert.deepEqual(long.native.inheritedFields,['kind']);
  assert.ok(long.native.omittedFields.includes('title'));
});

test('C21 inherited identity and its attribution fit together or are omitted across byte bounds',()=>{
  const base={ref:'evidence:fixture',source:'provider_reported',completeness:'complete',
    provenance:{kind:'provider_tool',sourceId:'call',receivedAt:1},value:'original 🧪'};
  const native={eventKind:'tool_call_update',nativeToolCallId:'call',title:'界"\\'.repeat(220),
    kind:'read',status:'completed',inheritedFields:['title','kind']};
  const item={...base,native};
  const start=Buffer.byteLength(JSON.stringify(base)),end=Buffer.byteLength(JSON.stringify(item));
  for(let budget=start;budget<=end;budget++){
    const projected=projectNativeMetadata(base,native,budget);
    assert.ok(Buffer.byteLength(JSON.stringify(projected))<=budget);
    const fields=projected.native?.inheritedFields??[];
    for(const field of native.inheritedFields) {
      assert.equal(projected.native?.[field]!==undefined,fields.includes(field),
        'attribution and value must be paired at '+budget);
    }
    assert.equal(projected.value,base.value);
  }
  const port=bindLiveEvidenceAccess({observations:[item],isActive:()=>true});
  const row=port.list().items[0];
  assert.equal(row.native.title,undefined);
  assert.deepEqual(row.native.inheritedFields,['kind']);
  assert.ok(row.omittedMetadataFields.includes('native.title'));
  assert.deepEqual(port.fetch(item.ref).item.native,row.native);
  assert.deepEqual(boundContextItem(item,1536).native.inheritedFields,['kind']);
  assert.deepEqual(item.native,native);
});

test('C22 F2/F4 actual MCP argument errors and annotation-only Intent shape; no retrieval on invalid input',async()=>{
  const stop=new AbortController();
  let calls=0;
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'c22-tools',controllerDelivery:'intent_mcp',
    contextAccess:{list(){calls++;return {kind:'unavailable',reason:'closed'}},
      async fetch(){calls++;return {kind:'unavailable',reason:'closed'}},
      async captureArtifact(){throw Error('not called')}},
    evidenceAccess:{list(){calls++;return {kind:'unavailable',reason:'closed'}},
      fetch(){calls++;return {kind:'unavailable',reason:'closed'}}}});
  try{
    const first=(await listTools(bridge.url,1)).result;
    const second=(await listTools(bridge.url,2,{cursor:first.nextCursor})).result;
    const tools=[...first.tools,...second.tools];
    const decision=tools.find(t=>t.name===bridge.decisionToolName);
    assert.deepEqual(decision.inputSchema,{type:'object',properties:{intent:{},replaces:{type:'string'}},
      required:['intent'],additionalProperties:false});
    for(const part of ['additions?: Action[]','waitPolicy?:','clarification?:','nextController?:','contextRequest?:',
      'Assessment:', 'requirementId:string','unverified','Finding:','after_model_acceptance','nested author','default only to empty arrays']){
      assert.ok(decision.description.includes(part),part);
    }
    assert.match(tools.find(t=>t.name==='context_fetch').description,/maxBytes limits a range response only when offset is supplied/);
    assert.match(tools.find(t=>t.name==='evidence_fetch').description,/maxBytes alone reads from offset 0/);
    const samples=[
      ['context_list',{cursor:false},'$.cursor','an object',undefined,/use 0.*\{revision, index\}.*legacy Decisions.*not valid retrieval cursors/],
      ['context_fetch',{},'$.ref','an object',undefined,/non-empty reference string or an object \{revision, index\}/],
      ['evidence_list',{bogus:1},'$.bogus','a supported field',['cursor']],
      ['evidence_fetch',{ref:'x',offset:-1},'$.offset','a non-negative safe integer'],
      ['context_fetch',{ref:'x',bogus:1},'$.bogus','a supported field',['ref','sourceOperationId','offset','maxBytes']],
    ];
    let n=2;
    for(const [name,args,path,expected,allowedFields,hintPattern] of samples){
      const result=value(await call(bridge.url,++n,name,args));
      assert.equal(result.kind,'unavailable');
      assert.equal(result.reason,'invalid_input');
      const {hint,...primary}=result.diagnostic;
      assert.deepEqual(primary,{code:'INVALID_PROPOSAL',path,expected,...(allowedFields&&{allowedFields})});
      if(hintPattern)assert.match(hint,hintPattern);
      else assert.equal(hint,undefined);
    }
    const key='🌍'.repeat(4000);
    const large=value(await call(bridge.url,++n,'evidence_list',{[key]:1}));
    assert.equal(large.reason,'invalid_input');
    assert.equal(large.diagnostic.path.length,512);
    assert.deepEqual(large.diagnostic.allowedFields,['cursor']);
    assert.equal(calls,0);
    assert.equal((await bridge.finalizeDecision()).kind,'missing');
  }finally{stop.abort();bridge.close();}
});
