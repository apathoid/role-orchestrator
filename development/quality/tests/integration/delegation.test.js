import assert from 'node:assert/strict';
import { test } from 'node:test';
import { abortOnly, final, setup } from '../../fixtures/application.js';
import { assessment, outcome, request } from '../../fixtures/core.js';

const delegate = (actionId, dependencies = [], overrides) => ({
  actionId, kind: 'delegate', objective: 'Inspect ' + actionId, profileId: 'primary',
  expectedResult: 'A finding', contextRefs: ['request-1'], dependsOn: dependencies, ...overrides,
});
const wait = (...ids) => ({ kind: 'all_requested', targets: ids.map(id => ({ kind: 'action', id })) });
const propose = (invocation, additions, overrides) => final(invocation, {
  finalAssessment: undefined, additions, waitPolicy: wait(...additions.map(action => action.actionId)), ...overrides,
});
const report = (invocation, overrides) => ({
  dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId, overrides), output: 'result-' + invocation.actionId,
});

test('two independent workers run in parallel, a third starts when one slot is released', { timeout: 3000 }, async () => {
  const active = new Map(['a', 'b', 'c'].map(id => [id, { started: Promise.withResolvers(), done: Promise.withResolvers() }]));
  const { api, invocations, closed } = setup({
    maxInvocations: 5, maxConcurrentInvocations: 2,
    async respond(invocation, count) {
      if (count === 1) return propose(invocation, [delegate('a'), delegate('b'), delegate('c')]);
      if (invocation.kind === 'controller') return final(invocation);
      const gate = active.get(invocation.actionId);
      gate.started.resolve();
      await gate.done.promise;
      return report(invocation);
    },
  });
  const submission = await api.submit(request());
  await Promise.all([active.get('a').started.promise, active.get('b').started.promise]);
  assert.equal(invocations.length, 3);
  assert.deepEqual(invocations[1].context, [{
    ref: 'request-1', source: 'user', completeness: 'complete', value: 'Literal task',
    provenance: { kind: 'user', sourceId: 'request-1', receivedAt: 100 },
    receivedSequence: { revision: 0, index: 0 },
  }]);
  assert.equal(invocations[1].authorityRef, 'fixture-authority');
  active.get('b').done.resolve();
  await active.get('c').started.promise;
  assert.equal(invocations.length, 4);
  active.get('a').done.resolve();
  active.get('c').done.resolve();
  const state = await submission.completion;
  assert.equal(state.status, 'finished');
  assert.deepEqual(invocations.map(item => item.kind), ['controller', 'delegate', 'delegate', 'delegate', 'controller']);
  assert.equal(closed.length, 5);
  const context = invocations.at(-1).context;
  assert.deepEqual(context.filter(item => item.source === 'model_claim' && item.ref.startsWith('attempt-output:')).map(item => item.value).sort(),
    ['result-a', 'result-b', 'result-c']);
});

test('terminal failure releases a dependency while model acceptance requires an explicit decision', async () => {
  let controllers = 0;
  const worker = delegate('a');
  const ordinary = delegate('b', [{ actionId: 'a', kind: 'after_terminal' }]);
  const assessed = delegate('c', [{ actionId: 'a', kind: 'after_model_acceptance' }]);
  const { api, invocations } = setup({
    maxInvocations: 6, maxConcurrentInvocations: 2,
    respond(invocation) {
      if (invocation.kind === 'delegate') return report(invocation,
        invocation.actionId === 'a' ? { terminal: 'failed' } : undefined);
      if (++controllers === 1) return propose(invocation, [ordinary, assessed, worker]);
      if (controllers === 2) {
        assert.equal(invocation.context[1].value.outcomes.find(item => item.actionId === 'a').terminal, 'failed');
        return propose(invocation, [], { waitPolicy: wait('c'), acceptedActionIds: ['a'] });
      }
      return final(invocation);
    },
  });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.deepEqual(invocations.map(item => item.kind === 'delegate' ? item.actionId : 'controller'),
    ['controller', 'a', 'b', 'controller', 'c', 'controller']);
});

