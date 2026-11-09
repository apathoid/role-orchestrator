import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createLocalStateStore } from '../adapters/state/local-store.js';
import { loadProjectPreferences } from '../adapters/configuration/project-file.js';
import { createAuthorityGrant } from '../application/configuration/authority.js';
import { decodeConfiguration } from '../application/configuration/decode-config.js';
import { createPermissionBroker } from '../application/configuration/permissions.js';
import { createOrchestrator } from '../application/orchestrator.js';
import { noopDiagnostics } from '../core/diagnostics.js';
import { loadExtensions } from './extensions.js';

/** @import {DiagnosticPort} from '../core/diagnostics.js' */
/** @import {AuthorityPort} from '../core/ports.js' */

export class RuntimeError extends Error {
  /** @param {string} code @param {string} message @param {string} [path] */
  constructor(code, message, path) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

/**
 * @typedef {{
 *   configuration: string, configurationDirectory?: string, stateDirectory?: string,
 *   project?: {cwd?: string, path?: string}, launch?: unknown,
 *   diagnostics?: DiagnosticPort, authority?: AuthorityPort,
 *   permissions?: Omit<Parameters<typeof createPermissionBroker>[0], 'authority' | 'ids'>
 * }} RuntimeOptions
 */

/** @param {RuntimeOptions} options */
export async function openRuntime(options) {
  const { diagnostics = noopDiagnostics } = options;
  const config = await decodeConfiguration(options.configuration);
  if (config.kind === 'rejected') {
    throw new RuntimeError(config.reason.code, config.reason.constraint, config.reason.path);
  }
  const project = await loadProjectPreferences(options.project ?? {});
  if (project.kind === 'unavailable') throw new RuntimeError('INVALID_CONFIGURATION', 'Cannot read project preferences', project.path);
  const location = options.stateDirectory ?? config.value.storage?.directory;
  if (!location || (!isAbsolute(location) && !options.configurationDirectory)) {
    throw new RuntimeError('INVALID_CONFIGURATION', 'State directory requires an absolute path or a configuration directory', '/storage/directory');
  }
  const directory = resolve(options.configurationDirectory ?? '/', location);
  const store = createLocalStateStore(directory);
  const clock = { now: Date.now, monotonicNow: () => performance.now() };
  const ids = { newId: randomUUID };
  const configurationRef = 'config:' + createHash('sha256').update(options.configuration).digest('hex');
  const authority = options.authority ?? createAuthorityGrant({
    reference: 'local-user', origin: 'user', profileIds: Object.keys(config.value.profiles),
  });
  await mkdir(directory, { mode: 0o700, recursive: true });
  await store.open(config.value.storage?.artifactRetention);
  /** @type {Awaited<ReturnType<typeof loadExtensions>> | undefined} */
  let extensions;
  try {
    const registry = extensions = await loadExtensions(config.value, {
      directory: options.configurationDirectory, clock, ids, diagnostics, launchOptions: options.launch,
      projectText: project.kind === 'available' ? project.text : undefined,
    });
    const { selection, catalog } = registry;
    if (selection.kind === 'rejected') {
      throw new RuntimeError('INVALID_CONFIGURATION', selection.source + ': ' + selection.constraint, selection.path);
    }
    const selected = await registry.selectController();
    if (selected.kind === 'unavailable') {
      throw new RuntimeError('CAPABILITY_UNAVAILABLE', selected.reason, '/controllerProfile');
    }
    const permissions = createPermissionBroker({ ...options.permissions, authority, ids });
    const coordinator = createOrchestrator({
      store, catalog, profile: selected.profile, provider: selected.provider, providerFor: registry.providerFor,
      clock, ids, authority, permissions, configurationRef, diagnostics, tools: registry.tools,
      context: selection.value.context, limits: {
        maxInvocations: selection.value.resources.maxInvocationsPerOperation,
        maxConcurrentInvocations: selection.value.resources.maxConcurrentInvocations,
      },
      invocationTimeoutMs: selection.value.resources.invocationTimeoutMs,
    });
    /** @type {Promise<void> | undefined} */
    let closing;
    return {
      coordinator, permissions, configurationRef, directory, catalog,
      close() {
        return closing ??= coordinator.close().finally(async () => {
          try { await registry.close(); }
          finally {
            try { await diagnostics.flush(); } catch { /* Best effort. */ }
            await store.close();
          }
        });
      },
    };
  } catch (error) {
    try { await extensions?.close(); }
    finally {
      try { await diagnostics.flush(); } catch { /* Best effort. */ }
      await store.close();
    }
    throw error;
  }
}
