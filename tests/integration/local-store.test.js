import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { applyEvent, createOperation, sameRecord } from '../../src/core/operation.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/core/snapshot.js';
import { createAuthorityGrant } from '../../src/main/index.js';
import { final, setup } from '../fixtures/application.js';
import { assessment, outcome, request } from '../fixtures/core.js';

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
    const child = fork(new URL('../fixtures/state-writer.js', import.meta.url), [directory], { silent: true });
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

test('an orphan with a contradictory dispatch record cannot be resumed as unsent', async t => {
  const { store, directory } = await setupStore(t);
  const state = initial();
  const reserved = reserve(state);
  const dispatched = applyEvent(reserved, {
    kind: 'attempt.dispatched', operationId: state.operationId, eventId: 'dispatch-1',
    receivedAt: 101, attemptId: 'attempt-1',
    route: { configurationRef: 'test-config', profileId: 'primary', providerId: 'fixture', model: 'fake' },
  });
  assert.equal(dispatched.kind, 'applied');
  await store.commit(state.operationId, null, state);
  await store.commit(state.operationId, 0, reserved);
  await store.commit(state.operationId, 1, dispatched.state);
  const name = (await fs.readdir(directory)).find(item => item.endsWith('.json'));
  const path = join(directory, name);
  const snapshot = JSON.parse(await fs.readFile(path, 'utf8'));
  snapshot.attempts[0].status = 'reserved';
  const corrupt = JSON.stringify(snapshot);
  await fs.writeFile(path, corrupt);
  const { api, invocations } = setup({ store });
  await assert.rejects(api.resume(state.operationId), { code: 'STORE_UNAVAILABLE', reason: 'corrupt_snapshot' });
  assert.equal(invocations.length, 0);
  assert.equal(await fs.readFile(path, 'utf8'), corrupt);
});

test('late evidence after the cleanup deadline is committed while the connection is still owned', { timeout: 3000 }, async t => {
  const { store } = await setupStore(t);
  const started = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const recorded = Promise.withResolvers();
  let now = 100;
  let expire;
  let observe;
  const { api, invocations } = setup({
    store, now: () => now,
    schedule(ms, callback) { expire = callback; return () => {}; },
    close() { closing.resolve(); return cleanup.promise; },
    respond(invocation, count, callback) {
      observe = callback;
      started.resolve(invocation);
      return reply.promise;
    },
    emit(event) {
      if (event.eventName === 'attempt.late_outcome' && event.reasonCode === 'COMPLETED') recorded.resolve();
    },
  });
  const submitted = await api.submit(request());
  const invocation = await started.promise;
  expire();
  await closing.promise;
  expire();
  const waiting = await submitted.completion;
  assert.equal(waiting.attempts[0].outcome.effect, 'unknown');

  const fact = {
    ref: 'late-tool', kind: 'provider_tool', sourceId: 'late-tool-invocation', exitCode: 0,
    completeness: 'complete', value: 'observed',
  };
  observe(fact);
  await new Promise(resolve => setImmediate(resolve));
  now = 110;
  observe(fact);
  reply.resolve({
    ...final(invocation),
    outcome: outcome(invocation.attemptId, { effect: 'confirmed', usage: { cost: 0.02, inputTokens: 1, outputTokens: null } }),
  });
  await recorded.promise;
  cleanup.resolve();
  const loaded = await store.load(waiting.operationId);
  assert.equal(loaded.status, 'waiting');
  assert.equal(loaded.waiting.reason.code, 'DEADLINE_EXCEEDED');
  assert.equal(loaded.waiting.reason.effect, 'confirmed');
  assert.equal(loaded.attempts[0].outcome.usage.cost, 0.02);
  assert.equal(loaded.events.filter(event => event.kind === 'controller.responded').length, 0);
  const samples = loaded.events.flatMap(event => event.observations ?? []).filter(item => item.providerRef === fact.ref);
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0].provenance, {
    kind: 'provider_tool', sourceId: fact.sourceId, receivedAt: 100, exit: { kind: 'tool_exit', code: 0 },
  });
  assert.equal(invocations.length, 1);
});


