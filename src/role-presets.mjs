// Presets are provider-neutral ways to produce canonical, materialized role
// assignments. A role may name a shared profile, override its fixed base
// profile inline, or supply a complete provider/model profile inline.
import { validateProfileDefinition } from './profile-validation.mjs';

export const ROLE_NAMES = Object.freeze([
  'router', 'explorer', 'planner', 'investigator',
  'coderLow', 'coderMedium', 'coderHigh',
  'reviewerLow', 'reviewerMedium', 'reviewerHigh',
  'responderLow', 'responderMedium', 'responderHigh',
  'finalValidator',
]);

const hasOwn = (object, key) => Object.hasOwn(object ?? {}, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = (value) => structuredClone(value);

function profileSnapshot(config, name, overrides) {
  if (!hasOwn(config.profiles, name)) throw new Error(`Unknown role assignment profile: ${name}`);
  return { profileName: name, profile: copy({ ...config.profiles[name], ...(overrides?.[name] ?? {}) }) };
}

function presetAssignment(config, preset, role) {
  const value = preset.roles[role];
  const where = `Invalid role preset "${preset.id}", role "${role}"`;
  if (typeof value === 'string') {
    if (!hasOwn(config.profiles, value)) {
      throw new Error(`${where}: unknown profile ${JSON.stringify(value)} (expected an existing profile name).`);
    }
    return profileSnapshot(config, value);
  }
  if (!record(value)) {
    throw new Error(`${where}: assignment must be a profile name or an inline profile object.`);
  }

  let profile;
  if (hasOwn(value, 'provider')) {
    // Switching providers is a complete assignment: never carry providerOptions,
    // timeouts or capability flags from the previous provider into the next.
    if (!hasOwn(value, 'model')) {
      throw new Error(`${where}: inline assignment with provider must also specify model.`);
    }
    profile = copy(value);
  } else {
    // A partial inline assignment always overlays the immutable config.roles
    // base, *never* the previous session's effective preset or profile overrides.
    const baseName = config.roles[role];
    if (!hasOwn(config.profiles, baseName)) throw new Error(`${where}: unknown base profile ${JSON.stringify(baseName)}.`);
    const baseProfile = config.profiles[baseName];
    profile = { ...copy(baseProfile), ...copy(value) };
    if (hasOwn(value, 'model') && value.model !== baseProfile.model) {
      // Model-specific metadata/fast-tier intent from the old model must not
      // masquerade as capabilities of a different (possibly unknown) model.
      // Explicit inline settings still take precedence when deliberately set.
      for (const key of ['contextWindow', 'supportedReasoningEfforts', 'supportsFastMode', 'fastMode']) {
        if (!hasOwn(value, key)) delete profile[key];
      }
    }
  }
  validateProfileDefinition(profile, config.providers, where);
  // Don't log the name of the base profile when its effective configuration
  // differs. Runtime consumes only the materialized `profile` object.
  return { profileName: `inline:${role}`, profile };
}

export function validateRolePresets(config) {
  if (config.rolePresets === undefined) config.rolePresets = [];
  if (!Array.isArray(config.rolePresets)) throw new Error('rolePresets must be an array.');
  const ids = new Set();
  for (const [index, preset] of config.rolePresets.entries()) {
    const where = `rolePresets[${index}]`;
    if (!record(preset)) throw new Error(`${where} must be an object.`);
    if (typeof preset.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(preset.id) || preset.id === 'custom') {
      throw new Error(`${where}.id must be a unique non-reserved identifier (letters, digits, _ or -, starting with a letter).`);
    }
    if (ids.has(preset.id)) throw new Error(`Duplicate role preset id "${preset.id}".`);
    ids.add(preset.id);
    if (typeof preset.label !== 'string' || !preset.label.trim()) throw new Error(`Invalid role preset "${preset.id}": label must be a non-empty string.`);
    if (preset.description !== undefined && typeof preset.description !== 'string') throw new Error(`Invalid role preset "${preset.id}": description must be a string.`);
    if (!record(preset.roles)) throw new Error(`Invalid role preset "${preset.id}": roles must be an object.`);
    for (const role of Object.keys(preset.roles)) {
      if (!ROLE_NAMES.includes(role)) throw new Error(`Invalid role preset "${preset.id}": unknown role "${role}".`);
      presetAssignment(config, preset, role); // same profile validator as config.profiles
    }
  }
  if (config.defaultRolePreset !== undefined) {
    if (typeof config.defaultRolePreset !== 'string' || !ids.has(config.defaultRolePreset)) {
      throw new Error(`defaultRolePreset references unknown role preset ${JSON.stringify(config.defaultRolePreset)}.`);
    }
  }
  return config;
}

export function resolveRoleAssignments(config, presetId = null, profileOverrides = {}) {
  const preset = presetId === null ? null : config.rolePresets?.find((entry) => entry.id === presetId);
  if (presetId !== null && !preset) throw new Error(`Unknown role preset: ${presetId}`);
  return Object.fromEntries(Object.keys(config.roles).map((role) => [role,
    preset && hasOwn(preset.roles, role)
      ? presetAssignment(config, preset, role)
      : profileSnapshot(config, config.roles[role], profileOverrides),
  ]));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stableValue(value[key])]));
}

// Compare effective behavior rather than profile labels, insertion order or ID.
export function normalizeRoleAssignments(assignments) {
  return stableValue(Object.fromEntries(Object.entries(assignments ?? {}).map(([role, assignment]) => [role, assignment.profile])));
}

export function matchRolePreset(config, assignments) {
  if (!config.rolePresets?.length) return null;
  const current = JSON.stringify(normalizeRoleAssignments(assignments));
  for (const preset of config.rolePresets) {
    if (JSON.stringify(normalizeRoleAssignments(resolveRoleAssignments(config, preset.id))) === current) return preset.id;
  }
  return null;
}

export function applyRolePreset(config, session, presetId) {
  // Resolve and validate everything before the atomic session map replacement.
  const next = resolveRoleAssignments(config, presetId);
  session.roleAssignments = next;
  session.profileOverrides = {};
}
