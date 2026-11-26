import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeConfiguration, resolveConfiguration } from '../../src/main/index.js';
import { resourceSnapshot } from '../../src/core/operation.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import { final, setup } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const config={schemaVersion:1,providers:{agent:{adapter:'acp',launch:{command:'agent'}}},
  profiles:{primary:{provider:'agent',model:'fixture'}},controllerProfile:'primary'};
test('C20 defaults and nullable trusted resource precedence',async()=>{
  const decoded=await decodeConfiguration(JSON.stringify(config));
  assert.equal(decoded.kind,'accepted');
  const base=decoded.value;
  assert.deepEqual(resolveConfiguration(base).value.resources,{
    maxConcurrentInvocations:5,maxInvocationsPerOperation:null,invocationTimeoutMs:null});
  for(const key of ['maxInvocationsPerOperation','invocationTimeoutMs']){
    const nullable=await decodeConfiguration(JSON.stringify({...config,resources:{[key]:null}}));
    assert.equal(nullable.kind,'accepted');
    const finite={...base,resources:{[key]:100}};
    const project=value=>JSON.stringify({schemaVersion:1,resources:{[key]:value}});
    assert.equal(resolveConfiguration(base,project(30)).value.resources[key],30);
    assert.equal(resolveConfiguration(base,project(null)).value.resources[key],null);
    assert.equal(resolveConfiguration(finite,project(null)).kind,'rejected');
    assert.equal(resolveConfiguration(finite,project(101)).kind,'rejected');
    assert.equal(resolveConfiguration(finite,project(100)).value.resources[key],100);
    assert.equal(resolveConfiguration(finite,project(30),{resources:{[key]:null}}).value.resources[key],null);
    for(const invalid of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'100']){
      assert.equal((await decodeConfiguration(JSON.stringify({...config,resources:{[key]:invalid}}))).kind,'rejected');
      assert.equal(resolveConfiguration(base,project(invalid)).kind,'rejected');
      assert.equal(resolveConfiguration(base,undefined,{resources:{[key]:invalid}}).kind,'rejected');
    }
  }
  assert.equal(resolveConfiguration(base,undefined,{resources:{maxConcurrentInvocations:null}}).kind,'rejected');
  assert.equal(resolveConfiguration(base,undefined,{resources:{invocationTimeoutMs:2147483647}}).kind,'accepted');
  assert.equal(resolveConfiguration(base,undefined,{resources:{invocationTimeoutMs:2147483648}}).kind,'rejected');
});
test('C20 unlimited cumulative budget admits 45 valid sequential Controller invocations and round-trips',async()=>{
  const {api,invocations,respondErrors}=setup({maxInvocations:null,respond(invocation,count){
    return count<45?final(invocation,{finalAssessment:undefined,nextController:{continue:true}}):final(invocation);
  }});
  try{
    const state=await(await api.submit(request())).completion;
    assert.equal(state.status,'finished',respondErrors.map(String).join('\n'));
    assert.equal(invocations.length,45);
    assert.equal(resourceSnapshot(state).charged,45);
    assert.equal(resourceSnapshot(state).remaining,null);
    const restored=decodeSnapshot(encodeSnapshot(state));
    assert.equal(restored.kind,'accepted');
    assert.equal(restored.value.limits.maxInvocations,null);
    assert.equal(resourceSnapshot(restored.value).remaining,null);
  }finally{await api.close();}
});

