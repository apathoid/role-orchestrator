import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorityGrant, createPermissionBroker } from '../../src/main/index.js';
import { final, setup } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

const choices = { providerRequestId: 'native-1', resource: 'tool:inspect', options: [
  { id: 'allow', kind: 'allow' }, { id: 'reject', kind: 'deny' },
] };

function broker(options = {}) {
  const authority = createAuthorityGrant({ reference: 'grant', origin: 'user', profileIds: ['primary'] });
  let i = 0;
  const permissions = createPermissionBroker({ authority, ids: { newId: () => 'request-' + ++i }, ...options });
  return { authority, permissions };
}

test('a standing decision avoids a second prompt and a missing UI does not allow an action', async () => {
  const signal = new AbortController();
  const { permissions } = broker({
    standing: [{ profileId: 'primary', resource: choices.resource, optionId: 'allow', kind: 'allow' }],
  });
  const bound = permissions.bind({ attemptId: 'attempt', authorityRef: 'grant', profileId: 'primary', signal: signal.signal });
  assert.deepEqual(await bound.request(choices), { kind: 'selected', option: 'allow' });
  assert.deepEqual(await bound.request({ ...choices, providerRequestId: 'other', resource: 'tool:other' }), { kind: 'unavailable' });
  bound.close();
  assert.deepEqual(await bound.request(choices), { kind: 'cancelled' });
});

test('permission reply must match the live attempt, native request and option', async () => {
  const waiting = Promise.withResolvers();
  const { authority, permissions } = broker({ onRequest: waiting.resolve });
  const { api, events } = setup({ authority, permissions, async respond(invocation) {
    const original = invocation.permissions.request(choices);
    const duplicate = invocation.permissions.request(choices);
    assert.deepEqual(await original, { kind: 'selected', option: 'reject' });
    assert.deepEqual(await duplicate, { kind: 'selected', option: 'reject' });
    return final(invocation);
  } });
  const submission = await api.submit(request());
  const { requestId, attemptId, providerRequestId } = await waiting.promise;
  const reply = { requestId, attemptId, providerRequestId, optionId: 'reject' };
  assert.equal(permissions.respond({ ...reply, attemptId: 'other' }).kind, 'rejected');
  assert.equal(permissions.respond({ ...reply, optionId: 'invented' }).code, 'UNKNOWN_PERMISSION_OPTION');
  assert.equal(permissions.respond(reply).kind, 'accepted');
  assert.equal(permissions.respond(reply).kind, 'rejected');
  assert.equal((await submission.completion).status, 'finished');
  assert.deepEqual(events.filter(event => event.eventName.startsWith('permission.')).map(event => [event.eventName, event.attemptId]), [
    ['permission.requested', attemptId], ['permission.resolved', attemptId],
  ]);
  assert.ok(!JSON.stringify(events).includes(choices.resource));
});

test('cancellation expires a pending permission before a late approval can be used', async () => {
  const waiting = Promise.withResolvers();
  const { authority, permissions } = broker({ onRequest: waiting.resolve });
  const { api } = setup({ authority, permissions, async respond(invocation) {
    assert.deepEqual(await invocation.permissions.request(choices), { kind: 'cancelled' });
    return final(invocation);
  } });
  const submission = await api.submit(request());
  const { requestId, attemptId, providerRequestId } = await waiting.promise;
  await api.cancel(submission.operation.operationId);
  assert.equal(permissions.respond({ requestId, attemptId, providerRequestId, optionId: 'allow' }).kind, 'rejected');
  assert.equal((await submission.completion).status, 'cancelled');
});
