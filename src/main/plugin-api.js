/** @import {ProviderConfig} from '../application/configuration/decode-config.js' */
/** @import {ProviderDescription, ProviderPort} from '../core/ports.js' */

/**
 * @typedef {{id: string, version: string, apiVersion: 1, exports: readonly ExtensionKind[]}} PluginManifest
 * @typedef {'createProvider' | 'loadSkill' | 'tool'} ExtensionKind
 * @typedef {(cleanup: () => void | Promise<void>) => void} RegisterCleanup
 * @typedef {(options: {providerId: string, configuration: ProviderConfig, onClose: RegisterCleanup}) =>
 *   ProviderPort | Promise<ProviderPort>} ProviderFactory
 * @typedef {(request: {id: string, content: 'metadata' | 'instructions'}) => Promise<unknown>} SkillLoader
 * @typedef {{manifest: PluginManifest, createProvider?: ProviderFactory, loadSkill?: SkillLoader, tool?: object}} Plugin
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function label(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export class PluginError extends Error {
  /** @param {string} code @param {string} path */
  constructor(code, path) {
    super(code + ' at ' + path);
    this.code = code;
    this.path = path;
  }
}

const exportNames = new Set(['createProvider', 'loadSkill', 'tool']);

/** @param {unknown} module @param {string} id @returns {Plugin} */
export function validatePlugin(module, id) {
  if (!object(module) || !object(module.manifest)) throw new PluginError('INVALID_PLUGIN', 'manifest');
  const { manifest } = module;
  if (manifest.apiVersion !== 1) throw new PluginError('UNSUPPORTED_PLUGIN_API', 'manifest.apiVersion');
  if (manifest.id !== id || !label(id)) throw new PluginError('INVALID_PLUGIN', 'manifest.id');
  if (!label(manifest.version)) throw new PluginError('INVALID_PLUGIN', 'manifest.version');
  const names = manifest.exports;
  if (!Array.isArray(names) || names.length === 0 || new Set(names).size !== names.length ||
      names.some(name => !exportNames.has(name))) {
    throw new PluginError('INVALID_PLUGIN', 'manifest.exports');
  }
  for (const name of exportNames) {
    if (!names.includes(name)) continue;
    if (name === 'tool' ? !object(module[name]) : typeof module[name] !== 'function') {
      throw new PluginError('INVALID_PLUGIN', name);
    }
  }
  return Object.freeze({
    manifest: Object.freeze({ id, version: manifest.version, apiVersion: 1, exports: Object.freeze([...names]) }),
    createProvider: names.includes('createProvider') ? /** @type {ProviderFactory} */ (module.createProvider) : undefined,
    loadSkill: names.includes('loadSkill') ? /** @type {SkillLoader} */ (module.loadSkill) : undefined,
    tool: names.includes('tool') ? /** @type {object} */ (module.tool) : undefined,
  });
}

/** @param {readonly {id: string}[]} entries */
export function duplicateExtensionIds(entries) {
  const seen = new Set();
  const duplicates = new Set();
  for (const { id } of entries) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

/** @param {unknown} value @param {string} providerId */
export async function validateProvider(value, providerId) {
  if (!object(value)) throw new PluginError('INVALID_PROVIDER', 'createProvider');
  for (const name of ['describe', 'open', 'invoke', 'cancel', 'close']) {
    if (typeof value[name] !== 'function') throw new PluginError('INVALID_PROVIDER', 'createProvider.' + name);
  }
  if ((value.lookupStatus !== undefined && typeof value.lookupStatus !== 'function') ||
      (value.supportsIdempotency !== undefined && value.supportsIdempotency !== true)) {
    throw new PluginError('INVALID_PROVIDER', 'createProvider.optional');
  }
  const provider = /** @type {ProviderPort} */ (value);
  /** @type {unknown} */
  const description = await provider.describe();
  if (!object(description) || description.providerId !== providerId ||
      (description.maxConcurrency !== null && (!Number.isSafeInteger(description.maxConcurrency) ||
        Number(description.maxConcurrency) < 1)) ||
      !object(description.capabilities)) {
    throw new PluginError('INVALID_PROVIDER', 'describe');
  }
  for (const capability of Object.values(description.capabilities)) {
    if (!object(capability) || !['supported', 'unsupported', 'unknown'].includes(String(capability.support)) ||
        !['configured', 'negotiated'].includes(String(capability.source)) ||
        (capability.detail !== undefined && typeof capability.detail !== 'string')) {
      throw new PluginError('INVALID_PROVIDER', 'describe.capabilities');
    }
  }
  return { provider, description: /** @type {ProviderDescription} */ (description) };
}
