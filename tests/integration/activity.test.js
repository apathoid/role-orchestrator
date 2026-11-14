import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
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

test('C13 delivery consumers preserve parallel execution and mutable workspace under identical load', { timeout: 10000 }, t =>
  withOwnedRun('C13-comparative-fixture', async cwd => {
    const file = join(cwd, 'input.txt');
    async function run(mode) {
      await writeFile(file, 'before');
      const gates = new Map(['a', 'b'].map(id => [id, { started: Promise.withResolvers(), release: Promise.withResolvers() }]));
      const slow = Promise.withResolvers(), notices = [];
      let first, emitted = 0;
      const start = performance.now(), heap = process.memoryUsage().heapUsed;
      const { api, invocations, events } = setup({
        maxConcurrentInvocations: 2, maxInvocations: 4,
        async respond(invocation, count, observe, activity) {
          for (let i = 0; i < 500; i++) {
            emitted++;
            activity({ kind: 'reasoning', payload: 'x'.repeat(4096), nativeId: 'same' });
          }
          if (count === 1) return final(invocation, { finalAssessment: undefined,
            additions: ['a','b'].map(actionId => ({ actionId, kind: 'delegate', objective: actionId,
              profileId: 'primary', expectedResult: 'read file', contextRefs: ['request-1'], dependsOn: [] })),
            waitPolicy: { kind: 'all_requested', targets: ['a','b'].map(id => ({kind:'action', id})) } });
          if (invocation.kind === 'controller') return final(invocation);
          const gate = gates.get(invocation.actionId);
          gate.started.resolve();
          await gate.release.promise;
          const value = await readFile(file, 'utf8');
          const ref = observe({ ref: 'file', kind: 'provider_report', sourceId: 'file', completeness: 'complete', value });
          const response = final(invocation);
          response.output = value;
          response.outcome.outputRefs = [{ ref, kind: 'output', source: 'provider_reported' }];
          return response;
        },
      });
      const submission = await api.submit(request({ workspaceContext: { cwd } }), id => {
        if (mode !== 'none') api.subscribeActivity({operationId:id}, event => {
          first ??= performance.now() - start;
          notices.push(event);
          if (mode === 'throwing') throw Error('consumer failure');
          if (mode === 'slow') return slow.promise;
        });
      });
      try {
        await Promise.all([...gates.values()].map(gate => gate.started.promise));
        await writeFile(file, 'after');
        gates.get('a').release.resolve();
        for (let i = 0; ; i++) {
          const state = await api.inspect(submission.operation.operationId);
          if (state.attempts.some(a => a.actionId === 'a' && a.status === 'terminal')) break;
          assert.ok(i < 1000, 'first worker did not finish');
          await tick();
        }
        gates.get('b').release.resolve();
        const state = await submission.completion;
        const elapsed = performance.now() - start;
        slow.resolve();
        await tick();
        const gaps = notices.filter(e => e.kind === 'gap').reduce((sum,e) => sum + e.droppedCount,0);
        t.diagnostic(JSON.stringify({mode, emitted, delivered:notices.length, gaps, firstMs:first, completionMs:elapsed,
          heapDeltaBytes:process.memoryUsage().heapUsed-heap, invocations:invocations.length}));
        assert.equal(state.status, 'finished');
        assert.equal(invocations.length, 4);
        assert.equal(state.events.filter(e=>e.kind==='attempt.outcome').length, 4);
        assert.ok(state.events.some(e=>e.kind==='attempt.outcome' && e.observations?.some(o=>o.value==='after')));
        if (mode === 'slow') {
          assert.ok(notices.length <= 128);
          assert.equal(notices.filter(e=>e.kind!=='gap').length + gaps, emitted);
        }
        return { state, events, invocations: invocations.map(i=>({kind:i.kind, actionId:i.actionId, context:i.context,
          workspaceContext:i.workspaceContext, instructions:i.instructions})) };
      } finally { slow.resolve(); for(const gate of gates.values()) gate.release.resolve(); await api.close(); }
    }
    const baseline = await run('none');
    for (const mode of ['fast','slow','throwing']) assert.deepEqual(await run(mode), baseline);
  }));
