import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeConfiguration, loadExtensions, resolveConfiguration } from '../../../../src/main/index.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const config = {
  schemaVersion: 1,
  providers: { base: { adapter: 'codex-cli' }, broken: { adapter: 'test-plugin' } },
  profiles: { primary: { provider: 'base', model: 'fixture' }, secondary: { provider: 'broken', model: 'fixture' } },
  controllerProfile: 'primary',
};

test('project cannot add executable extensions or override trusted provider settings', async () => {
  const { value } = await decodeConfiguration(JSON.stringify(config));
  for (const key of ['plugins', 'providers', 'tools']) {
    assert.deepEqual(resolveConfiguration(value, JSON.stringify({ schemaVersion: 1, [key]: [] })),
      { kind: 'rejected', source: 'project', path: '$.' + key, constraint: 'a supported field' });
  }
});

test('load failures are local and failed initialization unwinds registered resources', () =>
  withOwnedRun('C09-extensions', async directory => {
    const log = join(directory, 'log');
    await writeFile(join(directory, 'disabled.mjs'), "throw new Error('must never load')");
    await writeFile(join(directory, 'plugin.mjs'), `
      import { appendFile } from 'node:fs/promises';
      export const manifest = { id: 'test-plugin', version: '1', apiVersion: 1, exports: ['createProvider'] };
      export function createProvider({ onClose }) {
        onClose(() => appendFile(${JSON.stringify(log)}, 'first\\n'));
        onClose(() => appendFile(${JSON.stringify(log)}, 'second\\n'));
        return {};
      }
    `);
    const events = [];
    let sequence = 0;
    const decoded = await decodeConfiguration(JSON.stringify({ ...config, plugins: [
      { id: 'missing', module: './missing.mjs' },
      { id: 'disabled', module: './disabled.mjs', enabled: false },
      { id: 'test-plugin', module: './plugin.mjs' },
      { id: 'collision', module: './missing.mjs' }, { id: 'collision', module: './missing.mjs' },
    ] }));
    assert.equal(decoded.kind, 'accepted');
    const extensions = await loadExtensions(decoded.value, {
      directory, clock: { now: Date.now }, ids: { newId: () => String(++sequence) },
      diagnostics: { emit: event => { events.push(event); }, flush() {} },
    });
    try {
      assert.equal(await readFile(log, 'utf8'), 'second\nfirst\n');
      assert.equal(extensions.unavailableProvider('broken'), 'INVALID_PROVIDER');
      assert.ok(extensions.providerFor({ providerId: 'base' }));
      assert.equal(extensions.providerFor({ providerId: 'broken' }), undefined);
      assert.ok(events.some(event => event.details.id === 'missing' && event.reasonCode === 'PLUGIN_IMPORT_FAILED'));
      assert.ok(events.some(event => event.details.id === 'collision' && event.reasonCode === 'DUPLICATE_EXTENSION_ID'));
      assert.ok(events.every(event => event.details.id !== 'disabled'));
    } finally {
      await extensions.close();
    }
    assert.equal(await readFile(log, 'utf8'), 'second\nfirst\n');
  }));

test('Controller discovers and selects a plugin profile through the normal delegate path', async () => {
  const { randomUUID } = await import('node:crypto');
  const { fileURLToPath } = await import('node:url');
  const { createAuthorityGrant } = await import('../../../../src/main/index.js');
  const { final, setup } = await import('../../fixtures/application.js');
  const { request } = await import('../../fixtures/core.js');
  const extensions = await loadExtensions({
    ...config,
    providers: { ...config.providers, broken: { adapter: 'fixture-echo' } },
    plugins: [{ id: 'fixture-echo', module: fileURLToPath(new URL('../../fixtures/echo-plugin.js', import.meta.url)) }],
  }, { clock: { now: Date.now }, ids: { newId: randomUUID } });
  try {
    const { value: profile } = await extensions.catalog.resolve('profile', 'primary');
    const { api } = setup({
      profile, catalog: extensions.catalog, providerFor: extensions.providerFor,
      authority: createAuthorityGrant({ origin: 'user', reference: 'fixture-authority', profileIds: ['primary', 'secondary'] }),
      respond(invocation, count) {
        if (count === 1) {
          const entry = invocation.context[1].value.catalog.find(item => item.value.profileId === 'secondary');
          assert.equal(entry.value.capabilities['fixture.echo'].support, 'supported');
          return final(invocation, {
            finalAssessment: undefined, additions: [{
              kind: 'delegate', actionId: 'echo', profileId: entry.value.profileId, objective: 'success',
              contextRefs: [], dependsOn: [], expectedResult: 'echo', requiredCapabilities: ['fixture.echo'],
            }], waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: 'echo' }] },
          });
        }
        const result = invocation.context.find(item => item.ref.startsWith('attempt-output:'));
        assert.match(result.value, /^result id-/);
        return final(invocation);
      },
    });
    const completed = await (await api.submit(request())).completion;
    assert.equal(completed.status, 'finished');
    assert.equal(completed.attempts.find(attempt => attempt.actionId === 'echo').route.providerId, 'broken');
  } finally {
    await extensions.close();
  }
});
