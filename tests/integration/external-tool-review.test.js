import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { compileExternalTool, createExternalToolPort } from '../../src/application/configuration/external-tools.js';
import { createAuthorityGrant, createPermissionBroker } from '../../src/main/index.js';
import { final, setup } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const resource = 'release:publish';

async function toolPort(options) {
  const tool = await compileExternalTool({
    id: 'publish', description: 'Publish a release', resource, effect: 'write',
    inputSchema: { type: 'object' }, ...options,
  });
  assert.ok(tool);
  return createExternalToolPort(new Map([['publish', tool]]));
}

function broker(options) {
  const authority = createAuthorityGrant({ reference: 'grant', origin: 'user', profileIds: ['primary'] });
  return { authority, permissions: createPermissionBroker({ authority, ids: { newId: randomUUID }, ...options }) };
}

test('the actual permission request shows opted-in arguments with explicit redaction and truncation', { timeout: 5000 }, async () => {
  const prompt = Promise.withResolvers();
  const args = {
    version: 'v9.0', notes: '🚀'.repeat(1500), target: 'production',
    token: 'private-token', metadata: { password: 'private-password' },
  };
  const tools = await toolPort({
    permissionPreviewFields: ['version', 'target', 'notes', 'metadata'],
    async invoke(input) { assert.deepEqual(input, args); return 'published'; },
  });
  const { authority, permissions } = broker({ onRequest: prompt.resolve });
  const { api, events } = setup({ authority, permissions, tools, async respond(invocation) {
    const reply = await invocation.externalTools.call('publish', args);
    assert.equal(reply.status, 'completed');
    return final(invocation);
  } });
  const task = await api.submit(request());
  const { requestId, attemptId, providerRequestId, action } = await prompt.promise;
  try {
    assert.equal(action.title, 'Publish a release');
    assert.deepEqual(JSON.parse(action.details), {
      arguments: { version: 'v9.0', target: 'production' }, redacted: true, truncated: true,
    });
    assert.ok(Buffer.byteLength(action.details) <= 4096);
    assert.doesNotMatch(action.details, /private|password|token/);
  } finally {
    assert.equal(permissions.respond({ requestId, attemptId, providerRequestId, optionId: 'allow' }).kind, 'accepted');
    assert.equal((await task.completion).status, 'finished');
  }
  assert.doesNotMatch(JSON.stringify(events), /v9\.0|production|private/);
});

for (const cancelled of [true, false]) {
  test('a late tool result survives ' + (cancelled ? 'user cancellation' : 'provider detachment'),
    { timeout: 5000 }, () => withOwnedRun('C09-tool-late', async directory => {
      const store = createLocalStateStore(directory);
      await store.open();
      const started = Promise.withResolvers();
      const settled = Promise.withResolvers();
      const finishProvider = Promise.withResolvers();
      let executions = 0;
      const tools = await toolPort({
        async invoke(_input, scope) { executions++; started.resolve(scope); return settled.promise; },
      });
      const { authority, permissions } = broker({
        standing: [{ profileId: 'primary', resource, optionId: 'allow', kind: 'allow' }],
      });
      let toolReply;
      let lateRef;
      const { api, invocations, closed } = setup({ store, authority, permissions, tools, async respond(invocation, count) {
        if (count === 2) {
          const evidence = await invocation.contextAccess.fetch(lateRef);
          assert.equal(evidence.kind, 'available');
          assert.deepEqual(evidence.item.value.output, { releaseId: 'release-321' });
          return final(invocation);
        }
        toolReply = invocation.externalTools.call('publish', {});
        await finishProvider.promise;
        return final(invocation);
      } });
      try {
        const task = await api.submit(request());
        const { callId, attemptId, operationId } = await started.promise;
        if (cancelled) await api.cancel(operationId);
        finishProvider.resolve();
        assert.equal((await toolReply).status, 'unknown');
        const before = await task.completion;
        const status = cancelled ? 'cancelled' : 'finished';
        assert.equal(before.status, status);
        assert.equal(closed.length, 1);
        const receipts = state => state.events.flatMap(event => event.observations ?? [])
          .filter(item => item.value?.callId === callId);
        const [initial] = receipts(before);
        assert.equal(initial.value.effect, 'unknown');
        assert.equal(initial.value.status, 'unknown');
        settled.resolve({ releaseId: 'release-321' });
        let after;
        const deadline = Date.now() + 1100;
        do {
          after = await api.inspect(operationId);
          if (receipts(after).length > 1) break;
          await sleep(15);
        } while (Date.now() < deadline);
        const records = receipts(after);
        assert.equal(records.length, 2);
        const [, late] = records;
        assert.notEqual(late.ref, initial.ref);
        assert.equal(late.source, 'host_observed');
        assert.equal(late.provenance.sourceId, 'publish');
        assert.deepEqual(late.value, {
          status: 'completed', effect: 'unknown', output: { releaseId: 'release-321' },
          callId, toolId: 'publish', attemptId, late: true,
        });
        const event = after.events.find(event => event.observations?.some(item => item.ref === late.ref));
        assert.equal(event.late, true);
        assert.equal(event.outcome.attemptId, attemptId);
        assert.equal(after.status, status);
        assert.deepEqual(after.attempts, before.attempts);
        assert.equal(executions, 1);
        assert.equal(invocations.length, 1);
        await store.close();
        await store.open();
        assert.deepEqual(receipts(await api.inspect(operationId)), records);
        if (!cancelled) {
          lateRef = late.ref;
          const followup = await api.resume(operationId, { requestId: 'read-late-evidence', text: 'Inspect the release result' });
          assert.equal((await followup.completion).status, 'finished');
          assert.equal(invocations.length, 2);
          assert.equal(executions, 1);
        }
      } finally {
        finishProvider.resolve();
        settled.resolve({});
        await store.close();
      }
    }));
}