test('reopened history keeps the agent process exit, tool exit and model claims separate', async t => {
  const { directory, store } = await setupStore(t);
  let now = 100;
  const { api, invocations, events } = setup({
    store, now: () => now,
    respond(invocation, count, observe) {
      now = 110;
      observe({ ref: 'agent-exit', kind: 'agent_exit', sourceId: 'agent-process', exitCode: 0, completeness: 'complete' });
      now = 120;
      observe({ ref: 'claim', kind: 'model', sourceId: 'message-1', completeness: 'complete', value: 'Tests passed' });
      observe({ ref: 'legacy', source: 'host_observed', completeness: 'complete', value: { exitCode: 0 } });
      observe({ ref: 'malformed', kind: 'model', sourceId: 'message-2', exitCode: 0, completeness: 'complete' });
      now = 130;
      return {
        ...final(invocation, { finalAssessment: undefined, clarification: { question: 'Run the requested test?' } }),
        outcome: outcome(invocation.attemptId, { outputRefs: [
          { ref: 'agent-exit', kind: 'agent_exit', source: 'provider_reported' },
          { ref: 'claim', kind: 'tool_exit', source: 'host_observed' },
        ] }),
      };
    },
  });
  const waiting = await (await api.submit(request())).completion;
  assert.equal(waiting.status, 'waiting');
  assert.equal(events.filter(event => event.eventName === 'attempt.observation_invalid').length, 1);
  const outcomeRefs = waiting.attempts[0].outcome.outputRefs;
  assert.deepEqual(outcomeRefs.map(({ providerRef, kind, source }) => ({ providerRef, kind, source })), [
    { providerRef: 'agent-exit', kind: 'agent_exit', source: 'host_observed' },
    { providerRef: 'claim', kind: 'observation', source: 'model_claim' },
  ]);
  const observed = waiting.events.flatMap(event => event.observations ?? []);
  assert.ok(outcomeRefs.every(pointer => observed.some(item => item.ref === pointer.ref && item.providerRef === pointer.providerRef)));
  await store.close();

  const reopened = createLocalStateStore(directory);
  t.after(() => reopened.close());
  await reopened.open();
  const resumed = setup({
    store: reopened, idPrefix: 'resumed-', now: () => now,
    respond(invocation, count, observe) {
      observe({
        ref: 'tool-exit', kind: 'provider_tool', sourceId: 'test-invocation', exitCode: 1,
        completeness: 'truncated', value: 'one failing test',
      });
      return final(invocation);
    },
  });
  now = 140;
  const finished = await (await resumed.api.resume(waiting.operationId, {
    requestId: 'user-answer', questionId: waiting.waiting.questionId, text: 'Yes',
  })).completion;
  const context = resumed.invocations[0].context;
  const byRef = ref => context.find(item => item.ref === ref);
  assert.deepEqual(byRef('request-1').provenance, { kind: 'user', sourceId: 'request-1', receivedAt: 100 });
  assert.deepEqual(byRef('user-answer').provenance, { kind: 'user', sourceId: 'user-answer', receivedAt: 140 });
  const agent = byRef(outcomeRefs[0].ref);
  const claim = byRef(outcomeRefs[1].ref);
  assert.equal(agent.attemptId, invocations[0].attemptId);
  assert.equal(agent.source, 'host_observed');
  assert.deepEqual(agent.provenance, {
    kind: 'host_transport', sourceId: 'agent-process', receivedAt: 110, exit: { kind: 'agent_exit', code: 0 },
  });
  assert.equal(claim.source, 'model_claim');
  assert.equal(claim.value, 'Tests passed');
  assert.equal(claim.provenance.receivedAt, 120);
  assert.equal(claim.provenance.sourceId, 'message-1');
  assert.equal(claim.provenance.exit, undefined);
  assert.deepEqual(agent.receivedSequence, { revision: 3, index: 0 });
  assert.deepEqual(claim.receivedSequence, { revision: 3, index: 1 });
  assert.equal(context.find(item => item.providerRef === 'legacy').source, 'provider_reported');
  assert.equal(context.find(item => item.providerRef === 'legacy').provenance.exit, undefined);
  assert.equal(context.find(item => item.providerRef === 'malformed'), undefined);
  const controllerOutput = byRef('controller-output:' + invocations[0].attemptId);
  assert.equal(controllerOutput.value.clarification.question, 'Run the requested test?');
  assert.equal(controllerOutput.provenance.kind, 'model');
  assert.ok(!context.some(item => item.provenance?.exit?.kind === 'tool_exit'));

  const loaded = await reopened.load(finished.operationId);
  const records = loaded.events.flatMap(event => event.observations ?? []);
  const tool = records.find(item => item.providerRef === 'tool-exit');
  assert.equal(tool.source, 'provider_reported');
  assert.equal(tool.value, 'one failing test');
  assert.equal(tool.completeness, 'truncated');
  assert.deepEqual(tool.provenance, {
    kind: 'provider_tool', sourceId: 'test-invocation', receivedAt: 140, exit: { kind: 'tool_exit', code: 1 },
  });
  assert.deepEqual(records.filter(item => item.provenance?.exit?.kind === 'tool_exit'), [tool]);
  assert.equal(invocations.length, 1);
  assert.equal(resumed.invocations.length, 1);
});


