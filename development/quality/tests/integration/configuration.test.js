import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadProjectPreferences } from '../../../../src/adapters/configuration/project-file.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
import { createAuthorityGrant, createCatalog, decodeConfiguration, resolveConfiguration } from '../../../../src/main/index.js';
import { final, setup } from '../../fixtures/application.js';
import { request } from '../../fixtures/core.js';

const config = {
  schemaVersion: 1,
  providers: {
    agent: {
      adapter: 'acp', launch: { command: '/path/to/agent', env: { TOKEN: { fromEnv: 'AGENT_TOKEN' } } },
      nativeSettings: {},
    },
  },
  profiles: { primary: { provider: 'agent', model: 'configured-model' } },
  controllerProfile: 'primary',
  roles: { reviewer: { instructions: 'Review recorded evidence', preferredProfiles: ['primary'] } },
  resources: { maxConcurrentInvocations: 2, maxInvocationsPerOperation: 8, invocationTimeoutMs: 100 },
  storage: { directory: '/path/to/state' },
  diagnostics: { captureBodies: false },
  plugins: [], skills: [], tools: [],
};
const decode = (overrides = {}) => decodeConfiguration(JSON.stringify({ ...config, ...overrides }));

test('trusted configuration v1 validates without rewriting profile or secret references', async () => {
  assert.deepEqual(await decode(), { kind: 'accepted', value: config });
});

test('schema failures point to unknown keys, versions, missing controller and bad limits', async () => {
  const cases = [
    [{ extension: 'fixture' }, '/extension', 'additionalProperties'],
    [{ schemaVersion: 2 }, '/schemaVersion', 'const'],
    [{ controllerProfile: undefined }, '/controllerProfile', 'required'],
    [{ resources: { maxInvocationsPerOperation: 0 } }, '/resources/maxInvocationsPerOperation', 'minimum'],
    [{ resources: { invocationTimeoutMs: 2 ** 31 } }, '/resources/invocationTimeoutMs', 'maximum'],
    [{ context: { maxBytes: 0 } }, '/context/maxBytes', 'minimum'],
  ];
  for (const [overrides, path, constraint] of cases) {
    assert.deepEqual(await decode(overrides), { kind: 'rejected', reason: { code: 'INVALID_CONFIGURATION', path, constraint } });
  }
});

test('referential errors point to the actual declaration and reject prototype names', async () => {
  const cases = [
    [{ controllerProfile: 'constructor' }, '/controllerProfile'],
    [{ profiles: { primary: config.profiles.primary, 'unknown/provider': { provider: 'missing', model: 'other' } } },
      '/profiles/unknown~1provider/provider'],
    [{ roles: { reviewer: { instructions: 'Read', preferredProfiles: ['other'] } } }, '/roles/reviewer/preferredProfiles/0'],
  ];
  for (const [overrides, path] of cases) {
    assert.equal((await decode(overrides)).reason.path, path);
  }
});

test('invalid JSON and plaintext secret errors do not disclose input values', async () => {
  const secret = 'synthetic-private-token';
  const result = await decode({ providers: { agent: { adapter: 'acp', launch: { command: 'agent', env: { TOKEN: secret } } } } });
  assert.equal(result.reason.path, '/providers/agent/launch/env/TOKEN');
  assert.ok(!JSON.stringify(result).includes(secret));
  const malformed = await decodeConfiguration('{"TOKEN": "' + secret);
  assert.equal(malformed.reason.constraint, 'json');
  assert.ok(!JSON.stringify(malformed).includes(secret));
});

test('sources merge by field and project preferences cannot add authority', async () => {
  const { value } = await decode({
    profiles: { ...config.profiles, other: { provider: 'agent', model: 'another' } },
    skills: [{ id: 'check', source: '/path/to/instructions' }],
    context: { maxBytes: 2048 },
  });
  const project = JSON.stringify({
    schemaVersion: 1, controllerProfile: 'other', preferredRole: 'reviewer', preferredSkills: ['check'],
    resources: { maxConcurrentInvocations: 1, maxInvocationsPerOperation: 5 },
  });
  const merged = resolveConfiguration(value, project, { resources: { invocationTimeoutMs: 200 } });
  assert.equal(merged.value.controllerProfile, 'other');
  assert.equal(merged.value.preferredRole, 'reviewer');
  assert.deepEqual(merged.value.preferredSkills, ['check']);
  assert.deepEqual(merged.value.resources, {
    maxConcurrentInvocations: 1, maxInvocationsPerOperation: 5, invocationTimeoutMs: 200,
  });
  assert.deepEqual(merged.value.context, { maxBytes: 2048 });
  const launchWins = resolveConfiguration(value, project, { controllerProfile: 'primary', preferredSkills: [] });
  assert.equal(launchWins.value.controllerProfile, 'primary');
  assert.deepEqual(launchWins.value.preferredSkills, []);

  for (const key of ['providers', 'plugins', 'authority', 'storage', 'context']) {
    const result = resolveConfiguration(value, JSON.stringify({ schemaVersion: 1, [key]: 'synthetic' }));
    assert.equal(result.kind, 'rejected');
    assert.equal(result.path, '$.' + key);
    assert.equal(result.source, 'project');
  }
  const elevated = resolveConfiguration(value, JSON.stringify({
    schemaVersion: 1, resources: { maxConcurrentInvocations: 3 },
  }), { resources: { maxConcurrentInvocations: 4 } });
  assert.deepEqual(elevated, {
    kind: 'rejected', source: 'project', path: '$.resources.maxConcurrentInvocations', constraint: 'no-increase',
  });
});

