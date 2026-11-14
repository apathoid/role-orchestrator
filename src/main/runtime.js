import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createLocalStateStore } from '../adapters/state/local-store.js';
import { loadProjectPreferences } from '../adapters/configuration/project-file.js';
import { createAuthorityGrant } from '../application/configuration/authority.js';
import { decodeConfiguration } from '../application/configuration/decode-config.js';
import { createPermissionBroker } from '../application/configuration/permissions.js';
import { createOrchestrator } from '../application/orchestrator.js';
import { createEventStream } from '../application/events.js';
import { operationTrace } from '../hosts/commands.js';
import { loadExtensions } from './extensions.js';
import { createNdjsonSink } from '../adapters/state/ndjson-diagnostics.js';

/** @import {DiagnosticPort} from '../core/diagnostics.js' */
/** @import {AuthorityPort} from '../core/ports.js' */

import { RuntimeError } from './runtime-error.js';

/**
 * @typedef {{
 *   configuration: string, configurationDirectory?: string, stateDirectory?: string,
 *   project?: {cwd?: string, path?: string}, launch?: unknown,
 *   diagnostics?: DiagnosticPort, authority?: AuthorityPort,
 *   acp?: NonNullable<Parameters<typeof loadExtensions>[1]['acp']>,
 *   permissions?: Omit<Parameters<typeof createPermissionBroker>[0], 'authority' | 'ids'>
 * }} RuntimeOptions
 */

/** @param {RuntimeOptions} options @param {() => Promise<void>} [onStoreOpen] */
export async function openRuntime(options, onStoreOpen) {
  // The persisted operation journal is authoritative; diagnostic I/O is best effort.
  // Create the sink only after resolving the state directory.
  const config = await decodeConfiguration(options.configuration);
  if (config.kind === 'rejected') {
    throw new RuntimeError(config.reason.code, config.reason.constraint, config.reason.path);
  }
  const location = options.stateDirectory ?? config.value.storage?.directory;
  if (!location || (!isAbsolute(location) && !options.configurationDirectory)) {
    throw new RuntimeError('INVALID_CONFIGURATION', 'State directory requires an absolute path or a configuration directory', '/storage/directory');
  }
  const directory = resolve(options.configurationDirectory ?? '/', location);
  const secretValues = Object.values(config.value.providers).flatMap(provider =>
    Object.values(provider.launch?.env ?? {}).flatMap(ref => {
      const value = process.env[ref.fromEnv];
      return value && value.length >= 4 ? [value] : [];
    }));
  const diagnostics = createEventStream(options.diagnostics ?? createNdjsonSink({
    directory: resolve(directory, 'diagnostics'),
    maxFileBytes: config.value.diagnostics?.maxFileBytes,
    retainedFiles: config.value.diagnostics?.retainedFiles,
  }), { secrets: secretValues, captureBodies: config.value.diagnostics?.captureBodies });
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
    await onStoreOpen?.();
    const registry = extensions = await loadExtensions(config.value, {
      directory: options.configurationDirectory, clock, ids, diagnostics, launchOptions: options.launch, acp: options.acp,
    });
    const { selection, catalog } = registry;
    /** @param {typeof selection} resolved */
    function requireConfiguration(resolved) {
      if (resolved.kind === 'rejected') {
        throw new RuntimeError('INVALID_CONFIGURATION', resolved.source + ': ' + resolved.constraint, resolved.path);
      }
      return resolved.value;
    }
    const base = requireConfiguration(selection);
    /** @param {import('../core/contracts.js').Request['workspaceContext']} workspace */
    async function resolveExecution(workspace) {
      const project = await loadProjectPreferences(options.project?.path !== undefined
        ? options.project : { cwd: workspace?.cwd ?? options.project?.cwd });
      if (project.kind === 'unavailable') throw new RuntimeError('INVALID_CONFIGURATION', 'Cannot read project preferences', project.path);
      const selectedConfig = project.kind === 'available' ? requireConfiguration(registry.resolveProject(project.text)) : base;
      const selected = await registry.selectController(selectedConfig.controllerProfile);
      if (selected.kind === 'unavailable') {
        throw new RuntimeError('CAPABILITY_UNAVAILABLE', selected.reason, '/controllerProfile');
      }
      return {
        catalog: registry.projectCatalog(selectedConfig), profile: selected.profile, provider: selected.provider,
        limits: {
          maxInvocations: selectedConfig.resources.maxInvocationsPerOperation,
          maxConcurrentInvocations: selectedConfig.resources.maxConcurrentInvocations,
        },
        invocationTimeoutMs: selectedConfig.resources.invocationTimeoutMs,
      };
    }
    if (options.project) await resolveExecution(undefined);
    const permissions = createPermissionBroker({
      standing: config.value.permissions?.standing, ...options.permissions, authority, ids,
    });
    const coordinator = createOrchestrator({
      store, resolveExecution, providerFor: registry.providerFor,
      clock, ids, authority, permissions, configurationRef, diagnostics, tools: registry.tools,
      context: base.context, limits: {
        maxInvocations: base.resources.maxInvocationsPerOperation,
        maxConcurrentInvocations: base.resources.maxConcurrentInvocations,
      },
    });
    /** @type {Promise<void> | undefined} */
    let closing;
    function close() {
      return closing ??= coordinator.close().finally(async () => {
        try { await registry.close(); }
        finally {
          try { await diagnostics.flush(); } catch { /* Best effort. */ }
          diagnostics.close();
          await store.close();
        }
      });
    }
    const { submit, resume, inspect, inspectFinding, findRequest, cancel } = coordinator;
    /** @param {string} operationId */
    const trace = async operationId => operationTrace(await inspect(operationId), { secrets: secretValues });
    const api = Object.freeze({ submit, resume, inspect, inspectFinding, findRequest, cancel,
      trace,
      subscribe: diagnostics.subscribe, configurationRef, close });
    return { api, coordinator, permissions, configurationRef, directory, catalog, close };
  } catch (error) {
    try { await extensions?.close(); }
    finally {
      try { await diagnostics.flush(); } catch { /* Best effort. */ }
      diagnostics.close();
      await store.close();
    }
    throw error;
  }
}

/** @param {RuntimeOptions} options */
export async function openOrchestrator(options) {
  return (await openRuntime(options)).api;
}
