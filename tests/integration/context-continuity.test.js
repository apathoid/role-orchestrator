import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactContext } from '../../src/application/context-bundle.js';
import { coordinationFacts, controllerContext, operationHistory, operationWorkMap, deduplicateInlineResults } from '../../src/application/controller-context.js';
import { decodeDecision } from '../../src/core/contracts.js';
import { admitActions } from '../../src/core/action-graph.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
import { createOperation, applyEvent, acceptedWorkerAllowed } from '../../src/core/operation.js';
import { request, outcome, decision } from '../fixtures/core.js';
import { setup } from '../fixtures/application.js';

// C12R.9.0: desired behaviour is intentionally established before the fix.
// These fixtures are synthetic; they do not assert real-model quality.
test('C12R.9: a 256 KiB budget admits more than 128 small historical records', () => {
  const history = Array.from({ length: 160 }, (_, i) => ({
    ref: 'synthetic:' + i, source: 'provider_reported', completeness: 'complete', value: 'record-' + i,
  }));
  const packed = compactContext(history, 262144, false);
  assert.equal(packed.context.length, 160);
  assert.equal(packed.omitted, 0);
});

test('C12R.9: completed uncertain effects are not unresolved attempts', () => {
  const state = createOperation('op', request(), 'grant', { maxInvocations: 10, maxConcurrentInvocations: 2 });
  state.attempts.push({ attemptId: 'one', actionId: 'report-one', generation: 0, reservedAt: 1,
    dispatchCertainty: 'sent', status: 'terminal', endedAt: 2, outcome: outcome('one', { effect: 'unknown' }) });
  assert.deepEqual(coordinationFacts(state).unresolvedAttempts, []);
});

test('C12R.9: no-MCP history request is a valid optional controller continuation', () => {
  const value = {
    schemaVersion: 1, decisionId: 'request-old', operationId: 'op', contextCursor: 1,
    additions: [], cancellations: [], nextController: { continue: true, contextRequest: { refs: ['old-report'] } },
  };
  assert.equal(decodeDecision(value).kind, 'accepted');
  assert.equal(decodeDecision({ ...value, nextController: { contextRequest: { refs: ['old-report'] } } }).kind, 'rejected');
});

test('C12R.9: oversized dynamic facts cannot bypass optional controller budget', () => {
  const state = createOperation('op', request(), 'grant', { maxInvocations: 1000, maxConcurrentInvocations: 2 });
  for (let i = 0; i < 250; i++) {
    state.attempts.push({ attemptId: 'attempt-' + i, actionId: 'action-' + i,
      generation: 0, reservedAt: i, dispatchCertainty: 'sent', status: 'terminal', endedAt: i + 1,
      outcome: outcome('attempt-' + i, { effect: 'unknown' }) });
    state.events.push({ eventId: 'event-' + i, receivedAt: i, operationId: 'op',
      kind: 'attempt.outcome', outcome: outcome('attempt-' + i, { effect: 'unknown' }),
      dispatchCertainty: 'sent',
      observations: [{ ref: 'observation-' + i, source: 'provider_reported',
        completeness: 'complete', value: 'x'.repeat(40) }] });
  }
  const payload = controllerContext(state, [], undefined, undefined, 8192);
  const optional = payload.filter(item => item.provenance?.kind !== 'user');
  assert.ok(Buffer.byteLength(JSON.stringify(optional)) <= 8192,
    'the host technical projection must share the optional budget');
  assert.ok(payload.some(item => item.ref === 'host:invocation-context'));
  assert.equal(operationHistory(state).filter(item => item.ref.startsWith('observation-')).length, 250);
});

test('C12R.9.1: dedup requires provider identity, attempt, provenance and identical bytes', () => {
  const item = (ref, providerRef, attemptId, value) => ({
    ref, providerRef, attemptId, value, source: 'model_claim', completeness: 'complete',
    provenance: { kind: 'model', sourceId: 'agent' },
  });
  const history = [
    item('one', 'source-result', 'attempt-a', 'full report'),
    item('duplicate', 'source-result', 'attempt-a', 'full report'),
    item('independent', 'other-source', 'attempt-a', 'full report'),
    item('other-attempt', 'source-result', 'attempt-b', 'full report'),
    item('changed', 'source-result', 'attempt-a', 'different report'),
  ];
  const derived = deduplicateInlineResults(history);
  assert.equal(derived.filter(x => x.value === 'full report').length, 3);
  assert.equal(derived[1].duplicateOf, 'one');
  assert.equal(derived[1].unavailableReason, 'duplicate_inline');
  assert.equal(history[1].value, 'full report');
  assert.equal(derived[4].value, 'different report');
});

