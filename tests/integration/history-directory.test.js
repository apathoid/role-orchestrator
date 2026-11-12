import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindContextAccess, materializeControllerHistory } from '../../src/application/context-access.js';
import { controllerContext, operationHistory } from '../../src/application/controller-context.js';
import { decodeDecision } from '../../src/core/contracts.js';
import { applyEvent, createOperation } from '../../src/core/operation.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import { startMcpBridge } from '../../src/adapters/mcp-bridge.js';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
import { decision, outcome, request } from '../fixtures/core.js';
import { final, setup } from '../fixtures/application.js';

const report=(ref,value='value')=>({ref,source:'provider_reported',completeness:'complete',value,
  provenance:{kind:'provider_report',sourceId:'fixture',receivedAt:1}});
const pointer=ref=>({ref,source:'provider_reported',kind:'output'});
const pageRecord=invocation=>invocation.context.find(item=>item.ref.startsWith('host:history-page:'));

function fixture(id='directory') {
  let state=createOperation(id,request(),'fixture-authority',{maxInvocations:60,maxConcurrentInvocations:4});
  let seq=0;
  function append(event) {
    const transition=applyEvent(state,{...event,operationId:id,eventId:'event-'+(++seq),receivedAt:seq});
    assert.equal(transition.kind,'applied',JSON.stringify(transition.reason));
    state=transition.state;
    return state;
  }
  function reserve(attemptId) {
    append({kind:'attempt.reserved',attemptId,actionId:attemptId});
    append({kind:'attempt.dispatched',attemptId});
  }
  function batch(attemptId,observations,extra={}) {
    reserve(attemptId);
    append({kind:'attempt.outcome',dispatchCertainty:'sent',outcome:outcome(attemptId),
      observations,...extra});
  }
  return {append,reserve,batch,get state(){return state}};
}
function port(state,{selected,active=()=>true,maxBytes=65536}={}) {
  return bindContextAccess({state,store:{},maxBytes,profileId:'primary',attemptId:'reader',
    selected,isActive:active,newId:()=> 'artifact',now:()=>1,receive(){}});
}
function traverse(access,cursor=0) {
  const items=[];
  let pages=0;
  do {
    const page=access.list(cursor);
    assert.equal(page.kind,'available');
    assert.ok(page.items.length<=32);
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=8192);
    items.push(...page.items);
    if(page.nextCursor) {
      assert.ok(page.items.length>0);
      assert.equal(page.nextCursor.revision,page.cursor.revision);
      assert.equal(page.nextCursor.index,page.cursor.index+page.items.length);
    }
    cursor=page.nextCursor;
    assert.ok(++pages<100,'traversal must terminate');
  } while(cursor!==undefined);
  return {items,pages};
}

