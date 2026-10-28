import { applyRolePreset, matchRolePreset, resolveRoleAssignments } from './role-presets.mjs';

export const SESSION_CONFIG_IDS = {
  fastMode: 'orchestrator_fast_mode',
  rolePreset: 'orchestrator_role_preset',
};

function modelId(entry) {
  return typeof entry === 'string' ? entry : entry?.id;
}

function providerModels(config, providerName) {
  const configured = Array.isArray(config.providers?.[providerName]?.models)
    ? config.providers[providerName].models
    : [];
  const seen = new Set();
  const out = [];
  for (const entry of configured) {
    const id = modelId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(typeof entry === 'string' ? { id, name: id } : { ...entry, id });
  }
  for (const profile of Object.values(config.profiles ?? {})) {
    if (profile?.provider !== providerName || !profile?.model || seen.has(profile.model)) continue;
    seen.add(profile.model);
    out.push({ id: profile.model, name: profile.model });
  }
  return out;
}

function modelMeta(config, providerName, id) {
  return providerModels(config, providerName).find((entry) => entry.id === id) ?? null;
}

// Legacy editor state remains readable for sessions created by older versions,
// but never determines the scope of the session-wide Fast mode switch.
function defaultSelectedProfile(config) {
  if (config.ui?.defaultProfile && config.profiles?.[config.ui.defaultProfile]) return config.ui.defaultProfile;
  if (config.profiles?.balanced) return 'balanced';
  return Object.keys(config.profiles ?? {})[0] ?? null;
}

export function ensureSessionConfigState(session, config, { newSession = false } = {}) {
  if (!session.profileOverrides || typeof session.profileOverrides !== 'object' || Array.isArray(session.profileOverrides)) {
    session.profileOverrides = {};
  }
  if (!session.selectedProfile || !config.profiles?.[session.selectedProfile]) {
    session.selectedProfile = defaultSelectedProfile(config);
  }
  for (const name of Object.keys(session.profileOverrides)) {
    if (!config.profiles?.[name]) delete session.profileOverrides[name];
  }
  if (!session.roleAssignments) {
    // Previously persisted sessions retain their materialized role configuration;
    // a newly defined default preset is applied only to new sessions.
    const defaultPreset = newSession ? (config.defaultRolePreset ?? null) : null;
    session.roleAssignments = resolveRoleAssignments(config, defaultPreset, defaultPreset ? {} : session.profileOverrides);
    if (defaultPreset) session.profileOverrides = {};
  }
  return session;
}

function enrichProfileMetadata(config, profile) {
  const meta = modelMeta(config, profile.provider, profile.model);
  if (meta?.contextWindow && !profile.contextWindow) profile.contextWindow = meta.contextWindow;
  if (meta?.reasoningEfforts) profile.supportedReasoningEfforts = [...meta.reasoningEfforts];
  if (meta?.supportsFastMode === false) profile.supportsFastMode = false;
  else if (meta?.supportsFastMode === true && profile.supportsFastMode !== false) profile.supportsFastMode = true;
  return profile;
}

export function effectiveProfile(config, session, profileName) {
  const base = config.profiles?.[profileName];
  if (!base) throw new Error(`Unknown profile: ${profileName}`);
  const override = session.profileOverrides?.[profileName] ?? {};
  return enrichProfileMetadata(config, { ...base, ...override });
}

// Capability is declarative: a provider and the actual model must both opt in.
// In particular, an unknown model, unsupported local provider, or an explicit
// profile opt-out cannot receive a fast-tier request by accident.
function supportsRoleFastMode(config, assignment) {
  const profile = assignment?.profile;
  if (!profile || config.providers?.[profile.provider]?.supportsFastMode !== true) return false;
  const meta = modelMeta(config, profile.provider, profile.model);
  return meta?.supportsFastMode === true && profile.supportsFastMode !== false;
}

