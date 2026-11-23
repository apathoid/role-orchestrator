import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { startMcpBridge, retrievalDetail } from '../../src/adapters/mcp-bridge.js';
import { compileExternalTool, createExternalToolPort } from '../../src/application/configuration/external-tools.js';
import { bindControllerPreflight } from '../../src/application/controller-preflight.js';
import { bindLiveEvidenceAccess } from '../../src/application/live-evidence.js';
import { decodeControllerIntent } from '../../src/core/controller-intent.js';
import { observation } from '../../src/core/observation.js';

const native = (ref, value = 'payload', sourceId = 'native-call') =>
  observation({ ref, completeness: 'complete', value }, { kind: 'provider_tool', sourceId, receivedAt: 1 });

const definition = (id, invoke = async () => 'ok', effect = 'write') => ({
  id, description: 'Fixture '+id, resource: 'fixture:'+id, effect,
  inputSchema: { type:'object', additionalProperties:true }, invoke,
});

/** @param {string} url @param {number|string} id @param {string} method @param {unknown} params */
async function rpc(url,id,method,params) {
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  return {status:response.status,body:await response.json()};
}
/** @param {string} url @param {number|string} id @param {string} name @param {unknown} args */
const call=(url,id,name,args={})=>rpc(url,id,'tools/call',{name,arguments:args});
const value=reply=>JSON.parse(reply.body.result.content[0].text);

test('C18N-R RED R1: registered External ToolPort runs 100+ independent calls with receipts, permissions and provenance',async()=>{
  const tool=await compileExternalTool(definition('write',async input=>({seq:input.seq})));
  assert.ok(tool);
  const stop=new AbortController();
  let executions=0, grants=0;
  const receipts=[];
  const original=tool.invoke;
  tool.invoke=async (...args)=>{executions++;return original(...args);};
  const port=createExternalToolPort(new Map([['write',tool]])).bind({
    attemptId:'attempt-r1',operationId:'operation-r1',signal:stop.signal,isActive:()=>true,
    permissions:{async request(){grants++;return {kind:'selected',option:'allow'};}},
    newId:()=> 'external-'+(receipts.length+1),maxBytes:64*1024,
    receive(name,receipt){receipts.push({name,receipt});return 'host:tool:'+receipt.callId;},
  });
  const bridge=await startMcpBridge({signal:stop.signal,externalTools:port});
  try {
    for(let i=1;i<=120;i++){
      const response=await call(bridge.url,i,'write',{seq:i});
      assert.equal(response.status,200);
      assert.equal(value(response).status,'completed','call '+i);
      assert.equal(value(response).effect,'possible');
      assert.equal(value(response).ref,'host:tool:external-'+i);
    }
    assert.equal(executions,120);
    assert.equal(grants,120);
    assert.equal(receipts.length,120);
    for(let i=0;i<receipts.length;i++){
      assert.equal(receipts[i].name,'write');
      assert.equal(receipts[i].receipt.attemptId,'attempt-r1');
      assert.equal(receipts[i].receipt.output.seq,i+1);
    }
  }finally{stop.abort();bridge.close();}
});

test('C18N-R RED R2: rechecking unchanged large live buffer makes no repeated indexed-record visits',()=>{
  const underlying=Array.from({length:15000},(_,i)=>native('evidence:entry-'+i));
  let indexedReads=0;
  const observations=new Proxy(underlying,{get(target,key,receiver){
    if(typeof key==='string' && /^[0-9]+$/.test(key))indexedReads++;
    return Reflect.get(target,key,receiver);
  }});
  const preflight=bindControllerPreflight({requestId:'request',events:[],observations,
    profileId:'controller',isActive:()=>true});
  const parsed=decodeControllerIntent({finalAssessment:{
    overall:'complete',answer:'large context',observationRefs:['evidence:entry-14999']}});
  assert.equal(parsed.kind,'accepted');
  const first=preflight(parsed.value);
  assert.equal(first.kind,'checked');
  assert.deepEqual(first.issues,[]);
  const indexedInitially=indexedReads;
  assert.ok(indexedInitially>=underlying.length);
  indexedReads=0;
  const start=performance.now();
  for(let n=0;n<12;n++)assert.deepEqual(preflight(parsed.value).issues,[]);
  const repeatMs=performance.now()-start;
  assert.equal(indexedReads,0,'every correction must avoid re-reading existing observations; ms='+repeatMs);
  underlying.push(native('evidence:late-1'));
  const late=decodeControllerIntent({finalAssessment:{overall:'complete',answer:'later',
    observationRefs:['evidence:late-1']}});
  assert.equal(late.kind,'accepted');
  assert.deepEqual(preflight(late.value).issues,[]);
  assert.ok(indexedReads<=2,'only newly accepted observations may be scanned');
});

