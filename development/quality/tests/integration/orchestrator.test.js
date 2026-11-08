import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resourceSnapshot } from '../../../../src/main/index.js';
import { abortOnly, final, setup } from '../../fixtures/application.js';
import { assessment, outcome, request } from '../../fixtures/core.js';

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
  assert.deepEqual(invocations[1].context.slice(-2), [
    { ref: waiting.waiting.questionId, source: 'model_claim', completeness: 'complete', value: 'Which target?',
      provenance: { kind: 'model', sourceId: waiting.waiting.questionId, receivedAt: 100 },
      receivedSequence: { revision: waiting.revision, index: 0 } },
    { ref: 'reply-1', source: 'user', completeness: 'complete', value: 'Target A',
      provenance: { kind: 'user', sourceId: 'reply-1', receivedAt: 100 },
      receivedSequence: { revision: result.operation.revision, index: 0 } },
  ]);
  assert.equal(invocations[1].context.find(item => item.ref.startsWith('decision:')).value.clarification.question,
    'Which target?');
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
  let ref;
  const { api } = setup({ respond(invocation, count, observe) {
    ref = observe(record);
    return final(invocation, { finalAssessment: assessment({ observationRefs: [record.ref] }) });
  } });
  const state = await (await api.submit(request())).completion;
  const terminal = state.events.find(item => item.kind === 'attempt.outcome');
  assert.deepEqual(terminal.observations.find(item => item.ref === ref), {
    ...record, ref, providerRef: record.ref, provenance: { kind: 'provider_report', sourceId: record.ref, receivedAt: 100 },
  });
  assert.deepEqual(state.assessment.observationRefs, [ref]);
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

test('a continuation sees the previous delivered answer as a model record', async () => {
  const { api, invocations } = setup();
  const original = await (await api.submit(request())).completion;
  const continued = await api.resume(original.operationId, { requestId: 'explain', text: 'Explain that answer' });
  assert.equal((await continued.completion).status, 'finished');
  const history = invocations[1].context;
  const previous = history.find(item => item.ref.startsWith('assessment:'));
  assert.equal(previous.source, 'model_claim');
  assert.deepEqual(previous.value, original.assessment);
  assert.equal(history.at(-1).value, 'Explain that answer');
});

test('deadline bounds uncooperative invoke and cancel; a detached session cannot add late data', { timeout: 3000 }, async () => {
  const dispatched = Promise.withResolvers();
  const reply = Promise.withResolvers();
  let expire;
  let observed;
  const { api, invocations, cancellations, closed } = setup({
    schedule(ms, callback) { expire = callback; return () => {}; },
    cancel: () => new Promise(() => {}),
    respond(invocation, count, observe) {
      if (count > 1) return final(invocation);
      observed = observe;
      dispatched.resolve();
      return reply.promise;
    },
  });
  const submitted = await api.submit(request());
  await dispatched.promise;
  expire();
  const waiting = await submitted.completion;
  assert.equal(waiting.waiting.reason.code, 'DEADLINE_EXCEEDED');
  assert.equal(waiting.attempts[0].dispatchCertainty, 'unknown');
  assert.equal(waiting.attempts[0].outcome.terminal, 'unknown');
  assert.deepEqual(cancellations, [invocations[0].attemptId]);
  assert.equal(closed.length, 1);
  observed({ ref: 'late', source: 'provider_reported', completeness: 'complete', value: 'late' });
  reply.resolve(final(invocations[0]));
  const next = await (await api.submit(request({ requestId: 'independent' }))).completion;
  assert.equal(next.status, 'finished');
  assert.deepEqual(await api.inspect(waiting.operationId), waiting);
});

test('an undetached connection keeps its slot until late cleanup completes', { timeout: 3000 }, async () => {
  const dispatched = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const closing = Promise.withResolvers();
  let expire;
  let closes = 0;
  const { api, invocations } = setup({
    schedule(ms, callback) { expire = callback; return () => {}; },
    close() {
      if (++closes > 1) return;
      closing.resolve();
      return cleanup.promise;
    },
    respond(invocation, count) {
      if (count > 1) return final(invocation);
      dispatched.resolve();
      return new Promise(() => {});
    },
  });
  const submitted = await api.submit(request());
  await dispatched.promise;
  expire();
  await closing.promise;
  expire();
  const waiting = await submitted.completion;
  assert.equal(waiting.attempts[0].outcome.effect, 'unknown');
  const blocked = await (await api.submit(request({ requestId: 'other' }))).completion;
  assert.equal(blocked.waiting.reason.code, 'RESOURCE_LIMIT');
  assert.equal(invocations.length, 1);
  cleanup.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const resumed = await api.resume(blocked.operationId, { requestId: 'continue-other', text: 'Continue' });
  assert.equal((await resumed.completion).status, 'finished');
});