test('C12R.9.2: direct API budgets reject conflicting aliases and unsafe limits', async () => {
  const { createOrchestrator } = await import('../../src/application/orchestrator.js');
  const source = (await import('../fixtures/application.js')).setup;
  assert.throws(() => source({ context: { maxBytes: 12, controllerMaxBytes: 16 } }),
    /cannot both be set/);
  assert.throws(() => source({ context: { controllerMaxBytes: 16777217 } }), /context.controllerMaxBytes/);
  const a = source({ context: { controllerMaxBytes: 512 * 1024 } });
  assert.equal((await (await a.api.submit(request())).completion).status, 'finished');
});

test('C12R.9.3: work ledger is a derived map and records completed effect uncertainty separately', () => {
  const state = createOperation('op', request(), 'grant', { maxInvocations: 12, maxConcurrentInvocations: 2 });
  state.attempts.push({ attemptId: 'a1', actionId: 'task-one', generation: 0, reservedAt: 1,
    dispatchCertainty: 'sent', status: 'terminal', endedAt: 2,
    outcome: outcome('a1', { effect: 'possible',
      outputRefs: [{ref:'report',source:'model_claim',kind:'output'}] }) });
  state.events.push({ kind:'attempt.outcome', eventId:'e1',receivedAt:2,operationId:'op',
    outcome: outcome('a1', { effect:'possible',
      outputRefs: [{ref:'report',source:'model_claim',kind:'output'}] }),
    dispatchCertainty:'sent',
    observations:[{ref:'report',source:'model_claim',completeness:'complete',value:'saved original'}] });
  const raw=operationHistory(state);
  const map=operationWorkMap(state,raw);
  assert.equal(map[0].outputRefs[0].ref,'report');
  assert.equal(map[0].outputRefs[0].availability,'inline_captured');
  const ctx=controllerContext(state,[],undefined,undefined,8192);
  assert.equal(ctx[1].value.workMap.total,1);
  assert.equal(ctx[1].value.workMap.entries[0].actionId,'task-one');
  assert.deepEqual(ctx[1].value.unresolvedAttempts,[]);
  assert.equal(ctx[1].value.effectUncertainties[0].effect,'possible');
  assert.equal(raw.find(item=>item.ref==='report').value,'saved original');
});

test('C12R.9.4: optional history request arrives next turn without MCP or reexecuting Worker', async () => {
  const { setup, final } = await import('../fixtures/application.js');
  const task = { actionId:'worker', kind:'delegate', profileId:'primary',
    objective:'Create synthetic observations', expectedResult:'report',
    dependsOn:[], contextRefs:[] };
  let controllers = 0;
  let workers = 0;
  let selectedRef;
  const { api, invocations, respondErrors } = setup({ context:{controllerMaxBytes:8192,fetchMaxBytes:65536},
    maxInvocations:6, respond(invocation,count,observe) {
      if (invocation.kind === 'delegate') {
        workers++;
        observe({ref:'old-report',kind:'provider_report',sourceId:'fixture',completeness:'complete',
          value:'OLD '.repeat(900)});
        for(let i=0;i<30;i++) observe({ref:'noise-'+i,kind:'provider_report',sourceId:'fixture',
          completeness:'complete',value:'n'.repeat(400)});
        return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId)};
      }
      controllers++;
      if (controllers===1) return final(invocation,{finalAssessment:undefined,additions:[task],
        waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:'worker'}]}});
      if (controllers===2) {
        selectedRef=invocation.contextAccess.list().items.find(item=>item.providerRef==='old-report')?.ref;
        assert.ok(selectedRef);
        assert.ok(!invocation.context.some(item=>item.ref===selectedRef && item.value?.startsWith?.('OLD')));
        return final(invocation,{finalAssessment:undefined,nextController:{
          continue:true,contextRequest:{refs:[selectedRef],cursor:0}}});
      }
      assert.equal(invocation.context.find(item=>item.ref===selectedRef)?.value,'OLD '.repeat(900));
      assert.equal(invocation.context.some(item=>item.ref==='host:history-page:0'),true);
      return final(invocation);
    } });
  const done=await (await api.submit(request())).completion;
  assert.equal(done.status,'finished',respondErrors.map(error=>error instanceof Error?error.stack:String(error)).join('\n'));
  assert.equal(controllers,3);
  assert.equal(workers,1);
  assert.equal(invocations.filter(item=>item.kind==='delegate').length,1);
});

