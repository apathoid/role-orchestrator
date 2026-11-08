import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalStateStore } from '../../../../src/adapters/state/local-store.js';
import { encodeSnapshot } from '../../../../src/core/snapshot.js';
import { decodeConfiguration, resolveConfiguration } from '../../../../src/main/index.js';
import { final, setup } from '../../fixtures/application.js';
import { assessment, outcome, request } from '../../fixtures/core.js';

async function fixture(t, io) {
  const directory = await mkdtemp(join(tmpdir(), 'role-orchestrator-retention-'));
  const store = createLocalStateStore(directory, io);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.open();
  return { directory, store };
}

const observations = state => state.events.flatMap(event => event.observations ?? []);
const descriptor = (state, ref) => observations(state).find(item => item.ref === ref).artifact;

test('retention preserves the evidence chain and protects unfinished or unresolved operations', async t => {
  const { store } = await fixture(t);
  const policy = { maxBytes: 3 };
  const config = await decodeConfiguration(JSON.stringify({
    schemaVersion: 1, providers: { fixture: { adapter: 'test' } },
    profiles: { primary: { provider: 'fixture', model: 'test' } }, controllerProfile: 'primary',
    storage: { directory: '/state', artifactRetention: policy },
  }));
  assert.equal(config.kind, 'accepted');
  const effective = resolveConfiguration(config.value).value.storage.artifactRetention;
  assert.deepEqual(effective, policy);
  let oldRef;
  let sharedRef;
  let recentRef;
  let unknownRef;
  let now = 100;
  const { api } = setup({ store, now: () => now, async respond(invocation) {
    const capture = text => invocation.contextAccess.captureArtifact(Buffer.from(text));
    if (invocation.objective === 'old') {
      oldRef = await capture('old');
      sharedRef = await capture('shared');
      return final(invocation, {
        findings: [{ findingId: 'old', author: 'primary', subject: 'artifact', claim: 'Output was recorded',
          supports: [oldRef, sharedRef], uncertainties: [] }],
        finalAssessment: assessment({ findingRefs: ['finding:old'] }),
      });
    }
    if (invocation.objective === 'recent') {
      recentRef = await capture('new');
      return final(invocation);
    }
    if (invocation.objective === 'finished-possible') {
      await capture('shared');
      return { ...final(invocation), outcome: outcome(invocation.attemptId, { effect: 'possible' }) };
    }
    unknownRef = await capture('unresolved bytes');
    return { dispatchCertainty: 'unknown', outcome: outcome(invocation.attemptId, { terminal: 'unknown', effect: 'unknown' }) };
  } });
  const old = await (await api.submit(request({ requestId: 'old', text: 'old' }))).completion;
  now = 200;
  const recent = await (await api.submit(request({ requestId: 'recent', text: 'recent' }))).completion;
  now = 250;
  const possible = await (await api.submit(request({ requestId: 'possible', text: 'finished-possible' }))).completion;
  assert.equal(possible.status, 'finished');
  assert.equal(possible.attempts[0].outcome.effect, 'possible');
  now = 300;
  const unknown = await (await api.submit(request({ requestId: 'unknown', text: 'unknown' }))).completion;
  assert.equal(unknown.status, 'waiting');
  assert.equal(unknown.attempts[0].outcome.effect, 'unknown');
  const initial = await api.inspectFinding(old.operationId, 'finding:old');
  assert.deepEqual(initial.map(item => item.ref), ['finding:old', oldRef, sharedRef]);
  assert.equal(initial[1].artifactPresence, 'present');
  assert.equal(initial[1].attempt.attemptId, old.attempts[0].attemptId);
  assert.deepEqual(initial[1].recordedOutcome, initial[1].attempt.outcome);

  await store.close();
  await store.open(effective);
  assert.equal(encodeSnapshot(await store.load(old.operationId)), encodeSnapshot(old));
  assert.equal(encodeSnapshot(await store.load(unknown.operationId)), encodeSnapshot(unknown));
  const history = await api.inspectFinding(old.operationId, 'finding:old');
  assert.equal(history[1].artifactPresence, 'retention');
  assert.deepEqual(history[0].item.value, initial[0].item.value);
  assert.equal(history[2].artifactPresence, 'present');
  assert.equal(await store.artifactPresence(descriptor(recent, recentRef)), 'present');
  assert.equal(await store.artifactPresence(descriptor(unknown, unknownRef)), 'present');
  assert.deepEqual(await store.readArtifact(descriptor(old, oldRef), 3), { kind: 'unavailable', reason: 'retention' });

  const next = setup({ store, idPrefix: 'retained-', context: { maxBytes: 1 }, async respond(invocation) {
    assert.deepEqual(await invocation.contextAccess.fetch(oldRef), { kind: 'unavailable', reason: 'retention' });
    return final(invocation);
  } });
  const resumed = await next.api.resume(old.operationId, { requestId: 'follow', text: 'Inspect retained evidence' });
  assert.equal((await resumed.completion).status, 'finished');
  await assert.rejects(api.inspectFinding(recent.operationId, 'finding:old'), { path: '$.findingRef' });
});

test('age cleanup skips unknown ownership and retries unlink without reporting present bytes as retained', async t => {
  let failUnlink = true;
  const { directory, store } = await fixture(t, {
    ...fs,
    async unlink(path) {
      if (failUnlink && path.endsWith('.blob')) throw new Error('injected unlink failure');
      await unlink(path);
    },
  });
  let ref;
  const { api } = setup({ store, async respond(invocation) {
    ref = await invocation.contextAccess.captureArtifact(Buffer.from('eligible'));
    return final(invocation);
  } });
  const operation = await (await api.submit(request())).completion;
  const artifact = descriptor(operation, ref);
  const unlinked = await store.writeArtifact(Buffer.from('no receipt'), 10);
  const corrupt = join(directory, 'a'.repeat(64) + '.json');
  await store.close();
  await writeFile(corrupt, '{broken');
  await store.open({ maxAgeMs: 0 });
  assert.equal(await store.artifactPresence(artifact), 'present');
  assert.ok(!(await fs.readdir(directory)).some(name => name.endsWith('.retention')));
  await store.close();
  await unlink(corrupt);
  await store.open({ maxAgeMs: 0 });
  assert.equal(await store.artifactPresence(artifact), 'present');
  assert.equal((await store.readArtifact(artifact, 10)).kind, 'available');
  await store.close();
  failUnlink = false;
  await store.open({ maxAgeMs: 0 });
  assert.equal(await store.artifactPresence(artifact), 'retention');
  assert.equal(await store.artifactPresence(unlinked), 'present');
  await store.writeArtifact(Buffer.from('eligible'), 8);
  assert.equal(await store.artifactPresence(artifact), 'present');
});
