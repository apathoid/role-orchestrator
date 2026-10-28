import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ROLE_NAMES, applyRolePreset, matchRolePreset, normalizeRoleAssignments,
  resolveRoleAssignments, validateRolePresets,
} from '../src/role-presets.mjs';
import {
  applySessionProfileOverrides, buildSessionConfigOptions,
  ensureSessionConfigState, setSessionConfigOption, SESSION_CONFIG_IDS,
} from '../src/session-config.mjs';
import { buildCodexNativeConfigOptions } from '../src/codex-native-controls.mjs';

const raw = {
  providers: {
    primary: { adapter: 'codex-cli', supportsFastMode: true, models: [
      { id: 'economy', contextWindow: 1024, reasoningEfforts: ['low', 'medium'], supportsFastMode: true },
      { id: 'strong', contextWindow: 2048, reasoningEfforts: ['medium', 'high'], supportsFastMode: true },
    ] },
    local: { adapter: 'acp-agent', models: ['local-model'] },
  },
  profiles: {
    cheap: { provider: 'primary', model: 'economy', reasoningEffort: 'low' },
    powerful: { provider: 'primary', model: 'strong', reasoningEffort: 'high' },
    local: { provider: 'local', model: 'local-model', reasoningEffort: 'medium', providerOptions: { a: 1, b: 2 } },
  },
  roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, 'cheap'])),
  ui: { defaultProfile: 'cheap' },
  rolePresets: [
    { id: 'high', label: 'High Performance', roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, 'powerful'])) },
    { id: 'efficient', label: 'Efficient', roles: { reviewerMedium: 'powerful' } },
    { id: 'local', label: 'Local', roles: { investigator: 'local' } },
    { id: 'identical', label: 'Same as High', roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, 'powerful'])) },
  ],
};
const config = validateRolePresets(structuredClone(raw));
const presetOption = (session, cfg = config) => buildSessionConfigOptions(cfg, session).find((o) => o.id === SESSION_CONFIG_IDS.rolePreset);
// With or without presets, role/model/effort configuration lives in the file.
for (const rolePresets of [undefined, []]) {
  const noPresets = { ...config, rolePresets };
  const old = {};
  ensureSessionConfigState(old, noPresets, { newSession: true });
  assert.equal(presetOption(old, noPresets), undefined);
  assert.deepEqual(buildSessionConfigOptions(noPresets, old).map((o) => o.id), [SESSION_CONFIG_IDS.fastMode]);
  assert.deepEqual([...buildCodexNativeConfigOptions(old), ...buildSessionConfigOptions(noPresets, old)].map((o) => o.id), ['mode', 'collaboration_mode', SESSION_CONFIG_IDS.fastMode]);
  const previous = structuredClone(old);
  assert.throws(() => setSessionConfigOption(noPresets, old, 'orchestrator_model', 'strong'), /Unknown session config option/);
  assert.deepEqual(old, previous);
  assert.equal(applySessionProfileOverrides(noPresets, old).roleAssignments.router.profile.model, 'economy');
}

const session = {};
ensureSessionConfigState(session, config, { newSession: true });
const base = structuredClone(session.roleAssignments);
assert.equal(presetOption(session).currentValue, 'custom');
assert.deepEqual(presetOption(session).options.map((o) => o.name), [
  'Role preset: Custom', 'Role preset: High Performance', 'Role preset: Efficient',
  'Role preset: Local', 'Role preset: Same as High',
]);
// Zed shows exactly one role-related control; no role/template/model editors.
let uiOptions = buildSessionConfigOptions(config, session);
assert.deepEqual(uiOptions.map(({ id }) => id), [SESSION_CONFIG_IDS.rolePreset, SESSION_CONFIG_IDS.fastMode]);
assert.deepEqual([...buildCodexNativeConfigOptions(session), ...uiOptions].map((o) => o.id), ['mode', 'collaboration_mode', SESSION_CONFIG_IDS.rolePreset, SESSION_CONFIG_IDS.fastMode]);
assert.equal(uiOptions[0].options.length, 5);
assert.equal(uiOptions[1].name, 'Fast mode');
// Legacy role-editor metadata is inert and cannot affect preset matching.
const withOldEditor = { roleEditor: 'reviewerMedium', roleAssignments: structuredClone(base) };
ensureSessionConfigState(withOldEditor, config);
assert.equal(buildSessionConfigOptions(config, withOldEditor).length, 2);
assert.deepEqual(withOldEditor.roleAssignments, base);

