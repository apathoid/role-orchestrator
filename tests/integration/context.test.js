import assert from 'node:assert/strict';
import { test } from 'node:test';
import { final, setup } from '../fixtures/application.js';
import { outcome, request } from '../fixtures/core.js';

const action = (id, contextRefs = []) => ({
  actionId: id, kind: 'delegate', profileId: 'primary', objective: 'Inspect ' + id,
  expectedResult: 'A report', dependsOn: [], contextRefs,
});
const propose = (invocation, selected, cancellations = []) => final(invocation, {
  additions: [selected], finalAssessment: undefined, cancellations,
  waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: selected.actionId }] },
});

test('a configured byte budget compacts history and preserves selected refs and coordination facts', async () => {
  const maxBytes = 1280;
  const constraint = 'Preserve this constraint verbatim ' + 'x'.repeat(2000);
  const large = '🧪"\n'.repeat(2000);
  let controller = 0;
  const refs = new Map();
  const { api, invocations } = setup({ maxInvocations: 5, context: { maxBytes }, async respond(invocation, count, observe) {
    if (invocation.actionId === 'source') {
      for (const [ref, value] of [['private-unselected', 'unselected'], ['large', large], ['recent', 'small report']]) {
        refs.set(ref, observe({ ref, kind: 'provider_tool', sourceId: 'source-event', completeness: 'complete', value }));
      }
      return { dispatchCertainty: 'unknown', outcome: outcome(invocation.attemptId, {
        terminal: 'unknown', effect: 'unknown',
        outputRefs: [{ ref: 'recorded-payload', kind: 'output', source: 'provider_reported' }],
      }) };
    }
    if (invocation.kind === 'delegate') {
      if (invocation.actionId === 'target') {
        // The byte-limited prompt need not contain every selected ref. The
        // ContextPort still locates the original historical reference and
        // reports why its payload is unavailable.
        const ref = refs.get('recorded-payload');
        const page = invocation.contextAccess.list();
        assert.equal(page.kind, 'available');
        assert.equal(page.items.find(item => item.ref === ref)?.unavailableReason, 'payload');
        assert.deepEqual(await invocation.contextAccess.fetch(ref),
          { kind: 'unavailable', reason: 'payload' });
        const recent = await invocation.contextAccess.fetch(refs.get('recent'));
        assert.equal(recent.kind, 'available');
        assert.equal(recent.item.value, 'small report');
      }
      return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
    }
    if (++controller === 1) return propose(invocation, action('source'));
    if (controller === 2) {
      refs.set('recorded-payload', invocation.contextAccess.list().items.find(item => item.providerRef === 'recorded-payload').ref);
      return propose(invocation, action('target', [refs.get('large'), refs.get('recent'), 'missing', refs.get('recorded-payload'), refs.get('large'), 'host:operation-state']), ['source']);
    }
    return final(invocation);
  } });

  const finished = await (await api.submit(request({ userConstraints: [constraint] }))).completion;
  assert.equal(finished.status, 'finished');
  const second = invocations.filter(item => item.kind === 'controller')[1];
  const host = second.context[1].value;
  assert.equal(host.historyBudget.maxBytes, maxBytes);
  assert.ok(host.historyBudget.excerpted > 0);
  assert.equal(second.context.find(item => item.ref === refs.get('recent')).value, 'small report');
  const sourceAttempt = finished.attempts.find(item => item.actionId === 'source');
  assert.equal(host.unresolvedAttempts[0].attemptId, sourceAttempt.attemptId);

  const target = invocations.find(item => item.actionId === 'target');
  assert.deepEqual(target.userConstraints, [constraint]);
  assert.deepEqual(target.context.map(item => item.ref), [refs.get('large'), refs.get('recent'), 'missing', 'host:context-budget', 'host:operation-state']);
  const [excerpt, recent, missing, summary, facts] = target.context;
  assert.equal(excerpt.completeness, 'truncated');
  assert.equal(excerpt.value, undefined);
  assert.ok(excerpt.excerpt.length > 0 && large.startsWith(excerpt.excerpt) && excerpt.excerpt.isWellFormed());
  assert.equal(excerpt.provenance.kind, 'provider_tool');
  assert.equal(excerpt.attemptId, sourceAttempt.attemptId);
  // The small original value is fetched explicitly above if the optional
  // prompt budget was consumed by preceding selected records.
  assert.equal(recent.value, undefined);
  assert.equal(recent.completeness, 'unavailable');
  assert.equal(recent.unavailableReason, 'budget');
  assert.ok(Buffer.byteLength(JSON.stringify([excerpt, recent])) <= maxBytes);
  assert.equal(missing.unavailableReason, 'missing');
  assert.equal(summary.value.omitted, 1);
  assert.equal(summary.value.selected, 4);
  assert.deepEqual(facts.value.unresolvedAttempts.map(item => [item.attemptId, item.effect]), [[sourceAttempt.attemptId, 'unknown']]);
  assert.deepEqual(facts.value.cancellations, [{ actionId: 'source', source: 'superseded' }]);
  assert.equal(finished.events.flatMap(event => event.observations ?? []).find(item => item.ref === refs.get('large')).value, large);
});

