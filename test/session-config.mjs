import assert from 'node:assert/strict';
import {
  applySessionProfileOverrides,
  buildSessionConfigOptions,
  ensureSessionConfigState,
  SESSION_CONFIG_IDS,
  setSessionConfigOption,
} from '../src/session-config.mjs';

const config = {
  providers: {
    cloud: {
      adapter: 'codex-cli', supportsFastMode: true,
      models: [
        { id: 'cheap', name: 'Cheap', contextWindow: 1000, supportsFastMode: true },
        { id: 'strong', name: 'Strong', contextWindow: 2000, supportsFastMode: true },
        { id: 'legacy', name: 'Legacy', supportsFastMode: false },
      ],
    },
    local: { adapter: 'acp-agent', supportsFastMode: false, models: [{ id: 'local-model', supportsFastMode: true }] },
  },
  profiles: {
    economy: { provider: 'cloud', model: 'cheap', reasoningEffort: 'low' },
    balanced: { provider: 'cloud', model: 'strong', reasoningEffort: 'medium' },
    legacy: { provider: 'cloud', model: 'legacy' },
    local: { provider: 'local', model: 'local-model' },
    disabled: { provider: 'cloud', model: 'strong', supportsFastMode: false },
  },
  roles: { router: 'balanced', reviewerMedium: 'economy', planner: 'legacy', explorer: 'local', coderLow: 'disabled' },
  ui: { defaultProfile: 'balanced' },
};

const session = {};
ensureSessionConfigState(session, config);
assert.equal(session.selectedProfile, 'balanced');
const option = () => buildSessionConfigOptions(config, session)[0];
assert.deepEqual(buildSessionConfigOptions(config, session).map((o) => o.id), [SESSION_CONFIG_IDS.fastMode]);
assert.equal(option().name, 'Fast mode');
assert.equal(option().category, 'model_config');
assert.equal(option().currentValue, false);

// Removed selectors are rejected, including stale events from a former Zed UI.
const original = structuredClone(session.roleAssignments);
for (const id of ['orchestrator_profile', 'orchestrator_model', 'orchestrator_reasoning_effort', 'orchestrator_role_editor', SESSION_CONFIG_IDS.rolePreset]) {
  assert.throws(() => setSessionConfigOption(config, session, id, 'strong'), /Unknown session config option/);
}
assert.deepEqual(session.roleAssignments, original);

// The last selected template from an old session has no bearing on which roles
// the single fast-mode control addresses.
session.selectedProfile = 'economy';
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.fastMode, true);
assert.equal(session.fastModeOverride, true);
assert.deepEqual(session.roleAssignments, original, 'materialized assignments remain canonical');
assert.equal(option().currentValue, true);
let effective = applySessionProfileOverrides(config, session);
assert.equal(effective.roleAssignments.router.profile.fastMode, true);
assert.equal(effective.roleAssignments.reviewerMedium.profile.fastMode, true);
assert.equal(effective.roleAssignments.router.profile.model, 'strong');
assert.equal(effective.roleAssignments.reviewerMedium.profile.reasoningEffort, 'low');
assert.equal(effective.roleAssignments.planner.profile.fastMode, undefined, 'model unsupported');
assert.equal(effective.roleAssignments.explorer.profile.fastMode, undefined, 'provider unsupported');
assert.equal(effective.roleAssignments.coderLow.profile.fastMode, undefined, 'profile opt-out');
assert.equal(effective.profiles.economy.fastMode, undefined, 'profile templates stay untouched');

// The current workflow snapshot must not change when the switch changes.
const runningConfig = effective;
setSessionConfigOption(config, session, SESSION_CONFIG_IDS.fastMode, false);
assert.equal(runningConfig.roleAssignments.router.profile.fastMode, true);
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.router.profile.fastMode, false);
assert.equal(applySessionProfileOverrides(config, session).roleAssignments.reviewerMedium.profile.fastMode, false);
assert.deepEqual(session.roleAssignments, original);
assert.equal(option().currentValue, false);
assert.throws(() => setSessionConfigOption(config, session, SESSION_CONFIG_IDS.fastMode, 'true'), /must be boolean/);
assert.equal(session.fastModeOverride, false);

// A new model selected in a materialized session is checked against its actual
// provider/model capability, not the originally named profile or its model.
session.roleAssignments.router.profile.model = 'legacy';
session.roleAssignments.reviewerMedium.profile.model = 'strong';
effective = applySessionProfileOverrides(config, session);
assert.equal(effective.roleAssignments.router.profile.fastMode, undefined);
assert.equal(effective.roleAssignments.reviewerMedium.profile.fastMode, false);

// Empty or unsupported-only assignments do not expose a useless toggle.
const unsupported = { roleAssignments: { explorer: structuredClone(original.explorer), planner: structuredClone(original.planner) } };
assert.deepEqual(buildSessionConfigOptions(config, unsupported), []);
assert.throws(() => setSessionConfigOption(config, unsupported, SESSION_CONFIG_IDS.fastMode, true), /not supported/);
assert.equal(unsupported.fastModeOverride, undefined);

console.log('session-config: passed');
