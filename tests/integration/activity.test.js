import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createActivityStream } from '../../src/application/activity.js';
import { final, setup } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

test('activity is scoped by bound invocation, not payload or native identity', async () => {
  const stream = createActivityStream();
  const source = { operationId: 'op', attemptId: 'a', profileId: 'p', providerId: 'provider' };
  const all = [], only = [], other = [];
  stream.subscribe({ operationId: 'op' }, event => all.push(event));
  const unsubscribe = stream.subscribe({ operationId: 'op', attemptId: 'a' }, event => only.push(event));
  stream.subscribe({ operationId: 'else' }, event => other.push(event));
  stream.subscribe({ operationId: 'op' }, () => { throw new Error('renderer'); });
  const a = stream.bind(source, () => true);
  const b = stream.bind({ ...source, attemptId: 'b' }, () => true);
  const payload = { text: 'one', operationId: 'else' };
  a({ kind: 'reasoning', payload, nativeId: 'shared', operationId: 'else' });
  payload.text = 'changed';
  b({ kind: 'tool', payload: { status: 'pending' }, nativeId: 'shared' });
  a({ kind: 'reasoning', payload: 'no native ID' });
  await tick();
  assert.deepEqual(all.map(x => [x.attemptId, x.sequence, x.nativeId]), [['a', 1, 'shared'], ['b', 1, 'shared'], ['a', 2, undefined]]);
  assert.equal(all[0].payload.text, 'one');
  assert.equal(all[0].operationId, 'op');
  assert.equal(all[0].payload.operationId, 'else');
  assert.equal(only.length, 2);
  assert.deepEqual(other, []);
  unsubscribe();
  a({ kind: 'plan', payload: [] });
  await tick();
  assert.equal(only.length, 2);
  stream.close();
  a({ kind: 'reasoning', payload: 'after close' });
  await tick();
  assert.equal(all.length, 4);
});

test('activity cannot alter deterministic execution, observations, journal or invocation count', async () => {
  async function run(subscribe) {
    const received = [];
    let emitLate;
    const { api, invocations, events } = setup({ respond(invocation, _count, observe, activity) {
      emitLate = activity;
      activity({ kind: 'reasoning', payload: 'not evidence' });
      const ref = observe({ ref: 'fixture', kind: 'provider_report', sourceId: 'fixture', completeness: 'complete', value: 'real observation' });
      const reply = final(invocation);
      reply.outcome.outputRefs = [{ ref, kind: 'output', source: 'provider_reported' }];
      return reply;
    } });
    let unsubscribe;
    const { completion } = await api.submit(request(), id => {
      if (subscribe) {
        unsubscribe = api.subscribeActivity({ operationId: id }, event => received.push(event));
        api.subscribeActivity({ operationId: id }, () => Promise.reject(new Error('renderer')));
      }
    });
    const state = await completion;
    emitLate({ kind: 'reasoning', payload: 'late' });
    await tick();
    unsubscribe?.();
    await api.close();
    return { state, received, invocations: invocations.length, events };
  }
  const before = await run(false);
  const after = await run(true);
  assert.equal(after.state.status, 'finished');
  assert.ok(after.state.events.some(event => event.kind === 'attempt.outcome' && event.observations?.some(item => item.value === 'real observation')));
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.events, before.events);
  assert.equal(after.invocations, 1);
  assert.equal(after.received.length, 1);
  assert.equal(after.received[0].payload, 'not evidence');
  assert.ok(!JSON.stringify(after.state).includes('not evidence'));
});

test('slow activity consumer is bounded and receives an explicit gap without blocking emit', async () => {
  const stream = createActivityStream();
  const gate = Promise.withResolvers();
  const notices = [];
  stream.subscribe({ operationId: 'op' }, async event => { notices.push(event); await gate.promise; });
  const emit = stream.bind({ operationId: 'op', attemptId: 'a', profileId: 'p', providerId: 'provider' }, () => true);
  for (let i = 0; i < 1000; i++) emit({ kind: 'reasoning', payload: 'chunk' });
  await tick();
  assert.equal(notices.length, 1);
  gate.resolve();
  await tick();
  assert.equal(notices.at(-1).kind, 'gap');
  assert.equal(notices.filter(x => x.kind !== 'gap').length + notices.at(-1).droppedCount, 1000);
  assert.ok(notices.length <= 129);
  stream.close();
});