for(const budget of [256*1024,6000]) {
  test('history directory: growing real Controller prompt-only traversal, budget '+budget,async()=>{
    let controllers=0,workers=0,revision,firstCount,fresh=false,partial=false;
    const seen=[];
    const cursors=[];
    const {api,respondErrors,invocations}=setup({maxInvocations:45,
      context:{controllerMaxBytes:budget},respond(invocation,_,observe) {
        if(invocation.kind==='delegate') {
          workers++;
          const ref=observe({ref:'worker-added',kind:'provider_report',sourceId:'fixture',
            completeness:'complete',value:'new worker evidence'});
          return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),
            findings:[{findingId:'worker-finding',author:'primary',claim:'Worker result',
              subject:'worker',supports:[ref],uncertainties:[]}]};
        }
        controllers++;
        // The original failure added 31 observations and one Decision per
        // Controller turn. Keep growing the journal throughout the traversal.
        let support;
        for(let i=0;i<31;i++) {
          const ref=observe({ref:'controller-'+controllers+'-'+i,kind:'provider_report',
            sourceId:'fixture',completeness:'complete',value:'report '+controllers+' '+i});
          if(i===0) support=ref;
        }
        const findings=controllers%2===0?[{findingId:'finding-'+controllers,author:'primary',
          claim:'Historical claim',subject:'history',supports:[support],uncertainties:[]}]:undefined;
        const next=(cursor,additions=[])=>final(invocation,{finalAssessment:undefined,
          findings,additions,nextController:{continue:true,contextRequest:{cursor}}});
        if(controllers<4) return final(invocation,{finalAssessment:undefined,findings,
          nextController:{continue:true}});
        if(controllers===4) return next(0);
        // No access to contextAccess.list or an out-of-band history index:
        // this fixture model can only copy the cursor in its delivered prompt.
        const record=pageRecord(invocation);
        assert.ok(record,'structured history page must be delivered');
        assert.equal(record.excerpt,undefined);
        const page=record.value;
        assert.equal(page.kind,'available');
        assert.ok(page.items.length>0);
        if(fresh) {
          assert.ok(page.cursor.revision>revision);
          assert.equal(page.cursor.index,0);
          assert.ok(page.items.some(item=>!seen.some(prior=>prior.ref===item.ref)),
            'fresh traversal includes new records');
          return final(invocation,{findings});
        }
        if(revision===undefined) {
          revision=page.cursor.revision;
          firstCount=page.items.length;
          assert.equal(page.cursor.index,0);
          if(budget===256*1024) assert.equal(firstCount,32);
        }
        assert.equal(page.cursor.revision,revision);
        assert.equal(page.cursor.index,seen.length);
        cursors.push(page.cursor);
        for(const item of page.items) {
          assert.ok(!seen.some(prior=>prior.ref===item.ref),'no repeated historical identity');
          seen.push(item);
        }
        if(page.nextCursor) {
          assert.deepEqual(page.nextCursor,{revision,index:seen.length});
          if(page.items.length<32) partial=true;
          const additions=workers===0 && cursors.length===1?[{
            actionId:'new-worker',kind:'delegate',profileId:'primary',objective:'Produce new evidence',
            expectedResult:'report',dependsOn:[],contextRefs:[],
          }]:[];
          return next(page.nextCursor,additions);
        }
        fresh=true;
        return next(0);
      }});
    const state=await(await api.submit(request())).completion;
    assert.equal(state.status,'finished',respondErrors.map(error=>error.stack??String(error)).join('\n'));
    assert.deepEqual(respondErrors,[]);
    assert.ok(cursors.length>2);
    assert.equal(workers,1);
    const expected=operationHistory(state,revision).reverse();
    assert.deepEqual(seen.map(item=>item.ref),expected.map(item=>item.ref),
      'every original directory record, in order, exactly once');
    assert.deepEqual(seen.map(item=>item.receivedSequence),expected.map(item=>item.receivedSequence));
    assert.equal(invocations.filter(inv=>inv.kind==='delegate').length,1);
    assert.ok(operationHistory(state).length>expected.length);
    if(budget===6000) assert.ok(partial,'small prompt must force a partial structured page');
    await api.close();
  });
}

