import assert from 'node:assert/strict';
import { test } from 'node:test';
import { final, setup } from '../../fixtures/application.js';
import { outcome, request } from '../../fixtures/core.js';

const action = (id, contextRefs = []) => ({
  actionId: id, kind: 'delegate', profileId: 'primary', objective: 'Inspect ' + id,
  expectedResult: 'A report', dependsOn: [], contextRefs,
});
const propose = (invocation, selected, cancellations = []) => final(invocation, {
  additions: [selected], finalAssessment: undefined, cancellations,
  waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: selected.actionId }] },
});

test('a configured byte budget compacts history and preserves selected refs and coordination facts', async () => {
  const maxBytes = 1050;
  const constraint = 'Preserve this constraint verbatim ' + 'x'.repeat(2000);
  const large = '🧪"\n'.repeat(2000);
  let controller = 0;
  const { api, invocations } = setup({ maxInvocations: 5, context: { maxBytes }, respond(invocation, count, observe) {
    if (invocation.actionId === 'source') {
      for (const [ref, value] of [['private-unselected', 'unselected'], ['large', large], ['recent', 'small report']]) {
        observe({ ref, kind: 'provider_tool', sourceId: 'source-event', completeness: 'complete', value });
      }
      return { dispatchCertainty: 'unknown', outcome: outcome(invocation.attemptId, {
        terminal: 'unknown', effect: 'unknown',
        outputRefs: [{ ref: 'recorded-payload', kind: 'output', source: 'provider_reported' }],
      }) };
    }
    if (invocation.kind === 'delegate') return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
    if (++controller === 1) return propose(invocation, action('source'));
    if (controller === 2) {
      return propose(invocation, action('target', ['large', 'recent', 'missing', 'recorded-payload', 'large', 'host:operation-state']), ['source']);
    }
    return final(invocation);
  } });

  const finished = await (await api.submit(request({ userConstraints: [constraint] }))).completion;
  assert.equal(finished.status, 'finished');
  const second = invocations.filter(item => item.kind === 'controller')[1];
  const host = second.context[1].value;
  assert.equal(host.historyBudget.maxBytes, maxBytes);
  assert.ok(host.historyBudget.excerpted > 0);
  assert.equal(second.context.find(item => item.ref === 'recent').value, 'small report');
  const sourceAttempt = finished.attempts.find(item => item.actionId === 'source');
  assert.equal(host.unresolvedAttempts[0].attemptId, sourceAttempt.attemptId);

  const target = invocations.find(item => item.actionId === 'target');
  assert.deepEqual(target.userConstraints, [constraint]);
  assert.deepEqual(target.context.map(item => item.ref), ['large', 'recent', 'missing', 'recorded-payload', 'host:operation-state']);
  const [excerpt, recent, missing, recorded, facts] = target.context;
  assert.equal(excerpt.completeness, 'truncated');
  assert.equal(excerpt.value, undefined);
  assert.ok(excerpt.excerpt.length > 0 && large.startsWith(excerpt.excerpt) && excerpt.excerpt.isWellFormed());
  assert.equal(excerpt.provenance.kind, 'provider_tool');
  assert.equal(excerpt.attemptId, sourceAttempt.attemptId);
  assert.equal(recent.value, 'small report');
  assert.ok(Buffer.byteLength(JSON.stringify([excerpt, recent])) <= maxBytes);
  assert.equal(missing.unavailableReason, 'missing');
  assert.equal(recorded.unavailableReason, 'payload');
  assert.deepEqual(facts.value.unresolvedAttempts.map(item => [item.attemptId, item.effect]), [[sourceAttempt.attemptId, 'unknown']]);
  assert.deepEqual(facts.value.cancellations, [{ actionId: 'source', source: 'superseded' }]);
  assert.equal(finished.events.flatMap(event => event.observations ?? []).find(item => item.ref === 'large').value, large);
});

test('a tiny budget reports missing and omitted refs separately and keeps literal user messages', async () => {
  const input = 'Exact user text '.repeat(50);
  const followup = 'Exact follow-up '.repeat(50);
  const { api, invocations } = setup({ maxInvocations: 4, context: { maxBytes: 1 }, respond(invocation, count, observe) {
    if (count === 1) {
      observe({ ref: 'optional', kind: 'provider_report', sourceId: 'report', completeness: 'complete', value: 'available' });
      return final(invocation, { finalAssessment: undefined, clarification: { question: 'Continue?' } });
    }
    if (count === 2) return propose(invocation, action('worker', ['optional', 'unknown-ref', 'reply']));
    if (count === 3) return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
    return final(invocation);
  } });
  const waiting = await (await api.submit(request({ text: input }))).completion;
  const resumed = await api.resume(waiting.operationId, { requestId: 'reply', questionId: waiting.waiting.questionId, text: followup });
  assert.equal((await resumed.completion).status, 'finished');
  assert.equal(invocations[1].context[0].value, input);
  assert.ok(invocations[1].context[1].value.historyBudget.omitted > 0);
  assert.equal(invocations[1].context.find(item => item.ref === 'reply').value, followup);
  assert.deepEqual(invocations[2].context.map(item => [item.ref, item.unavailableReason, item.value]), [
    ['optional', 'budget', undefined], ['unknown-ref', 'missing', undefined], ['reply', undefined, followup],
  ]);
});
