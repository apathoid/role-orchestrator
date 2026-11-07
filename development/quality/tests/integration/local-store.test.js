import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStateStore } from '../../../../src/adapters/state/local-store.js';
import { applyEvent, createOperation, sameRecord } from '../../../../src/core/operation.js';
import { final, setup } from '../../fixtures/application.js';
import { outcome, request } from '../../fixtures/core.js';

async function setupStore(t, overrides) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'role-orchestrator-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalStateStore(directory, { ...fs, ...overrides });
  t.after(() => store.close());
  await store.open();
  return { directory, store };
}

const initial = (id = 'operation-1') => createOperation(id, request(), 'grant-ref', {
  maxInvocations: 5, maxConcurrentInvocations: 2,
});

function reserve(state, id = 'attempt-1') {
  const result = applyEvent(state, {
    kind: 'attempt.reserved', eventId: 'reserve-' + id, operationId: state.operationId,
    receivedAt: 100, attemptId: id, actionId: id,
  });
  assert.equal(result.kind, 'applied');
  return result.state;
}

test('local store persists complete revisions and serializes competing CAS writes', async t => {
  const { store, directory } = await setupStore(t);
  const state = initial('../../opaque');
  const id = state.operationId;
  assert.equal(await store.load(id), undefined);
  assert.deepEqual(await store.commit(id, null, state), { kind: 'committed' });
  const first = reserve(state);
  const competing = reserve(state, 'other-attempt');
  const results = await Promise.all([store.commit(id, 0, first), store.commit(id, 0, competing)]);
  assert.deepEqual(results, [{ kind: 'committed' }, { kind: 'conflict' }]);
  assert.deepEqual(await store.commit(id, 1, state), { kind: 'unavailable' });
  await store.close();
  const reopened = createLocalStateStore(directory);
  t.after(() => reopened.close());
  await reopened.open();
  assert.ok(sameRecord(await reopened.load(id), first));
  assert.deepEqual((await reopened.list()).map(operation => operation.operationId), [id]);
  const names = (await fs.readdir(directory)).filter(name => !name.startsWith('.writer.sqlite'));
  assert.equal(names.length, 1);
  assert.match(names[0], /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/u);
});

test('partial temp writes and rejected rename leave the previous JSON intact', async t => {
  let fault;
  const { store, directory } = await setupStore(t, {
    async open(path, ...args) {
      const file = await fs.open(path, ...args);
      if (fault === 'write' && String(path).endsWith('.tmp')) {
        file.writeFile = async () => {
          await file.write('{"partial":');
          throw Object.assign(new Error('fault'), { code: 'ENOSPC' });
        };
      }
      return file;
    },
    async rename(from, to) {
      if (fault === 'rename') throw Object.assign(new Error('fault'), { code: 'EIO' });
      return fs.rename(from, to);
    },
  });
  const state = initial();
  const id = state.operationId;
  await store.commit(id, null, state);
  const next = reserve(state);
  for (const phase of ['write', 'rename']) {
    fault = phase;
    assert.deepEqual(await store.commit(id, 0, next), { kind: 'unavailable' });
    assert.ok(sameRecord(await store.load(id), state));
    assert.equal((await fs.readdir(directory)).filter(name => !name.startsWith('.writer.sqlite')).length, 1);
  }
});

test('readers see old or new complete JSON, and post-rename sync failure is resolved by load', async t => {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  let phase = 'initial';
  const { store, directory } = await setupStore(t, {
    async open(path, ...args) {
      const file = await fs.open(path, ...args);
      if (typeof args[0] === 'number') {
        const sync = file.sync.bind(file);
        file.sync = () => {
          if (phase === 'after_rename') throw Object.assign(new Error('fault'), { code: 'EIO' });
          return sync();
        };
      }
      return file;
    },
    async rename(from, to) {
      if (phase === 'before_rename') {
        ready.resolve();
        await release.promise;
        phase = 'after_rename';
      }
      return fs.rename(from, to);
    },
  });
  const state = initial();
  const id = state.operationId;
  await store.commit(id, null, state);
  const next = reserve(state);
  phase = 'before_rename';
  const writing = store.commit(id, 0, next);
  try {
    await ready.promise;
    assert.ok(sameRecord(await store.load(id), state));
    assert.equal((await store.list()).length, 1);
  } finally {
    release.resolve();
  }
  assert.deepEqual(await writing, { kind: 'unavailable' });
  assert.ok(sameRecord(await store.load(id), next));
  assert.deepEqual(await store.commit(id, 0, next), { kind: 'conflict' });
  assert.equal((await fs.readdir(directory)).filter(name => !name.startsWith('.writer.sqlite')).length, 1);
});

