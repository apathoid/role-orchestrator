/** @import {Outcome, Request} from './contracts.js' */
/** @import {Operation} from './operation.js' */

/**
 * @typedef {'supported' | 'unsupported' | 'unknown'} Support
 * @typedef {{support: Support, source: 'configured' | 'negotiated'}} Capability
 * @typedef {{providerId: string, maxConcurrency: number | null, capabilities: Readonly<Record<string, Capability>>}} ProviderDescription
 * @typedef {{profileId: string, providerId: string, model: string}} Profile
 * @typedef {{sessionId: string}} ProviderSession
 * @typedef {{ref: string, value?: unknown, completeness: 'complete' | 'truncated' | 'unavailable',
 *   source: 'user' | 'host_observed' | 'provider_reported' | 'model_claim'}} ContextItem
 * @typedef {{attemptId: string, operationId: string, actionId: string, kind: 'controller' | 'delegate',
 *   objective: string, expectedResult?: string, continuationReference?: string, instructions: readonly string[], profile: Profile, workspaceContext?: Request['workspaceContext'],
 *   userConstraints: readonly string[], context: readonly ContextItem[], authorityRef: string, timeoutMs: number,
 *   signal: AbortSignal}} Invocation
 * @typedef {{outcome: Outcome, output?: unknown, dispatchCertainty: 'not_sent' | 'sent' | 'unknown'}} ProviderResult
 * @typedef {{
 *   describe: () => Promise<ProviderDescription>,
 *   open: (profile: Profile, signal: AbortSignal) => Promise<ProviderSession>,
 *   invoke: (session: ProviderSession, request: Invocation, observe: (item: ContextItem) => void) => Promise<ProviderResult>,
 *   cancel: (session: ProviderSession, attemptId: string) => Promise<void>,
 *   close: (session: ProviderSession) => Promise<void>
 * }} ProviderPort
 *
 * @typedef {{kind: 'committed'} | {kind: 'conflict'} | {kind: 'unavailable'}} CommitResult
 * @typedef {{
 *   open: () => Promise<void>,
 *   load: (operationId: string) => Promise<Operation | undefined>,
 *   commit: (operationId: string, expectedRevision: number | null, next: Operation) => Promise<CommitResult>,
 *   list: () => Promise<readonly Operation[]>,
 *   close: () => Promise<void>
 * }} StateStore
 *
 * @typedef {{kind: 'profile', value: Profile} |
 *   {kind: 'role' | 'skill', value: {id: string, instructions: string}} |
 *   {kind: 'tool', value: {id: string, description: string}}} CatalogEntry
 * @typedef {{
 *   list: () => Promise<readonly CatalogEntry[]>,
 *   resolve: (kind: CatalogEntry['kind'], id: string) => Promise<CatalogEntry | undefined>
 * }} Catalog
 * @typedef {{
 *   materialize: (refs: readonly string[], budget: number) => Promise<readonly ContextItem[]>,
 *   append: (items: readonly ContextItem[]) => Promise<void>,
 *   fetchArtifact: (ref: string) => Promise<ContextItem>
 * }} ContextPort
 * @typedef {{
 *   request: (attemptId: string, providerRequestId: string, options: readonly string[]) =>
 *     Promise<{kind: 'selected', option: string} | {kind: 'denied' | 'cancelled'}>,
 *   cancel: (requestId: string) => Promise<void>
 * }} PermissionPort
 */

export {};
