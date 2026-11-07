/** @import {Outcome, Request} from './contracts.js' */
/** @import {Operation} from './operation.js' */

/**
 * @typedef {'supported' | 'unsupported' | 'unknown'} Support
 * @typedef {{support: Support, source: 'configured' | 'negotiated'}} Capability
 * @typedef {{providerId: string, maxConcurrency: number | null, capabilities: Readonly<Record<string, Capability>>}} ProviderDescription
 * @typedef {{profileId: string, providerId: string, model: string, capabilities?: Readonly<Record<string, Capability>>}} Profile
 * @typedef {{sessionId: string}} ProviderSession
 * @typedef {{ref: string, value?: unknown, completeness: 'complete' | 'truncated' | 'unavailable',
 *   source: 'user' | 'host_observed' | 'provider_reported' | 'model_claim'}} ContextItem
 * @typedef {{attemptId: string, operationId: string, actionId: string, kind: 'controller' | 'delegate',
 *   objective: string, expectedResult?: string, continuationReference?: string, instructions: readonly string[], profile: Profile, workspaceContext?: Request['workspaceContext'],
 *   attachments?: readonly Request['attachments'][number][], requiredCapabilities?: readonly string[],
 *   userConstraints: readonly string[], context: readonly ContextItem[], authorityRef: string, timeoutMs: number,
 *   signal: AbortSignal, permissions?: Pick<AttemptPermissions, 'request'>}} Invocation
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
 *   {kind: 'role' | 'skill', value: {id: string, instructions: string, purpose?: string, preferredProfiles?: readonly string[]}} |
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
 * @typedef {{reference: string, authorize: (reference: string, profileId: string) =>
 *   'ALLOWED' | 'PERMISSION_DENIED' | 'REVOKED'}} AuthorityPort
 * @typedef {{id: string, kind: 'allow' | 'deny'}} PermissionOption
 * @typedef {{providerRequestId: string, resource: string, options: readonly PermissionOption[]}} PermissionRequest
 * @typedef {{kind: 'selected', option: string} | {kind: 'denied' | 'cancelled' | 'unavailable' | 'invalid'}} PermissionResult
 * @typedef {{request: (request: PermissionRequest) => Promise<PermissionResult>, close: () => void}} AttemptPermissions
 * @typedef {{
 *   bind: (attempt: {attemptId: string, authorityRef: string, profileId: string, signal: AbortSignal,
 *     report?: (event: 'permission.requested' | 'permission.resolved' | 'permission.expired', reason: string) => void
 *   }) => AttemptPermissions
 * }} PermissionPort
 */

export {};