test('project discovery stays within the explicitly selected directory', async () => {
  await withOwnedRun('project-config', async directory => {
    const child = resolve(directory, 'child');
    await mkdir(child);
    const parentConfig = resolve(directory, '.role-orchestrator.json');
    await writeFile(parentConfig, '{"schemaVersion":1}');
    assert.equal((await loadProjectPreferences({})).kind, 'absent');
    assert.equal((await loadProjectPreferences({ cwd: child })).kind, 'absent');
    assert.equal((await loadProjectPreferences({ cwd: child, path: parentConfig })).kind, 'available');
    assert.equal((await loadProjectPreferences({ cwd: child, path: 'missing.json' })).kind, 'unavailable');
    await writeFile(resolve(child, '.role-orchestrator.json'), '{}');
    assert.deepEqual(await loadProjectPreferences({ cwd: child }), { kind: 'available', text: '{}' });
  });
});

test('catalog snapshots two models on one port and exposes capability provenance without native settings', async () => {
  const { value } = await decode({
    profiles: { ...config.profiles, other: { provider: 'agent', model: 'another' } },
  });
  const capability = { support: 'supported', source: 'negotiated' };
  const catalog = createCatalog(value, [{ providerId: 'agent', capabilities: { 'input.image': capability }, maxConcurrency: 2 }]);
  value.profiles.primary.model = 'changed';
  capability.support = 'unsupported';
  const primary = await catalog.resolve('profile', 'primary');
  const other = await catalog.resolve('profile', 'other');
  assert.equal(primary.value.model, 'configured-model');
  assert.equal(other.value.model, 'another');
  assert.equal(primary.value.providerId, other.value.providerId);
  assert.deepEqual(primary.value.capabilities['input.image'], { support: 'supported', source: 'negotiated' });
  assert.equal(await catalog.resolve('profile', 'constructor'), undefined);
  assert.throws(() => { primary.value.model = 'mutated'; }, TypeError);
  assert.ok(!JSON.stringify(await catalog.list()).includes('AGENT_TOKEN'));
});

test('a mandatory image capability is checked before open, while optional metadata can remain unknown', async () => {
  let opened = 0;
  const image = { ref: 'image-1', mediaType: 'image/png' };
  const missing = setup({
    open() { opened++; },
    capabilities: { 'input.image': { support: 'unsupported', source: 'negotiated' } },
  });
  const submission = await missing.api.submit(request({ attachments: [image] }));
  const unavailable = await submission.completion;
  assert.equal(unavailable.waiting.reason.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(unavailable.attempts[0].dispatchCertainty, 'not_sent');
  assert.equal(opened, 0);
  assert.equal(missing.invocations.length, 0);

  const available = setup({
    capabilities: {
      'input.image': { support: 'supported', source: 'configured' },
      'usage': { support: 'unknown', source: 'configured' },
    },
  });
  const successful = await (await available.api.submit(request({ attachments: [image] }))).completion;
  assert.equal(successful.status, 'finished');
  assert.deepEqual(available.invocations[0].attachments, [image]);
  assert.equal(successful.attempts[0].outcome.usage.cost, null);
});

test('a revoked authority during open prevents dispatch and closes the acquired session', async () => {
  const authority = createAuthorityGrant({ reference: 'grant', origin: 'user', profileIds: ['primary'] });
  const opened = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { api, invocations, closed } = setup({
    authority, async open() { opened.resolve(); await release.promise; },
  });
  const submission = await api.submit(request());
  await opened.promise;
  authority.revoke();
  release.resolve();
  const state = await submission.completion;
  assert.equal(state.waiting.reason.code, 'REVOKED');
  assert.equal(state.attempts[0].dispatchCertainty, 'not_sent');
  assert.equal(invocations.length, 0);
  assert.equal(closed.length, 1);
});

test('a known profile without a trusted grant cannot open an invocation', async () => {
  const authority = createAuthorityGrant({ reference: 'grant', origin: 'provider', profileIds: ['other'] });
  let opened = 0;
  const { api, invocations } = setup({ authority, open() { opened++; } });
  const state = await (await api.submit(request())).completion;
  assert.equal(state.waiting.reason.code, 'PERMISSION_DENIED');
  assert.equal(state.attempts[0].outcome.effect, 'none');
  assert.equal(invocations.length, 0);
  assert.equal(opened, 0);
});

test('workspace files and Git state can change during a live attempt without invalidation', { timeout: 4000 }, async () => {
  await withOwnedRun('workspace-drift', async (cwd, run) => {
    function git(...args) {
      const result = run('git', args, { cwd });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
    const file = resolve(cwd, 'example.js');
    git('init', '-q');
    await writeFile(file, 'export const value = 1;');
    git('add', 'example.js');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--no-gpg-sign', '-qm', 'synthetic fixture');
    const started = Promise.withResolvers();
    const proceed = Promise.withResolvers();
    const { api, invocations, cancellations } = setup({ async respond(invocation) {
      started.resolve();
      await proceed.promise;
      return final(invocation);
    } });
    const submission = await api.submit(request({ workspaceContext: { cwd } }));
    await started.promise;
    try {
      git('switch', '-qc', 'other-branch');
      await writeFile(file, 'export const value = 2;');
      git('add', 'example.js');
      await writeFile(file, 'export const value = 3;');
    } finally {
      proceed.resolve();
    }
    const finished = await submission.completion;
    assert.equal(finished.status, 'finished');
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].authorityRef, 'fixture-authority');
    assert.deepEqual(cancellations, []);
  });
});