test('C12R.9.6: telemetry measures Host serialization, not provider internal context', async () => {
  const { api, events } = setup({ maxInvocations:2, context:{controllerMaxBytes:8192} });
  const state=await (await api.submit(request())).completion;
  assert.equal(state.status,'finished');
  const host=events.find(event=>event.eventName==='context.host_prepared');
  assert.ok(host);
  assert.equal(host.details.kind,'controller');
  assert.ok(host.details.serializedContextBytes>0);
  assert.equal(host.details.recordCount>=2,true);
  assert.equal(host.details.workTotal,0);
  assert.ok(!JSON.stringify(host).includes('Literal task'));
  const reply=events.find(event=>event.eventName==='provider.reply_observed');
  assert.equal(reply.details.terminal,'completed');
  assert.equal(reply.details.inputTokens,null);
});

test('C12R.9 review P1: exhausted technical map advertises exact uncertainty and cancellation omissions', () => {
  const state=createOperation('many-work',request(), 'grant',
    {maxInvocations:1000,maxConcurrentInvocations:4});
  for(let i=0;i<200;i++){
    const id='attempt-'+i,actionId='work-'+i;
    state.attempts.push({attemptId:id,actionId,generation:0,reservedAt:i,
      status:'terminal',endedAt:i+1,dispatchCertainty:'sent',
      outcome:outcome(id,{effect:'possible'})});
    state.events.push({kind:'action.cancelled',eventId:'cancel-'+i,
      operationId:'many-work',receivedAt:i,actionId,source:'superseded'});
  }
  const pendingId='active-attempt';
  state.attempts.push({attemptId:pendingId,actionId:'active-work',
    status:'dispatched',generation:0,reservedAt:1,dispatchCertainty:'unknown'});
  const unknownId='orphan-attempt';
  state.attempts.push({attemptId:unknownId,actionId:'old-work',generation:0,
    reservedAt:1,endedAt:2,dispatchCertainty:'unknown',status:'terminal',
    outcome:outcome(unknownId,{terminal:'unknown',effect:'unknown'})});
  const ctx=controllerContext(state,[],undefined,undefined,4096);
  const host=ctx[1].value;
  assert.equal(host.technicalCoverage.effectUncertainties.total,200);
  assert.equal(host.technicalCoverage.cancellations.total,200);
  assert.equal(host.technicalCoverage.unresolvedAttempts.total,2);
  assert.equal(host.technicalCoverage.pendingAttempts.total,1);
  assert.equal(host.technicalCoverage.outcomes.total,201);
  for(const [key,counts] of Object.entries(host.technicalCoverage)) {
    assert.equal(counts.total,counts.represented+counts.omitted,key);
  }
  assert.ok(host.technicalCoverage.effectUncertainties.omitted>0);
  assert.ok(host.workMap.omitted>0);
  assert.ok(host.workMap.nextCursor.index>0,
    'a model-requested workCursor must advance despite many action events');
  assert.ok(Buffer.byteLength(JSON.stringify(ctx.slice(1)))<=4096);
  const next=controllerContext(state,[],undefined,undefined,4096,undefined,[],host.workMap.nextCursor);
  assert.deepEqual(next[1].value.workMap.cursor,host.workMap.nextCursor);
  assert.ok(next[1].value.workMap.entries.length>0,
    'next workMap page should contain previously omitted work');
  assert.equal(next[1].value.technicalCoverage.effectUncertainties.total,200);
  const tiny=controllerContext(state,[],undefined,undefined,1)[1].value;
  assert.equal(tiny.technicalCoverage.effectUncertainties.total,200);
  assert.equal(tiny.technicalBudget.mandatoryOverflow,true);
});

test('C12R.9 review P1: accepted workCursor is optional and has strict bounds', () => {
  const base={schemaVersion:1,decisionId:'history',operationId:'op',
    contextCursor:1,additions:[],cancellations:[],
    nextController:{continue:true,contextRequest:{workCursor:{revision:199,index:2}}}};
  assert.equal(decodeDecision(base).kind,'accepted');
  for(const workCursor of [-1,1.5,'20',null,{revision:1,index:-1},{revision:1,index:1,extra:true}]) {
    assert.equal(decodeDecision({...base,nextController:{continue:true,
      contextRequest:{workCursor}}}).kind,'rejected');
  }
});

