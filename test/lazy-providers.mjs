import assert from 'node:assert/strict';
import { createModelRegistry } from '../src/models.mjs';
import { CodexCliProvider } from '../src/providers/codex-cli.mjs';
import { normalizeCapabilities } from '../src/providers/provider.mjs';

// The test must run without the optional ACP SDK installed. In particular,
// resolving a role must not import an unselected provider or start any process.
const config = {
  providers: {
    local: { adapter: 'codex-cli', models: ['fake-local'] },
    codex: { adapter: 'codex-acp', models: ['remote'] },
    remote: { adapter: 'acp-agent', command: '/this/path/does/not/exist', workspaceModes: { readOnly: 'read', write: 'write' }, models: ['remote'] },
  },
  profiles: {
    local: { provider: 'local', model: 'fake-local' },
    codex: { provider: 'codex', model: 'remote' },
    remote: { provider: 'remote', model: 'remote' },
  },
  roles: { router: 'local', investigator: 'codex', coderHigh: 'remote' },
};
const registry = createModelRegistry(config);
try {
  const cli = registry.resolveRole('router');
  assert.deepEqual(cli.capabilities, new CodexCliProvider('local', config.providers.local).capabilities());
  const codex = registry.resolveRole('investigator');
  assert.equal(codex.capabilities.images, true);
  assert.equal(codex.capabilities.mcp.http, true);
  const generic = registry.resolveRole('coderHigh');
  assert.equal(generic.capabilities.workspaceModes.write, true);
  assert.equal(generic.capabilities.images, false);
  assert.equal(generic.capabilities.permissions, false);
  assert.equal(generic.capabilities.resourceLinks, true);
  assert.deepEqual(await registry.listModels('local'), ['fake-local']);
  // Metadata access must preserve stable references for preset materialization.
  assert.strictEqual(registry.resolveRole('investigator').provider, codex.provider);
  assert.deepEqual(normalizeCapabilities(codex.capabilities), codex.capabilities);
} finally {
  await registry.close(); // No unselected ACP dependency should be imported on close.
}

const bridgeRegistry = createModelRegistry(config, { requestPermission: async () => {} });
try {
  assert.equal(bridgeRegistry.resolveRole('coderHigh').capabilities.permissions, true);
} finally { await bridgeRegistry.close(); }
assert.throws(() => createModelRegistry({ ...config, roles: { router: 'missing' } }).resolveRole('router'), /unknown profile/i);
assert.throws(() => createModelRegistry({ ...config, providers: { other: { adapter: 'not-real' } }, roles: { router: 'other' }, profiles: { other: { provider: 'other', model: 'some' } } }).resolveRole('router'), /unsupported provider adapter/i);
console.log('lazy-providers: passed (sync metadata, selected import, unused ACP provider isolation, lifecycle)');