test('opposing findings and a model revision survive reopening alongside raw evidence', async t => {
  const { store, directory } = await setupStore(t);
  const profileIds = ['primary', 'left', 'right'];
  const authority = createAuthorityGrant({ reference: 'fixture-authority', origin: 'user', profileIds });
  const subject = 'src/example.js';
  const revise = {
    findingId: 'revision', author: 'primary', subject, claim: 'The two runs checked different inputs',
    supports: ['finding:left', 'finding:right'], uncertainties: ['The intended input is unclear'],
    supersedes: 'finding:left',
  };
  let controllers = 0;
  const { api, invocations } = setup({
    store, authority, maxInvocations: 5, maxConcurrentInvocations: 2,
    extraCatalog: profileIds.slice(1).map(profileId => ({
      kind: 'profile', value: { profileId, providerId: 'fixture', model: 'model-' + profileId },
    })),
    respond(invocation, count, observe) {
      if (invocation.kind === 'delegate') {
        const author = invocation.profile.profileId;
        const ref = 'raw-' + author;
        const value = author === 'left' ? 'failed' : 'passed';
        observe({ kind: 'provider_tool', sourceId: 'run-' + author, ref, completeness: 'complete', value });
        return {
          dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId), output: 'worker-' + author,
          findings: [{
            findingId: author, author, subject, claim: 'The check ' + value, supports: [ref], uncertainties: [],
          }],
        };
      }
      if (++controllers === 1) {
        const additions = profileIds.slice(1).map(id => ({
          actionId: id, kind: 'delegate', profileId: id, objective: 'Inspect', expectedResult: 'Finding',
          contextRefs: [], dependsOn: [],
        }));
        return final(invocation, {
          additions, finalAssessment: undefined,
          waitPolicy: { kind: 'all_requested', targets: additions.map(item => ({ kind: 'action', id: item.actionId })) },
        });
      }
      const available = invocation.context.filter(item => item.kind === 'finding');
      assert.deepEqual(available.map(item => item.value.claim).sort(), ['The check failed', 'The check passed']);
      assert.deepEqual(available.map(item => item.value.subject), [subject, subject]);
      assert.ok(available.every(item => item.source === 'model_claim' && item.provenance.sourceId === item.value.author));
      return final(invocation, {
        findings: [revise], finalAssessment: assessment({ findingRefs: ['finding:revision'], observationRefs: [invocation.context.find(item => item.providerRef === 'raw-left').ref] }),
      });
    },
  });
  const first = await (await api.submit(request())).completion;
  assert.equal(first.status, 'finished');
  assert.deepEqual(first.assessment.findingRefs, ['finding:revision']);
  assert.equal(invocations.length, 4);
  const wire = JSON.parse(encodeSnapshot(first));
  const index = wire.events.findIndex(event => event.decision?.findings?.length);
  wire.events[index].decision.findings[0].supersedes = 'finding:foreign';
  assert.equal(decodeSnapshot(JSON.stringify(wire)).reason.path, '$.events[' + index + '].decision.findings[0].supersedes');
  await store.close();

  const reopened = createLocalStateStore(directory);
  t.after(() => reopened.close());
  await reopened.open();
  const next = setup({
    store: reopened, authority, idPrefix: 'reopen-', maxInvocations: 5,
    respond: invocation => final(invocation, { finalAssessment: assessment({
      findingRefs: ['finding:left', 'finding:right', 'finding:revision'], answer: 'Both readings are relevant',
    }) }),
  });
  const resumed = await (await next.api.resume(first.operationId, { requestId: 'followup-findings', text: 'Reassess' })).completion;
  assert.equal(resumed.assessment.answer, 'Both readings are relevant');
  const delivered = new Map(next.invocations[0].context.map(item => [item.ref, item]));
  const revision = delivered.get('finding:revision');
  assert.deepEqual(revision.value, revise);
  assert.equal(revision.attemptId, invocations.at(-1).attemptId);
  assert.equal(delivered.get('finding:left').value.claim, 'The check failed');
  assert.equal(delivered.get('finding:right').value.claim, 'The check passed');
  assert.equal(next.invocations[0].context.find(item => item.providerRef === 'raw-left').value, 'failed');
  assert.equal(next.invocations[0].context.find(item => item.providerRef === 'raw-right').value, 'passed');
  assert.deepEqual(resumed.events.filter(event => event.kind === 'operation.finished').map(event => event.assessment.answer),
    [first.assessment.answer, 'Both readings are relevant']);
});

