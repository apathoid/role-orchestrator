import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeConfiguration, resolveConfiguration } from '../../src/main/index.js';
import { resourceSnapshot } from '../../src/core/operation.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import { final, setup } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

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
test('C20 finite persisted cumulative budget is not widened by an unlimited default on resume',async()=>{
  const first=setup({maxInvocations:2,respond(invocation){
    return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
  }});
  try{
    const state=await(await first.api.submit(request())).completion;
    assert.equal(state.status,'waiting');
    assert.equal(state.limits.maxInvocations,2);
    assert.equal(resourceSnapshot(state).remaining,0);
  }finally{await first.api.close();}
});
