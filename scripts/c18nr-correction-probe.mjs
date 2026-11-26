import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { bindControllerPreflight } from '../src/application/controller-preflight.js';
import { compileExternalTool, createExternalToolPort } from '../src/application/configuration/external-tools.js';
import { bindAssessmentEvidence, scopedEvidenceAliases } from '../src/application/evidence-identity.js';
import { evidenceRefs, checkAssessment } from '../src/core/finding.js';
import { decodeControllerIntent } from '../src/core/controller-intent.js';
import { observation } from '../src/core/observation.js';

if (typeof globalThis.gc !== 'function') throw Error('node --expose-gc required');
const memory=()=>{globalThis.gc();return process.memoryUsage().heapUsed;};
const createItem=i=>observation({ref:'evidence:probe:'+i,completeness:'complete',value:'evidence '+i},
  {kind:'provider_tool',sourceId:'provider-'+i,receivedAt:i});
const durations=[];
for(const size of [1000,6000,20000]){
  const observations=Array.from({length:size},(_,i)=>createItem(i));
  const events=[{kind:'attempt.outcome',observations:observations.slice(0,Math.min(size,3000)),
    outcome:{outputRefs:[]},findings:[]}];
  const historical=evidenceRefs('request',events);
  const parsed=decodeControllerIntent({finalAssessment:{overall:'complete',answer:'verified',
    observationRefs:['evidence:probe:'+(size-1)]}});
  assert.equal(parsed.kind,'accepted');
  const input=parsed.value;
  // The old C18N implementation copied the entire historical sets and
  // rescanned all live observations/aliases for *each* accepted proposal.
  // This benchmark reproduces that algorithm only as a synthetic baseline,
  // not as a second runtime admission path.
  const oldCheck=()=>{
    const refs={observations:new Set(historical.observations),rawObservations:new Set(historical.rawObservations),
      findings:new Set(historical.findings),findingOutputs:new Set(historical.findingOutputs)};
    for(const item of observations){
      refs.observations.add(item.ref);
      if(!item.summary)refs.rawObservations.add(item.ref);
    }
    const aliases=scopedEvidenceAliases(observations,[],refs);
    const assessment={...bindAssessmentEvidence(input.finalAssessment,aliases.resolve),author:'controller'};
    return checkAssessment(refs,assessment,'controller');
  };
  const preflight=bindControllerPreflight({requestId:'request',events,observations,
    profileId:'controller',isActive:()=>true});
  const startBuild=performance.now();
  const first=preflight(input);
  const indexedFirstMs=performance.now()-startBuild;
  assert.equal(first.kind,'checked');
  assert.deepEqual(first.issues,[]);
  const repeats=24;
  const time=func=>{
    const before=performance.now();
    for(let i=0;i<repeats;i++)func();
    return (performance.now()-before)/repeats;
  };
  const baselinePerCorrectionMs=time(()=>assert.equal(oldCheck(),undefined));
  const optimizedPerCorrectionMs=time(()=>assert.deepEqual(preflight(input).issues,[]));
  durations.push({liveCount:size,historicalCount:Math.min(size,3000),
    firstIndexedMs:Number(indexedFirstMs.toFixed(3)),
    baselinePerCorrectionMs:Number(baselinePerCorrectionMs.toFixed(3)),
    indexedPerCorrectionMs:Number(optimizedPerCorrectionMs.toFixed(3)),
    retainedHeapBytes:memory()});
}
const tool=await compileExternalTool({
  id:'measurement',description:'measure real ToolPort',resource:'fixture:measurement',effect:'write',
  inputSchema:{type:'object'},async invoke(input){return {input,payload:'x'.repeat(8192)};},
});
assert.ok(tool);
const stop=new AbortController();
const receipts=[];
let permissionChecks=0;
let n=0;
const port=createExternalToolPort(new Map([['measurement',tool]])).bind({
  attemptId:'bench-attempt',operationId:'bench-operation',signal:stop.signal,isActive:()=>true,
  permissions:{async request(){permissionChecks++;return {kind:'selected',option:'allow'};}},
  newId:()=> 'call-'+(++n),maxBytes:32*1024,
  receive(_name,receipt){receipts.push(receipt);return 'host:tool:'+receipt.callId;},
});
const beforeToolHeap=memory();
for(let i=0;i<300;i++){
  const result=await port.call('measurement',{index:i});
  assert.equal(result.status,'completed');
  assert.equal(result.effect,'possible');
  assert.equal(result.output.input.index,i);
}
const afterToolHeap=memory();
assert.equal(permissionChecks,300);
assert.equal(receipts.length,300);
assert.equal(receipts.at(-1).output.input.index,299);
stop.abort();
process.stdout.write(JSON.stringify({
  node:process.version,kind:'C18N-R synthetic performance; not real model latency',
  preflight:durations,
  externalToolPort:{completed:300,permissions:permissionChecks,recordedReceipts:receipts.length,
    retainedHeapGrowthBytes:afterToolHeap-beforeToolHeap,
    note:'The receipt array deliberately retains real observed payloads; this is evidence, not bridge replay cache.'},
})+'\n');
