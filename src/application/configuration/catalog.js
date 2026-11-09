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
  /** @type {Map<CatalogEntry['kind'], Map<string, CatalogEntry>>} */
  const byKind = new Map([['profile', new Map()], ['role', new Map()], ['skill', new Map()], ['tool', new Map()]]);
  for (const [profileId, profile] of Object.entries(configuration.profiles)) {
    const description = providers.get(profile.provider);
    const capabilities = Object.freeze(Object.fromEntries(Object.entries(description?.capabilities ?? {})
      .map(([key, value]) => [key, Object.freeze({ ...value })])));
    const reason = unavailable?.get(profile.provider);
    const value = Object.freeze({
      ...(reason && { unavailable: reason }),
      profileId, providerId: profile.provider, model: profile.model, capabilities: description ? capabilities : undefined,
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
