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
  const { api, invocations } = setup({ context:{controllerMaxBytes:8192,fetchMaxBytes:65536},
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
  assert.equal(done.status,'finished');
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
  assert.equal(host.details.workTotal,1);
  assert.ok(!JSON.stringify(host).includes('Literal task'));
  const reply=events.find(event=>event.eventName==='provider.reply_observed');
  assert.equal(reply.details.terminal,'completed');
  assert.equal(reply.details.inputTokens,null);
});
