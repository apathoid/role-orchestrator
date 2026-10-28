import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';

async function withOverride(override, fn) {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-config-'));
  const file = join(root, 'override.json');
  const previous = process.env.AGENT_CONFIG;
  try {
    await writeFile(file, JSON.stringify(override));
    process.env.AGENT_CONFIG = file;
    await fn();
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONFIG; else process.env.AGENT_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
}

await withOverride({ providers: { typo: { type: 'codex-acpp' } } }, async () => {
  await assert.rejects(() => loadConfig(), /providers\.typo\.type must be one of/i);
});


await withOverride({ providers: { subscription: { type: 'codex-acp', adapter: undefined } } }, async () => {
  const config = await loadConfig();
  assert.equal(config.providers.subscription.adapter, 'codex-acp', 'legacy provider.type should migrate to adapter');
});

await withOverride({ providers: { generic: { adapter: 'acp-agent', command: 'fake-agent', workspaceModes: { readOnly: 'read', write: 'write' }, models: ['fake-model'] } }, profiles: { genericProfile: { provider: 'generic', model: 'fake-model' } } }, async () => {
  const config = await loadConfig();
  assert.equal(config.providers.generic.adapter, 'acp-agent');
  assert.deepEqual(config.providers.generic.workspaceModes, { readOnly: 'read', write: 'write' });
});

// A generic ACP provider may advertise Fast mode only with an explicit
// protocol config ID that can actually forward the boolean control.
await withOverride({ providers: { generic: {
  adapter: 'acp-agent', command: 'fake-agent',
  workspaceModes: { readOnly: 'read', write: 'write' },
  supportsFastMode: true, models: [{ id: 'fast', supportsFastMode: true }],
} } }, async () => {
  await assert.rejects(() => loadConfig(), /providers\.generic\.fastModeConfigId is required/);
});
await withOverride({ providers: { generic: {
  adapter: 'acp-agent', command: 'fake-agent',
  workspaceModes: { readOnly: 'read', write: 'write' },
  supportsFastMode: true, fastModeConfigId: 'speed-tier',
  models: [{ id: 'fast', supportsFastMode: true }],
} } }, async () => {
  const config = await loadConfig();
  assert.equal(config.providers.generic.fastModeConfigId, 'speed-tier');
});

await withOverride({ policy: { finalValidationForHighRisk: 'yes' } }, async () => {
  await assert.rejects(() => loadConfig(), /finalValidationForHighRisk must be boolean/i);
});

await withOverride({ ui: { defaultProfile: 'missing-profile' } }, async () => {
  await assert.rejects(() => loadConfig(), /ui\.defaultProfile references unknown profile/i);
});

await withOverride({ profiles: { balanced: { contextWindow: -1 } } }, async () => {
  await assert.rejects(() => loadConfig(), /profiles\.balanced\.contextWindow must be a positive integer/i);
});

await withOverride({ providers: { subscription: { models: ['gpt-5.6-luna', 'gpt-5.6-luna'] } } }, async () => {
  await assert.rejects(() => loadConfig(), /duplicate model id/i);
});

await withOverride({ providers: { subscription: { idleTimeoutMs: 0 } } }, async () => {
  await assert.rejects(() => loadConfig(), /providers\.subscription\.idleTimeoutMs must be a positive integer/i);
});

await withOverride({ profiles: { balanced: { turnDeadlineMs: -1 } } }, async () => {
  await assert.rejects(() => loadConfig(), /profiles\.balanced\.turnDeadlineMs must be a positive integer/i);
});

await withOverride({ rolePresets: [{ id: 'high', label: 'High', roles: { reviewerMedium: 'balanced' } }] }, async () => {
  const config = await loadConfig();
  assert.equal(config.rolePresets[0].roles.reviewerMedium, 'balanced');
});
await withOverride({ rolePresets: [{ id: 'bad', label: 'Bad', roles: { reviewMedium: 'balanced' } }] }, async () => {
  await assert.rejects(() => loadConfig(), /preset "bad".*unknown role "reviewMedium"/);
});
await withOverride({ rolePresets: [{ id: 'bad', label: 'Bad', roles: { reviewerMedium: 'absent' } }] }, async () => {
  await assert.rejects(() => loadConfig(), /preset "bad", role "reviewerMedium".*unknown profile/);
});
await withOverride({ rolePresets: [{ id: 'fast', label: 'Fast', roles: {} }], defaultRolePreset: 'unknown' }, async () => {
  await assert.rejects(() => loadConfig(), /defaultRolePreset references unknown/);
});

// Load-time validation works for inline model overrides without registering
// the model in profiles, roles or the provider model metadata catalog.
await withOverride({ rolePresets: [{ id: 'direct', label: 'Direct', roles: {
  reviewerMedium: { model: 'future-model', reasoningEffort: 'high' },
  coderHigh: { provider: 'subscription', model: 'another-model' },
} }] }, async () => {
  const config = await loadConfig();
  assert.equal(config.rolePresets[0].roles.reviewerMedium.model, 'future-model');
  const { resolveRoleAssignments } = await import('../src/role-presets.mjs');
  assert.equal(resolveRoleAssignments(config, 'direct').reviewerMedium.profile.model, 'future-model');
});
for (const [assignment, pattern] of [
  [{ provider: 'missing', model: 'new' }, /preset "invalid", role "reviewerMedium".*unknown provider/],
  [{ model: 'new', idleTimeoutMs: 0 }, /preset "invalid", role "reviewerMedium"\.idleTimeoutMs/],
]) {
  await withOverride({ rolePresets: [{ id: 'invalid', label: 'Invalid', roles: { reviewerMedium: assignment } }] }, async () => {
    await assert.rejects(() => loadConfig(), pattern);
  });
}

await withOverride({ policy: { reviewWork: { maxFilesPerUnit: 4, maxUnitsPerBatch: 2, maxBatchesPerRun: 8 } } }, async () => {
  assert.equal((await loadConfig()).policy.reviewWork.maxFilesPerUnit, 4);
});
for (const [field, value] of [['maxFilesPerUnit', 0], ['maxUnitsPerBatch', 9], ['maxBatchesPerRun', -1]]) {
  await withOverride({ policy: { reviewWork: { [field]: value } } }, async () => {
    await assert.rejects(() => loadConfig(), new RegExp(`policy\\.reviewWork\\.${field}`));
  });
}
console.log('config: passed');