test('C18N-R RED R3: all external builtin-name collisions compile and remain reachable through real ToolPort',async()=>{
  const collisionNames=['context_list','context_fetch','evidence_list','evidence_fetch','submit_decision'];
  const compiled=await Promise.all(collisionNames.map(name=>compileExternalTool(definition(name,async()=>name,'read'))));
  compiled.forEach((tool,i)=>assert.ok(tool,'registration '+collisionNames[i]));
  const registered=new Map(compiled.map((tool,i)=>[collisionNames[i],tool]));
  const stop=new AbortController();
  const observations=[native('evidence:identity')];
  let sequence=0;
  const tools=createExternalToolPort(registered).bind({
    operationId:'collision-op',attemptId:'collision-attempt',signal:stop.signal,isActive:()=>true,
    permissions:{async request(){return {kind:'selected',option:'allow'};}},
    newId:()=> 'call-'+(++sequence),maxBytes:4096,receive(){return 'host:tool:receipt-'+sequence;},
  });
  const bridge=await startMcpBridge({signal:stop.signal,attemptId:'collision-attempt',controllerDelivery:'intent_mcp',
    externalTools:tools,evidenceAccess:bindLiveEvidenceAccess({observations,isActive:()=>true}),
    contextAccess:{list:()=>({kind:'available',cursor:{revision:0,index:0},items:[]}),
      fetch:async()=>({kind:'unavailable',reason:'missing'}),captureArtifact:async()=>undefined}});
  try{
    const all=[];let cursor;
    do{
      const page=(await rpc(bridge.url,150+all.length,'tools/list',cursor?{cursor}:{})).body.result;
      all.push(...page.tools.map(tool=>tool.name));
      cursor=page.nextCursor;
    }while(cursor!==undefined);
    assert.equal(new Set(all).size,all.length);
    for(const name of collisionNames){
      assert.ok(all.includes(name),name);
      const result=value(await call(bridge.url,'x-'+name,name));
      assert.equal(result.output,name);
    }
    for(const name of [bridge.contextListToolName,bridge.contextFetchToolName,
      bridge.evidenceListToolName,bridge.evidenceFetchToolName,bridge.decisionToolName]){
      assert.ok(name.startsWith('role_orchestrator_'));
      assert.ok(all.includes(name));
    }
    assert.equal(value(await call(bridge.url,201,bridge.contextListToolName)).kind,'available');
    assert.equal(value(await call(bridge.url,202,bridge.evidenceListToolName)).items[0].ref,'evidence:identity');
    assert.match(retrievalDetail(true,bridge),new RegExp(bridge.evidenceListToolName));
    const result=value(await call(bridge.url,203,bridge.decisionToolName,
      {intent:{finalAssessment:{overall:'complete',answer:'done'}}}));
    assert.equal(result.kind,'proposal_pending');
    assert.equal((await bridge.finalizeDecision()).kind,'intent');
  }finally{stop.abort();bridge.close();}
});

test('C18N-R RED R4: explicit resume cursor persists after empty/exhausted snapshot and new append',()=>{
  const observations=[];
  const access=bindLiveEvidenceAccess({observations,isActive:()=>true});
  const empty=access.list();
  assert.equal(empty.resumeCursor,0);
  assert.equal(empty.nextCursor,undefined);
  observations.push(native('evidence:a'),native('evidence:b'));
  const initial=access.list(empty.resumeCursor);
  assert.deepEqual(initial.items.map(item=>item.ref),['evidence:a','evidence:b']);
  assert.equal(initial.resumeCursor,2);
  assert.equal(initial.nextCursor,undefined);
  observations.push(native('evidence:c'),native('evidence:d'));
  const late=access.list(initial.resumeCursor);
  assert.deepEqual(late.items.map(item=>item.ref),['evidence:c','evidence:d']);
  assert.equal(late.resumeCursor,4);
  assert.equal(access.list(late.resumeCursor).resumeCursor,4);
  assert.deepEqual(access.list(999),{kind:'unavailable',reason:'invalid_cursor'});
});

test('C18N-R RED R5: oversized metadata does not strand entries; origin completeness and fetched bytes survive',async()=>{
  const sourceId='Ƀ'.repeat(18000);
  const observations=[
    native('evidence:large', 'body-🌍',sourceId),
    native('evidence:next','next-body'),
    native('evidence:third','third-body'),
  ];
  const stop=new AbortController();
  const bridge=await startMcpBridge({signal:stop.signal,
    evidenceAccess:bindLiveEvidenceAccess({observations,isActive:()=>true})});
  try{
    const first=value(await call(bridge.url,1,bridge.evidenceListToolName,{cursor:0}));
    assert.equal(first.kind,'available');
    assert.equal(first.items[0].ref,'evidence:large');
    assert.equal(first.items[0].source,'provider_reported');
    assert.equal(first.items[0].completeness,'complete');
    assert.ok(first.items[0].omittedMetadataFields?.includes('provenance'));
    const remainder=value(await call(bridge.url,2,bridge.evidenceListToolName,
      {cursor:first.resumeCursor}));
    assert.ok([...first.items,...remainder.items].some(item=>item.ref==='evidence:next'));
    const fetched=value(await call(bridge.url,3,bridge.evidenceFetchToolName,{ref:'evidence:large'}));
    assert.equal(fetched.kind,'chunk');
    assert.equal(Buffer.from(fetched.base64,'base64').toString('utf8'),'body-🌍');
    assert.ok(Buffer.byteLength(JSON.stringify(first))<24*1024);
    assert.ok(Buffer.byteLength(JSON.stringify(fetched))<256*1024);
  }finally{stop.abort();bridge.close();}
});

