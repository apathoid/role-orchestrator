/** @import {Configuration} from './decode-config.js' */
/** @import {Catalog, CatalogEntry, ProviderDescription} from '../../core/ports.js' */

/**
 * Capture the model-facing portion of trusted configuration. Launch commands,
 * environment references and adapter-native settings remain in composition.
 * @param {Configuration} configuration
 * @param {readonly ProviderDescription[]} [descriptions]
 * @returns {Catalog}
 */
export function createCatalog(configuration, descriptions = []) {
  const providers = new Map(descriptions.map(item => [item.providerId, item]));
  /** @type {Map<CatalogEntry['kind'], Map<string, CatalogEntry>>} */
  const byKind = new Map([['profile', new Map()], ['role', new Map()]]);
  for (const [profileId, profile] of Object.entries(configuration.profiles)) {
    const description = providers.get(profile.provider);
    const capabilities = Object.freeze(Object.fromEntries(Object.entries(description?.capabilities ?? {})
      .map(([key, value]) => [key, Object.freeze({ ...value })])));
    const value = Object.freeze({
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
  const entries = Object.freeze([...byKind.values()].flatMap(items => [...items.values()]));
  return Object.freeze({
    async list() { return entries; },
    async resolve(kind, id) { return byKind.get(kind)?.get(id); },
  });
}