test('C12R.9 review P2: persisted next-turn positional refs fetch the original without MCP', async () => {
  const { setup, final }=await import('../fixtures/application.js');
  let selected;
  let controllers=0;
  const {api,respondErrors}=setup({maxInvocations:4,context:{controllerMaxBytes:8192},
    respond(invocation,_,observe) {
      controllers++;
      if(controllers===1){
        observe({ref:'position-source',kind:'provider_report',sourceId:'fixture',completeness:'complete',
          value:'original attributed positional body'});
        return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
      }
      if(controllers===2){
        const page=invocation.contextAccess.list();
        const entry=page.items.find(item=>item.providerRef==='position-source');
        assert.ok(entry?.receivedSequence);
        selected=entry.receivedSequence;
        return final(invocation,{finalAssessment:undefined,nextController:{
          continue:true,contextRequest:{refs:[selected]}}});
      }
      const body=invocation.context.find(item=>item.receivedSequence?.revision===selected.revision &&
        item.receivedSequence?.index===selected.index);
      assert.equal(body.value,'original attributed positional body');
      assert.equal(body.source,'provider_reported');
      assert.equal(body.provenance.sourceId,'fixture');
      return final(invocation);
    }});
  const result=await (await api.submit(request())).completion;
  assert.equal(result.status,'finished',respondErrors.map(err=>String(err.stack??err)).join('\n'));
  assert.equal(controllers,3);
  const decision=result.events.find(event=>event.kind==='controller.responded' &&
    event.decision.nextController?.contextRequest?.refs?.length);
  assert.deepEqual(decision.decision.nextController.contextRequest.refs,[selected]);
});

test('C12R.9 review P2: malformed and duplicate positions reject in v1 Decision', () => {
  const base={schemaVersion:1,decisionId:'pos',operationId:'op',contextCursor:1,
    additions:[],cancellations:[],nextController:{continue:true,
      contextRequest:{refs:[{revision:2,index:0}]}}};
  assert.equal(decodeDecision(base).kind,'accepted');
  for(const ref of [{revision:-1,index:0},{revision:1,index:0,foreign:true},
    {revision:0,index:'0'},{revision:0},{revision:1,index:1.5}]) {
    assert.equal(decodeDecision({...base,nextController:{continue:true,
      contextRequest:{refs:[ref]}}}).kind,'rejected');
  }
  assert.equal(decodeDecision({...base,nextController:{continue:true,
    contextRequest:{refs:[{revision:2,index:0},{revision:2,index:0}]}}}).kind,'rejected');
});

test('C12R.9 P2: duplicate positional refs ignore JSON key order while distinct offsets remain valid',()=>{
  const base={schemaVersion:1,decisionId:'dup-pos',operationId:'op',contextCursor:0,
    additions:[],cancellations:[],nextController:{continue:true,
      contextRequest:{refs:[{revision:3,index:5},{index:5,revision:3}]}}};
  assert.equal(decodeDecision(base).kind,'rejected');
  assert.equal(decodeDecision({...base,nextController:{continue:true,
    contextRequest:{refs:[{ref:{revision:3,index:5},offset:0},
      {ref:{index:5,revision:3},offset:0}]}}}).kind,'rejected');
  assert.equal(decodeDecision({...base,nextController:{continue:true,
    contextRequest:{refs:[{ref:{revision:3,index:5},offset:0},
      {ref:{revision:3,index:5},offset:65536}]}}}).kind,'accepted');
});

test('C12R.9 review: workCursor order is based on immutable reservations, not racing outcomes',()=>{
  const state=createOperation('stable-work',request(),'grant',
    {maxInvocations:10,maxConcurrentInvocations:2});
  for(const [index,id] of ['left','right'].entries()){
    state.attempts.push({attemptId:'run-'+id,actionId:'work-'+id,status:'terminal',
      generation:0,reservedAt:index,endedAt:index+2,dispatchCertainty:'sent',
      outcome:outcome('run-'+id)});
    state.events.push({kind:'attempt.reserved',eventId:'reserve-'+id,
      receivedAt:index,operationId:'stable-work',actionId:'work-'+id,attemptId:'run-'+id});
  }
  const order=()=>operationWorkMap(state,operationHistory(state)).map(item=>item.actionId);
  assert.deepEqual(order(),['work-right','work-left']);
  state.events.push({kind:'attempt.outcome',eventId:'end-right',receivedAt:3,
    operationId:'stable-work',dispatchCertainty:'sent',outcome:outcome('run-right')});
  assert.deepEqual(order(),['work-right','work-left']);
  state.events.push({kind:'attempt.outcome',eventId:'end-left',receivedAt:4,
    operationId:'stable-work',dispatchCertainty:'sent',outcome:outcome('run-left')});
  assert.deepEqual(order(),['work-right','work-left']);
  assert.equal(controllerContext(state,[],undefined,undefined,4096)[1].value.workMap.entries[0].actionId,'work-right');
});

test('C12R.9 P1: stale workCursor never silently resets to page zero',()=>{
  const state=createOperation('stale-work-cursor',request(),'grant',
    {maxInvocations:3,maxConcurrentInvocations:1});
  const payload=controllerContext(state,[],undefined,undefined,4096,undefined,[],99);
  const map=payload[1].value.workMap;
  assert.equal(map.cursor,99);
  assert.equal(map.total,0);
  assert.equal(map.unavailableReason,'invalid_cursor');
  assert.equal(map.entries.length,0);
  assert.equal(map.nextCursor,undefined);
});