test('unreadable snapshots are never treated as an empty slot for a new commit', async t => {
  const { store, directory } = await setupStore(t);
  const state = initial();
  const id = state.operationId;
  await store.commit(id, null, state);
  const name = (await fs.readdir(directory)).find(name => name.endsWith('.json'));
  const path = join(directory, name);
  for (const [content, reason] of [
    ['{"schemaVersion":2}', 'unsupported_version'],
    ['{"schemaVersion":', 'corrupt_snapshot'],
  ]) {
    await fs.writeFile(path, content);
    await assert.rejects(store.load(id), { code: 'STORE_UNAVAILABLE', reason });
    assert.deepEqual(await store.commit(id, null, state), { kind: 'unavailable' });
    assert.equal(await fs.readFile(path, 'utf8'), content);
  }
});

test('writer ownership excludes live peers and recovers after close or process death', { timeout: 5000 }, async t => {
  const { directory, store } = await setupStore(t);
  const start = () => {
    const child = fork(new URL('../../fixtures/state-writer.js', import.meta.url), [directory], { silent: true });
    const message = once(child, 'message').then(([value]) => value);
    const exit = once(child, 'exit');
    t.after(async () => {
      child.kill('SIGKILL');
      await exit;
    });
    return { child, message, exit };
  };
  const id = 'operation-1';
  assert.deepEqual(await store.commit(id, null, initial(id)), { kind: 'committed' });
  // A stale-looking lock file cannot displace a live owner.
  const workspace = await fs.mkdtemp(join(tmpdir(), 'role-orchestrator-unlocked-workspace-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const old = new Date(0);
  await fs.utimes(join(directory, '.writer.sqlite'), old, old);
  const blocked = start();
  assert.deepEqual(await blocked.message, { kind: 'error', code: 'STATE_STORE_IN_USE' });
  await fs.writeFile(join(workspace, 'edit.txt'), 'unrelated edit');
  assert.equal(await fs.readFile(join(workspace, 'edit.txt'), 'utf8'), 'unrelated edit');
  await blocked.exit;
  await store.close();

  const graceful = start();
  assert.deepEqual(await graceful.message, { kind: 'opened' });
  await assert.rejects(store.open(), { code: 'STATE_STORE_IN_USE' });
  graceful.child.send('close');
  assert.deepEqual(await graceful.exit, [0, null]);

  const crashed = start();
  assert.deepEqual(await crashed.message, { kind: 'opened' });
  crashed.child.kill('SIGKILL');
  assert.deepEqual(await crashed.exit, [null, 'SIGKILL']);
  await store.open();
  assert.ok(sameRecord(await store.load(id), initial(id)));
});

test('artifacts expose truncation and verify the bounded stored bytes', async t => {
  const { store, directory } = await setupStore(t);
  const source = Buffer.from('abcdef');
  const ref = await store.writeArtifact(source, 3);
  assert.equal(ref.originalSize, 6);
  assert.equal(ref.size, 3);
  assert.equal(ref.truncated, true);
  const content = await store.readArtifact(ref, 3);
  assert.equal(content.kind, 'available');
  assert.equal(Buffer.from(content.bytes).toString(), 'abc');
  assert.deepEqual(await store.readArtifact(ref, 2), { kind: 'unavailable' });
  const file = (await fs.readdir(directory)).find(name => name.endsWith('.blob'));
  const path = join(directory, file);
  for (const corrupted of ['ab', 'aBc', 'abcd']) {
    await fs.writeFile(path, corrupted);
    assert.deepEqual(await store.readArtifact(ref, 3), { kind: 'integrity_error' });
  }
  await fs.unlink(path);
  assert.deepEqual(await store.readArtifact(ref, 3), { kind: 'unavailable' });
});

test('partial artifact writes publish no ref and reopen removes only owned temp names', async t => {
  let fail = true;
  const { store, directory } = await setupStore(t, {
    async open(path, ...args) {
      const file = await fs.open(path, ...args);
      if (fail && String(path).endsWith('.tmp')) {
        file.writeFile = async () => {
          await file.write('incomplete');
          throw new Error('failed write');
        };
      }
      return file;
    },
  });
  await assert.rejects(store.writeArtifact(Buffer.from('actual data'), 10), { code: 'STORE_UNAVAILABLE' });
  assert.ok(!(await fs.readdir(directory)).some(name => name.endsWith('.tmp') || name.endsWith('.blob')));
  fail = false;
  const ref = await store.writeArtifact(Buffer.from('actual data'), 10);
  const state = initial();
  const reserved = reserve(state);
  const terminal = applyEvent(reserved, {
    kind: 'attempt.outcome', operationId: state.operationId, eventId: 'artifact-outcome', receivedAt: 101,
    outcome: outcome('attempt-1', { terminal: 'failed', outputRefs: [{ ref: ref.ref, source: 'host_observed', kind: 'output' }] }),
    dispatchCertainty: 'not_sent',
    observations: [{ ref: ref.ref, value: ref, completeness: 'truncated', source: 'host_observed' }],
  });
  assert.equal(terminal.kind, 'applied');
  assert.deepEqual(await store.commit(state.operationId, null, state), { kind: 'committed' });
  assert.deepEqual(await store.commit(state.operationId, 0, reserved), { kind: 'committed' });
  assert.deepEqual(await store.commit(state.operationId, 1, terminal.state), { kind: 'committed' });
  await store.close();
  const orphan = '.state-00000000-0000-4000-8000-000000000000.tmp';
  await fs.writeFile(join(directory, orphan), 'incomplete');
  await fs.writeFile(join(directory, '.unrelated.tmp'), 'keep');
  await store.open();
  assert.ok(!(await fs.readdir(directory)).includes(orphan));
  assert.equal(await fs.readFile(join(directory, '.unrelated.tmp'), 'utf8'), 'keep');
  const restored = await store.load(state.operationId);
  assert.ok(sameRecord(restored, terminal.state));
  const artifact = restored.events.at(-1).observations[0].value;
  assert.equal((await store.readArtifact(artifact, 10)).kind, 'available');
});

test('a damaged snapshot is visible in list and blocks only its own initial request redelivery', async t => {
  const { store, directory } = await setupStore(t);
  const { api, invocations } = setup({ store });
  const damagedRequest = request({ requestId: 'damaged' });
  const damaged = await (await api.submit(damagedRequest)).completion;
  const [name] = (await fs.readdir(directory)).filter(item => item.endsWith('.json'));
  const path = join(directory, name);
  const original = await fs.readFile(path);
  const healthy = await (await api.submit(request({ requestId: 'healthy' }))).completion;
  for (const [content, reason] of [
    ['{"schemaVersion":', 'corrupt_snapshot'],
    ['{"schemaVersion":999}', 'unsupported_version'],
  ]) {
    await fs.writeFile(path, content);
    const entries = await store.list();
    assert.ok(entries.some(entry => entry.kind === 'unavailable' && entry.reason === reason && entry.ref.startsWith('state:')));
    assert.ok(entries.some(entry => entry.operationId === healthy.operationId));
    await assert.rejects(api.inspect(damaged.operationId), { code: 'STORE_UNAVAILABLE', reason });
    await assert.rejects(api.submit(damagedRequest), { code: 'STORE_UNAVAILABLE' });
    const finished = await (await api.submit(request({ requestId: reason }))).completion;
    assert.equal(finished.status, 'finished');
    assert.equal(await fs.readFile(path, 'utf8'), content);
  }
  await fs.writeFile(path, original);
  assert.equal((await api.submit(damagedRequest)).operation.operationId, damaged.operationId);
  assert.equal(invocations.filter(item => item.operationId === damaged.operationId).length, 1);
});

test('snapshots written before request-keyed filenames still load and commit in their original slot', async t => {
  const { store, directory } = await setupStore(t);
  const state = initial();
  await store.commit(state.operationId, null, state);
  const [name] = (await fs.readdir(directory)).filter(item => item.endsWith('.json'));
  const originalName = name.slice(0, 64) + '.json';
  await fs.rename(join(directory, name), join(directory, originalName));
  assert.ok(sameRecord(await store.load(state.operationId), state));
  const reserved = reserve(state);
  assert.deepEqual(await store.commit(state.operationId, 0, reserved), { kind: 'committed' });
  assert.ok(sameRecord(await store.load(state.operationId), reserved));
  assert.deepEqual((await fs.readdir(directory)).filter(item => item.endsWith('.json')), [originalName]);
  const { api, invocations } = setup({ store });
  const healthy = await (await api.submit(request({ requestId: 'healthy' }))).completion;
  await fs.writeFile(join(directory, originalName), '{"schemaVersion":');
  assert.equal((await (await api.resume(healthy.operationId)).completion).status, 'finished');
  await assert.rejects(api.submit(request()), { code: 'STORE_UNAVAILABLE' });
  assert.equal(invocations.length, 1);
});

test('read-only storage prevents dispatch and disk recovery does not replay a previously sent effect', async t => {
  let readOnly = true;
  const { store } = await setupStore(t, {
    open(path, ...args) {
      if (readOnly && String(path).endsWith('.tmp')) {
        return Promise.reject(Object.assign(new Error('read-only'), { code: 'EROFS' }));
      }
      return fs.open(path, ...args);
    },
  });
  let effects = 0;
  const { api, invocations } = setup({
    store,
    respond(invocation, count) {
      if (count === 1) {
        effects++;
        readOnly = true;
      } else {
        assert.equal(invocation.context[1].value.unresolvedAttempts[0].effect, 'unknown');
      }
      return final(invocation);
    },
  });
  await assert.rejects(api.submit(request()), { code: 'STORE_UNAVAILABLE' });
  assert.equal(invocations.length, 0);
  readOnly = false;
  const submitted = await api.submit(request());
  await assert.rejects(submitted.completion, { code: 'STORE_UNAVAILABLE' });
  const stranded = await api.inspect(submitted.operation.operationId);
  assert.equal(stranded.attempts[0].status, 'dispatched');
  readOnly = false;
  assert.equal((await (await api.submit(request())).completion).status, 'active');
  assert.equal(invocations.length, 1);
  const recovered = await (await api.resume(stranded.operationId)).completion;
  assert.equal(recovered.status, 'finished');
  assert.equal(recovered.attempts[0].outcome.terminal, 'unknown');
  assert.equal(invocations.length, 2);
  assert.equal(effects, 1);
});
