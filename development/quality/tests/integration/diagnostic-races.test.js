import assert from 'node:assert/strict';
import { test } from 'node:test';
import { abortOnly, final, setup } from '../../fixtures/application.js';
import { request } from '../../fixtures/core.js';
import { createAuthorityGrant, createPermissionBroker } from '../../../../src/main/index.js';

test('C11.6 repeated cancel-invoke races settle without hidden extra dispatch', async () => {
  for (let iteration = 0; iteration < 8; iteration++) {
    const reached = Promise.withResolvers();
    const { api, invocations, closed } = setup({
      respond: async invocation => {
        reached.resolve();
        await abortOnly(invocation.signal);
        return final(invocation);
      },
    });
    const pending = await api.submit(request({ requestId: 'race-' + iteration }));
    await reached.promise;
    await api.cancel(pending.operation.operationId, 'client');
    const result = await pending.completion;
    assert.equal(result.status, 'cancelled');
    assert.equal(invocations.length, 1);
    assert.ok(result.attempts.every(a => a.cancellation || a.status === 'terminal'));
    await api.close();
    assert.equal(closed.length, 1);
  }
});

test('C11.6 repeated concurrent permission approval after cancel cannot revive a task', async () => {
  for (let iteration = 0; iteration < 5; iteration++) {
    const reached = Promise.withResolvers();
    const authority = createAuthorityGrant({
      reference: 'fixture-authority', origin: 'user', profileIds: ['primary'],
    });
    let sequence = 0;
    const broker = createPermissionBroker({ authority, ids: { newId: () => 'p-' + ++sequence },
      onRequest: reached.resolve });
    const { api, invocations } = setup({ authority, permissions: broker,
      async respond(invocation) {
        await invocation.permissions.request({ providerRequestId: 'native-' + iteration,
          resource: 'read', options: [{ id: 'allow', kind: 'allow' }] });
        return final(invocation);
      },
    });
    const pending = await api.submit(request({ requestId: 'permission-' + iteration }));
    const asked = await reached.promise;
    await api.cancel(pending.operation.operationId, 'client');
    assert.equal(broker.respond({ requestId: asked.requestId, attemptId: asked.attemptId,
      providerRequestId: asked.providerRequestId, optionId: 'allow' }).kind, 'rejected');
    const result = await pending.completion;
    assert.equal(result.status, 'cancelled');
    assert.equal(invocations.length, 1);
    await api.close();
  }
});