test('C12R.9 P1: serialized technical byte count is exact, including its own digits',()=>{
  const state=createOperation('byte-exact',request(),'grant',
    {maxInvocations:20,maxConcurrentInvocations:1});
  for(let i=0;i<8;i++){
    state.attempts.push({attemptId:'t'+i,actionId:'a'+i,generation:0,
      reservedAt:i,status:'terminal',endedAt:i,dispatchCertainty:'sent',
      outcome:outcome('t'+i,{effect:'possible'})});
  }
  for(const maxBytes of [1,2500,4096,8192,65536]){
    const context=controllerContext(state,[],undefined,undefined,maxBytes);
    const host=context[1];
    const observed=Buffer.byteLength(JSON.stringify([host]));
    assert.equal(host.value.technicalBudget.mandatoryBytes,observed);
    assert.equal(host.value.technicalBudget.mandatoryOverflow,observed>maxBytes);
    if(!host.value.technicalBudget.mandatoryOverflow){
      assert.ok(Buffer.byteLength(JSON.stringify(context.slice(1)))<=maxBytes,
        'the optional technical and historical records must fit their shared budget');
    }
  }
});

test('C12R.9 review P2: workMap ends without phantom cursors and reports budget stalls',()=>{
  const state=createOperation('page-end',request(),'grant',
    {maxInvocations:8,maxConcurrentInvocations:1});
  for(const [i,id] of ['first','second','third'].entries()){
    state.attempts.push({attemptId:'run-'+id,actionId:'work-'+id,generation:0,
      reservedAt:i,status:'terminal',endedAt:i+1,dispatchCertainty:'sent',
      outcome:outcome('run-'+id,{effect:'possible'})});
    state.events.push({kind:'attempt.reserved',attemptId:'run-'+id,
      actionId:'work-'+id,eventId:'reserve-'+id,operationId:state.operationId,receivedAt:i});
  }
  const full=controllerContext(state,[],undefined,undefined,65536)[1].value.workMap;
  assert.equal(full.represented,3);
  assert.equal(full.nextCursor,undefined,'last page has no next page');
  assert.equal(full.unavailableReason,undefined);
  const atEnd=controllerContext(state,[],undefined,undefined,65536,undefined,[],{revision:3,index:3})[1].value.workMap;
  assert.equal(atEnd.represented,0);
  assert.equal(atEnd.nextCursor,undefined);
  assert.equal(atEnd.unavailableReason,undefined);
  const stalled=controllerContext(state,[],undefined,undefined,1)[1].value.workMap;
  assert.equal(stalled.represented,0);
  assert.equal(stalled.nextCursor,undefined);
  assert.equal(stalled.unavailableReason,'budget');
  const stale=controllerContext(state,[],undefined,undefined,4096,undefined,[],{revision:3,index:4})[1].value.workMap;
  assert.equal(stale.unavailableReason,'invalid_cursor');
  assert.equal(stale.nextCursor,undefined);
});

test('C12R.9: real Controller continuation traverses a growing workMap without duplicates', async () => {
  const { setup, final } = await import('../fixtures/application.js');
  let controllers=0;
  let initialTotal=0;
  const seen=[];
  const {api,respondErrors}=setup({maxInvocations:30,context:{controllerMaxBytes:2300},
    respond(invocation) {
      controllers++;
      const map=invocation.context.find(item=>item.ref==='host:invocation-context').value.workMap;
      if(controllers<=12) return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
      if(controllers===13) {
        initialTotal=map.total;
        assert.ok(map.nextCursor,'fixture must force paging');
      }
      assert.equal(map.total,initialTotal);
      for(const row of map.entries) {
        assert.ok(!seen.includes(row.attemptId),'duplicate historical Controller');
        seen.push(row.attemptId);
      }
      if(map.nextCursor) return final(invocation,{finalAssessment:undefined,
        nextController:{continue:true,contextRequest:{workCursor:map.nextCursor}}});
      assert.equal(seen.length,initialTotal);
      assert.ok(map.liveTotal>map.total);
      return final(invocation);
    }});
  const state=await (await api.submit(request())).completion;
  assert.deepEqual(respondErrors,[]);
  assert.equal(state.status,'finished');
  assert.equal(initialTotal,12);
  assert.equal(seen.length,12);
});

