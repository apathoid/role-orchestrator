import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createAcpProvider } from '../src/main/index.js';
import { withOwnedRun } from './owned-run.mjs';

assert.equal(typeof global.gc,'function','run with --expose-gc');
const profile={providerId:'acp',profileId:'primary',model:'fixture'};
const fixture=fileURLToPath(new URL('../tests/fixtures/acp-contract-agent.js',import.meta.url));
const answer='# Result\nПроверка 🧪\n{"value":"a\\b"}';
const results=[];
for(const mib of [1,4,16]){
  await withOwnedRun('C20R-capture-'+mib,async cwd=>{
    global.gc();
    const baseline=process.memoryUsage().heapUsed;
    const provider=createAcpProvider({providerId:'acp',defaultCwd:cwd,
      configuration:{adapter:'acp',launch:{command:process.execPath,args:[fixture,'c20r-scale-'+mib]}}});
    const signal=new AbortController().signal;
    const session=await provider.open(profile,signal);
    const observations=[];
    let toolEventBytes=0,toolEvents=0,peakHeap=baseline;
    const start=performance.now();
    let result;
    try{
      result=await provider.invoke(session,{attemptId:'scale',operationId:'scale',actionId:'worker',kind:'delegate',
        profile,objective:'fixture',instructions:[],context:[],userConstraints:[],authorityRef:'grant',
        workspaceContext:{cwd},timeoutMs:null,signal},o=>{observations.push(o);return o.ref;},event=>{
        if(event.kind==='tool'){
          toolEventBytes+=Buffer.byteLength(JSON.stringify(event.payload));
          if(++toolEvents%64===0)peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);
        }
      });
      assert.equal(result.outcome.terminal,'completed');
      assert.equal(result.output,answer);
      assert.equal(observations.find(o=>o.ref===result.outputObservationRef)?.value,answer);
    }finally{await provider.close(session);}
    const wallMs=performance.now()-start;
    const stop=observations.find(o=>o.ref==='acp-stop').value;
    assert.equal(stop.historyTruncated,true);
    assert.equal(stop.resultTruncated,false);
    assert.ok(stop.historyBytes<=1024*1024);
    assert.equal(stop.resultBytes,Buffer.byteLength(answer));
    assert.ok(stop.toolIdentityBytes<=1024*1024);
    const retainedObservationBytes=Buffer.byteLength(JSON.stringify(observations));
    peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);
    global.gc();
    const retainedHeapDelta=process.memoryUsage().heapUsed-baseline;
    const acceptedObservations=observations.length;
    observations.length=0;
    result=undefined;
    global.gc();
    results.push({mib,toolEventBytes,toolEvents,acceptedObservations,retainedObservationBytes,
      historyBytes:stop.historyBytes,historyOmittedEvents:stop.historyOmittedEvents,
      resultBytes:stop.resultBytes,toolIdentityBytes:stop.toolIdentityBytes,
      sampledPeakHeapDelta:peakHeap-baseline,retainedHeapDelta,
      releasedHeapDelta:process.memoryUsage().heapUsed-baseline,wallMs});
  });
}
console.log('C20R_ACP_CAPTURE '+JSON.stringify({node:process.version,
  scope:'actual ACP SDK subprocess; tool update JSON bytes excluding transport envelopes, sampled main-process heap with observer-retained payloads and Activity clone/serialization; not peak RSS or native-model latency',results}));

await withOwnedRun('C20R-many-text-chunks',async cwd=>{
  const provider=createAcpProvider({providerId:'acp',defaultCwd:cwd,
    configuration:{adapter:'acp',launch:{command:process.execPath,args:[fixture,'c20r-many-chunks']}}});
  const signal=new AbortController().signal,session=await provider.open(profile,signal),observations=[];
  const start=performance.now();
  try{
    const result=await provider.invoke(session,{attemptId:'chunks',operationId:'chunks',actionId:'worker',kind:'delegate',
      profile,objective:'fixture',instructions:[],context:[],userConstraints:[],authorityRef:'grant',
      workspaceContext:{cwd},timeoutMs:null,signal},o=>{observations.push(o);return o.ref;});
    assert.equal(result.outcome.terminal,'completed');
    assert.equal(result.output,'abcdefghij'.repeat(50000));
    assert.equal(observations.find(o=>o.ref===result.outputObservationRef)?.value,result.output);
    const stop=observations.find(o=>o.ref==='acp-stop').value;
    assert.equal(stop.resultBytes,500000);
    assert.equal(stop.historyTruncated,true);
    assert.equal(stop.resultTruncated,false);
    console.log('C20R_ACP_CHUNKS '+JSON.stringify({chunks:50000,resultBytes:stop.resultBytes,wallMs:performance.now()-start,
      scope:'actual ACP SDK fixture; no model latency'}));
  }finally{await provider.close(session);}
});