test('unavailable profiles and bad graph edges leave an independent worker dispatchable', async () => {
  const { api, invocations } = setup({
    maxInvocations: 3,
    respond(invocation, count) {
      if (count === 1) return propose(invocation, [
        delegate('wrong-profile', [], { profileId: 'missing' }),
        delegate('unknown-edge', [{ actionId: 'unknown', kind: 'after_terminal' }]),
        delegate('independent'),
      ]);
      return invocation.kind === 'delegate' ? report(invocation) : final(invocation);
    },
  });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.equal(invocations[1].actionId, 'independent');
  assert.equal(invocations.length, 3);
  assert.equal(invocations[2].context[1].value.actions.find(item => item.actionId === 'wrong-profile').code,
    'CAPABILITY_UNAVAILABLE');
  assert.equal(invocations[2].context[1].value.actions.find(item => item.actionId === 'unknown-edge').reason,
    'unknown_dependency');
});

test('an operation waiting for a shared slot makes progress after an unrelated operation settles', { timeout: 3000 }, async () => {
  const firstRunning = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { api, invocations } = setup({
    async respond(invocation, count) {
      if (count === 1) { firstRunning.resolve(); await release.promise; }
      return final(invocation);
    },
  });
  const first = await api.submit(request());
  await firstRunning.promise;
  const second = await api.submit(request({ requestId: 'request-2' }));
  assert.equal(invocations.length, 1);
  release.resolve();
  const states = await Promise.all([first.completion, second.completion]);
  assert.ok(states.every(state => state.status === 'finished'));
  assert.equal(invocations.length, 2);
});

test('next_completion observes the first result and the remaining pending attempt', { timeout: 3000 }, async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const both = Promise.withResolvers();
  const checked = Promise.withResolvers();
  let workers = 0;
  let controllers = 0;
  const { api, invocations } = setup({
    maxInvocations: 5, maxConcurrentInvocations: 3,
    async respond(invocation) {
      if (invocation.kind === 'delegate') {
        if (++workers === 2) both.resolve();
        await (invocation.actionId === 'first' ? first.promise : second.promise);
        return report(invocation);
      }
      const cursor = invocation.context[1].value;
      if (++controllers === 1) return propose(invocation, [delegate('first'), delegate('second')], {
        contextCursor: cursor.contextCursor,
        waitPolicy: { ...wait('first', 'second'), kind: 'next_completion' },
      });
      if (controllers === 2) {
        assert.ok(cursor.outcomes.some(item => item.actionId === 'second'));
        assert.ok(!cursor.outcomes.some(item => item.actionId === 'first'));
        const pending = cursor.pendingAttempts.find(item => item.actionId === 'first');
        assert.equal(pending.status, 'dispatched');
        checked.resolve();
        return propose(invocation, [], {
          contextCursor: cursor.contextCursor,
          waitPolicy: { kind: 'all_requested', targets: [{ kind: 'attempt', id: pending.attemptId }] },
        });
      }
      assert.ok(cursor.outcomes.some(item => item.actionId === 'first'));
      return final(invocation);
    },
  });
  const submission = await api.submit(request());
  await both.promise;
  second.resolve();
  await checked.promise;
  first.resolve();
  const state = await submission.completion;
  assert.equal(state.status, 'finished');
  assert.equal(invocations.length, 5);
});

test('waiting on a result the Controller has already seen returns a field error', async () => {
  let controllers = 0;
  const { api, invocations } = setup({
    maxInvocations: 4,
    respond(invocation) {
      if (invocation.kind === 'delegate') return report(invocation);
      const { contextCursor } = invocation.context[1].value;
      if (++controllers === 1) return propose(invocation, [delegate('worker')], { contextCursor });
      if (controllers === 2) return propose(invocation, [], { waitPolicy: wait('worker'), contextCursor });
      assert.equal(invocation.context.at(-1).value.path, '$.waitPolicy.targets');
      return final(invocation);
    },
  });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.equal(invocations.filter(item => item.kind === 'delegate').length, 1);
});