function fastCapableAssignments(config, assignments) {
  return Object.values(assignments ?? {}).filter((assignment) => supportsRoleFastMode(config, assignment));
}

function fastModeEnabled(config, session) {
  const capable = fastCapableAssignments(config, session.roleAssignments);
  if (!capable.length) return false;
  return session.fastModeOverride ?? capable.every((assignment) => assignment.profile.fastMode === true);
}

export function applySessionProfileOverrides(config, session) {
  ensureSessionConfigState(session, config);
  return {
    ...config,
    // The session-wide speed option is orthogonal to the materialized preset
    // configuration. Only capable roles receive the speed overlay; workflow
    // snapshots remain stable for the lifetime of an outer turn.
    roleAssignments: Object.fromEntries(Object.entries(session.roleAssignments).map(([role, assignment]) => {
      const profile = enrichProfileMetadata(config, structuredClone(assignment.profile));
      if (session.fastModeOverride !== null && session.fastModeOverride !== undefined &&
          supportsRoleFastMode(config, { profile })) {
        profile.fastMode = session.fastModeOverride;
      }
      return [role, { ...structuredClone(assignment), profile }];
    })),
    profiles: Object.fromEntries(
      Object.keys(config.profiles).map((name) => [name, effectiveProfile(config, session, name)]),
    ),
  };
}

export function buildSessionConfigOptions(config, session) {
  ensureSessionConfigState(session, config);
  const options = [];

  if (config.rolePresets?.length) {
    options.push({
      type: 'select',
      id: SESSION_CONFIG_IDS.rolePreset,
      name: 'Role preset',
      description: 'Apply role assignments defined in the config file. Custom is computed from the actual session assignments.',
      currentValue: matchRolePreset(config, session.roleAssignments) ?? 'custom',
      options: [
        { value: 'custom', name: 'Role preset: Custom' },
        ...config.rolePresets.map(({ id, label, description }) => ({
          value: id, name: `Role preset: ${label}`, description,
        })),
      ],
    });
  }

  // One session-scoped speed switch for all fast-capable roles in the
  // materialized assignment set, regardless of profileName or preset ID.
  // Unknown/unsupported models are excluded and no control is shown when none
  // of the roles can use the service tier.
  if (fastCapableAssignments(config, session.roleAssignments).length) {
    options.push({
      type: 'boolean',
      id: SESSION_CONFIG_IDS.fastMode,
      name: 'Fast mode',
      category: 'model_config',
      description: 'Request fast service tier for all compatible role models in this session. Availability depends on the backend.',
      currentValue: fastModeEnabled(config, session),
    });
  }
  return options;
}

function unwrapValue(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value && typeof value === 'object') {
    if ('value' in value) return value.value;
    if ('valueId' in value) return value.valueId;
    if ('value_id' in value) return value.value_id;
  }
  return value;
}

export function setSessionConfigOption(config, session, configId, rawValue) {
  ensureSessionConfigState(session, config);
  const value = unwrapValue(rawValue);
  if (configId === SESSION_CONFIG_IDS.rolePreset && config.rolePresets?.length) {
    if (typeof value !== 'string') throw new Error('Role preset ID must be a string.');
    if (value !== 'custom') applyRolePreset(config, session, value);
    // Custom is derived, not a mutable mode or a second source of truth.
    return;
  }
  if (configId !== SESSION_CONFIG_IDS.fastMode) {
    // Reject old/stale UI events too: model, effort and role assignments are
    // configurable exclusively in the config file (or via preset selection).
    throw new Error(`Unknown session config option: ${configId}`);
  }

  if (typeof value !== 'boolean') throw new Error('Fast mode value must be boolean.');
  if (!fastCapableAssignments(config, session.roleAssignments).length) {
    throw new Error('Fast mode is not supported by any assigned role model.');
  }
  // Atomic scalar update. The canonical role assignments and preset matching
  // remain untouched; the speed overlay is applied only to workflow snapshots.
  session.fastModeOverride = value;
}
