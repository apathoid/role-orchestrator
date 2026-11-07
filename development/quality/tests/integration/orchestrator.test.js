import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resourceSnapshot } from '../../../../src/main/index.js';
import { abortOnly, final, setup } from '../../fixtures/application.js';
import { assessment, request } from '../../fixtures/core.js';

test('a literal request without cwd takes one Controller and correlates the timeline', async () => {
  const { api, invocations, events, closed } = setup();
  const input = request({ text: '  буквальный вопрос\n', userConstraints: ['No tool use'] });
  const first = await api.submit(input);
  const second = await api.submit(input);
  assert.equal(second.operation.operationId, first.operation.operationId);
  await assert.rejects(api.submit({ ...input, text: 'Changed' }), { code: 'IDENTITY_CONFLICT' });
  const state = await first.completion;
  assert.equal(state.status, 'finished');
  assert.equal(state.assessment.answer, 'Direct answer');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].kind, 'controller');
  assert.equal(invocations[0].workspaceContext, undefined);
  assert.equal(invocations[0].objective, input.text);
  assert.equal(invocations[0].context[0].source, 'user');
  assert.equal(invocations[0].context[0].value, input.text);
  assert.equal(invocations[0].authorityRef, 'fixture-authority');
  assert.deepEqual(invocations[0].userConstraints, input.userConstraints);
  assert.equal(closed.length, 1);
  assert.deepEqual(events.map(item => item.eventName), [
    'operation.accepted', 'attempt.reserved', 'attempt.dispatched', 'controller.requested',
    'attempt.outcome', 'controller.responded', 'operation.finished',
  ]);
  assert.ok(events.every(item => item.operationId === state.operationId));
  assert.ok(!JSON.stringify(events).includes(input.text));
  assert.equal((await api.resume(state.operationId)).operation.status, 'finished');
  assert.equal(invocations.length, 1);
});

test('a non-Git directory is passed as a value and cannot grant authority', async () => {
  const { api, invocations } = setup();
  const cwd = import.meta.dirname;
  await assert.rejects(api.submit(request({ configurationRef: 'forged' })), { code: 'PERMISSION_DENIED' });
  const submission = await api.submit(request({ workspaceContext: { cwd } }));
  assert.equal((await submission.completion).status, 'finished');
  assert.equal(invocations[0].workspaceContext.cwd, cwd);
  assert.equal(invocations.length, 1);
});

test('malformed Decision is returned as a field error on the same shared budget', async () => {
  const { api, invocations } = setup({ respond(invocation, count) {
    return count === 1 ? { ...final(invocation), output: { schemaVersion: 2 } } : final(invocation);
  } });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.equal(resourceSnapshot(state).charged, 2);
  assert.equal(invocations[1].context[0].value, 'Literal task');
  assert.equal(invocations[1].context.at(-1).value.path, '$.schemaVersion');
  assert.equal(invocations[1].context.at(-1).source, 'host_observed');
});

test('repeated malformed Decision exhausts resources without inventing a final', async () => {
  const { api, invocations } = setup({ maxInvocations: 2, respond: invocation => ({ ...final(invocation), output: null }) });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'waiting');
  assert.equal(state.waiting.reason.code, 'RESOURCE_LIMIT');
  assert.equal(state.assessment, undefined);
  assert.equal(invocations.length, 2);
});

test('unavailable refs prompt correction while partial model assessment remains partial', async () => {
  const { api, invocations } = setup({ respond(invocation, count) {
    return final(invocation, { finalAssessment: assessment({
      findingRefs: count === 1 ? ['invented'] : [],
      requirements: [{ requirementId: 'check', status: 'unverified', observationRefs: [], findingRefs: [] }],
    }) });
  } });
  const state = await (await api.submit(request())).completion;
  assert.equal(invocations.length, 2);
  assert.equal(state.assessment.overall, 'partial');
  assert.equal(state.assessment.requirements[0].status, 'unverified');
});

test('clarification waits for a matching reply and redelivery spends no second attempt', async () => {
  const { api, invocations } = setup({ respond(invocation, count) {
    return count === 1 ? final(invocation, { finalAssessment: undefined, clarification: { question: 'Which target?' } }) : final(invocation);
  } });
  const waiting = await (await api.submit(request())).completion;
  assert.equal(waiting.waiting.question, 'Which target?');
  assert.equal((await api.resume(waiting.operationId)).operation.status, 'waiting');
  assert.equal(invocations.length, 1);
  await assert.rejects(api.resume(waiting.operationId, { requestId: 'reply-1', questionId: 'foreign', text: 'A' }),
    { path: '$.questionId' });
  const reply = { requestId: 'reply-1', questionId: waiting.waiting.questionId, text: 'Target A' };
  const result = await api.resume(waiting.operationId, reply);
  await api.resume(waiting.operationId, reply);
  const finished = await result.completion;
  assert.equal(finished.operationId, waiting.operationId);
  assert.equal(resourceSnapshot(finished).charged, 2);
  assert.equal(invocations[1].context.at(-1).value, 'Target A');
  assert.equal((await api.resume(waiting.operationId, reply)).operation.status, 'finished');
  await assert.rejects(api.resume(waiting.operationId, { ...reply, requestId: 'another' }), { path: '$.questionId' });
  assert.equal(invocations.length, 2);
});