test('replanning cancels the named worker, preserves its unknown effect and executes the new id', { timeout: 3000 }, async () => {
  const initialWorkers = Promise.withResolvers();
  const completeFast = Promise.withResolvers();
  let workers = 0;
  let controllers = 0;
  const { api, invocations, cancellations } = setup({
    maxInvocations: 6, maxConcurrentInvocations: 3,
    async respond(invocation) {
      if (invocation.kind === 'delegate') {
        if (++workers === 2) initialWorkers.resolve();
        if (invocation.actionId === 'old') return abortOnly(invocation.signal);
        if (invocation.actionId === 'fast') await completeFast.promise;
        return report(invocation);
      }
      const { contextCursor } = invocation.context[1].value;
      if (++controllers === 1) return propose(invocation, [delegate('old'), delegate('fast')], {
        contextCursor, waitPolicy: { ...wait('old', 'fast'), kind: 'next_completion' },
      });
      if (controllers === 2) return propose(invocation, [delegate('replacement')], {
        contextCursor, cancellations: ['old'], waitPolicy: wait('old', 'replacement'),
      });
      return final(invocation);
    },
  });
  const submission = await api.submit(request());
  await initialWorkers.promise;
  completeFast.resolve();
  const state = await submission.completion;
  assert.equal(state.status, 'finished');
  const old = state.attempts.find(item => item.actionId === 'old');
  assert.equal(old.cancellation, 'superseded');
  assert.equal(old.outcome.effect, 'unknown');
  assert.deepEqual(cancellations, [old.attemptId]);
  assert.deepEqual(invocations.filter(item => item.kind === 'delegate').map(item => item.actionId), ['old', 'fast', 'replacement']);
  assert.equal(state.attempts.find(item => item.actionId === 'fast').outcome.terminal, 'completed');
});

test('a final that requests cancellation is reconsidered with the resulting unknown effect', { timeout: 3000 }, async () => {
  const { api } = setup({
    maxInvocations: 5, maxConcurrentInvocations: 3,
    async respond(invocation, count) {
      if (invocation.kind === 'delegate') {
        if (invocation.actionId === 'pending') return abortOnly(invocation.signal);
        return report(invocation);
      }
      const { contextCursor, outcomes } = invocation.context[1].value;
      if (count === 1) return propose(invocation, [delegate('pending'), delegate('quick')], {
        contextCursor, waitPolicy: { ...wait('pending', 'quick'), kind: 'next_completion' },
      });
      const result = outcomes.find(item => item.actionId === 'pending');
      if (!result) return final(invocation, { contextCursor, cancellations: ['pending'] });
      assert.equal(result.effect, 'unknown');
      return final(invocation, { contextCursor, finalAssessment: assessment({
        overall: 'partial', unresolvedQuestions: ['Effect of cancelled action is unknown'],
      }) });
    },
  });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.status, 'finished');
  assert.equal(state.assessment.overall, 'partial');
  assert.deepEqual(state.assessment.unresolvedQuestions, ['Effect of cancelled action is unknown']);
});

test('disagreement and a failed check leave the next action to the Controller', async () => {
  let controllers = 0;
  const { api, invocations } = setup({
    maxInvocations: 6, maxConcurrentInvocations: 2,
    respond(invocation) {
      if (invocation.kind === 'delegate') {
        const claim = { left: 'The check failed', right: 'The check passed', investigate: 'The claims refer to different checks' };
        return {
          ...report(invocation, invocation.actionId === 'left' ? { terminal: 'failed' } : undefined),
          output: claim[invocation.actionId],
        };
      }
      const { contextCursor } = invocation.context[1].value;
      if (++controllers === 1) return propose(invocation, [delegate('left'), delegate('right')], { contextCursor });
      if (controllers === 2) {
        const claims = invocation.context.filter(item => item.ref.startsWith('attempt-output:'));
        assert.deepEqual(claims.map(item => item.value).sort(), ['The check failed', 'The check passed']);
        return propose(invocation, [delegate('investigate', [], { contextRefs: claims.map(item => item.ref) })], { contextCursor });
      }
      return final(invocation, { finalAssessment: assessment({ answer: 'The claims refer to different checks' }) });
    },
  });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.assessment.answer, 'The claims refer to different checks');
  assert.equal(state.assessment.overall, 'partial');
  assert.deepEqual(invocations.filter(item => item.kind === 'delegate').map(item => item.actionId), ['left', 'right', 'investigate']);
});

