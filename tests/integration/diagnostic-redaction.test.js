import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactDiagnostic } from '../../src/application/redact-diagnostic.js';
import { createEventStream } from '../../src/application/events.js';

test('C11.3 nested secrets, env, auth headers and error strings are redacted', () => {
  const source = { reasonCode: 'FAILED', details: {
    password: 'abc123', nested: [{ authorization: 'Bearer private-token' },
      { message: 'The key my-known-secret failed; Authorization: Bearer abc.123' }],
    env: { API_KEY: 'from-key', NORMAL: 'safe' },
    endpoint: 'https://user:password@example.test/path',
  } };
  const sourceText = JSON.stringify(source);
  const redacted = redactDiagnostic(source, { secrets: ['my-known-secret'] });
  const text = JSON.stringify(redacted);
  for (const forbidden of ['abc123', 'private-token', 'my-known-secret', 'from-key', 'user:password', 'abc.123']) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  assert.equal(JSON.stringify(source), sourceText);
  assert.equal(redacted.reasonCode, 'FAILED');
});

test('C11.3 body capture defaults off including nested diagnostic objects and listeners', async () => {
  const sinkEvents = [], listenerEvents = [];
  const stream = createEventStream({ emit: event => { sinkEvents.push(event); }, flush() {} });
  stream.subscribe(event => listenerEvents.push(event));
  stream.emit({ schemaVersion: 1, eventId: '1', receivedAt: 1, sequence: 1,
    level: 'info', component: 'fixture', eventName: 'test', reasonCode: 'DONE',
    details: { prompt: 'private prompt', toolOutput: 'private output', tag: 'public' } });
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(sinkEvents.length, 1);
  assert.deepEqual(listenerEvents, sinkEvents);
  assert.ok(!JSON.stringify(sinkEvents).includes('private prompt'));
  assert.ok(!JSON.stringify(sinkEvents).includes('private output'));
  assert.equal(sinkEvents[0].details.tag, 'public');
  stream.close();
});

test('C11.3 explicit capture still redacts known credentials', () => {
  const result = redactDiagnostic({ prompt: 'My prompt', token: 'private', body: 'Bearer zz-123' },
    { captureBodies: true });
  assert.equal(result.prompt, 'My prompt');
  assert.equal(result.token, '[REDACTED]');
  assert.equal(result.body, 'Bearer [REDACTED]');
});
