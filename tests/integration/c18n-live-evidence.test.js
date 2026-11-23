import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMcpBridge } from '../../src/adapters/mcp-bridge.js';
import { bindControllerPreflight } from '../../src/application/controller-preflight.js';
import { bindLiveEvidenceAccess } from '../../src/application/live-evidence.js';
import { providerEvidenceRef } from '../../src/application/evidence-identity.js';
import { materializeControllerIntent } from '../../src/application/controller-intent.js';
import { decodeControllerIntent } from '../../src/core/controller-intent.js';
import { observation } from '../../src/core/observation.js';

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
  items.push(sample('evidence:late','newly appended'));
  const second=port.list(first.nextCursor);
  assert.equal(second.kind,'available');
  assert.equal(second.items.length,6);
  assert.equal(second.items.at(-1).ref,'evidence:late');
  assert.equal(second.nextCursor,undefined);
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
  assert.deepEqual(port.list(),{kind:'available',cursor:0,items:[]});
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
    assert.deepEqual(value(listed),{kind:'available',cursor:0,items:[]});
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