test('cancelling a question rejects a late reply without further dispatch', async () => {
  const { api, invocations } = setup({ respond: invocation =>
    final(invocation, { finalAssessment: undefined, clarification: { question: 'Which target?' } }) });
  const state = await (await api.submit(request())).completion;
  assert.equal((await api.cancel(state.operationId, 'client')).status, 'cancelled');
  await assert.rejects(api.resume(state.operationId, {
    requestId: 'reply-late', questionId: state.waiting.questionId, text: 'A',
  }), { path: '$.questionId' });
  assert.equal(invocations.length, 1);
});

test('a start failure records no dispatch and releases its slot', async () => {
  const { api, invocations } = setup({ open() { throw Error('open failed'); } });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.waiting.reason.code, 'PROVIDER_START_FAILED');
  assert.equal(state.attempts[0].dispatchCertainty, 'not_sent');
  assert.equal(state.attempts[0].outcome.effect, 'none');
  assert.equal(resourceSnapshot(state).active, 0);
  assert.equal(invocations.length, 0);
});

test('cancellation during open closes the acquired session without dispatch', async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { api, invocations, closed } = setup({ async open() { started.resolve(); await release.promise; } });
  const submission = await api.submit(request());
  await started.promise;
  await api.cancel(submission.operation.operationId);
  release.resolve();
  const state = await submission.completion;
  assert.equal(state.status, 'cancelled');
  assert.equal(state.attempts[0].dispatchCertainty, 'not_sent');
  assert.equal(state.attempts[0].outcome.terminal, 'cancelled');
  assert.equal(invocations.length, 0);
  assert.equal(closed.length, 1);
});

test('timeout after dispatch records uncertainty and never implicitly replays', async () => {
  const dispatched = Promise.withResolvers();
  let expire;
  const { api, invocations, closed, cancellations } = setup({
    schedule(ms, callback) { expire = callback; return () => { expire = undefined; }; },
    respond(invocation) { dispatched.resolve(); return abortOnly(invocation.signal); },
  });
  const submission = await api.submit(request());
  await dispatched.promise;
  expire();
  const state = await submission.completion;
  assert.equal(state.waiting.reason.code, 'DEADLINE_EXCEEDED');
  assert.equal(state.attempts[0].outcome.effect, 'unknown');
  assert.equal(state.attempts[0].outcome.terminal, 'unknown');
  assert.equal((await api.resume(state.operationId)).operation.status, 'waiting');
  assert.equal(invocations.length, 1);
  assert.equal(closed.length, 1);
  assert.deepEqual(cancellations, [invocations[0].attemptId]);
  assert.equal(expire, undefined);
});

test('observations from the executor preserve their source and can support a model assessment', async () => {
  const record = { ref: 'observation-1', source: 'provider_reported', completeness: 'complete', value: 'Exit 0' };
  const { api } = setup({ respond(invocation, count, observe) {
    observe(record);
    return final(invocation, { finalAssessment: assessment({ observationRefs: [record.ref] }) });
  } });
  const state = await (await api.submit(request())).completion;
  const terminal = state.events.find(item => item.kind === 'attempt.outcome');
  assert.deepEqual(terminal.observations, [record]);
  assert.deepEqual(state.assessment.observationRefs, [record.ref]);
});

test('a reply can continue past unknown effects without replaying the prior attempt or resetting the budget', async () => {
  const { api, invocations } = setup({ respond(invocation, count) {
    if (count === 1) throw Error('disconnected');
    return final(invocation);
  } });
  const unknown = await (await api.submit(request())).completion;
  assert.equal(unknown.waiting.reason.code, 'PROVIDER_DISCONNECTED');
  const finished = await (await api.resume(unknown.operationId, { requestId: 'follow', text: 'Explain the available facts' })).completion;
  assert.equal(finished.status, 'finished');
  assert.equal(finished.attempts[0].outcome.effect, 'unknown');
  assert.equal(resourceSnapshot(finished).charged, 2);
  assert.notEqual(invocations[0].attemptId, invocations[1].attemptId);
  assert.equal(invocations[1].context[1].value.outcomes[0].effect, 'unknown');
});