test('C20 null deadline schedules no execution timer, while explicit cancellation still settles a silent provider', {timeout:4000},async()=>{
  const started=Promise.withResolvers();
  const timers=[];
  const {api}=setup({invocationTimeoutMs:null,maxInvocations:null,
    schedule(ms,expire){const t={ms,expire};timers.push(t);return()=>{};},
    respond(invocation){started.resolve(invocation);return new Promise(()=>{});}
  });
  try{
    const submitted=await api.submit(request());
    const invocation=await started.promise;
    assert.equal(invocation.timeoutMs,null);
    assert.deepEqual(timers,[]);
    await api.cancel(submitted.operation.operationId);
    const cancelled=await submitted.completion;
    assert.equal(cancelled.status,'cancelled');
    assert.equal(cancelled.attempts[0].outcome.effect,'unknown');
  }finally{await api.close();}
});
test('C20 finite persisted cumulative budget is not widened by an unlimited default on resume',()=>withOwnedRun('c20-resume-budget',async directory=>{
  const store=createLocalStateStore(directory);
  await store.open();
  const first=setup({store,maxInvocations:2,respond(invocation){
    return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
  }});
  let state;
  try{
    state=await(await first.api.submit(request())).completion;
    assert.equal(state.status,'waiting');
    assert.equal(state.limits.maxInvocations,2);
    assert.equal(resourceSnapshot(state).remaining,0);
  }finally{
    try{await first.api.close();}finally{await store.close();}
  }
  const reopened=createLocalStateStore(directory);
  await reopened.open();
  const current=setup({store:reopened,idPrefix:'c20-resumed-',maxInvocations:null,invocationTimeoutMs:null});
  try{
    const previous=await reopened.load(state.operationId);
    assert.equal(previous.limits.maxInvocations,2);
    const resumed=await(await current.api.resume(state.operationId,{requestId:'follow-up',text:'Continue'})).completion;
    assert.equal(resumed.status,'waiting');
    assert.equal(resumed.limits.maxInvocations,2);
    assert.equal(resourceSnapshot(resumed).remaining,0);
    assert.equal(current.invocations.length,0);
  }finally{
    try{await current.api.close();}finally{await reopened.close();}
  }
}));

test('C20 five concurrent slots admit five independent invocations, with a sixth waiting for release',{timeout:5000},async()=>{
  const releases=Array.from({length:6},()=>Promise.withResolvers());
  const five=Promise.withResolvers(),six=Promise.withResolvers();
  const {api,invocations}=setup({maxInvocations:null,maxConcurrentInvocations:5,invocationTimeoutMs:null,
    async respond(invocation,count){
      if(count===5)five.resolve();
      if(count===6)six.resolve();
      await releases[count-1].promise;
      return final(invocation);
    }
  });
  try{
    const submissions=await Promise.all(releases.map((_,i)=>api.submit(request({requestId:'concurrent-'+i}))));
    await five.promise;
    assert.equal(invocations.length,5);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(invocations.length,5);
    releases[0].resolve();
    await six.promise;
    assert.equal(invocations.length,6);
    releases.forEach(r=>r.resolve());
    assert.ok((await Promise.all(submissions.map(s=>s.completion))).every(s=>s.status==='finished'));
  }finally{releases.forEach(r=>r.resolve());await api.close();}
});

test('C20 no hard deadline: late detachment retains and then releases the occupied slot',{timeout:5000},async()=>{
  const entered=Promise.withResolvers(),closing=Promise.withResolvers(),detached=Promise.withResolvers();
  let expire,closes=0;
  const {api,invocations}=setup({maxInvocations:null,invocationTimeoutMs:null,
    schedule(ms,callback){assert.equal(ms,2000);expire=callback;return()=>{};},
    respond(invocation,count){if(count>1)return final(invocation);entered.resolve();return new Promise(()=>{});},
    close(){if(++closes===1){closing.resolve();return detached.promise;}}
  });
  try{
    const first=await api.submit(request());
    await entered.promise;
    assert.equal(expire,undefined);
    await api.cancel(first.operation.operationId);
    await closing.promise;
    expire();
    const cancelled=await first.completion;
    assert.ok(cancelled.events.flatMap(e=>e.observations??[]).some(o=>o.value?.status==='not_confirmed'&&o.value.slotRetained));
    const blocked=await(await api.submit(request({requestId:'other'}))).completion;
    assert.equal(blocked.waiting.reason.resource,'provider_cleanup_pending');
    assert.equal(invocations.length,1);
    detached.resolve();
    await new Promise(resolve=>setImmediate(resolve));
    const after=await api.inspect(first.operation.operationId);
    assert.equal(after.events.flatMap(e=>e.observations??[]).filter(o=>o.value?.status==='detached').length,1);
    const resumed=await(await api.resume(blocked.operationId,{requestId:'retry-other',text:'Continue'})).completion;
    assert.equal(resumed.status,'finished');
  }finally{detached.resolve();await api.close();}
});