test('all_requested waits on its target while an independent action outside that wait set still starts', { timeout: 3000 }, async () => {
  const backgroundStarted = Promise.withResolvers();
  const backgroundRelease = Promise.withResolvers();
  const controllerSawPending = Promise.withResolvers();
  let controllers = 0;
  const { api } = setup({
    maxInvocations: 5, maxConcurrentInvocations: 3,
    async respond(invocation) {
      if (invocation.kind === 'delegate') {
        if (invocation.actionId === 'background') {
          backgroundStarted.resolve();
          await backgroundRelease.promise;
        } else {
          await backgroundStarted.promise;
        }
        return report(invocation);
      }
      const { contextCursor, pendingAttempts } = invocation.context[1].value;
      if (++controllers === 1) return propose(invocation, [delegate('target'), delegate('background')], {
        contextCursor, waitPolicy: wait('target'),
      });
      if (controllers === 2) {
        assert.equal(pendingAttempts.find(item => item.actionId === 'background').status, 'dispatched');
        controllerSawPending.resolve();
        return propose(invocation, [], { contextCursor, waitPolicy: wait('background') });
      }
      return final(invocation);
    },
  });
  const submission = await api.submit(request());
  await controllerSawPending.promise;
  backgroundRelease.resolve();
  assert.equal((await submission.completion).status, 'finished');
});

test('a clarification can resume and wait for an existing background attempt', { timeout: 3000 }, async () => {
  const background = Promise.withResolvers();
  const waitingForBackground = Promise.withResolvers();
  let controllers = 0;
  const { api, invocations } = setup({
    maxInvocations: 8, maxConcurrentInvocations: 3,
    async respond(invocation) {
      if (invocation.kind === 'delegate') {
        if (invocation.actionId === 'background') await background.promise;
        return report(invocation);
      }
      const { contextCursor, pendingAttempts, outcomes } = invocation.context[1].value;
      switch (++controllers) {
        case 1: return propose(invocation, [delegate('background'), delegate('quick')], {
          contextCursor, waitPolicy: { ...wait('quick'), kind: 'next_completion' },
        });
        case 2: return final(invocation, {
          contextCursor, finalAssessment: undefined, clarification: { question: 'Choose A or B?' },
        });
        case 3: {
          const pending = pendingAttempts.find(item => item.actionId === 'background');
          assert.equal(pending.status, 'dispatched');
          waitingForBackground.resolve();
          return propose(invocation, [], {
            contextCursor, waitPolicy: { kind: 'all_requested', targets: [{ kind: 'attempt', id: pending.attemptId }] },
          });
        }
        default:
          assert.ok(outcomes.some(item => item.actionId === 'background'));
          return final(invocation);
      }
    },
  });
  const waiting = await (await api.submit(request())).completion;
  const original = waiting.attempts.find(item => item.actionId === 'background');
  const resumed = await api.resume(waiting.operationId, {
    requestId: 'reply', questionId: waiting.waiting.questionId, text: 'B',
  });
  await waitingForBackground.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controllers, 3);
  assert.equal((await api.inspect(waiting.operationId)).status, 'active');
  background.resolve();
  const finished = await resumed.completion;
  assert.equal(finished.status, 'finished');
  assert.equal(finished.attempts.find(item => item.actionId === 'background').attemptId, original.attemptId);
  assert.equal(invocations.filter(item => item.actionId === 'background').length, 1);
  assert.equal(controllers, 4);
});