function workLifecycleFixture() {
  let state=createOperation('lifecycle-map',request(),'grant',{maxInvocations:40,maxConcurrentInvocations:10});
  let sequence=0;
  const apply=event=>{
    const next=applyEvent(state,{...event,operationId:state.operationId,eventId:'event-'+(++sequence),receivedAt:sequence});
    assert.equal(next.kind,'applied',JSON.stringify(next.reason));
    state=next.state;
  };
  const action=id=>({actionId:id,kind:'delegate',profileId:'primary',objective:id,
    expectedResult:'report',dependsOn:[],contextRefs:[]});
  const admit=ids=>{
    const actions=ids.map(item=>typeof item==='string'?action(item):item);
    const known=state.events.flatMap(event=>event.kind==='controller.responded'?
      (event.admissions??[]).flatMap(item=>item.kind==='accepted'?[item.action]:[]):[]);
    const admissions=admitActions(known,actions);
    apply({kind:'controller.responded',decision:decision({operationId:state.operationId,
      decisionId:'decision-'+sequence,additions:actions,finalAssessment:undefined}),admissions});
    return admissions;
  };
  const reserve=(id,attemptId='run-'+id)=>apply({kind:'attempt.reserved',actionId:id,attemptId});
  const row=id=>operationWorkMap(state,operationHistory(state)).find(item=>item.actionId===id);
  return {apply,admit,reserve,row,action,get state(){return state}};
}

test('C12R.9: workMap reports actual accepted-only execution disposition, not proposal admission',()=>{
  const f=workLifecycleFixture();
  f.admit(['accepted','cancelled','rejected','deferred','duplicate']);
  assert.equal(f.row('accepted').status,'accepted');
  f.apply({kind:'action.deferred',actionId:'deferred',code:'RESOURCE_LIMIT',resource:'concurrency'});
  assert.equal(f.row('deferred').status,'deferred');
  assert.equal(acceptedWorkerAllowed(f.state,'deferred'),true);
  f.apply({kind:'action.cancelled',actionId:'cancelled',source:'superseded'});
  f.apply({kind:'action.rejected',actionId:'rejected',code:'CAPABILITY_UNAVAILABLE',category:'adapter'});
  assert.equal(acceptedWorkerAllowed(f.state,'cancelled'),false);
  assert.equal(acceptedWorkerAllowed(f.state,'rejected'),false);
  assert.equal(f.row('cancelled').status,'cancelled');
  assert.equal(f.row('cancelled').cancellation,'superseded');
  assert.equal(f.row('rejected').status,'rejected');
  assert.equal(f.row('rejected').code,'CAPABILITY_UNAVAILABLE');
  f.apply({kind:'action.deferred',actionId:'cancelled',code:'RESOURCE_LIMIT'});
  f.apply({kind:'action.deferred',actionId:'rejected',code:'RESOURCE_LIMIT'});
  assert.equal(f.row('cancelled').status,'cancelled');
  assert.equal(f.row('rejected').status,'rejected');
  assert.equal(f.admit([{...f.action('duplicate'),objective:'changed proposal'}])[0].kind,'rejected');
  assert.equal(f.row('duplicate').status,'accepted');
  assert.equal(acceptedWorkerAllowed(f.state,'duplicate'),true);
  assert.equal(f.row('cancelled').objectiveRef,'decision:decision-0');
  const restored=decodeSnapshot(encodeSnapshot(f.state));
  assert.equal(restored.kind,'accepted');
  assert.equal(operationWorkMap(restored.value,operationHistory(restored.value)).find(row=>row.actionId==='cancelled').status,'cancelled');
});

test('C12R.9: workMap preserves cancellation and effects for reserved/dispatched attempts',()=>{
  const f=workLifecycleFixture();
  f.admit(['reserved','dispatched']);
  f.reserve('reserved'); f.reserve('dispatched');
  f.apply({kind:'attempt.dispatched',attemptId:'run-dispatched'});
  f.apply({kind:'action.cancelled',actionId:'reserved',source:'superseded'});
  f.apply({kind:'action.cancelled',actionId:'dispatched',source:'superseded'});
  assert.equal(f.row('reserved').status,'reserved');
  assert.equal(f.row('reserved').cancellation,'superseded');
  assert.equal(f.row('reserved').dispatchCertainty,'not_sent');
  assert.equal(f.row('dispatched').status,'dispatched');
  assert.equal(f.row('dispatched').dispatchCertainty,'unknown');
  f.apply({kind:'attempt.outcome',dispatchCertainty:'not_sent',
    outcome:outcome('run-reserved',{terminal:'cancelled'})});
  f.apply({kind:'attempt.outcome',dispatchCertainty:'unknown',
    outcome:outcome('run-dispatched',{terminal:'unknown',effect:'unknown'})});
  assert.equal(f.row('reserved').terminal,'cancelled');
  assert.equal(f.row('dispatched').effect,'unknown');
  assert.equal(f.row('dispatched').cancellation,'superseded');
});