test('a tiny budget reports missing and omitted refs separately and keeps literal user messages', async () => {
  const input = 'Exact user text '.repeat(50);
  const followup = 'Exact follow-up '.repeat(50);
  let optionalRef;
  const { api, invocations } = setup({ maxInvocations: 4, context: { maxBytes: 1 }, respond(invocation, count, observe) {
    if (count === 1) {
      optionalRef = observe({ ref: 'optional', kind: 'provider_report', sourceId: 'report', completeness: 'complete', value: 'available' });
      return final(invocation, { finalAssessment: undefined, clarification: { question: 'Continue?' } });
    }
    if (count === 2) return propose(invocation, action('worker', [optionalRef, 'unknown-ref', 'reply']));
    if (count === 3) return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
    return final(invocation);
  } });
  const waiting = await (await api.submit(request({ text: input }))).completion;
  const resumed = await api.resume(waiting.operationId, { requestId: 'reply', questionId: waiting.waiting.questionId, text: followup });
  assert.equal((await resumed.completion).status, 'finished');
  assert.equal(invocations[1].context[0].value, input);
  assert.ok(invocations[1].context[1].value.historyBudget.omitted > 0);
  assert.equal(invocations[1].context.find(item => item.ref === 'reply').value, followup);
  // With a one-byte optional budget even a missing-reference marker cannot
  // fit. The literal user reply remains, and the lost refs are counted.
  assert.equal(invocations[2].context.find(item => item.ref === 'reply').value, followup);
  const summary = invocations[2].context.find(item => item.ref === 'host:context-budget');
  assert.equal(summary.value.selected, 3);
  assert.equal(summary.value.omitted, 2);
  assert.ok(!invocations[2].context.some(item => item.ref === optionalRef || item.ref === 'unknown-ref'));
});

test('C12R.4 ambiguous legacy refs never expose one of the conflicting payloads', async () => {
  const {bindContextAccess}=await import('../../src/application/context-access.js');
  const {createOperation,applyEvent}=await import('../../src/core/operation.js');
  let state=createOperation('op',request(),'grant',{maxInvocations:4,maxConcurrentInvocations:1});
  let n=0;
  for(const attemptId of ['a','b']){
    for(const event of [
      {kind:'attempt.reserved',attemptId,actionId:attemptId},
      {kind:'attempt.dispatched',attemptId},
      {kind:'attempt.outcome',outcome:outcome(attemptId),dispatchCertainty:'sent',
        observations:[{ref:'same',source:'provider_reported',completeness:'complete',value:attemptId}]},
    ]){
      const next=applyEvent(state,{...event,operationId:'op',eventId:'e'+(++n),receivedAt:n});
      assert.equal(next.kind,'applied'); state=next.state;
    }
  }
  const port=bindContextAccess({state,store:{},maxBytes:4096,profileId:'primary',attemptId:'next',
    isActive:()=>true,newId:()=> 'id',now:()=>1,receive:()=>{}});
  const entries=port.list().items.filter(item=>item.ref==='same');
  assert.equal(entries.length,1);
  assert.equal(entries[0].unavailableReason,'ambiguous');
  assert.deepEqual(await port.fetch('same'),{kind:'unavailable',reason:'ambiguous'});
  assert.deepEqual(await port.fetch(entries[0].receivedSequence),{kind:'unavailable',reason:'ambiguous'});
});
test('C12R.4 a known oversized artifact with missing bytes is not reported as merely budget-limited', async () => {
  const {bindContextAccess}=await import('../../src/application/context-access.js');
  const {createOperation,applyEvent}=await import('../../src/core/operation.js');
  let state=createOperation('op',request(),'grant',{maxInvocations:4,maxConcurrentInvocations:1});
  let n=0;
  for(const event of [
    {kind:'attempt.reserved',attemptId:'a',actionId:'a'},
    {kind:'attempt.dispatched',attemptId:'a'},
    {kind:'attempt.outcome',outcome:outcome('a'),dispatchCertainty:'sent',
      observations:[{ref:'artifact:one',source:'provider_reported',completeness:'complete',
        artifact:{ref:'sha256:'+'a'.repeat(64),size:1024,originalSize:1024,truncated:false}}]},
  ]){
    const next=applyEvent(state,{...event,operationId:'op',eventId:'e'+(++n),receivedAt:n});
    assert.equal(next.kind,'applied'); state=next.state;
  }
  for (const [presence, reason] of [['missing','payload'],['retention','retention'],['present','budget']]){
    const port=bindContextAccess({state,store:{artifactPresence:async()=>presence},maxBytes:16,
      profileId:'primary',attemptId:'next',isActive:()=>true,newId:()=> 'id',now:()=>1,receive:()=>{}});
    assert.deepEqual(await port.fetch('artifact:one'),{kind:'unavailable',reason});
  }
});
