import assert from 'node:assert/strict';
import { invokeWithRecovery, safeToolEvent, recoveryEligibility } from '../src/recovery/invocation-recovery.mjs';
import { createCancellationError, CANCELLATION_REASONS } from '../src/cancellation.mjs';
import { providerCancelledError } from '../src/providers/errors.mjs';
import { acpFailureProjection } from '../src/observability/recovery-diagnostics.mjs';
import { observableEventData } from '../src/observability/execution-observer.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';
import { normalizeAcpToolObservation } from '../src/providers/acp/tool-events.mjs';

const cancelled = (outgoingCancelCount = 0) => providerCancelledError({provider:'fake',role:'any',diagnostics:{
  acpUpdateCount:4,outgoingCancelCount,msSinceLastAcpUpdate:1800,
  outgoingCancels:outgoingCancelCount?[{reason:'outer_cancelled',notificationStatus:'submitted',turnNumber:1}]:[],
}});
const common = { sandboxMode:'read-only', mcpServers:[], presentToUser:false };
const events=[];
const seen=[];
let calls=0;
const result = await invokeWithRecovery({ role:'investigator', replaySafety:'verified-read-only', options: common,
  emit: async event => events.push(event), checkWorkspace: async () => true,
  invoke: async options => { calls++; seen.push(options.executionScope);
    await options.reporter?.({type:'role_tool_event',toolObservation:{kind:'read'}});
    if(calls===1)throw cancelled(); return {ok:true}; },
});
assert.deepEqual(result,{ok:true});
assert.equal(calls,2);
assert.equal(seen[0].operationId,seen[1].operationId);
assert.deepEqual(seen.map(x=>x.attempt),[1,2]);
assert.equal(events.filter(e=>e.type==='invocation_retry_scheduled').length,1);
assert.equal(events.filter(e=>e.type==='invocation_retry_started').length,1);
assert.equal(events.filter(e=>e.type==='invocation_recovered').length,1);

// Scheduling is not execution: a cancelled second attempt cannot increment
// the persisted actual-retry counter.
{
 const ctrl=new AbortController(), emitted=[];
 let count=0;
 await assert.rejects(invokeWithRecovery({role:'reviewerLow',replaySafety:'verified-read-only',
  options:{...common,signal:ctrl.signal},checkWorkspace:async()=>true,
  emit:async e=>{emitted.push(e);if(e.type==='invocation_retry_scheduled')ctrl.abort();},
  invoke:async()=>{count++;throw cancelled();}}),e=>e?.name==='AbortError');
 assert.equal(count,1);
 assert.equal(emitted.some(e=>e.type==='invocation_retry_scheduled'),true);
 assert.equal(emitted.some(e=>e.type==='invocation_retry_started'),false);
 const metric=createEfficiencyRun('aborted-retry');emitted.forEach(e=>metric.onEvent(e));
 assert.equal(metric.finish({status:'cancelled'}).retries,0);
}


for(const [kind, event] of [
  ['execute',{type:'role_tool_event',toolObservation:{kind:'execute'}}],
  ['unknown',{type:'role_tool_event',toolObservation:{kind:null}}],
  ['answer',{type:'role_native_update',update:{sessionUpdate:'agent_message_chunk'}}],
]) {
  let count=0;
  const logs=[];
  await assert.rejects(invokeWithRecovery({role:'reviewerLow',options:common,replaySafety:'verified-read-only',
    checkWorkspace:async()=>true,emit:async e=>logs.push(e),invoke:async opt=>{
      count++;await opt.reporter?.(event);throw cancelled();}}),/stopReason=cancelled/);
  assert.equal(count,1,`no replay after ${kind}`);
  assert.equal(logs.at(-1).reason,'tool_effects_unknown');
}
let stableChecks=0;
const unstable=[];
await assert.rejects(invokeWithRecovery({role:'planner',options:common,replaySafety:'verified-read-only',
  invoke:async()=>{throw cancelled();},checkWorkspace:async()=>{stableChecks++;return false;},emit:async e=>unstable.push(e)}),/stopReason=cancelled/);
