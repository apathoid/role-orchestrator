import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadConfig} from '../src/config.mjs';
import {runWorkflow} from '../src/workflow.mjs';
import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import {createExecutionObserver} from '../src/observability/execution-observer.mjs';
import {routingReport} from '../src/routing/reporting.mjs';
class RouteReached extends Error{}
const root=await mkdtemp(join(tmpdir(),'routing-integration-'));
const traceRoot=await mkdtemp(join(tmpdir(),'routing-integration-traces-'));
try {
  const cmd=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  cmd('init','-q');cmd('config','user.email','fake@example.invalid');cmd('config','user.name','Fake');
  await writeFile(join(root,'x'),'test');cmd('add','.');cmd('commit','-qm','test');
  const config=await loadConfig({repoRoot:root,home:join(root,'nohome'),env:{}});
  config.policy.routerContext={mode:'observe'};
  const observer=createExecutionObserver({root:traceRoot});
  for(const operation of ['investigate','review','change','plan']) {
    const task=emptyTaskSpec(operation,operation==='change'?'explicit':'not_requested');
    const output={mode:operation==='plan'?'investigate':operation,writeIntent:task.writeIntent,
      complexity:'medium',risk:'normal',reason:'test',task};
    let calls=0;const received=[];const run=observer.begin(operation);run.running();
    const registry={resolveRole:role=>({role,profileName:'fixture',providerName:'fixture',profile:{model:'fixture',contextWindow:32768}}),
      invokeRole:async role=>{calls++;assert.equal(role,'router');return {output,outputFormat:'structured',
        meta:{structuredOutput:{format:'structured'},usage:{inputTokens:10,outputTokens:4}},
        resolved:{profileName:'fixture',providerName:'fixture',profile:{model:'fixture',contextWindow:32768}}};}};
    try {await runWorkflow({task:`User ${operation} request`,repoStart:root,registry,config,planOnly:operation==='plan',
      reporter:async event=>{received.push(event);run.event(event);if(event.type==='route')throw new RouteReached();}});
      assert.fail('Expected to stop immediately after routing');}
    catch(error){if(!(error instanceof RouteReached))throw error;}
    await run.finish({status:'failed',code:'EXECUTION_FAILED'});
    assert.equal(calls,1,'telemetry must not invoke models');
    assert(received.some(e=>e.type==='semantic_intent_validation'&&e.status==='accepted'));
    assert.equal(received.find(e=>e.type==='route').policy.mode,operation);
    const persisted=await observer.getTrace(operation,{runId:run.runId,full:true});
    assert.equal(persisted.find(e=>e.kind==='role_router_context').data.requestedMode,'observe');
    assert.equal(persisted.find(e=>e.kind==='route').data.mode,operation);
    const before=calls;
    await routingReport({observer,sessionId:operation});
    assert.equal(calls,before,'routing report must not use the Router');
  }
  // Malformed Typed Task refuses execution and emits diagnostic validation and outcome.
  let calls=0;const received=[];
  const invalidRegistry={resolveRole:role=>({role,profileName:'fixture',providerName:'fixture',profile:{model:'fixture'}}),
    invokeRole:async role=>{calls++;if(role!=='router')throw new Error('Unauthorized non-router call');
      return {output:{mode:'change',writeIntent:'explicit',complexity:'medium',risk:'normal'},outputFormat:'structured',
        meta:{structuredOutput:{format:'structured'}},resolved:{profileName:'fixture',providerName:'fixture',profile:{model:'fixture'}}};}};
  const result=await runWorkflow({task:'Make edits',repoStart:root,config,registry:invalidRegistry,
    reporter:async event=>{received.push(event);}});
  assert.equal(result.status,'intent_unresolved');assert.equal(calls,1);
  assert(received.some(e=>e.type==='semantic_intent_validation'&&e.status==='missing'));
  assert(received.some(e=>e.type==='routing_outcome'&&e.status==='intent_unresolved'));
  assert.equal(received.at(-2).type,'routing_outcome','diagnostics precede terminal complete');
  assert.equal(received.at(-1).type,'complete','complete remains the final workflow event');
  assert.equal(received.filter(e=>e.type==='routing_outcome').length,1);
  // A diagnostic sink failure must not suppress the authoritative completion.
  const failedTelemetryEvents=[];
  const resultWithoutTelemetry=await runWorkflow({task:'Make edits',repoStart:root,config,registry:invalidRegistry,
    reporter:async event=>{
      if(event.type==='routing_outcome')throw new Error('Diagnostic storage unavailable');
      failedTelemetryEvents.push(event);
    }});
  assert.equal(resultWithoutTelemetry.status,'intent_unresolved');
  assert.equal(failedTelemetryEvents.at(-1).type,'complete');
  assert.equal(failedTelemetryEvents.filter(e=>e.type==='complete').length,1);
  assert.equal(calls,2,'diagnostic failure must not trigger a Router retry');
}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});await rm(traceRoot,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
console.log('routing-integration: PASS (4 pipelines, contract denial, terminal order, telemetry failure, no extra invocations, trace and report)');
