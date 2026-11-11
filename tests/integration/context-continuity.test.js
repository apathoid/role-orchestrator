import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactContext } from '../../src/application/context-bundle.js';
import { coordinationFacts, controllerContext, operationHistory, operationWorkMap, deduplicateInlineResults } from '../../src/application/controller-context.js';
import { decodeDecision } from '../../src/core/contracts.js';
import { createOperation } from '../../src/core/operation.js';
import { request, outcome } from '../fixtures/core.js';
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
  assert.ok(host.workMap.nextCursor>host.workMap.cursor,
    'a model-requested workCursor must advance despite many action events');
  assert.ok(Buffer.byteLength(JSON.stringify(ctx.slice(1)))<=4096);
  const next=controllerContext(state,[],undefined,undefined,4096,undefined,[],host.workMap.nextCursor);
  assert.equal(next[1].value.workMap.cursor,host.workMap.nextCursor);
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
    nextController:{continue:true,contextRequest:{workCursor:199}}};
  assert.equal(decodeDecision(base).kind,'accepted');
  for(const workCursor of [-1,1.5,'20',null]) {
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