assert.equal(stableChecks,1);
assert.equal(unstable.at(-1).reason,'workspace_changed');
for(const extra of [{signal:{aborted:true}},{mcpServers:[{}]},{presentToUser:true}]) {
  let count=0;
  await assert.rejects(invokeWithRecovery({options:{...common,...extra},replaySafety:'verified-read-only',
    checkWorkspace:async()=>true,invoke:async()=>{count++;throw cancelled();}}));
  assert.equal(count,extra.signal?.aborted?0:1);
}
assert.equal(recoveryEligibility(cancelled(1),{...common,replaySafety:'verified-read-only'}),'inner_cancel_sent');
assert.equal(recoveryEligibility(cancelled(),{...common,replaySafety:'verified-read-only'}),null);
assert.equal(recoveryEligibility(createCancellationError(CANCELLATION_REASONS.SESSION_CANCELLED),{
  ...common,replaySafety:'verified-read-only'}),'not_provider_cancellation');
assert.equal(safeToolEvent({type:'role_tool_event',toolObservation:{kind:'search'}}),true);
assert.equal(safeToolEvent({type:'role_tool_event',toolObservation:{kind:'edit'}}),false);
let exhaustedCount=0;
const exhausted=[];
await assert.rejects(invokeWithRecovery({role:'explorer',options:common,replaySafety:'verified-read-only',
  invoke:async()=>{exhaustedCount++;throw cancelled();},checkWorkspace:async()=>true,emit:async e=>exhausted.push(e)}),e=>{
    assert.equal(e.recovery.attempts,2);return true;});
assert.equal(exhaustedCount,2);
assert.equal(exhausted.at(-1).type,'invocation_recovery_exhausted');

const secret='my/private/repo/SECRET';
const projection=acpFailureProjection({innerAcp:{acpUpdateCount:22,lastAcpUpdateType:secret,
 outgoingCancelCount:1,outgoingCancels:[{reason:secret,outerReason:secret,notificationStatus:'submitted'}],
 extraSecret:secret}});
assert.equal(projection.lastAcpUpdateType,null);
assert.equal(projection.outgoingCancels[0].reason,null);
assert.equal(JSON.stringify(projection).includes(secret),false);
const observed=observableEventData({type:'role_error',role:'reviewerLow',code:'CANCELLED',reason:'PROVIDER_CANCELLED',
 diagnostics:{innerAcp:{acpUpdateCount:22,lastAcpUpdateType:'tool_call',outgoingCancelCount:1,innerSessionId:secret,secret}}});
assert.equal(observed.acp.acpUpdateCount,22);
assert.equal(JSON.stringify(observed).includes(secret),false);
const efficiency=createEfficiencyRun('recovery-test');
for(const e of events)efficiency.onEvent(e);
const stats=efficiency.finish({status:'completed'});
assert.equal(stats.retries,1);
assert.equal(stats.recoveredOperations,1);
const normalized=normalizeEfficiencyRuns([stats]);
assert.equal(normalized[0].recoveredOperations,1);
assert.equal(normalized[0].retries,1);
console.log('invocation-recovery: passed');

// ACP v1/v2 partial tool updates retain the kind of an already classified
// tool. Missing kind on an UPDATE is not a new/unknown tool invocation.
{
  let invocations = 0;
  const emitted = [];
  await invokeWithRecovery({role:'reviewerMedium', options:common, replaySafety:'verified-read-only',
    checkWorkspace:async()=>true, emit:async e=>emitted.push(e),
    invoke:async ({reporter})=>{
      invocations++;
      if (invocations===1) {
        await reporter({type:'role_tool_event', update:{sessionUpdate:'tool_call',toolCallId:'t1',kind:'read',status:'in_progress'},
          toolObservation:{type:'tool_observation',toolId:'t1',operation:'upsert',kind:'read',kindSource:'declared',status:'in_progress'}});
        await reporter({type:'role_tool_event', update:{sessionUpdate:'tool_call_update',toolCallId:'t1',status:'completed'},
          toolObservation:{type:'tool_observation',toolId:'t1',operation:'upsert',status:'completed'}});
        await reporter({type:'role_tool_event', update:{sessionUpdate:'tool_call_content_chunk',toolCallId:'t1',content:{type:'text',text:'ok'}},
          toolObservation:{type:'tool_observation',toolId:'t1',operation:'append_content'}});
        throw cancelled();
      }
      return 'success';
    },
  });
  assert.equal(invocations,2);
  assert.equal(emitted.filter(e=>e.type==='invocation_recovered').length,1);
}