test('bound context fetch recovers artifacts and model summaries with raw coverage after reopening', async t => {
  const { directory, store } = await setupStore(t);
  const maxBytes = 1024;
  const raw = 'detail '.repeat(100);
  const bytes = Buffer.alloc(1400, 42);
  let ref;
  let missingRef;
  let rawRef;
  const first = setup({
    store, context: { maxBytes },
    async respond(invocation, count, observe) {
      ref = await invocation.contextAccess.captureArtifact(bytes);
      missingRef = await invocation.contextAccess.captureArtifact(Buffer.from('will be missing'));
      rawRef = observe({ kind: 'provider_report', ref: 'raw', sourceId: 'source', completeness: 'complete', value: raw });
      observe({ kind: 'model_summary', text: 'Model summary', coveredObservationRefs: ['raw', ref] });
      observe({ kind: 'model_summary', text: 'Foreign coverage', coveredObservationRefs: ['unknown-observation'] });
      return final(invocation);
    },
  });
  const original = await (await first.api.submit(request())).completion;
  assert.equal(original.status, 'finished');
  const records = original.events.flatMap(event => event.observations ?? []);
  const summary = records.find(item => item.summary);
  assert.equal(records.filter(item => item.summary).length, 1);
  assert.equal(summary.source, 'model_claim');
  assert.deepEqual(summary.summary, { author: 'primary', coveredObservationRefs: [rawRef, ref] });
  assert.equal(summary.value, 'Model summary');
  assert.equal(records.find(item => item.ref === rawRef).value, raw);
  const artifact = records.find(item => item.ref === ref);
  assert.equal(artifact.artifact.size, maxBytes);
  assert.equal(artifact.artifact.originalSize, bytes.length);
  assert.equal(artifact.completeness, 'truncated');
  const encoded = JSON.parse(encodeSnapshot(original));
  encoded.events.find(event => event.kind === 'attempt.outcome').observations
    .find(item => item.summary).summary.coveredObservationRefs = ['other-operation'];
  assert.match(decodeSnapshot(JSON.stringify(encoded)).reason.path, /\.summary\.coveredObservationRefs$/);
  const missing = records.find(item => item.ref === missingRef).artifact.ref.slice('sha256:'.length);
  await fs.unlink(join(directory, 'artifact-' + missing + '.blob'));
  await store.close();
  const reopened = createLocalStateStore(directory);
  t.after(() => reopened.close());
  await reopened.open();

  const accesses = [];
  const next = setup({ store: reopened, idPrefix: 'reopen-context-', maxInvocations: 4, context: { maxBytes },
    async respond(invocation, count) {
      const access = invocation.contextAccess;
      accesses.push(access);
      if (count === 1) {
        const result = await access.fetch(rawRef);
        assert.equal(result.item.value, raw);
        const foundSummary = await access.fetch(summary.ref);
        assert.equal(foundSummary.item.source, 'model_claim');
        assert.deepEqual(foundSummary.item.summary, summary.summary);
        const action = {
          actionId: 'inspect', kind: 'delegate', objective: 'Inspect output', expectedResult: 'A result',
          profileId: 'primary', contextRefs: [ref, missingRef], dependsOn: [],
        };
        return final(invocation, {
          additions: [action], finalAssessment: undefined,
          waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: 'inspect' }] },
        });
      }
      if (invocation.kind === 'delegate') {
        const result = await access.fetch(ref);
        assert.equal(result.kind, 'available');
        assert.equal(result.item.completeness, 'truncated');
        assert.deepEqual(result.bytes, bytes.subarray(0, maxBytes));
        assert.deepEqual(await access.fetch(missingRef), { kind: 'unavailable', reason: 'payload' });
        assert.deepEqual(await access.fetch(rawRef), { kind: 'unavailable', reason: 'denied' });
        return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId) };
      }
      return final(invocation);
    },
  });
  const continued = await next.api.resume(original.operationId, { requestId: 'retrieve-details', text: 'Read detail' });
  assert.equal((await continued.completion).status, 'finished');
  assert.equal(accesses.length, 3);
  assert.deepEqual(await accesses[1].fetch(ref), { kind: 'unavailable', reason: 'closed' });
});

