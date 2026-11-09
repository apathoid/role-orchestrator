import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAcpProvider } from '../adapters/acp/provider.js';
import { createCodexProvider } from '../adapters/cli/codex-provider.js';
import { createCatalog } from '../application/configuration/catalog.js';
import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { duplicateExtensionIds, PluginError, validatePlugin, validateProvider } from './plugin-api.js';

/** @import {Configuration} from '../application/configuration/decode-config.js' */
/** @import {Clock, DiagnosticPort, IdFactory} from '../core/diagnostics.js' */
/** @import {Profile, ProviderDescription, ProviderPort} from '../core/ports.js' */
/** @import {Plugin, ProviderFactory} from './plugin-api.js' */

/** @type {ReadonlyMap<string, ProviderFactory>} */
const builtins = new Map([['acp', createAcpProvider], ['codex-cli', createCodexProvider]]);

/** @param {string} specifier @param {string | undefined} directory */
function pluginSpecifier(specifier, directory) {
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (directory === undefined || !isAbsolute(directory)) throw new PluginError('INVALID_PLUGIN_PATH', 'module');
    return pathToFileURL(resolve(directory, specifier)).href;
  }
  // Bare packages are resolved by Node relative to this installed package.
  if (!/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/.test(specifier) ||
      specifier.split('/').some(part => part === '.' || part === '..')) {
    throw new PluginError('INVALID_PLUGIN_PATH', 'module');
  }
  return specifier;
}

/**
 * Compose extensions from decoded trusted configuration. Close after the
 * orchestrators using this registry have stopped. A new trusted config gets a
 * new registry, while the StateStore remains with the calling Host.
 * @param {Configuration} configuration
 * @param {{directory?: string, clock: Clock, ids: IdFactory, diagnostics?: DiagnosticPort}} options
 */
export async function loadExtensions(configuration, { directory, clock, ids, diagnostics = noopDiagnostics }) {
  /** @type {Map<string, Plugin>} */
  const plugins = new Map();
  /** @type {Map<string, ProviderPort>} */
  const providers = new Map();
  /** @type {ProviderDescription[]} */
  const descriptions = [];
  /** @type {Map<string, string>} */
  const unavailable = new Map();
  /** @type {(() => Promise<void>)[]} */
  const releases = [];
  let sequence = 0;
  /** @param {string} eventName @param {string} id @param {string} reasonCode @param {string} [path] */
  function report(eventName, id, reasonCode, path) {
    emitDiagnostic(diagnostics, {
      schemaVersion: 1, eventId: ids.newId(), sequence: ++sequence, receivedAt: clock.now(),
      component: 'extensions', level: eventName.endsWith('.loaded') ? 'info' : 'warn',
      eventName, reasonCode, details: { id, ...(path === undefined ? {} : { path }) },
    });
  }
  const entries = configuration.plugins ?? [];
  const duplicates = duplicateExtensionIds(entries);
  for (const { id, module, enabled } of entries) {
    if (enabled === false) continue;
    if (duplicates.has(id) || builtins.has(id)) {
      report('plugin.load_failed', id, 'DUPLICATE_EXTENSION_ID', 'manifest.id');
      continue;
    }
    try {
      const loaded = await import(pluginSpecifier(module, directory));
      plugins.set(id, validatePlugin(loaded, id));
      report('plugin.loaded', id, 'LOADED');
    } catch (error) {
      report('plugin.load_failed', id, error instanceof PluginError ? error.code : 'PLUGIN_IMPORT_FAILED',
        error instanceof PluginError ? error.path : 'module');
    }
  }
  for (const [id, endpoint] of Object.entries(configuration.providers)) {
    const factory = builtins.get(endpoint.adapter) ?? plugins.get(endpoint.adapter)?.createProvider;
    if (!factory) {
      unavailable.set(id, 'PROVIDER_FACTORY_UNAVAILABLE');
      report('provider.load_failed', id, 'PROVIDER_FACTORY_UNAVAILABLE', 'adapter');
      continue;
    }
    /** @type {(() => void | Promise<void>)[]} */
    const cleanup = [];
    async function release() {
      for (const dispose of cleanup.splice(0).reverse()) {
        try { await dispose(); } catch { report('provider.cleanup_failed', id, 'PLUGIN_CLEANUP_FAILED'); }
      }
    }
    try {
      const value = await factory({
        providerId: id, configuration: structuredClone(endpoint),
        onClose(dispose) {
          if (typeof dispose !== 'function') throw new PluginError('INVALID_PROVIDER', 'onClose');
          cleanup.push(dispose);
        },
      });
      const { provider, description } = await validateProvider(value, id);
      releases.push(release);
      providers.set(id, provider);
      descriptions.push(description);
      report('provider.loaded', id, 'LOADED');
    } catch (error) {
      unavailable.set(id, error instanceof PluginError ? error.code : 'PROVIDER_INIT_FAILED');
      report('provider.load_failed', id, unavailable.get(id) ?? 'PROVIDER_INIT_FAILED',
        error instanceof PluginError ? error.path : 'createProvider');
      await release();
    }
  }
  const catalog = createCatalog(configuration, descriptions);
  /** @type {Promise<void> | undefined} */
  let closing;
  return Object.freeze({
    catalog,
    /** @param {Profile} profile */
    providerFor(profile) { return providers.get(profile.providerId); },
    /** @param {string} providerId */
    unavailableProvider(providerId) { return unavailable.get(providerId); },
    close() {
      providers.clear();
      return closing ??= (async () => {
        for (const release of releases.reverse()) await release();
      })();
    },
  });
}
