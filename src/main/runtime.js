import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createLocalStateStore } from '../adapters/state/local-store.js';
import { loadProjectPreferences } from '../adapters/configuration/project-file.js';
import { createAuthorityGrant } from '../application/configuration/authority.js';
import { decodeConfiguration } from '../application/configuration/decode-config.js';
import { createInteractionBroker } from '../application/interactions.js';
import { createPermissionBroker } from '../application/configuration/permissions.js';
import { createOrchestrator } from '../application/orchestrator.js';
import { describeUserSettings, resolveFeatureChoices, workerApproval, approvalMappingsRef } from '../application/configuration/user-settings.js';
import { sameRecord } from '../core/operation.js';
import { createEventStream } from '../application/events.js';
import { operationTrace } from '../hosts/commands.js';
import { loadExtensions } from './extensions.js';
import { knownConfigurationSecrets } from './configuration-secrets.js';
import { createNdjsonSink, defaultDiagnosticMaxFileBytes, defaultDiagnosticQueueMaxBytes } from '../adapters/state/ndjson-diagnostics.js';

/** @import {DiagnosticPort} from '../core/diagnostics.js' */
/** @import {AuthorityPort} from '../core/ports.js' */

import { RuntimeError } from './runtime-error.js';

/**
 * @typedef {{
 *   configuration: string, configurationDirectory?: string, stateDirectory?: string,
 *   project?: {cwd?: string, path?: string}, launch?: unknown,
 *   diagnostics?: DiagnosticPort, authority?: AuthorityPort,
 *   acp?: NonNullable<Parameters<typeof loadExtensions>[1]['acp']>,
 *   permissions?: Omit<Parameters<typeof createPermissionBroker>[0], 'authority' | 'ids'>,
 *   interactions?: Omit<Parameters<typeof createInteractionBroker>[0], 'ids'>
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
  const redaction = knownConfigurationSecrets(config.value.providers);
  const secretValues = redaction.secrets;
  const diagnostics = createEventStream(options.diagnostics ?? createNdjsonSink({
    directory: resolve(directory, 'diagnostics'),
    maxFileBytes: config.value.diagnostics?.maxFileBytes,
    retainedFiles: config.value.diagnostics?.retainedFiles,
  }), { secrets: secretValues, captureBodies: config.value.diagnostics?.captureBodies,
    maxPrivateRecordBytes: Math.min(config.value.diagnostics?.maxFileBytes ?? defaultDiagnosticMaxFileBytes, defaultDiagnosticQueueMaxBytes) });
  if (config.value.diagnostics?.captureBodies) {
    try { process.stderr.write('Warning: diagnostic prompt capture is enabled; arbitrary prompt text may contain sensitive data.\n'); } catch { /* Best effort warning. */ }
  }
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
      directory: options.configurationDirectory, clock, ids, diagnostics,
      privateDiagnostics:{emit:diagnostics.emitPrivate,flush:()=>{}}, launchOptions: options.launch, acp: options.acp,
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
    async function workspaceConfiguration(workspace) {
      const project = await loadProjectPreferences(options.project?.path !== undefined
        ? options.project : { cwd: workspace?.cwd ?? options.project?.cwd });
      if (project.kind === 'unavailable') throw new RuntimeError('INVALID_CONFIGURATION', 'Cannot read project preferences', project.path);
      return project.kind === 'available' ? requireConfiguration(registry.resolveProject(project.text)) : base;
    }
    /** @param {import('../core/contracts.js').Request['workspaceContext']} workspace
     * @param {string} [controllerProfile] @param {import('../core/contracts.js').UserSettings} [overrides]
     */
    async function settings(workspace, controllerProfile, overrides) {
      return describeUserSettings(await workspaceConfiguration(workspace),catalog,authority,registry.providerFor,controllerProfile,overrides);
    }
    /** @param {import('../core/contracts.js').Request['workspaceContext']} workspace @param {string} [controllerProfile]
     * @param {import('../core/ports.js').SettingsInput} [input]
     */
    async function resolveExecution(workspace, controllerProfile, input={}) {
      const selectedConfig = await workspaceConfiguration(workspace);
      const requested=input.recovery?.profileId??controllerProfile;
      if (requested !== undefined) {
        const decision = authority.authorize(authority.reference, requested);
        if (decision !== 'ALLOWED') throw new RuntimeError(decision, 'Controller profile is outside the active grant', '/controllerProfile');
      }
      const selected = await registry.selectController(requested ?? selectedConfig.controllerProfile);
      if (selected.kind === 'unavailable') {
        throw new RuntimeError('CAPABILITY_UNAVAILABLE', selected.reason, '/controllerProfile');
      }
      const resolved=resolveFeatureChoices(selectedConfig,selected.profile.profileId,input.recovery?.overrides??input.explicit,input.inherited);
      if(resolved.kind==='rejected')throw new RuntimeError('CAPABILITY_UNAVAILABLE','Unknown logical user setting',resolved.path);
      const {choices,overrides}=resolved;
      /** @type {import('../core/ports.js').AcceptedSettings|undefined} */
      let accepted=requested!==undefined||Object.keys(choices).length?{
        profileId:selected.profile.profileId,providerId:selected.profile.providerId,model:selected.profile.model,configurationRef,
        ...(Object.keys(overrides).length&&{overrides}),...choices,
        ...(approvalMappingsRef(selectedConfig,choices.approvalMode)&&{approvalMappingsRef:approvalMappingsRef(selectedConfig,choices.approvalMode)}),
      }:undefined;
      if(input.recovery) {
        const {configurationRef:_current,...effective}=accepted??{};
        const {configurationRef:_historical,...historical}=input.recovery;
        if(!sameRecord(effective,historical))throw new RuntimeError('CAPABILITY_UNAVAILABLE','Accepted Controller settings are no longer compatible','/userSettings');
        accepted=input.recovery;
      }
      return {
        catalog: registry.projectCatalog(selectedConfig), profile: selected.profile, provider: selected.provider,
        settings:accepted, ...(accepted?.approvalMode&&{workerApproval:(/** @type {import('../core/ports.js').Profile} */ profile)=>workerApproval(selectedConfig,profile.profileId,accepted?.approvalMode)}),
        limits: {
          maxInvocations: selectedConfig.resources.maxInvocationsPerOperation,
          maxConcurrentInvocations: selectedConfig.resources.maxConcurrentInvocations,
        },
        defaultedLimits: {
          maxInvocations: selectedConfig.defaultedResourceCeilings.maxInvocationsPerOperation,
          maxConcurrentInvocations: selectedConfig.defaultedResourceCeilings.maxConcurrentInvocations,
        },
        invocationTimeoutMs: selectedConfig.resources.invocationTimeoutMs,
      };
    }
    if (options.project) await resolveExecution(undefined);
    const permissions = createPermissionBroker({
      standing: config.value.permissions?.standing, ...options.permissions, authority, ids,
    });
    const interactions = createInteractionBroker({ ...options.interactions, ids });
    const coordinator = createOrchestrator({
      store, resolveExecution, providerFor: registry.providerFor,
      clock, ids, authority, permissions, interactions: options.interactions ? interactions : undefined, configurationRef, diagnostics, committedDiagnostic:diagnostics.emit, tools: registry.tools,
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
    const { submit, resume, inspect, inspectFinding, findRequest, cancel, subscribeActivity } = coordinator;
    /** @param {string} operationId */
    const trace = async operationId => operationTrace(await inspect(operationId), redaction);
    const api = Object.freeze({ submit, resume, inspect, inspectFinding, findRequest, cancel, settings,
      trace,
      subscribe: diagnostics.subscribe, subscribeExecution: (/** @type {import('../core/ports.js').ActivityScope} */ scope, /** @type {import('../application/events.js').EventListener} */ listener) => diagnostics.subscribe(listener, scope), subscribeActivity, pendingInteractions: interactions.pending,
      respondInteraction: interactions.respond, configurationRef, close });
    return { api, coordinator, permissions, interactions, configurationRef, directory, catalog, close };
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