test('cross-operation context reads require an exact share and cannot be enabled by a reported hash', async t => {
  const { store } = await setupStore(t);
  const content = Buffer.from('source artifact');
  let ref;
  const source = setup({ store, async respond(invocation) {
    ref = await invocation.contextAccess.captureArtifact(content);
    return final(invocation);
  } });
  const origin = await (await source.api.submit(request())).completion;
  assert.equal(origin.status, 'finished');
  const stored = origin.events.flatMap(event => event.observations ?? []).find(item => item.ref === ref).artifact;
  let allow = false;
  let reportRef;
  const target = setup({
    store, idPrefix: 'target-', maxInvocations: 2,
    allowContextShare: share => allow && share.sourceOperationId === origin.operationId &&
      share.targetOperationId.startsWith('target-') && share.ref === ref && share.profileId === 'primary',
    async respond(invocation, count, observe) {
      const access = invocation.contextAccess;
      if (count === 1) {
        reportRef = observe({ kind: 'provider_report', ref: 'model-reported-hash', sourceId: 'report', completeness: 'complete', value: stored });
        observe({ kind: 'provider_report', ref: 'forged', sourceId: 'report', completeness: 'complete', artifact: stored });
        return final(invocation);
      }
      assert.deepEqual(await access.fetch(ref, origin.operationId), { kind: 'unavailable', reason: 'denied' });
      assert.deepEqual(await access.fetch(ref), { kind: 'unavailable', reason: 'missing' });
      assert.deepEqual(await access.fetch('forged'), { kind: 'unavailable', reason: 'missing' });
      const report = await access.fetch(reportRef);
      assert.deepEqual(report.item.value, stored);
      assert.equal(report.bytes, undefined);
      allow = true;
      const shared = await access.fetch(ref, origin.operationId);
      assert.equal(shared.kind, 'available');
      assert.deepEqual(shared.bytes, content);
      assert.deepEqual(await access.fetch('request-1', origin.operationId), { kind: 'unavailable', reason: 'denied' });
      return final(invocation);
    },
  });
  const other = await (await target.api.submit(request({ requestId: 'another-operation' }))).completion;
  const resumed = await target.api.resume(other.operationId, { requestId: 'cross-operation-read', text: 'Read' });
  assert.equal((await resumed.completion).status, 'finished');
  assert.equal(target.invocations.length, 2);
});
