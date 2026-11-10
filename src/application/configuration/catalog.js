/** @import {Configuration} from './decode-config.js' */
/** @import {Capability, Catalog, CatalogEntry, ProviderDescription} from '../../core/ports.js' */

/**
 * Capture the model-facing portion of trusted configuration. Launch commands,
 * environment references and adapter-native settings remain in composition.
 * @param {Configuration} configuration
 * @param {readonly ProviderDescription[]} [descriptions]
 * @param {{records: readonly import('../../core/ports.js').SkillMetadata[], loadSkill: NonNullable<Catalog['loadSkill']>}} [skills]
 * @param {readonly import('../../core/ports.js').ToolMetadata[]} [tools]
 * @param {{unavailable?: ReadonlyMap<string, string>, preferences?: Catalog['preferences']}} [options]
 * @returns {Catalog}
 */
export function createCatalog(configuration, descriptions = [], skills, tools = [], { unavailable, preferences } = {}) {
  const providers = new Map(descriptions.map(item => [item.providerId, item]));
  /** @type {Map<string, {mode: 'native'} | {mode: 'selectable', defaultLevel: string, values: ReadonlyMap<string, string>}>} */
  const reasoning = new Map();
  /** @type {Map<CatalogEntry['kind'], Map<string, CatalogEntry>>} */
  const byKind = new Map([['profile', new Map()], ['role', new Map()], ['skill', new Map()], ['tool', new Map()]]);
  for (const [profileId, profile] of Object.entries(configuration.profiles)) {
    const description = providers.get(profile.provider);
    const capabilities = Object.freeze(Object.fromEntries(Object.entries(description?.capabilities ?? {})
      .map(([key, value]) => [key, Object.freeze({ ...value })])));
    const reason = unavailable?.get(profile.provider);
    const declared = profile.reasoningEffort;
    const selection = !declared || declared === 'native'
      ? /** @type {const} */ ({mode: 'native'})
      : {mode: /** @type {const} */ ('selectable'),
        defaultLevel: profile.defaultReasoningLevel ?? declared[0].level,
        values: new Map(declared.map(item => [item.level, item.effort]))};
    reasoning.set(profileId, selection);
    const modelView = selection.mode === 'native'
      ? Object.freeze({mode: /** @type {const} */ ('native')})
      : Object.freeze({mode: /** @type {const} */ ('selectable'),
        levels: Object.freeze([...selection.values.keys()].sort()), defaultLevel: selection.defaultLevel,
        capability: Object.freeze({support: /** @type {const} */ ('unknown'), source: /** @type {const} */ ('configured')})});
    const value = Object.freeze({
      ...(reason && { unavailable: reason }),
      profileId, providerId: profile.provider, model: profile.model, reasoning: modelView,
      capabilities: description ? capabilities : undefined,
    });
    byKind.get('profile')?.set(profileId, Object.freeze({ kind: 'profile', value }));
  }
  for (const [id, role] of Object.entries(configuration.roles ?? {})) {
    const value = Object.freeze({
      id, purpose: role.purpose, instructions: role.instructions,
      preferredProfiles: Object.freeze([...(role.preferredProfiles ?? [])]),
    });
    byKind.get('role')?.set(id, Object.freeze({ kind: 'role', value }));
  }
  for (const skill of skills?.records ?? []) {
    byKind.get('skill')?.set(skill.id, Object.freeze({ kind: 'skill', value: skill }));
  }
  for (const { id, description, effect, resource } of tools) {
    byKind.get('tool')?.set(id, Object.freeze({ kind: 'tool', value: Object.freeze({
      id, description, effect, resource,
    }) }));
  }
  const entries = Object.freeze([...byKind.values()].flatMap(items => [...items.values()]));
  return Object.freeze({
    loadSkill: skills?.loadSkill,
    preferences,
    selectReasoning(profileId, level) {
      const entry = reasoning.get(profileId);
      const availableLevels = entry?.mode === 'selectable' ? [...entry.values.keys()].sort() : [];
      if (!entry || (entry.mode === 'native' && level !== undefined) ||
          (entry.mode === 'selectable' && level !== undefined && !entry.values.has(level))) {
        return {kind: 'rejected', profileId, requestedLevel: level, availableLevels};
      }
      if (entry.mode === 'native') return {kind: 'selected', selection: Object.freeze({mode: 'native'})};
      const chosen = level ?? entry.defaultLevel;
      return {kind: 'selected', selection: Object.freeze({
        mode: 'selectable', level: chosen, nativeValue: /** @type {string} */ (entry.values.get(chosen)),
        selectionSource: level === undefined ? 'default' : 'model',
      })};
    },
    async list() { return entries; },
    async resolve(kind, id) { return byKind.get(kind)?.get(id); },
  });
}


/**
 * Resolve only explicit requirements. An absent declaration has unknown support.
 * @param {Readonly<Record<string, Capability>>} capabilities
 * @param {Iterable<string>} required
 */
export function unavailableCapabilities(capabilities, required) {
  return Array.from(required).flatMap(key => {
    const entry = Object.hasOwn(capabilities, key) ? capabilities[key] : undefined;
    if (entry?.support === 'supported') return [];
    return [{ key, support: entry?.support ?? 'unknown', detail: entry?.detail }];
  });
}

/**
 * Optional legacy Catalog implementations remain native-only. A missing
 * selectable resolver never authorizes a model-supplied override.
 * @param {Catalog} catalog @param {import('../../core/ports.js').Profile} profile @param {string} [level]
 * @returns {import('../../core/ports.js').ReasoningResolution}
 */
export function resolveRequestedReasoning(catalog, profile, level) {
  const resolved = catalog.selectReasoning?.(profile.profileId, level);
  if (resolved) return resolved;
  if (level !== undefined || profile.reasoning?.mode === 'selectable') {
    return {kind: 'rejected', profileId: profile.profileId, requestedLevel: level,
      availableLevels: profile.reasoning?.mode === 'selectable' ? profile.reasoning.levels : []};
  }
  return {kind: 'selected', selection: Object.freeze({mode: 'native'})};
}