// Unknown starting kind, clearing/replacing a safe kind, mismatched tool ID,
// and unrecognized native data-plane updates all fail closed.
for (const [label, updates] of [
  ['unclassified first update',[{type:'role_tool_event', update:{sessionUpdate:'tool_call_update',toolCallId:'t1',status:'completed'}, toolObservation:{type:'tool_observation',toolId:'t1',operation:'upsert'}}]],
  ['kind cleared',[{type:'role_tool_event',update:{sessionUpdate:'tool_call',toolCallId:'t1',kind:'read'},toolObservation:{type:'tool_observation',toolId:'t1',operation:'upsert',kind:'read'}}, {type:'role_tool_event',update:{sessionUpdate:'tool_call_update',toolCallId:'t1',kind:null},toolObservation:{type:'tool_observation',toolId:'t1',operation:'upsert',kind:null}}]],
  ['kind changed',[{type:'role_tool_event',update:{sessionUpdate:'tool_call',toolCallId:'t1',kind:'read'},toolObservation:{type:'tool_observation',toolId:'t1',operation:'upsert',kind:'read'}},{type:'role_tool_event',update:{sessionUpdate:'tool_call_update',toolCallId:'t1',kind:'execute'},toolObservation:{type:'tool_observation',toolId:'t1',operation:'upsert',kind:'execute'}}]],
  ['observation mismatch',[{type:'role_tool_event',update:{sessionUpdate:'tool_call',toolCallId:'t1',kind:'read'},toolObservation:{type:'tool_observation',toolId:'other',operation:'upsert',kind:'read'}}]],
  ['unknown forwarded ACP update',[{type:'role_native_update',update:{sessionUpdate:'future_content_type',content:{type:'text',text:'shown'}}}]],
]) {
  let count=0;
  await assert.rejects(invokeWithRecovery({options:common,replaySafety:'verified-read-only',checkWorkspace:async()=>true,
    invoke:async ({reporter})=>{
      count++;for (const e of updates)await reporter(e);throw cancelled();
    }}),e=>e.recovery?.reason==='tool_effects_unknown',label);
  assert.equal(count,1,`${label} cannot be replayed`);
}

// Recovery emission must never cause a successful provider invocation to fail
// or create a spurious exhaustion report (even if the UI/log sink rejects).
for (const eventType of ['invocation_retry_scheduled','invocation_retry_started','invocation_recovered']) {
  let invocations=0;
  const emitted=[];
  const value=await invokeWithRecovery({options:common,replaySafety:'verified-read-only',checkWorkspace:async()=>true,
    emit:async e=>{emitted.push(e);if(e.type===eventType)throw Error('telemetry is unavailable');},
    invoke:async()=>{invocations++;if(invocations===1)throw cancelled();return 'completed';}});
  assert.equal(value,'completed');
  assert.equal(invocations,2);
  assert.equal(emitted.some(e=>e.type==='invocation_recovery_exhausted'),false);
}
for (const eventType of ['invocation_retry_skipped','invocation_recovery_exhausted']) {
  let invocations=0;
  await assert.rejects(invokeWithRecovery({options:common,replaySafety:'verified-read-only',checkWorkspace:async()=>true,
    emit:async e=>{if(e.type===eventType)throw Error('telemetry is unavailable');},
    invoke:async()=>{invocations++;throw cancelled();},
    ...(eventType==='invocation_retry_skipped'?{replaySafety:'none'}:{})}),
  e=>e?.code==='CANCELLED');
  assert.equal(invocations,eventType==='invocation_retry_skipped'?1:2);
}

