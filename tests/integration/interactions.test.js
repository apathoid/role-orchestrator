import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createInteractionBroker } from '../../src/main/index.js';

function fixture(options = {}, deadline = 200) {
  let next = 0, time = 100;
  const timers = new Set(), notices = [];
  const stop = new AbortController();
  const broker = createInteractionBroker({ ids: { newId: () => 'request-' + ++next },
    onRequest: request => { notices.push(request); }, ...options });
  function bind(operationId = 'op', attemptId = 'attempt') {
    return broker.bind({ operationId, attemptId, profileId: 'profile', signal: stop.signal, isActive: () => true,
      deadline, clock: { now: () => time, monotonicNow: () => time },
      schedule(ms, expire) { const timer = { at: time + ms, expire }; timers.add(timer); return () => timers.delete(timer); } });
  }
  function advance(ms) {
    time += ms;
    // Simulate the single owner's deadline, not a broker timer.
    if (deadline !== null && time >= deadline) stop.abort('deadline');
    for (const timer of [...timers]) if (timer.at <= time) timer.expire();
  }
  return { broker, bind, stop, notices, advance, timers };
}
const input = { kind: 'input', nativeKind: 'form', providerRequestId: 'native-1', payload: { message: 'Question' } };

test('native interaction reply belongs to one attempt/owner and duplicate reply is idempotent while live', async () => {
  const { broker, bind, notices, timers } = fixture();
  const one = bind(), two = bind('other', 'second');
  const first = one.request(input), duplicate = one.request(input), second = two.request(input);
  await tick();
  assert.equal(notices.length, 2);
  const [a, b] = notices;
  assert.deepEqual(broker.pending('op'), [a]);
  assert.equal(a.deadlineAt, 200);
  assert.equal(broker.respond({ ...a, attemptId: b.attemptId, payload: 'yes' }).kind, 'rejected');
  const reply = { ...a, payload: { action: 'accept', value: 'yes' } };
  assert.equal(broker.respond(reply).kind, 'accepted');
  assert.equal(broker.respond(reply).kind, 'accepted');
  assert.equal(broker.respond({ ...reply, payload: 'different' }).code, 'INTERACTION_REPLY_CONFLICT');
  assert.deepEqual(await first, { kind: 'answered', payload: reply.payload });
  assert.deepEqual(await duplicate, await first);
  assert.equal((await one.request({ ...input, payload: 'different' })).kind, 'invalid');
  assert.equal(broker.respond({ ...b, payload: 'no' }).kind, 'accepted');
  assert.deepEqual(await second, { kind: 'answered', payload: 'no' });
  assert.equal(timers.size, 0);
  one.close(); two.close();
  assert.equal(broker.respond(reply).kind, 'rejected');
});

test('C20 interaction uses only the inherited invocation deadline and closes on cancellation', async () => {
  const { broker, bind, notices, advance, timers } = fixture({},120);
  const one = bind();
  const first = one.request(input);
  await tick();
  assert.equal(notices[0].deadlineAt, 120);
  assert.equal(timers.size,0);
  advance(20);
  assert.equal((await first).kind, 'timed_out');
  assert.equal(broker.respond({ ...notices[0], payload: 'late' }).kind, 'rejected');
  assert.equal(broker.pending('op').length, 0);
});

test('C20 indefinite interaction accepts a late user response and remains explicitly cancellable',async()=>{
  const {broker,bind,notices,advance,stop,timers}=fixture({},null);
  const one=bind();
  const first=one.request(input);
  await tick();
  assert.equal(notices[0].deadlineAt,null);
  advance(1000000);
  assert.equal(timers.size,0);
  assert.equal(broker.pending('op').length,1);
  assert.equal(broker.respond({...notices[0],payload:'yes'}).kind,'accepted');
  assert.deepEqual(await first,{kind:'answered',payload:'yes'});
  const second=one.request({...input,providerRequestId:'native-2'});
  await tick();
  stop.abort('client');
  assert.equal((await second).kind,'cancelled');
  assert.equal(broker.respond({...notices[1],payload:'late'}).kind,'rejected');
  assert.equal(timers.size,0);
});

test('handler-owned interaction cannot be answered by an observer; late handler reply cannot revive it', async () => {
  const entered = Promise.withResolvers(), reply = Promise.withResolvers();
  const { broker, bind, advance } = fixture({ onRequest: undefined,
    async handleRequest(request, signal) { entered.resolve({ request, signal }); return reply.promise; } },110);
  const one = bind();
  const result = one.request(input);
  const { request, signal } = await entered.promise;
  assert.equal(broker.respond({ ...request, payload: 'observer' }).kind, 'rejected');
  advance(10);
  assert.equal((await result).kind, 'timed_out');
  assert.equal(signal.aborted, true);
  reply.resolve({ kind: 'answered', payload: 'late' });
  await tick();
  assert.deepEqual(broker.pending('op'), []);
  one.close();
});