test('C18N-R R2 parity: history, inherited findings, ambiguous aliases and late observations',()=>{
  const priorFinding={findingId:'prior',author:'controller',claim:'prior',subject:'subject',
    supports:['evidence:historical'],uncertainties:[]};
  const events=[{kind:'attempt.outcome',outcome:{outputRefs:[{ref:'finding-output:past',kind:'finding'}]},
    observations:[native('evidence:historical')],findings:[priorFinding]}];
  const current=native('evidence:live');
  const observations=[current];
  let active=true;
  const preflight=bindControllerPreflight({requestId:'request',events,observations,
    profileId:'controller',isActive:()=>active});
  const run=raw=>{
    const p=decodeControllerIntent(raw);
    assert.equal(p.kind,'accepted');
    return preflight(p.value);
  };
  const good={findings:[{findingId:'new',claim:'new',subject:'subject',
    supports:['evidence:historical','evidence:live'],supersedes:'finding:prior'}],
    finalAssessment:{overall:'complete',answer:'done',observationRefs:['evidence:live','evidence:historical'],
      findingRefs:['finding:prior','finding:new','finding-output:past']}};
  assert.deepEqual(run(good).issues,[]);
  assert.deepEqual(run(good).issues,[],'temporary finding-index mutation must not leak between proposals');
  const duplicate=run({...good,findings:[{...good.findings[0],findingId:'prior'}]});
  assert.equal(duplicate.issues[0].path,'$.findings[0].findingId');
  const missing=run({finalAssessment:{overall:'complete',answer:'pending',
    observationRefs:['evidence:late-worker']}});
  assert.equal(missing.issues[0].availability,'not_in_snapshot');
  observations.push(native('evidence:late-worker'));
  assert.deepEqual(run({finalAssessment:{overall:'complete',answer:'received',
    observationRefs:['evidence:late-worker']}}).issues,[]);
  // Same provider-local ref as the historical Request is ambiguous:
  // require canonical IDs without choosing silently.
  current.providerRef='request';
  // The index is append-only: mutate a fixture only before it is indexed in a
  // fresh preflight to reflect the production immutability contract.
  const aliasCheck=bindControllerPreflight({requestId:'request',events,observations,
    profileId:'controller',isActive:()=>active});
  const ambiguous=(()=>{
    const parsed=decodeControllerIntent({finalAssessment:{overall:'complete',answer:'ambiguous',
      observationRefs:['request']}});
    assert.equal(parsed.kind,'accepted');return aliasCheck(parsed.value);
  })();
  assert.ok(ambiguous.issues.some(issue=>issue.availability==='ambiguous'));
  active=false;
  assert.deepEqual(run(good),{kind:'unchecked',reason:'closed',advisory:true});
});

test('C18N-R R4/R5: consecutive oversized metadata, exhausted complete page and explicit positional gaps',()=>{
  const largeId='📦'.repeat(10000);
  const observations=[
    native('evidence:oversized-a','a',largeId),
    native('evidence:normal-1','ok'),
    native('evidence:oversized-b','b',largeId),
    native('evidence:oversized-c','c',largeId),
    native('evidence:normal-2','ok'),
    native('evidence:very-long-ref:'+'v'.repeat(5000),'unreachable-from-directory'),
    native('evidence:normal-3','ok'),
  ];
  const access=bindLiveEvidenceAccess({observations,isActive:()=>true});
  const first=access.list();
  assert.equal(first.kind,'available');
  assert.equal(first.items.length,7);
  assert.equal(first.resumeCursor,7);
  assert.equal(first.nextCursor,undefined);
  assert.equal(first.items[0].omittedMetadataFields.includes('provenance'),true);
  assert.deepEqual(first.items[5],{kind:'unavailable',reason:'budget',index:5});
  assert.equal(first.items[6].ref,'evidence:normal-3');
  assert.ok(Buffer.byteLength(JSON.stringify(first))<24*1024);
  observations.push(...Array.from({length:12},(_,i)=>native('evidence:later-'+i)));
  const next=access.list(first.resumeCursor);
  assert.equal(next.items.length,12);
  assert.equal(next.resumeCursor,19);
  assert.equal(next.nextCursor,undefined);
  observations.push(native('evidence:late-after-full-page'));
  const last=access.list(next.resumeCursor);
  assert.equal(last.items[0].ref,'evidence:late-after-full-page');
  assert.equal(last.resumeCursor,20);
  assert.equal(access.list(20).resumeCursor,20);
});
