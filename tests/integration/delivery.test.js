import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createEventStream } from '../../src/application/events.js';
import { createActivityStream } from '../../src/application/activity.js';

test('execution subscribers are bounded, scoped and independent of diagnostic sink', async () => {
  const durable = [], seen = [], other = [];
  const gate = Promise.withResolvers();
  const stream = createEventStream({ emit: event => durable.push(event), flush() {} });
  stream.subscribe(async event => { seen.push(event); await gate.promise; }, { operationId: 'op' });
  stream.subscribe(event => other.push(event), { operationId: 'other' });
  for (let i = 0; i < 1000; i++) stream.emit({ schemaVersion: 1, eventId: String(i), receivedAt: i,
    sequence: i, level: 'info', component: 'fixture', eventName: 'attempt.event', reasonCode: 'fixture', operationId: 'op' });
  await tick();
  assert.equal(durable.length, 1000);
  assert.equal(seen.length, 1);
  gate.resolve();
  await tick();
  assert.equal(other.length, 0);
  assert.equal(seen.at(-1).eventName, 'delivery.gap');
  assert.equal(seen.length - 1 + seen.at(-1).details.droppedCount, 1000);
  assert.ok(seen.length <= 128);
  stream.close();
});

test('oversized activity is represented by a gap and does not consume result capacity', async () => {
  const stream = createActivityStream(), notices = [];
  stream.subscribe({ operationId: 'op' }, event => notices.push(event));
  const emit = stream.bind({ operationId: 'op', attemptId: 'a', profileId: 'p', providerId: 'x' }, () => true);
  emit({ kind: 'reasoning', payload: 'x'.repeat(1024 * 1024 + 1) });
  await tick();
  emit({ kind: 'reasoning', payload: 'after' });
  await tick();
  assert.equal(notices[0].kind, 'gap');
  assert.equal(notices[0].droppedCount, 1);
  assert.equal(notices[1].payload, 'after');
  stream.close();
});
