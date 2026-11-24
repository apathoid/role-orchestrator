import assert from 'node:assert/strict';
import { createAuthorityGrant, createOrchestrator, resourceSnapshot } from '../src/main/index.js';
import { encodeSnapshot } from '../src/core/snapshot.js';
import { createLocalStateStore } from '../src/adapters/state/local-store.js';
import { final } from '../tests/fixtures/application.js';
import { request } from '../tests/fixtures/core.js';
import { withOwnedRun } from './owned-run.mjs';

assert.equal(typeof global.gc,'function','run with --expose-gc');
const profile={profileId:'primary',providerId:'fixture',model:'fixture'};
const results=[];
for(const count of [45,90,120]){
  await withOwnedRun('C20-scale-'+count,async directory=>{
    global.gc();
    const heapBefore=process.memoryUsage().heapUsed;
    const store=createLocalStateStore(directory);
    await store.open();
    let commits=0,commitMs=0,calls=0,contextBytes=0,maxContextBytes=0,diagnostics=0,diagnosticBytes=0,sequence=0;
    const api=createOrchestrator({
      store:{...store,async commit(id,revision,next){
        const start=performance.now();
        try{return await store.commit(id,revision,next);}
        finally{commits++;commitMs+=performance.now()-start;}
      }},
      profile,authority:createAuthorityGrant({reference:'fixture-authority',origin:'user',profileIds:[profile.profileId]}),
      configurationRef:'test-config',clock:{now:Date.now,monotonicNow:()=>performance.now()},
      ids:{newId:()=> 'scale-'+ ++sequence},limits:{maxInvocations:null,maxConcurrentInvocations:5},
      invocationTimeoutMs:null,
      catalog:{async list(){return [{kind:'profile',value:profile}];},async resolve(){}},
      provider:{
        async describe(){return {providerId:profile.providerId,maxConcurrency:5,capabilities:{}};},
        async open(){return {sessionId:'session-'+sequence};},
        async invoke(session,invocation,observe){
          calls++;
          assert.equal(invocation.timeoutMs,null);
          const bytes=Buffer.byteLength(JSON.stringify(invocation.context));
          contextBytes+=bytes;maxContextBytes=Math.max(maxContextBytes,bytes);
          observe({ref:'tool-'+calls,sourceId:'call-'+calls,kind:'provider_tool',completeness:'complete',value:'evidence '+calls+' '+ 'x'.repeat(256)});
          return final(invocation,calls<count?{finalAssessment:undefined,nextController:{continue:true}}:{});
        },
        async cancel(){},async close(){},
      },
      diagnostics:{emit(event){diagnostics++;diagnosticBytes+=Buffer.byteLength(JSON.stringify(event));},flush(){}},
    });
    const start=performance.now();
    let state;
    try{
      state=await(await api.submit(request())).completion;
      assert.equal(state.status,'finished');
      assert.equal(calls,count);
      assert.equal(resourceSnapshot(state).charged,count);
      assert.equal(resourceSnapshot(state).remaining,null);
    }finally{try{await api.close();}finally{await store.close();}}
    const wallMs=performance.now()-start;
    const snapshot=encodeSnapshot(state);
    const retained=state.events.flatMap(e=>e.observations??[]);
    assert.equal(retained.filter(o=>o.providerRef?.startsWith('tool-')).length,count);
    global.gc();
    const heapDeltaBytes=process.memoryUsage().heapUsed-heapBefore;
    const reopened=createLocalStateStore(directory);
    await reopened.open();
    try{
      const restored=await reopened.load(state.operationId);
      assert.equal(encodeSnapshot(restored),snapshot);
      assert.equal(resourceSnapshot(restored).remaining,null);
    }finally{await reopened.close();}
    results.push({calls,commits,commitMs,wallMs,snapshotBytes:Buffer.byteLength(snapshot),
      events:state.events.length,observations:retained.length,contextBytes,maxContextBytes,
      diagnostics,diagnosticBytes,heapDeltaBytes});
  });
}
console.log('C20_SCALE '+JSON.stringify({node:process.version,scope:'real local-store commits/reopen, deterministic ProviderPort, no model/transport latency; heap includes retained final state, serialized snapshot and probe references; not a constant-memory guarantee',results}));