// Partial presets overlay the fixed config.roles, never the previous session.
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'high');
assert.equal(presetOption(session).currentValue, 'high');
assert.equal(session.roleAssignments.router.profile.model, 'strong');
assert.equal(session.roleAssignments.reviewerMedium.profile.model, 'strong');
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.coderHigh.profile.model, 'strong');
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'efficient');
assert.deepEqual(session.roleAssignments.router, base.router);
assert.equal(session.roleAssignments.reviewerMedium.profile.model, 'strong');
assert.equal(presetOption(session).currentValue, 'efficient');

// A materialized single-role difference results in derived Custom, without UI editors.
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'high');
session.roleAssignments = {
  ...session.roleAssignments,
  reviewerMedium: {
    ...session.roleAssignments.reviewerMedium,
    profile: { ...session.roleAssignments.reviewerMedium.profile, model: 'economy' },
  },
};
assert.equal(presetOption(session).currentValue, 'custom');
assert.equal(session.roleAssignments.reviewerHigh.profile.model, 'strong');
session.roleAssignments.reviewerMedium.profile.model = 'strong';
assert.equal(presetOption(session).currentValue, 'high'); // first matching declaration
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'custom');
assert.equal(presetOption(session).currentValue, 'high'); // Custom isn't an independent state

// Failure paths and stale UI requests never mutate assignments or overrides.
const before = structuredClone(session);
assert.throws(() => setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'missing'), /Unknown role preset/);
for (const id of ['orchestrator_role_model_reviewerMedium', 'orchestrator_role_reasoning_reviewerMedium', 'orchestrator_role_editor', 'orchestrator_model', 'orchestrator_profile', 'orchestrator_reasoning_effort']) {
  assert.throws(() => setSessionConfigOption(config, session, id, 'economy'), /Unknown session config option/);
}
assert.deepEqual(session, before);

// Fast mode is an orthogonal session-wide overlay on ALL eligible models.
// It must neither rewrite the saved preset nor affect model, effort or provider.
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'efficient');
const beforeFast = structuredClone(session.roleAssignments);
session.selectedProfile = 'powerful'; // obsolete metadata cannot scope the toggle
assert.equal(buildSessionConfigOptions(config, session)[1].name, 'Fast mode');
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.fastMode, true);
assert.deepEqual(session.roleAssignments, beforeFast);
assert.equal(session.fastModeOverride, true);
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.router.profile.fastMode, true);
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.reviewerMedium.profile.fastMode, true);
assert.equal(presetOption(session).currentValue, 'efficient', 'the speed switch must not turn a preset into Custom');
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'high');
assert.equal(presetOption(session).currentValue, 'high');
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.reviewerMedium.profile.fastMode, true);
assert.equal(session.profileOverrides.cheap, undefined);

// Provider-neutral presets work through the same layer.
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'local');
assert.equal(session.roleAssignments.investigator.profile.provider, 'local');
assert.equal(session.roleAssignments.investigator.profile.model, 'local-model');
assert.equal(session.roleAssignments.router.profile.provider, 'primary');
assert.equal(session.fastModeOverride, true);
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.router.profile.fastMode, true);
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.investigator.profile.fastMode, undefined,
  'a local model must not inherit the fast-tier request when switching to a mixed preset');
assert.equal(presetOption(session).currentValue, 'local');
assert.deepEqual(buildSessionConfigOptions(config, session).map(({ id }) => id), [SESSION_CONFIG_IDS.rolePreset, SESSION_CONFIG_IDS.fastMode]);

// Runtime snapshots cannot change retroactively when session settings change.
const runningConfig = applySessionProfileOverrides(config, session);
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.rolePreset, 'high');
assert.equal(runningConfig.roleAssignments.investigator.profile.model, 'local-model');
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.investigator.profile.model, 'strong');
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.investigator.profile.contextWindow, 2048);

// Normalization is structural, ignoring object key ordering and profile labels.
const one = { router: { profileName: 'x', profile: { provider: 'p', providerOptions: { a: 1, b: 2 }, model: 'm' } } };
const two = { router: { profileName: 'y', profile: { model: 'm', providerOptions: { b: 2, a: 1 }, provider: 'p' } } };
assert.deepEqual(normalizeRoleAssignments(one), normalizeRoleAssignments(two));