test('history directory: stable count/byte limits, positional refs, scope, end and invalid cursor',async()=>{
  const f=fixture();
  f.batch('seed',Array.from({length:70},(_,i)=>report('short-'+i)));
  const access=port(f.state);
  const initial=access.list();
  assert.equal(initial.items.length,32);
  assert.deepEqual(initial.nextCursor,{revision:f.state.revision,index:32});
  const all=traverse(access);
  assert.equal(all.items.length,71);
  assert.equal(all.pages,3);
  assert.deepEqual(all.items.map(item=>item.ref),operationHistory(f.state).reverse().map(item=>item.ref));
  const end=access.list({revision:f.state.revision,index:71});
  assert.equal(end.kind,'available');
  assert.deepEqual(end.items,[]);
  assert.equal(end.nextCursor,undefined);
  for(const cursor of [1,-1,1.5,null,'0',{revision:-1,index:0},{revision:0,index:0,extra:true},
    {revision:f.state.revision+1,index:0},{revision:f.state.revision,index:72}]) {
    assert.deepEqual(access.list(cursor),{kind:'unavailable',reason:'invalid_cursor'});
  }
  const empty=port(f.state,{selected:new Set()}).list();
  assert.equal(empty.kind,'available');
  assert.deepEqual(empty.items,[]);
  assert.equal(empty.nextCursor,undefined);
  const long='opaque-'+'x'.repeat(4000);
  f.batch('long',[
    report(long,'long body'),...Array.from({length:40},(_,i)=>report('ref-'+i+'-'+ 'z'.repeat(700)))]);
  const grown=port(f.state);
  const bytePage=grown.list();
  assert.ok(bytePage.items.length<32 && bytePage.items.length>0);
  assert.ok(Buffer.byteLength(JSON.stringify(bytePage))<=8192);
  assert.ok(bytePage.nextCursor);
  const allGrown=traverse(grown).items;
  const positional=allGrown.find(item=>typeof item.ref==='object');
  assert.ok(positional);
  assert.equal((await grown.fetch(positional.ref)).item.value,'long body');
  const old=traverse(grown,initial.nextCursor).items;
  assert.deepEqual(old.map(item=>item.ref),all.items.slice(32).map(item=>item.ref));
  let active=true;
  const scoped=port(f.state,{selected:new Set([long,'short-1']),active:()=>active});
  const visible=traverse(scoped).items;
  assert.equal(visible.length,2);
  assert.ok(visible.some(item=>item.ref==='short-1'));
  assert.equal((await scoped.fetch(positional.ref)).item.value,'long body');
  assert.deepEqual(await scoped.fetch('short-2'),{kind:'unavailable',reason:'denied'});
  active=false;
  assert.deepEqual(scoped.list(),{kind:'unavailable',reason:'closed'});
  assert.deepEqual(await scoped.fetch(positional.ref),{kind:'unavailable',reason:'closed'});
});

test('history directory: partial materialization and final prompt preserve exact cursor, budget stall is explicit',async()=>{
  const f=fixture();
  f.batch('seed',[report('body','x'.repeat(1000)),
    ...Array.from({length:50},(_,i)=>report('directory-'+i+'-'+'z'.repeat(300)))]);
  const access=port(f.state);
  const initial=access.list();
  const requestPage={refs:['body'],cursor:0};
  const records=await materializeControllerHistory(access,requestPage,3000);
  const page=records.find(item=>item.ref==='host:history-page:0').value;
  assert.equal(page.kind,'available');
  assert.ok(page.items.length>0 && page.items.length<initial.items.length);
  assert.deepEqual(page.items,initial.items.slice(0,page.items.length));
  assert.deepEqual(page.nextCursor,{revision:initial.cursor.revision,index:page.items.length});
  assert.equal(access.list(page.nextCursor).items[0].ref,initial.items[page.items.length].ref);
  const whole=await materializeControllerHistory(access,{cursor:0},65536);
  let partial;
  for(let budget=1800;budget<8000;budget+=16) {
    const context=controllerContext(f.state,[],undefined,undefined,budget,undefined,whole);
    const item=context.find(item=>item.ref==='host:history-page:0');
    if(item?.value?.kind==='available' && item.value.items.length>0 &&
        item.value.items.length<initial.items.length) {partial=item;break;}
  }
  assert.ok(partial,'final Controller packing must deliver a shorter structured page');
  assert.equal(partial.excerpt,undefined);
  assert.deepEqual(partial.value.items,initial.items.slice(0,partial.value.items.length));
  assert.deepEqual(partial.value.nextCursor,{revision:initial.cursor.revision,index:partial.value.items.length});
  const marker=(await materializeControllerHistory(access,{cursor:0},100))[0];
  assert.deepEqual(marker.value,{kind:'unavailable',reason:'budget'});
  const tiny=controllerContext(f.state,[],undefined,undefined,1,undefined,whole);
  assert.deepEqual(tiny[1].value.historyRequestCoverage.directory,{kind:'unavailable',end:false,reason:'budget'});
  assert.equal(tiny.some(item=>item.ref==='host:history-page:0'),false);
  const invalid=(await materializeControllerHistory(access,{cursor:17},65536))[0];
  assert.deepEqual(invalid.value,{kind:'unavailable',reason:'invalid_cursor'});
  const last=await materializeControllerHistory(access,{cursor:{revision:f.state.revision,
    index:operationHistory(f.state).length}},65536);
  assert.equal(last[0].value.kind,'available');
  assert.deepEqual(last[0].value.items,[]);
  assert.equal(last[0].value.nextCursor,undefined);
  const tinyInvalid=await materializeControllerHistory(access,{cursor:17},1);
  assert.deepEqual(tinyInvalid[0].value,{kind:'unavailable',reason:'invalid_cursor'});
  assert.deepEqual(controllerContext(f.state,[],undefined,undefined,1,undefined,tinyInvalid)[1]
    .value.historyRequestCoverage.directory,{kind:'unavailable',end:false,reason:'invalid_cursor'});
  const tinyEnd=await materializeControllerHistory(access,{cursor:{revision:f.state.revision,
    index:operationHistory(f.state).length}},1);
  assert.equal(tinyEnd[0].value.kind,'available');
  const endCoverage=controllerContext(f.state,[],undefined,undefined,1,undefined,tinyEnd)[1]
    .value.historyRequestCoverage.directory;
  assert.equal(endCoverage.kind,'available');
  assert.equal(endCoverage.end,true);
  assert.equal(endCoverage.reason,undefined);
});

