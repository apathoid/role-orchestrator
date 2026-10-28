import assert from 'node:assert/strict';
import { createModelRegistry } from '../src/models.mjs';
import { applySessionProfileOverrides, ensureSessionConfigState, setSessionConfigOption, SESSION_CONFIG_IDS } from '../src/session-config.mjs';
import { ROLE_NAMES, validateRolePresets } from '../src/role-presets.mjs';

const config = validateRolePresets({
  providers: {
    cloud: { adapter: 'codex-cli', models: ['low', 'high'] },
    custom: { adapter: 'acp-agent', command: '/does-not-run', workspaceModes: { readOnly: 'read-only', write: 'write' }, models: ['local'] },
  },
  profiles: {
    low: { provider: 'cloud', model: 'low', reasoningEffort: 'low' },
    high: { provider: 'cloud', model: 'high', reasoningEffort: 'high' },
    local: { provider: 'custom', model: 'local', reasoningEffort: 'medium' },
  },
  roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, 'low'])),
  rolePresets: [{ id: 'mixed', label: 'Mixed', roles: { coderHigh: 'high', investigator: 'local' } }],
});
const session = {};
ensureSessionConfigState(session, config, { newSession: true });
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'mixed');
const workflowConfig = applySessionProfileOverrides(config, session);
const registry = createModelRegistry(workflowConfig);
try {
  assert.deepEqual(
    [registry.resolveRole('router').profile.model, registry.resolveRole('coderHigh').profile.model, registry.resolveRole('investigator').profile.model],
    ['low', 'high', 'local'],
  );
  assert.equal(registry.resolveRole('investigator').providerName, 'custom');
  assert.equal(registry.resolveRole('coderHigh').profile.reasoningEffort, 'high');
  assert.equal(registry.resolveRole('coderHigh').profileName, 'high');
  assert.throws(() => setSessionConfigOption(config, session, 'orchestrator_role_model_coderHigh', 'low'), /Unknown session config option/);
  assert.equal(registry.resolveRole('coderHigh').profile.model, 'high', 'in-flight workflow is stable');
  const next = createModelRegistry(applySessionProfileOverrides(config, session));
  try { assert.equal(next.resolveRole('coderHigh').profile.model, 'high'); }
  finally { await next.close(); }
} finally {
  await registry.close();
}
// An inline model ID (even absent from a provider.models catalog) reaches the
// actual registry unchanged. A full inline assignment can switch provider,
// without carrying old provider options into the new one.
const inlineConfig = {
  ...config,
  rolePresets: [{ id: 'direct', label: 'Direct', roles: {
    coderHigh: { model: 'not-in-catalog', reasoningEffort: 'medium' },
    investigator: { provider: 'custom', model: 'local-inline', reasoningEffort: 'high', providerOptions: { customKey: 42 } },
  } }],
};
validateRolePresets(inlineConfig);
const inlineSession = {};
ensureSessionConfigState(inlineSession, inlineConfig, { newSession: true });
setSessionConfigOption(inlineConfig, inlineSession, SESSION_CONFIG_IDS.rolePreset, 'direct');
const snapshot = applySessionProfileOverrides(inlineConfig, inlineSession);
const inlineRegistry = createModelRegistry(snapshot);
try {
  assert.equal(inlineRegistry.resolveRole('coderHigh').profileName, 'inline:coderHigh');
  assert.equal(inlineRegistry.resolveRole('coderHigh').providerName, 'cloud');
  assert.equal(inlineRegistry.resolveRole('coderHigh').profile.model, 'not-in-catalog');
  assert.equal(inlineRegistry.resolveRole('coderHigh').profile.reasoningEffort, 'medium');
  assert.equal(inlineRegistry.resolveRole('investigator').providerName, 'custom');
  assert.equal(inlineRegistry.resolveRole('investigator').profile.model, 'local-inline');
  assert.deepEqual(inlineRegistry.resolveRole('investigator').profile.providerOptions, { customKey: 42 });
  // A running workflow remains stable even if session selects another preset.
  setSessionConfigOption(inlineConfig, inlineSession, SESSION_CONFIG_IDS.rolePreset, 'direct');
  assert.equal(inlineRegistry.resolveRole('coderHigh').profile.model, 'not-in-catalog');
} finally {
  await inlineRegistry.close();
}
console.log('role-presets-runtime: passed');