// New sessions apply optional default once; old sessions never retroactively do.
const withDefault = { ...config, defaultRolePreset: 'high' };
const newSession = {};
ensureSessionConfigState(newSession, withDefault, { newSession: true });
assert.equal(matchRolePreset(withDefault, newSession.roleAssignments), 'high');
const legacy = { profileOverrides: { cheap: { model: 'strong', reasoningEffort: 'medium' } }, selectedProfile: 'cheap' };
ensureSessionConfigState(legacy, withDefault);
assert.equal(legacy.roleAssignments.router.profile.model, 'strong');
assert.equal(legacy.roleAssignments.router.profileName, 'cheap');

// Persisted assignments survive reload and a same-ID definition change.
const stateRoot = await mkdtemp(path.join(tmpdir(), 'role-presets-session-'));
const previousRoot = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = stateRoot;
try {
  const { saveSession, loadSession } = await import('../src/session-store.mjs');
  await saveSession('presets-A', { ...session, cwd: '/tmp/project', history: [], transcript: [] });
  const restored = await loadSession('presets-A');
  ensureSessionConfigState(restored, config);
  assert.deepEqual(restored.roleAssignments, session.roleAssignments);
  assert.equal(restored.fastModeOverride, true, 'session speed override is persisted');
  assert.equal(applySessionProfileOverrides(config, restored).roleAssignments.router.profile.fastMode, true);
  assert.deepEqual(buildSessionConfigOptions(config, restored).map((o) => o.id), [SESSION_CONFIG_IDS.rolePreset, SESSION_CONFIG_IDS.fastMode]);
  assert.equal(matchRolePreset(config, restored.roleAssignments), 'high');
  const edited = structuredClone(config);
  edited.rolePresets[0].roles.router = 'cheap';
  assert.equal(matchRolePreset(edited, restored.roleAssignments), 'identical');
  edited.rolePresets[3].roles.router = 'cheap';
  assert.equal(matchRolePreset(edited, restored.roleAssignments), null);
  assert.equal(restored.roleAssignments.router.profile.model, 'strong');

  // Concurrent sessions can pick different presets and persist independently.
  const second = {};
  ensureSessionConfigState(second, config, { newSession: true });
  applyRolePreset(config, second, 'efficient');
  await Promise.all([
    saveSession('presets-A', { ...restored, cwd: '/tmp/project' }),
    saveSession('presets-B', { ...second, cwd: '/tmp/project', history: [], transcript: [] }),
  ]);
  assert.equal(matchRolePreset(config, (await loadSession('presets-A')).roleAssignments), 'high');
  assert.equal(matchRolePreset(config, (await loadSession('presets-B')).roleAssignments), 'efficient');
  assert.equal((await loadSession('presets-B')).fastModeOverride, null, 'speed mode does not leak between sessions');
  assert.deepEqual((await loadSession('presets-A')).roleAssignments, restored.roleAssignments);
} finally {
  if (previousRoot === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = previousRoot;
  await rm(stateRoot, { recursive: true, force: true });
}

// Config failures must identify preset/role; no adapter-specific special cases.
for (const [bad, pattern] of [
  [{ ...config, rolePresets: [{ id: 'x', label: 'OK', roles: { reviewMedium: 'cheap' } }] }, /preset "x".*unknown role "reviewMedium"/],
  [{ ...config, rolePresets: [{ id: 'x', label: 'OK', roles: { reviewerMedium: 'absent' } }] }, /preset "x", role "reviewerMedium".*unknown profile/],
  [{ ...config, rolePresets: [{ id: 'x', label: '', roles: {} }] }, /preset "x".*label/],
  [{ ...config, rolePresets: [{ id: 'a', label: 'A', roles: {} }, { id: 'a', label: 'B', roles: {} }] }, /duplicate role preset id "a"/i],
  [{ ...config, rolePresets: [], defaultRolePreset: 'missing' }, /defaultRolePreset references unknown/],
  [{ ...config, rolePresets: [{ id: 'custom', label: 'Custom', roles: {} }] }, /non-reserved identifier/],
]) assert.throws(() => validateRolePresets(structuredClone(bad)), pattern);

// Inline assignments are the same canonical role profiles, with no new
// profile or model-catalog entries needed. `roles` remains the fixed baseline.
const withInline = validateRolePresets({
  ...structuredClone(config),
  rolePresets: [
    { id: 'inline', label: 'Inline', roles: {
      reviewerMedium: { model: 'unlisted-cloud-model', reasoningEffort: 'medium' },
      coderHigh: { provider: 'local', model: 'unlisted-local-model', reasoningEffort: 'high', providerOptions: { c: 3 } },
      investigator: { reasoningEffort: 'medium' },
    } },
    { id: 'sameEffect', label: 'Identical Inline', roles: {
      reviewerMedium: { reasoningEffort: 'medium', model: 'unlisted-cloud-model' },
      coderHigh: { providerOptions: { c: 3 }, reasoningEffort: 'high', model: 'unlisted-local-model', provider: 'local' },
      investigator: { reasoningEffort: 'medium' },
    } },
  ],
});
const inlineSession = {};
ensureSessionConfigState(inlineSession, withInline, { newSession: true });
const fixedBase = structuredClone(inlineSession.roleAssignments);
applyRolePreset(withInline, inlineSession, 'inline');
assert.equal(inlineSession.roleAssignments.reviewerMedium.profile.provider, 'primary');
assert.equal(inlineSession.roleAssignments.reviewerMedium.profile.model, 'unlisted-cloud-model');
assert.equal(inlineSession.roleAssignments.reviewerMedium.profile.reasoningEffort, 'medium');
assert.equal(inlineSession.roleAssignments.reviewerMedium.profileName, 'inline:reviewerMedium');
assert.equal(inlineSession.roleAssignments.coderHigh.profile.provider, 'local');
assert.equal(inlineSession.roleAssignments.coderHigh.profile.model, 'unlisted-local-model');
assert.deepEqual(inlineSession.roleAssignments.coderHigh.profile.providerOptions, { c: 3 });
assert.equal(inlineSession.roleAssignments.coderHigh.profileName, 'inline:coderHigh');
assert.equal(inlineSession.roleAssignments.coderHigh.profile.contextWindow, undefined);
assert.equal(inlineSession.roleAssignments.investigator.profile.model, 'economy');
assert.deepEqual(inlineSession.roleAssignments.router, fixedBase.router);
assert.equal(matchRolePreset(withInline, inlineSession.roleAssignments), 'inline', 'first matching inline preset wins');
assert.equal(presetOption(inlineSession, withInline).currentValue, 'inline');
assert.deepEqual(buildSessionConfigOptions(withInline, inlineSession).map(({ id }) => id), [SESSION_CONFIG_IDS.rolePreset, SESSION_CONFIG_IDS.fastMode]);
// Inline model absent from the declared catalog must not be assumed fast-capable.
setSessionConfigOption(withInline, inlineSession, SESSION_CONFIG_IDS.fastMode, true);
const fastInline = applySessionProfileOverrides(withInline, inlineSession).roleAssignments;
assert.equal(fastInline.reviewerMedium.profile.fastMode, undefined);
assert.equal(fastInline.router.profile.fastMode, true);
assert.equal(fastInline.coderHigh.profile.fastMode, undefined);
assert.equal(matchRolePreset(withInline, inlineSession.roleAssignments), 'inline');
// Model changes cannot accidentally carry model-specific capability flags
// (or fast-tier settings) from the fixed base model into an unknown model.
const staleMetaConfig = structuredClone(withInline);
staleMetaConfig.profiles.cheap = {
  ...staleMetaConfig.profiles.cheap,
  contextWindow: 4096, supportsFastMode: true, fastMode: true,
  providerOptions: { shared: 'preserved' },
};
const staleSnapshot = resolveRoleAssignments(staleMetaConfig, 'inline');
assert.equal(staleSnapshot.reviewerMedium.profile.contextWindow, undefined);
assert.equal(staleSnapshot.reviewerMedium.profile.supportsFastMode, undefined);
assert.equal(staleSnapshot.reviewerMedium.profile.fastMode, undefined);
assert.deepEqual(staleSnapshot.reviewerMedium.profile.providerOptions, { shared: 'preserved' });
assert.deepEqual(staleSnapshot.coderHigh.profile.providerOptions, { c: 3 }, 'full assignment cannot inherit providerOptions');
// A deliberate inline per-model declaration must still win.
staleMetaConfig.rolePresets[0].roles.reviewerMedium.contextWindow = 8192;
assert.equal(resolveRoleAssignments(staleMetaConfig, 'inline').reviewerMedium.profile.contextWindow, 8192);

// The resolver must never accidentally inherit modified session values.
inlineSession.roleAssignments.reviewerMedium.profile.model = 'temporarily-changed';
assert.equal(matchRolePreset(withInline, inlineSession.roleAssignments), null);
applyRolePreset(withInline, inlineSession, 'inline');
assert.equal(inlineSession.roleAssignments.reviewerMedium.profile.model, 'unlisted-cloud-model');
assert.deepEqual(fixedBase, resolveRoleAssignments(withInline));
// Existing sessions snapshot complete profiles; editing preset definitions only
// changes the match result, not their saved model/provider or their UI speed state.
const inlineStateDir = await mkdtemp(path.join(tmpdir(), 'inline-role-presets-'));
const originalStateDir = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = inlineStateDir;
try {
  const { saveSession, loadSession } = await import('../src/session-store.mjs');
  await saveSession('inline-session', { ...inlineSession, cwd: '/tmp/repo', history: [], transcript: [] });
  const loaded = await loadSession('inline-session');
  ensureSessionConfigState(loaded, withInline);
  assert.deepEqual(loaded.roleAssignments, inlineSession.roleAssignments);
  assert.equal(loaded.fastModeOverride, true);
  assert.equal(matchRolePreset(withInline, loaded.roleAssignments), 'inline');
  const revised = structuredClone(withInline);
  revised.rolePresets[0].roles.reviewerMedium.model = 'some-future-model';
  revised.rolePresets[1].roles.reviewerMedium.model = 'some-future-model';
  assert.equal(matchRolePreset(revised, loaded.roleAssignments), null);
  assert.equal(applySessionProfileOverrides(revised, loaded).roleAssignments.reviewerMedium.profile.model, 'unlisted-cloud-model');
} finally {
  if (originalStateDir === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = originalStateDir;
  await rm(inlineStateDir, { recursive: true, force: true });
}
// Invalid inline assignments are rejected using named profile validation, with
// exact preset and role context. Failed apply must not partially update session.
for (const [value, pattern] of [
  [null, /preset "broken", role "reviewerMedium".*inline profile object/],
  [[], /preset "broken", role "reviewerMedium".*inline profile object/],
  [{ provider: 'local' }, /preset "broken", role "reviewerMedium".*also specify model/],
  [{ provider: 'missing', model: 'whatever' }, /preset "broken", role "reviewerMedium".*unknown provider/],
  [{ model: '' }, /preset "broken", role "reviewerMedium"\.model must be a non-empty string/],
  [{ reasoningEffort: 5 }, /preset "broken", role "reviewerMedium"\.reasoningEffort must be a non-empty string/],
  [{ turnDeadlineMs: -1 }, /preset "broken", role "reviewerMedium"\.turnDeadlineMs must be a positive integer/],
  [{ contextWindow: 0 }, /preset "broken", role "reviewerMedium"\.contextWindow must be a positive integer/],
  [{ providerOptions: [] }, /preset "broken", role "reviewerMedium"\.providerOptions must be an object/],
  [{ fastMode: 'yes' }, /preset "broken", role "reviewerMedium"\.fastMode must be boolean/],
]) {
  const invalid = { ...withInline, rolePresets: [{ id: 'broken', label: 'Broken', roles: { reviewerMedium: value } }] };
  assert.throws(() => validateRolePresets(invalid), pattern);
  const unchanged = structuredClone(inlineSession);
  assert.throws(() => applyRolePreset(invalid, inlineSession, 'broken'), pattern);
  assert.deepEqual(inlineSession, unchanged);
}
// Invalid second role: full map must be computed and validated before commit.
const invalidAfterValid = { ...withInline, rolePresets: [{ id: 'broken', label: 'Broken', roles: {
  router: { model: 'valid-new-model' }, reviewerMedium: { provider: 'missing', model: 'x' },
} }] };
const prior = structuredClone(inlineSession);
assert.throws(() => applyRolePreset(invalidAfterValid, inlineSession, 'broken'), /unknown provider/);
assert.deepEqual(inlineSession, prior);

console.log('role-presets: passed');
