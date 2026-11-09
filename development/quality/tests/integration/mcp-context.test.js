import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAuthorityGrant, createPermissionBroker, loadExtensions } from '../../../../src/main/index.js';
import { createLocalStateStore } from '../../../../src/adapters/state/local-store.js';
import { final, setup } from '../../fixtures/application.js';
import { request } from '../../fixtures/core.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const fixture = name => fileURLToPath(new URL('../../fixtures/' + name, import.meta.url));
const options = { skip: process.platform !== 'linux', timeout: 12_000 };

for (const adapter of ['codex-cli', 'acp']) {
  test(adapter + ' retrieves omitted evidence through live MCP and cites it in the assessment', options, () =>
    withOwnedRun('C09-mcp-' + adapter, async cwd => {
      const directory = join(cwd, 'state');
      await mkdir(directory);
      const store = createLocalStateStore(directory);
      await store.open();
      const config = {
        schemaVersion: 1, controllerProfile: 'primary',
        profiles: { primary: { provider: 'fixture', model: 'fixture' } },
        providers: { fixture: { adapter, mcpBridge: true, launch: { command: process.execPath,
          args: adapter === 'acp' ? [fixture('acp-contract-agent.js'), 'mcp'] : [fixture('codex-mcp-child.js')] } } },
        plugins: [{ id: 'fixture-tools', module: fixture('tools-plugin.js') }],
        tools: [{ id: 'echo_text' }],
      };
      const extensions = await loadExtensions(config, { clock: { now: Date.now }, ids: { newId: randomUUID } });
      try {
        const seed = setup({
          store,
          async respond(invocation, _, observe) {
            observe({ ref: 'seed', kind: 'host_transport', sourceId: 'fixture', completeness: 'complete', value: 'retrievable-evidence' });
            assert.ok(await invocation.contextAccess.captureArtifact(Buffer.alloc(4096)));
            for (let n = 0; n < 5; n++) {
              observe({ ref: 'noise-' + n, kind: 'host_transport', sourceId: 'fixture', completeness: 'complete', value: 'x'.repeat(600) });
            }
            return final(invocation);
          },
        });
        const first = await (await seed.api.submit(request({ workspaceContext: { cwd } }))).completion;
        assert.equal(first.status, 'finished');
        const { value: profile } = await extensions.catalog.resolve('profile', 'primary');
        assert.equal(profile.capabilities['context.retrieval'].support, adapter === 'acp' ? 'unknown' : 'supported');
        const authority = createAuthorityGrant({ reference: 'fixture-authority', origin: 'user', profileIds: ['primary'] });
        const permissions = createPermissionBroker({
          authority, ids: { newId: randomUUID },
          standing: [{ profileId: 'primary', resource: 'fixture:echo', optionId: 'allow', kind: 'allow' }],
        });
        const { api } = setup({
          store, idPrefix: 'mcp-', profile, provider: extensions.providerFor(profile), catalog: extensions.catalog,
          context: { maxBytes: 512 }, maxInvocations: 4, authority, permissions, tools: extensions.tools,
        });
        const resumed = await (await api.resume(first.operationId, { requestId: 'follow-up', text: 'Retrieve evidence' })).completion;
        assert.equal(resumed.status, 'finished',
          JSON.stringify(resumed.events.findLast(event => event.kind === 'attempt.outcome')));
        assert.equal(resumed.assessment.answer, 'retrievable-evidence');
        assert.equal(resumed.attempts.length, 2);
        const evidence = resumed.events.flatMap(event => event.observations ?? []);
        assert.equal(evidence.find(item => item.ref === resumed.assessment.observationRefs[0]).providerRef, 'seed');
        const tool = evidence.find(item => item.ref === resumed.assessment.observationRefs[1]);
        assert.equal(tool.provenance.sourceId, 'echo_text');
        assert.equal(tool.source, 'host_observed');
        assert.equal(evidence.filter(item => item.provenance?.sourceId === 'echo_text').length, 1);
        assert.equal(tool.value.attemptId, resumed.attempts[1].attemptId);
        assert.equal(tool.value.output, 'from live MCP');
        const url = await readFile(join(cwd, 'mcp-url'), 'utf8');
        await assert.rejects(fetch(url), TypeError);
      } finally {
        await extensions.close();
        await store.close();
      }
    }));
}
