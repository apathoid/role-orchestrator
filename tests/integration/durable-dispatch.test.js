import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { applyEvent, resourceSnapshot } from '../../src/core/operation.js';
import { setup } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';

for (const [boundary, status, effects] of [
  ['before_reservation', undefined, 0],
  ['after_reservation', 'reserved', 0],
  ['before_dispatch_record', 'reserved', 0],
  ['after_dispatch_record', 'dispatched', 0],
  ['after_provider_dispatch', 'dispatched', 1],
  ['after_result_before_outcome_commit', 'dispatched', 1],
  ['after_outcome_commit', 'terminal', 1],
  ['after_terminal_commit', 'terminal', 1],
  ['after_delivery', 'terminal', 1],
]) {
  test('durable dispatch crash boundary: ' + boundary, { timeout: 5000 }, async t => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'role-orchestrator-crash-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const child = fork(new URL('../fixtures/dispatch-crash.js', import.meta.url), [directory, boundary], { silent: true });
    const exit = once(child, 'exit');
    t.after(async () => { child.kill('SIGKILL'); await exit; });
    const { operationId, delivered } = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exit.then(() => assert.fail('Child exited before its crash boundary')),
    ]);
    assert.equal(delivered, boundary === 'after_delivery');
    child.kill('SIGKILL');
    assert.deepEqual(await exit, [null, 'SIGKILL']);

    const durable = createLocalStateStore(directory);
    await durable.open();
    t.after(() => durable.close());
    const persisted = await durable.load(operationId);
    const attempt = persisted.attempts[0];
    assert.equal(attempt?.status, status);
    const chargedBefore = status ? 1 : 0;
    assert.equal(resourceSnapshot(persisted).charged, chargedBefore);
    assert.equal(resourceSnapshot(persisted).remaining, 3 - chargedBefore);
    if (status === 'dispatched') assert.equal(attempt.dispatchCertainty, 'unknown');

    const { api, invocations, events } = setup({ store: durable, idPrefix: 'recovered-' });
    const duplicate = await api.submit(request());
    const redelivered = await duplicate.completion;
    assert.equal(redelivered.operationId, operationId);
    if (boundary === 'after_terminal_commit' || boundary === 'after_delivery') {
      assert.equal(redelivered.status, 'finished');
      assert.equal(redelivered.assessment.answer, 'Direct answer');
    }
    assert.equal(invocations.length, 0);
    const completed = await (await api.resume(operationId)).completion;
    assert.equal(completed.status, 'finished');
    if (persisted.status === 'active') {
      assert.equal(invocations.length, 1);
      assert.notEqual(invocations[0].attemptId, attempt?.attemptId);
      assert.equal(resourceSnapshot(completed).remaining, 2 - chargedBefore);
      const old = completed.attempts.find(item => item.attemptId === attempt?.attemptId);
      if (status === 'dispatched') assert.equal(old.outcome.effect, 'unknown');
      if (status === 'reserved') {
        assert.equal(old.dispatchCertainty, 'not_sent');
        assert.equal(old.outcome.effect, 'none');
      }
      if (status === 'terminal') assert.deepEqual(old.outcome, attempt.outcome);
      for (const [index, record] of completed.events.entries()) {
        if (index < persisted.revision || record.kind !== 'attempt.outcome') continue;
        const diagnostic = events.find(item => item.eventId === record.eventId);
        assert.equal(diagnostic.sequence, index + 1);
        assert.equal(diagnostic.attemptId, record.outcome.attemptId);
      }
    } else {
      assert.equal(invocations.length, 0);
      assert.equal(completed.revision, persisted.revision);
    }
    const recorded = await fs.readFile(join(directory, 'external-effects'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    assert.equal(recorded, 'effect\n'.repeat(effects));
  });
}

test('an unacknowledged durable dispatch record is read but does not send an invocation', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'role-orchestrator-ack-'));
  const durable = createLocalStateStore(directory);
  await durable.open();
  t.after(async () => { await durable.close(); await fs.rm(directory, { recursive: true, force: true }); });
  let lostAcknowledgement = false;
  let loadsAfterFailure = 0;
  const { api, invocations, events } = setup({
    store: {
      ...durable,
      async commit(id, revision, next) {
        const result = await durable.commit(id, revision, next);
        if (result.kind === 'committed' && next.events.at(-1)?.kind === 'attempt.dispatched') {
          lostAcknowledgement = true;
          return { kind: 'unavailable' };
        }
        return result;
      },
      async load(id) {
        if (lostAcknowledgement) loadsAfterFailure++;
        return durable.load(id);
      },
    },
  });
  const submitted = await api.submit(request());
  await assert.rejects(submitted.completion, { code: 'STORE_UNAVAILABLE' });
  assert.equal(loadsAfterFailure, 1);
  assert.equal(invocations.length, 0);
  assert.equal((await durable.load(submitted.operation.operationId)).attempts[0].dispatchCertainty, 'unknown');
  const persisted = await durable.load(submitted.operation.operationId);
  const trace = events.find(event => event.eventName === 'store.unconfirmed_revision_visible');
  assert.equal(trace.sequence, persisted.revision);
  assert.equal(trace.attemptId, persisted.attempts[0].attemptId);
});

