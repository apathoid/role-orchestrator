import assert from 'node:assert/strict';
import { startMcpBridge } from '../src/adapters/mcp-bridge.js';

/**
 * Deterministic same-process measurement, not a real provider or a portable
 * resource benchmark. GC isolates retained JS heap from transient replies.
 */
if (typeof globalThis.gc !== 'function') throw Error('Run with node --expose-gc');

const stop=new AbortController();
let called=0;
const responsePayload='a'.repeat(8192);
const bridge=await startMcpBridge({
  signal:stop.signal,
  externalTools:{
    list:()=>[{id:'measure',description:'Fixture',effect:'write',inputSchema:{type:'object'}}],
    async call(){called++;return {status:'completed',effect:'possible',output:responsePayload};},
  },
});
const memory=()=>{ globalThis.gc();return process.memoryUsage().heapUsed; };
const measurements=[];
try{
  const baseline=memory();
  const request=async id=>{
    const response=await fetch(bridge.url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'measure',arguments:{}}})});
    assert.equal(response.status,200);
    const packet=await response.json();
    assert.equal(JSON.parse(packet.result.content[0].text).status,'completed');
  };
  for(let i=0;i<1000;i++){
    await request(i);
    if((i+1)%250===0)measurements.push({calls:i+1,heapBytes:memory()});
  }
  assert.equal(called,1000);
  const growth=measurements.at(-1).heapBytes-baseline;
  // 1000 * 8 KiB completed payloads would retain >=8 MiB even before
  // JS Map/Promise overhead; use a broad total heap ceiling for undici/GC.
  // Historical ordinary result storage is also forbidden by contract tests.
  assert.ok(growth < 32*1024*1024,'unexpected retained JS heap growth: '+growth);
  process.stdout.write(JSON.stringify({node:process.version,baselineHeapBytes:baseline,
    measurements,retainedHeapGrowthBytes:growth,completedOrdinaryCalls:called,
    note:'Same-process synthetic HTTP/undici measurement, real native memory UNVERIFIED'})+'\n');
}finally{stop.abort();bridge.close();}