test('a correlated reply during cleanup records late facts but cannot drive the Controller', { timeout: 3000 }, async () => {
  const dispatched = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const reply = Promise.withResolvers();
  let expire;
  let observe;
  const { api, invocations } = setup({
    schedule(ms, callback) { expire = callback; return () => {}; },
    close() { closing.resolve(); return cleanup.promise; },
    respond(invocation, count, callback) {
      observe = callback;
      dispatched.resolve(invocation);
      return reply.promise;
    },
  });
  const submitted = await api.submit(request());
  const invocation = await dispatched.promise;
  expire();
  await closing.promise;
  const fact = { ref: 'late-exit', source: 'provider_reported', completeness: 'complete', value: 'failed before effect' };
  observe(fact);
  observe(fact);
  reply.resolve({
    ...final(invocation),
    outcome: outcome(invocation.attemptId, {
      terminal: 'failed', effect: 'none', usage: { cost: 0.02, inputTokens: null, outputTokens: null },
    }),
  });
  await new Promise(resolve => setImmediate(resolve));
  cleanup.resolve();
  const state = await submitted.completion;
  assert.equal(state.status, 'waiting');
  assert.equal(state.waiting.reason.code, 'DEADLINE_EXCEEDED');
  assert.equal(state.waiting.reason.effect, 'none');
  assert.equal(state.attempts[0].outcome.terminal, 'failed');
  assert.equal(state.attempts[0].outcome.effect, 'none');
  assert.equal(state.attempts[0].outcome.usage.cost, 0.02);
  assert.equal(resourceSnapshot(state).usage.cost.known, 0.02);
  assert.equal(state.events.filter(event => event.kind === 'controller.responded').length, 0);
  assert.equal(state.events.flatMap(event => event.observations ?? []).filter(item => item.providerRef === fact.ref).length, 1);
  assert.equal(invocations.length, 1);
});


test('invalid finding references receive field errors and do not partially append a batch', async () => {
  const finding = {
    findingId: 'first', author: 'primary', claim: 'A model claim', subject: 'target',
    supports: ['request-1'], uncertainties: ['Needs confirmation'],
  };
  const { api, invocations } = setup({ maxInvocations: 4, respond(invocation, count) {
    if (count === 1) return final(invocation, {
      findings: [finding, { ...finding, findingId: 'second', supports: ['foreign-observation'] }],
    });
    if (count === 2) return final(invocation, { findings: [finding, { ...finding, claim: 'Duplicate id' }] });
    if (count === 3) return final(invocation, { findings: [{ ...finding, author: 'other-model' }] });
    return final(invocation, { findings: [finding], finalAssessment: assessment({ findingRefs: ['finding:first'] }) });
  } });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.deepEqual(invocations.slice(1).map(invocation => invocation.context.at(-1).value.path),
    ['$.findings[1].supports[0]', '$.findings[1].findingId', '$.findings[0].author']);
  assert.ok(invocations.every(invocation => invocation.context.every(item => item.kind !== 'finding')));
  assert.deepEqual(state.events.flatMap(event => event.decision?.findings ?? []), [{ ...finding, supersedes: undefined }]);
});

test('an invalid worker finding preserves the worker outcome and raw output', async () => {
  const { api, events, invocations } = setup({ maxInvocations: 3, respond(invocation, count) {
    if (count === 1) return final(invocation, {
      additions: [{
        actionId: 'inspect', kind: 'delegate', profileId: 'primary', objective: 'Inspect', expectedResult: 'Finding',
        contextRefs: [], dependsOn: [],
      }],
      finalAssessment: undefined, waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: 'inspect' }] },
    });
    if (invocation.kind === 'delegate') return {
      dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId), output: 'Available raw report',
      findings: [{
        findingId: 'bad', author: 'primary', claim: 'An unsupported finding', subject: 'target',
        supports: [], uncertainties: [], supersedes: 'finding:bad',
      }],
    };
    return final(invocation);
  } });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  const worker = state.attempts.find(item => item.actionId === 'inspect');
  assert.equal(worker.outcome.terminal, 'completed');
  const delivered = invocations.at(-1).context;
  assert.equal(delivered.find(item => item.ref === 'attempt-output:' + worker.attemptId).value, 'Available raw report');
  assert.ok(delivered.every(item => item.kind !== 'finding'));
  assert.deepEqual(events.filter(event => event.eventName === 'worker.findings_invalid_proposal').map(event => event.attemptId),
    [worker.attemptId]);
});