test('a provider disconnect round-trips its exact terminal uncertainty through the durable store', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'role-orchestrator-unknown-'));
  const durable = createLocalStateStore(directory);
  await durable.open();
  t.after(async () => { await durable.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const { api } = setup({ store: durable, respond() { throw new Error('Disconnected'); } });
  const completed = await (await api.submit(request())).completion;
  await durable.close();
  await durable.open();
  const restored = await durable.load(completed.operationId);
  assert.equal(restored.waiting.reason.code, 'PROVIDER_DISCONNECTED');
  assert.deepEqual(restored.attempts[0].outcome, completed.attempts[0].outcome);
  assert.equal(restored.attempts[0].dispatchCertainty, 'unknown');
});

test('outcome CAS conflict and lost final ACK retry only the local record', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'role-orchestrator-delivery-'));
  const durable = createLocalStateStore(directory);
  await durable.open();
  t.after(async () => { await durable.close(); await fs.rm(directory, { recursive: true, force: true }); });
  let outcomeConflict = true;
  let lostFinalAcknowledgement = true;
  const writes = [];
  const { api, invocations } = setup({
    store: {
      ...durable,
      async commit(id, revision, next) {
        const event = next.events.at(-1);
        if (event?.kind === 'attempt.outcome' || event?.kind === 'operation.finished') {
          writes.push({ kind: event.kind, eventId: event.eventId, expected: revision, actual: next.revision });
        }
        if (event?.kind === 'attempt.outcome' && outcomeConflict) {
          outcomeConflict = false;
          const prior = await durable.load(id);
          const concurrent = applyEvent(prior, {
            eventId: 'concurrent-deferred', operationId: id, receivedAt: 100, kind: 'action.deferred',
            actionId: 'another-action', code: 'RESOURCE_LIMIT',
          });
          assert.equal(concurrent.kind, 'applied');
          assert.deepEqual(await durable.commit(id, revision, concurrent.state), { kind: 'committed' });
          const stale = await durable.commit(id, revision, next);
          assert.deepEqual(stale, { kind: 'conflict' });
          return stale;
        }
        const result = await durable.commit(id, revision, next);
        if (event?.kind === 'operation.finished' && lostFinalAcknowledgement) {
          lostFinalAcknowledgement = false;
          assert.equal(result.kind, 'committed');
          return { kind: 'unavailable' };
        }
        return result;
      },
    },
  });
  const first = await (await api.submit(request())).completion;
  assert.equal(first.status, 'finished');
  assert.equal(invocations.length, 1);
  assert.equal(writes.length, 4);
  assert.equal(writes[0].eventId, writes[1].eventId);
  assert.equal(writes[1].expected, writes[0].expected + 1);
  assert.ok(first.events.some(event => event.eventId === 'concurrent-deferred'));
  assert.equal(writes[2].eventId, writes[3].eventId);
  assert.equal(writes[3].expected, writes[3].actual);
  assert.equal(first.events.filter(event => event.kind === 'attempt.outcome').length, 1);
  assert.equal(first.events.filter(event => event.kind === 'operation.finished').length, 1);

  await durable.close();
  await durable.open();
  const restarted = setup({ store: durable });
  const duplicate = await (await restarted.api.submit(request())).completion;
  assert.equal(duplicate.assessment.answer, first.assessment.answer);
  assert.equal(duplicate.revision, first.revision);
  assert.equal(restarted.invocations.length, 0);
});

test('durable outcome and final delivery survive a failing diagnostic sink', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'role-orchestrator-diagnostics-'));
  const store = createLocalStateStore(directory);
  await store.open();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  let failedEmits = 0;
  const first = setup({
    store, emit(event) {
      failedEmits++;
      if (event.eventName === 'attempt.outcome') return Promise.reject(new Error('sink unavailable'));
      throw new Error('sink unavailable');
    },
  });
  const completed = await (await first.api.submit(request())).completion;
  assert.ok(failedEmits > 0);
  assert.equal(completed.status, 'finished');
  await store.close();
  await store.open();
  const restarted = setup({ store });
  const redelivered = await (await restarted.api.resume(completed.operationId)).completion;
  assert.equal(redelivered.assessment.answer, completed.assessment.answer);
  assert.equal(redelivered.attempts[0].outcome.terminal, 'completed');
  assert.equal(restarted.invocations.length, 0);
});