test('C12R.9: journal-prefix pages keep accepted rows in place across reservation, cancellation, retry and new admissions',()=>{
  const f=workLifecycleFixture();
  f.admit(['a','b','c']);
  f.admit(['newer']);
  const revision=f.state.revision;
  const initial=controllerContext(f.state,[],undefined,undefined,65536)[1].value.workMap;
  assert.deepEqual(initial.entries.map(row=>row.actionId),['newer','a','b','c']);
  f.reserve('b');
  f.apply({kind:'attempt.dispatched',attemptId:'run-b'});
  f.apply({kind:'attempt.outcome',dispatchCertainty:'unknown',
    outcome:outcome('run-b',{terminal:'unknown',effect:'unknown'})});
  f.apply({kind:'attempt.outcome',dispatchCertainty:'sent',late:true,
    outcome:outcome('run-b',{effect:'confirmed'})});
  f.apply({kind:'action.cancelled',actionId:'c',source:'superseded'});
  f.admit(['later']);
  f.reserve('later');
  const page=controllerContext(structuredClone(f.state),[],undefined,undefined,65536,undefined,[],
    {revision,index:1})[1].value.workMap;
  assert.deepEqual(page.entries.map(row=>row.actionId),['a','b','c']);
  assert.equal(page.total,4);
  assert.equal(page.liveTotal,5);
  assert.equal(page.entries[1].attemptId,'run-b');
  assert.equal(page.entries[1].status,'terminal');
  assert.equal(page.entries[1].effect,'confirmed');
  assert.equal(page.entries[2].status,'cancelled');
  assert.equal(page.nextCursor,undefined);
  assert.equal(controllerContext(f.state,[],undefined,undefined,65536)[1].value.workMap.entries[0].actionId,'later');
});

test('C12R.9: cancelled accepted-only row remains truthful even without cancellations preview',()=>{
  const f=workLifecycleFixture();
  f.admit(['older']);
  f.admit(['cancelled']);
  f.apply({kind:'action.cancelled',actionId:'cancelled',source:'superseded'});
  // Find the actual byte boundary rather than relying on a fixed-size estimate
  // of mandatory metadata; the map must not depend on the separate preview.
  let matching;
  for(let budget=1000;budget<4096;budget+=1) {
    const host=controllerContext(f.state,[],undefined,undefined,budget)[1].value;
    if(host.workMap.entries[0]?.actionId==='cancelled' && host.cancellations.length===0) {
      matching=host;
      break;
    }
  }
  assert.ok(matching);
  assert.equal(matching.workMap.entries[0].status,'cancelled');
  assert.equal(matching.workMap.entries[0].cancellation,'superseded');
  assert.equal(matching.technicalCoverage.cancellations.omitted,1);
});

test('C12R.9: one-row Controller pages survive new retry Worker and growing journal',async()=>{
  const {final}=await import('../fixtures/application.js');
  const original={actionId:'original-worker',kind:'delegate',profileId:'primary',
    objective:'Produce a report',expectedResult:'report',dependsOn:[],contextRefs:[]};
  let expected, chosenBudget;
  async function execute(calibrate) {
    let controllers=0, originalAttempt, traversalDone=false;
    const seen=[];
    const {api,respondErrors,invocations}=setup({maxInvocations:30,idPrefix:'long-'+ 'x'.repeat(200)+'-',
      context:{controllerMaxBytes:calibrate?65536:chosenBudget},
      async respond(invocation) {
        if(invocation.kind==='delegate') {
          if(invocation.actionId===original.actionId) originalAttempt=invocation.attemptId;
          return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId)};
        }
        controllers++;
        const host=invocation.context.find(item=>item.ref==='host:invocation-context').value;
        const map=host.workMap;
        if(controllers===1) return final(invocation,{finalAssessment:undefined,additions:[original],
          waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:original.actionId}]}});
        if(controllers<6) return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
        if(calibrate) {
          expected=map.entries.map(row=>row.attemptId);
          // Calibrate against the actual invocation's persisted state and
          // catalog. Long identities ensure a wide one-record byte interval.
          const state=await api.inspect(invocation.operationId);
          const candidates=[];
          for(let bytes=1000;bytes<8192;bytes+=8) {
            const probe=controllerContext(state,host.catalog,undefined,undefined,bytes,host.preferences)[1].value.workMap;
            if(probe.entries.length===1 && probe.nextCursor) candidates.push(bytes);
          }
          assert.ok(candidates.length>8,'fixture needs a one-row byte interval');
          chosenBudget=candidates[Math.floor(candidates.length/2)];
          return final(invocation);
        }
        if(traversalDone) return final(invocation);
        assert.equal(map.total,expected.length);
        assert.equal(map.entries.length,1,'exactly one real workMap row per Controller invocation');
        seen.push(map.entries[0].attemptId);
        assert.deepEqual(seen,expected.slice(0,seen.length));
        if(controllers===6) {
          assert.ok(map.nextCursor);
          const retry={...original,actionId:'retry-worker',retryOf:originalAttempt,retryBasis:'no_effect'};
          return final(invocation,{finalAssessment:undefined,additions:[retry],
            nextController:{continue:true,contextRequest:{workCursor:map.nextCursor}}});
        }
        if(map.nextCursor) return final(invocation,{finalAssessment:undefined,
          nextController:{continue:true,contextRequest:{workCursor:map.nextCursor}}});
        assert.deepEqual(seen,expected);
        assert.ok(map.liveTotal>map.total);
        traversalDone=true;
        const state=await api.inspect(invocation.operationId);
        if(!state.attempts.some(attempt=>attempt.actionId==='retry-worker' && attempt.status==='terminal')) {
          return final(invocation,{finalAssessment:undefined,
            waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:'retry-worker'}]}});
        }
        return final(invocation);
      }});
    const finished=await(await api.submit(request())).completion;
    assert.equal(finished.status,'finished',respondErrors.map(error=>error.stack??String(error)).join('\n'));
    assert.deepEqual(respondErrors,[]);
    if(!calibrate) {
      assert.deepEqual(invocations.filter(item=>item.kind==='delegate').map(item=>item.actionId),
        ['original-worker','retry-worker']);
      const map=operationWorkMap(finished,operationHistory(finished));
      assert.ok(map.some(row=>row.actionId==='original-worker'&&row.terminal==='completed'));
      assert.ok(map.some(row=>row.actionId==='retry-worker'&&row.terminal==='completed'));
    }
    await api.close();
  }
  await execute(true);
  await execute(false);
});

