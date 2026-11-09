import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAuthorityGrant, decodeConfiguration, loadExtensions } from '../../../../src/main/index.js';
import { createLocalStateStore } from '../../../../src/adapters/state/local-store.js';
import { assessment, request } from '../../fixtures/core.js';
import { final, setup } from '../../fixtures/application.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const runtime = { clock: { now: Date.now }, ids: { newId: randomUUID } };
const fixture = name => fileURLToPath(new URL('../../fixtures/' + name, import.meta.url));
const echo = { id: 'fixture-echo', module: fixture('echo-plugin.js') };
const skills = { id: 'fixture-skills', module: fixture('skills-plugin.js') };
const configuration = {
  schemaVersion: 1, controllerProfile: 'primary',
  providers: { base: { adapter: 'codex-cli' }, echo: { adapter: 'fixture-echo' } },
  profiles: { primary: { provider: 'base', model: 'fixture' }, echo: { provider: 'echo', model: 'fixture' } },
  plugins: [echo, skills], skills: [{ id: 'guide', source: 'fixture-skills' }],
};
const project = fields => JSON.stringify({ schemaVersion: 1, ...fields });
const localFailure = (path, constraint) => ({ kind: 'rejected', source: 'project', path, constraint });

test('project selection resolves installed extensions and the Controller sees preferences', async () => {
  const extensions = await loadExtensions(configuration, { ...runtime, projectText: project({ preferredSkills: ['guide'] }) });
  try {
    assert.equal(extensions.selection.kind, 'accepted');
    const controller = await extensions.selectController();
    assert.equal(controller.kind, 'available');
    const { api, invocations } = setup({ profile: controller.profile, catalog: extensions.catalog });
    assert.equal((await (await api.submit(request())).completion).status, 'finished');
    assert.deepEqual(invocations[0].context[1].value.preferences, { roleId: undefined, skillIds: ['guide'] });
  } finally {
    await extensions.close();
  }
  for (const [fields, expected] of [
    [{ preferredSkills: ['guide'] }, localFailure('$.preferredSkills[0]', 'available-skill')],
    [{ controllerProfile: 'echo' }, localFailure('$.controllerProfile', 'available-profile')],
    [{ plugins: [{ id: 'attack', module: './unsafe.js' }] }, localFailure('$.plugins', 'a supported field')],
  ]) {
    const current = await loadExtensions({ ...configuration, plugins: [] }, { ...runtime, projectText: project(fields) });
    try {
      assert.deepEqual(current.selection, expected);
      assert.equal((await current.selectController()).reason, 'PREFERENCES_REJECTED');
      assert.equal((await current.selectController('primary')).kind, 'available');
    } finally {
      await current.close();
    }
  }
});

test('major version is local to a plugin and optional v1 fields preserve the original config', () =>
  withOwnedRun('C09-version', async directory => {
    await writeFile(join(directory, 'future.mjs'), "export const manifest = { id: 'fixture-echo', version: '2', apiVersion: 2, exports: ['createProvider'] };");
    const old = await decodeConfiguration(JSON.stringify(configuration));
    assert.equal(old.kind, 'accepted');
    const { kind, value } = await decodeConfiguration(JSON.stringify({
      ...configuration, controllerProfile: 'echo',
      providers: { ...configuration.providers, base: { adapter: 'codex-cli', mcpBridge: false } },
      plugins: [{ id: echo.id, module: './future.mjs', enabled: true }],
    }));
    assert.equal(kind, 'accepted');
    const extensions = await loadExtensions(value, { ...runtime, directory });
    try {
      assert.deepEqual(await extensions.selectController(),
        { kind: 'unavailable', profileId: 'echo', reason: 'UNSUPPORTED_PLUGIN_API' });
      assert.equal((await extensions.selectController('primary')).kind, 'available');
      assert.equal((await extensions.catalog.resolve('profile', 'echo')).value.unavailable, 'UNSUPPORTED_PLUGIN_API');
    } finally {
      await extensions.close();
    }
    const newer = await decodeConfiguration(JSON.stringify({ ...configuration, schemaVersion: 2 }));
    assert.equal(newer.kind, 'rejected');
    assert.equal(newer.reason.path, '/schemaVersion');
  }));

function propose(invocation, actionId) {
  return final(invocation, {
    finalAssessment: undefined,
    additions: [{ kind: 'delegate', actionId, profileId: 'echo', objective: 'success',
      expectedResult: 'echo', contextRefs: [], dependsOn: [] }],
    waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: actionId }] },
  });
}

for (const remove of [false, true]) {
  test((remove ? 'uninstall' : 'disable') + ' on resume keeps prior findings and rejects only new work for that profile', () =>
    withOwnedRun('C09-resume-extension', async cwd => {
      const directory = join(cwd, 'state');
      await mkdir(directory);
      const store = createLocalStateStore(directory);
      const authority = createAuthorityGrant({ reference: 'fixture-authority', origin: 'user', profileIds: ['primary', 'echo'] });
      await store.open();
      const old = await loadExtensions(configuration, runtime);
      try {
        const controller = await old.selectController();
        const { api } = setup({
          store, authority, profile: controller.profile, catalog: old.catalog, providerFor: old.providerFor, maxInvocations: 6,
          respond(invocation, count) {
            if (count === 1) return propose(invocation, 'original-worker');
            const evidence = invocation.context.find(item => item.ref.startsWith('attempt-output:'));
            return final(invocation, {
              findings: [{ findingId: 'durable', author: 'primary', claim: 'Echo result', subject: 'echo',
                supports: [evidence.ref], uncertainties: [] }],
              finalAssessment: assessment({ findingRefs: ['finding:durable'] }),
            });
          },
        });
        const original = await (await api.submit(request())).completion;
        assert.equal(original.status, 'finished');
        const finding = await api.inspectFinding(original.operationId, 'finding:durable');
        assert.equal(finding[0].item.value.claim, 'Echo result');
        await old.close();
        await store.close();
        await store.open();

        const current = await loadExtensions({ ...configuration, plugins: remove ? [] : [{ ...echo, enabled: false }] }, runtime);
        try {
          const route = await current.selectController();
          assert.equal(route.kind, 'available');
          const resumed = setup({
            store, authority, profile: route.profile, catalog: current.catalog, providerFor: current.providerFor,
            configurationRef: 'changed-config', idPrefix: 'resumed-', maxInvocations: 6,
            respond(invocation, count) {
              assert.equal(invocation.context.find(item => item.ref === 'finding:durable').value.claim, 'Echo result');
              if (count === 1) {
                assert.ok(invocation.context[1].value.catalog.find(item => item.value.profileId === 'echo').value.unavailable);
                return propose(invocation, 'disabled-worker');
              }
              return final(invocation, { finalAssessment: assessment({ findingRefs: ['finding:durable'] }) });
            },
          });
          const finished = await (await resumed.api.resume(original.operationId, { requestId: 'resume', text: 'Continue' })).completion;
          assert.equal(finished.status, 'finished');
          assert.equal(finished.events.find(item => item.kind === 'action.rejected' && item.actionId === 'disabled-worker').code,
            'CAPABILITY_UNAVAILABLE');
          assert.ok(!finished.attempts.some(attempt => attempt.actionId === 'disabled-worker'));
          assert.deepEqual(await resumed.api.inspectFinding(original.operationId, 'finding:durable'), finding);
        } finally {
          await current.close();
        }
      } finally {
        await old.close();
        await store.close();
      }
    }));
}