test('history directory: late observations preserve prefix membership and event-local positional identity',async()=>{
  const f=fixture();
  f.reserve('late');
  f.append({kind:'attempt.outcome',dispatchCertainty:'unknown',
    outcome:outcome('late',{terminal:'unknown',effect:'unknown',
      outputRefs:[pointer('first'),pointer('second'),pointer('third')]})});
  const revision=f.state.revision;
  const before=port(f.state).list();
  const first=before.items.find(item=>item.ref==='first').receivedSequence;
  const second=before.items.find(item=>item.ref==='second').receivedSequence;
  const third=before.items.find(item=>item.ref==='third').receivedSequence;
  f.append({kind:'attempt.outcome',dispatchCertainty:'sent',late:true,
    outcome:outcome('late',{effect:'confirmed',outputRefs:[pointer('first'),pointer('second'),pointer('third')]}),
    observations:[report('first','late body'),report('late-extra','late extra')]});
  f.batch('new',[report('new-report')]);
  const access=port(f.state);
  const historical=access.list({revision,index:0});
  assert.deepEqual(historical.items.map(item=>item.ref),before.items.map(item=>item.ref));
  assert.equal(historical.items.find(item=>item.ref==='first').completeness,'complete');
  const resolved=historical.items.find(item=>item.ref==='first').receivedSequence;
  assert.ok(resolved.revision>revision);
  assert.equal((await access.fetch(resolved)).item.value,'late body');
  assert.deepEqual(await access.fetch(first),{kind:'unavailable',reason:'ambiguous'},
    'a legacy shifted output slot must never return a different late body');
  assert.deepEqual(await access.fetch(second),{kind:'unavailable',reason:'payload'});
  assert.deepEqual(await access.fetch(third),{kind:'unavailable',reason:'payload'});
  assert.deepEqual(operationHistory(f.state).find(item=>item.ref==='second').receivedSequence,second);
  assert.deepEqual(operationHistory(f.state).find(item=>item.ref==='third').receivedSequence,third);
  assert.ok(access.list().items.some(item=>item.ref==='late-extra'));
  assert.ok(access.list().items.some(item=>item.ref==='new-report'));
});

test('history directory: MCP context_list shares journal cursor across bridges',async()=>{
  const f=fixture();
  f.batch('original',Array.from({length:70},(_,i)=>report('old-'+i)));
  const stop=new AbortController();
  let bridge=await startMcpBridge({contextAccess:port(f.state),signal:stop.signal});
  let id=0;
  const call=async args=>{
    const response=await fetch(bridge.url,{method:'POST',
      headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18'},
      body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',
        params:{name:'context_list',arguments:args}})});
    assert.equal(response.status,200);
    return JSON.parse((await response.json()).result.content[0].text);
  };
  try {
    const first=await call({});
    assert.equal(first.items.length,32);
    assert.deepEqual(first.nextCursor,{revision:f.state.revision,index:32});
    bridge.close();
    f.batch('added',Array.from({length:35},(_,i)=>report('new-'+i)));
    bridge=await startMcpBridge({contextAccess:port(f.state),signal:stop.signal});
    const second=await call({cursor:first.nextCursor});
    assert.deepEqual(second.items.map(item=>item.ref),
      operationHistory(f.state,first.cursor.revision).reverse().slice(32,64).map(item=>item.ref));
    assert.equal(second.cursor.revision,first.cursor.revision);
    const third=await call({cursor:second.nextCursor});
    assert.equal(third.nextCursor,undefined);
    assert.equal([...first.items,...second.items,...third.items].length,71);
    assert.equal((await call({cursor:0})).items[0].ref,'new-34');
    assert.deepEqual(await call({cursor:32}),{kind:'unavailable',reason:'invalid_cursor'});
    assert.deepEqual(await call({cursor:{revision:1,index:-1}}),{kind:'unavailable',reason:'invalid_input'});
  } finally {stop.abort();bridge.close();}
});