test('C12R.9: accepted workMap cursor survives file-store restart and real Controller recovery',()=>
  withOwnedRun('C12R9-workmap-recovery',async cwd=>{
    let store=createLocalStateStore(cwd);
    await store.open();
    let state=createOperation('workmap-recovery',request(),'fixture-authority',
      {maxInvocations:12,maxConcurrentInvocations:1});
    assert.deepEqual(await store.commit(state.operationId,null,state),{kind:'committed'});
    let n=0;
    const append=async event=>{
      const next=applyEvent(state,{eventId:'pre-'+(++n),receivedAt:n,operationId:state.operationId,...event});
      assert.equal(next.kind,'applied',JSON.stringify(next.reason));
      assert.deepEqual(await store.commit(state.operationId,state.revision,next.state),{kind:'committed'});
      state=next.state;
    };
    for(const id of ['oldest','middle','newest']) {
      await append({kind:'attempt.reserved',attemptId:id,actionId:id});
      await append({kind:'attempt.dispatched',attemptId:id});
      await append({kind:'attempt.outcome',dispatchCertainty:'sent',outcome:outcome(id)});
    }
    await append({kind:'attempt.reserved',attemptId:'current',actionId:'current'});
    await append({kind:'attempt.dispatched',attemptId:'current'});
    const revision=state.revision;
    const before=controllerContext(state,[],undefined,undefined,65536)[1].value.workMap;
    assert.deepEqual(before.entries.map(row=>row.attemptId),['newest','middle','oldest']);
    await append({kind:'attempt.outcome',dispatchCertainty:'sent',outcome:outcome('current')});
    const workCursor={revision,index:1};
    await append({kind:'controller.responded',attemptId:'current',decision:decision({
      operationId:state.operationId,decisionId:'continue-map',finalAssessment:undefined,
      nextController:{continue:true,contextRequest:{workCursor}}})});
    await store.close();
    store=createLocalStateStore(cwd);
    await store.open();
    try {
      const {final}=await import('../fixtures/application.js');
      const {api,respondErrors,invocations}=setup({store,maxInvocations:12,idPrefix:'recovered-',
        context:{controllerMaxBytes:65536},respond(invocation) {
          const map=invocation.context.find(item=>item.ref==='host:invocation-context').value.workMap;
          assert.deepEqual(map.cursor,workCursor);
          assert.deepEqual(map.entries.map(row=>row.attemptId),['middle','oldest']);
          assert.equal(map.total,3);
          assert.equal(map.liveTotal,4);
          assert.equal(map.nextCursor,undefined);
          return final(invocation);
        }});
      const done=await(await api.resume(state.operationId)).completion;
      assert.equal(done.status,'finished',respondErrors.map(error=>error.stack??String(error)).join('\n'));
      assert.equal(invocations.length,1);
      assert.equal(done.events.filter(event=>event.kind==='operation.recovered').length,1);
      await api.close();
    } finally {await store.close();}
  }));
