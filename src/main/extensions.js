import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAcpProvider } from '../adapters/acp/provider.js';
import { createCodexProvider } from '../adapters/cli/codex-provider.js';
import { compileExternalTool, createExternalToolPort } from '../application/configuration/external-tools.js';
import { resolveConfiguration } from '../application/configuration/resolve-config.js';
import { createCatalog } from '../application/configuration/catalog.js';
import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { createSkillRegistry } from './skill-registry.js';
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
 * @param {{directory?: string, clock: Clock, ids: IdFactory, diagnostics?: DiagnosticPort,
 *   projectText?: string, launchOptions?: unknown, acp?: Pick<Parameters<typeof createAcpProvider>[0], 'bridge' | 'bridgeCapabilities'>}} options
 */
export async function loadExtensions(configuration, { directory, clock, ids, diagnostics = noopDiagnostics, projectText, launchOptions, acp }) {
  configuration = structuredClone(configuration);
  /** @type {Map<string, string>} */
  const pluginFailures = new Map();
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
  /** @type {Promise<void> | undefined} */
  let closing;
  function close() {
    providers.clear();
    plugins.clear();
    return closing ??= (async () => {
      for (const release of releases.reverse()) await release();
    })();
  }
  try {
    const entries = configuration.plugins ?? [];
    const duplicates = duplicateExtensionIds(entries);
    for (const { id, module, enabled } of entries) {
      if (enabled === false) { pluginFailures.set(id, 'PLUGIN_DISABLED'); continue; }
      if (duplicates.has(id) || builtins.has(id)) {
        pluginFailures.set(id, 'DUPLICATE_EXTENSION_ID');
        report('plugin.load_failed', id, 'DUPLICATE_EXTENSION_ID', 'manifest.id');
        continue;
      }
      try {
        const loaded = await import(pluginSpecifier(module, directory));
        plugins.set(id, validatePlugin(loaded, id));
        report('plugin.loaded', id, 'LOADED');
      } catch (error) {
        const reason = error instanceof PluginError ? error.code : 'PLUGIN_IMPORT_FAILED';
        pluginFailures.set(id, reason);
        report('plugin.load_failed', id, reason, error instanceof PluginError ? error.path : 'module');
      }
    }
    for (const [id, endpoint] of Object.entries(configuration.providers)) {
      const factory = builtins.get(endpoint.adapter) ?? plugins.get(endpoint.adapter)?.createProvider;
      if (!factory) {
        const reason = pluginFailures.get(endpoint.adapter) ?? 'PROVIDER_FACTORY_UNAVAILABLE';
        unavailable.set(id, reason);
        report('provider.load_failed', id, reason, 'adapter');
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
          ...(endpoint.adapter === 'acp' && acp),
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
    const skills = await createSkillRegistry(configuration.skills ?? [], plugins);
    const configuredTools = configuration.tools ?? [];
    const duplicateTools = duplicateExtensionIds(configuredTools);
    const tools = new Map();
    for (const id of new Set(configuredTools.map(tool => tool.id))) {
      const exports = [...plugins.values()].filter(plugin => plugin.tool?.id === id);
      const duplicate = duplicateTools.has(id) || exports.length > 1;
      const tool = !duplicate && exports.length === 1 ? await compileExternalTool(exports[0].tool) : undefined;
      if (tool) tools.set(id, tool);
      else report('tool.load_failed', id, duplicate ? 'DUPLICATE_EXTENSION_ID' : 'INVALID_TOOL', 'tool');
    }
    const installed = {
      profiles: new Set(Object.entries(configuration.profiles).flatMap(([id, profile]) => providers.has(profile.provider) ? [id] : [])),
      skills: new Set(skills.records.flatMap(skill => skill.version ? [skill.id] : [])),
    };
    /** @param {string} [text] */
    const resolveProject = text => resolveConfiguration(configuration, text, launchOptions, installed);
    const selection = resolveProject(projectText);
    const selectedProfile = selection.kind === 'accepted' ? selection.value.controllerProfile : undefined;
    const catalog = createCatalog(configuration, descriptions, skills, [...tools.values()].map(tool => tool.metadata), { unavailable });
    /** @param {import('../application/configuration/resolve-config.js').EffectiveConfiguration} value */
    function projectCatalog(value) {
      return { ...catalog, preferences: value.preferredRole || value.preferredSkills.length
        ? Object.freeze({ roleId: value.preferredRole, skillIds: Object.freeze([...value.preferredSkills]) }) : undefined };
    }
    return Object.freeze({
      catalog: selection.kind === 'accepted' ? Object.freeze(projectCatalog(selection.value)) : catalog,
      selection, resolveProject, projectCatalog,
      async selectController(profileId = selectedProfile) {
        if (profileId === undefined) return {
          kind: /** @type {const} */ ('unavailable'), profileId: configuration.controllerProfile, reason: 'PREFERENCES_REJECTED',
        };
        const entry = await catalog.resolve('profile', profileId);
        if (entry?.kind !== 'profile') return { kind: /** @type {const} */ ('unavailable'), profileId, reason: 'UNKNOWN_PROFILE' };
        const profile = entry.value;
        const provider = providers.get(profile.providerId);
        return provider ? { kind: /** @type {const} */ ('available'), profile, provider }
          : { kind: /** @type {const} */ ('unavailable'), profileId, reason: profile.unavailable ?? 'EXTENSIONS_CLOSED' };
      },
      tools: tools.size ? createExternalToolPort(tools) : undefined,
      /** @param {Profile} profile */
      providerFor(profile) { return providers.get(profile.providerId); },
      /** @param {string} providerId */
      unavailableProvider(providerId) { return unavailable.get(providerId); },
      close() {
        tools.clear();
        return close();
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