test('history directory: accepted cursor persists across snapshot and real Controller recovery',()=>
  withOwnedRun('C12R9-directory-recovery',async cwd=>{
    let store=createLocalStateStore(cwd);
    await store.open();
    const f=fixture('directory-recovery');
    assert.deepEqual(await store.commit(f.state.operationId,null,f.state),{kind:'committed'});
    const persist=async (previous)=>assert.deepEqual(await store.commit(f.state.operationId,previous,f.state),{kind:'committed'});
    let prev=f.state.revision;
    f.batch('prior',Array.from({length:70},(_,i)=>report('saved-'+i)));
    // Store supports committing one revision at a time, so replay through the
    // same authoritative transitions rather than skipping CAS boundaries.
    let stored=createOperation(f.state.operationId,request(),'fixture-authority',
      {maxInvocations:60,maxConcurrentInvocations:4});
    for(const event of f.state.events) {
      const next=applyEvent(stored,event);
      assert.equal(next.kind,'applied');
      assert.deepEqual(await store.commit(stored.operationId,stored.revision,next.state),{kind:'committed'});
      stored=next.state;
    }
    const first=port(f.state).list();
    const cursor=first.nextCursor;
    const expected=operationHistory(f.state,cursor.revision).reverse().slice(32,64).map(item=>item.ref);
    prev=f.state.revision;
    f.append({kind:'controller.responded',decision:decision({operationId:f.state.operationId,
      decisionId:'pending-directory',finalAssessment:undefined,nextController:{continue:true,
        contextRequest:{cursor}}})});
    await persist(prev);
    const restored=decodeSnapshot(encodeSnapshot(f.state));
    assert.equal(restored.kind,'accepted');
    assert.deepEqual(restored.value.events.at(-1).decision.nextController.contextRequest.cursor,cursor);
    await store.close();
    store=createLocalStateStore(cwd);
    await store.open();
    try {
      const {api,respondErrors,invocations}=setup({store,maxInvocations:60,maxConcurrentInvocations:4,
        idPrefix:'recovered-',respond(invocation) {
          const page=pageRecord(invocation).value;
          assert.deepEqual(page.cursor,cursor);
          assert.deepEqual(page.items.map(item=>item.ref),expected);
          return final(invocation);
        }});
      const state=await(await api.resume(f.state.operationId)).completion;
      assert.equal(state.status,'finished',respondErrors.map(error=>error.stack??String(error)).join('\n'));
      assert.equal(invocations.length,1);
      assert.ok(state.events.some(event=>event.kind==='operation.recovered'));
      await api.close();
    } finally {await store.close();}
  }));

test('history directory: v1 Decision validates new and legacy cursor shapes without changing contextCursor',()=>{
  const base=decision({finalAssessment:undefined,nextController:{continue:true,contextRequest:{cursor:0}}});
  for(const cursor of [0,32,{revision:20,index:2}]) {
    const decoded=decodeDecision({...base,nextController:{continue:true,contextRequest:{cursor}}});
    assert.equal(decoded.kind,'accepted');
    assert.deepEqual(decoded.value.nextController.contextRequest.cursor,cursor);
    assert.equal(decoded.value.contextCursor,0);
  }
  for(const cursor of [-1,1.5,null,'32',{revision:1,index:-1},{revision:1,index:2,extra:1}]) {
    assert.equal(decodeDecision({...base,nextController:{continue:true,contextRequest:{cursor}}}).kind,'rejected');
  }
});