// A cancellation during the scheduled event is NOT an exhausted or started
// attempt. The trace stores cancellation, and P3 never counts a phantom retry.
{
  const controller=new AbortController();
  const emitted=[];let calls=0;
  await assert.rejects(invokeWithRecovery({options:{...common,signal:controller.signal},replaySafety:'verified-read-only',
    checkWorkspace:async()=>true,
    emit:async e=>{emitted.push(e);if(e.type==='invocation_retry_scheduled')controller.abort();},
    invoke:async()=>{calls++;throw cancelled();}}),e=>e.name==='AbortError');
  assert.equal(calls,1);
  assert.equal(emitted.at(-1).type,'invocation_recovery_cancelled');
  assert.equal(emitted.some(e=>e.type==='invocation_recovery_exhausted'),false);
  const metrics=createEfficiencyRun('cancel-before-start');emitted.forEach(e=>metrics.onEvent(e));
  const snapshot=metrics.finish({status:'cancelled'});
  assert.equal(snapshot.retries,0);
  assert.equal(snapshot.exhaustedOperations,0);
  const projection=observableEventData(emitted.at(-1));
  assert.equal(projection.reason,'outer_cancelled');
}

// A cancellation delivered while publishing retry_started occurs AFTER the
// invocation has begun. It counts as a real attempt, but not exhaustion.
{
  const controller=new AbortController();const emitted=[];let calls=0;
  await assert.rejects(invokeWithRecovery({options:{...common,signal:controller.signal},replaySafety:'verified-read-only',
    checkWorkspace:async()=>true,
    emit:async e=>{emitted.push(e);if(e.type==='invocation_retry_started')controller.abort();},
    invoke:async()=>{calls++;if(calls===1)throw cancelled();await new Promise(resolve=>setImmediate(resolve));
      throw createCancellationError(CANCELLATION_REASONS.SESSION_CANCELLED);}}),e=>e.name==='AbortError');
  assert.equal(calls,2);
  assert.equal(emitted.filter(e=>e.type==='invocation_retry_started').length,1);
  assert.equal(emitted.at(-1).type,'invocation_recovery_cancelled');
  assert.equal(emitted.some(e=>e.type==='invocation_recovery_exhausted'),false);
}

// The engine independently validates sandbox/prompt/tool permissions, even
// when a future caller incorrectly labels an invocation as verified-read-only.
for (const unsafeOptions of [{sandboxMode:'workspace-write'},
  {promptBlocks:[{type:'resource_link',uri:'file:///tmp/private'}]},
  {mcpServers:[{name:'external'}]},
  {mcpServers:{length:0}}]) {
  let attempts=0;
  await assert.rejects(invokeWithRecovery({options:{...common,...unsafeOptions},replaySafety:'verified-read-only',checkWorkspace:async()=>true,
    invoke:async()=>{attempts++;throw cancelled();}}),e=>e.recovery.reason==='replay_not_authorized');
  assert.equal(attempts,1);
}
console.log('invocation-recovery edge cases: passed');

// Provider normalization is the authoritative tool event shape; corrupted
// raw/normalized disagreement must not be interpreted as a harmless patch.
{
  let invocations=0;
  await assert.rejects(invokeWithRecovery({options:common,replaySafety:'verified-read-only',checkWorkspace:async()=>true,
    invoke:async ({reporter})=>{invocations++;
      await reporter({type:'role_tool_event',update:{sessionUpdate:'tool_call',toolCallId:'t1',kind:'execute'},
        toolObservation:{type:'tool_observation',toolId:'t1',operation:'upsert',kind:'read'}});
      throw cancelled();}}),e=>e.recovery.reason==='tool_effects_unknown');
  assert.equal(invocations,1);
}
console.log('normalized ACP agreement: passed');


// Integrate with the actual ACP normalization used by Codex and Generic
// adapters, rather than assuming mock observations resemble wire events.
for (const version of ['v1','v2']) {
  let count=0;
  const updates=[
    {sessionUpdate:'tool_call',toolCallId:'normalized',kind:'search',status:'in_progress'},
    {sessionUpdate:'tool_call_update',toolCallId:'normalized',status:'completed'},
    {sessionUpdate:'tool_call_content_chunk',toolCallId:'normalized',content:{type:'text',text:'match'}},
  ];
  const result=await invokeWithRecovery({options:common,replaySafety:'verified-read-only',checkWorkspace:async()=>true,
    invoke:async ({reporter})=>{count++;
      if(count===1){for(const update of updates) await reporter({type:'role_tool_event',update,
        toolObservation:normalizeAcpToolObservation(update,{version})});throw cancelled();}
      return 'ok';}});
  assert.equal(result,'ok');assert.equal(count,2);
}
console.log('real ACP normalized tool events: passed');
