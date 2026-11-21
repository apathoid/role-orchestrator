import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {checkPattern} from '../src/hosts/cli-pattern.js';

// Baseline RED runs only inside a short-lived killed subprocess. Never put
// catastrophic provider-controlled regexp execution on the test runner event loop.
const script='new RegExp("(a+)+$","u").test("a".repeat(40)+"!")';
const red=spawnSync(process.execPath,['-e',script],{timeout:400,maxBuffer:64*1024});
assert.equal(red.error?.code,'ETIMEDOUT','baseline pathological V8 regexp must be observed as blocked');
console.log('C15R6R_RED '+JSON.stringify({case:'provider-pattern-backtracking',subprocessTimeoutMs:400,
  result:'baseline isolated subprocess required termination'}));
const iterations=[];
for(let i=0;i<3;i++){
  const start=performance.now();
  assert.equal(await checkPattern('^[a-z]{2,8}$','hello'),'match');
  iterations.push(Math.round(performance.now()-start));
}
const start=performance.now();
let usable=false;
const blocked=checkPattern('(a+)+$','a'.repeat(40)+'!');
await new Promise(resolve=>setImmediate(()=>{usable=true;resolve();}));
assert.equal(usable,true);
const activeAfterImmediateMs=Math.round(performance.now()-start);
const outcome=await blocked;
assert.equal(outcome,'timeout');
const totalMs=Math.round(performance.now()-start);
assert.ok(activeAfterImmediateMs<500,'the main event loop did not remain responsive');
console.log('C15R6R_GREEN '+JSON.stringify({case:'technical-worker-guard',outcome,
  activeAfterImmediateMs,totalMs,safePatternMs:iterations,
  limits:{validationMs:750,maxConcurrent:4,maxValueBytes:262144,maxPatternBytes:8192}}));
