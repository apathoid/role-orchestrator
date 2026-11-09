/** @import {ArtifactReference, ContextItem, ProviderObservation} from './observation.js' */
/** @import {Outcome, Request} from './contracts.js' */
/** @import {Operation} from './operation.js' */

/**
 * @typedef {'supported' | 'unsupported' | 'unknown'} Support
 * @typedef {{support: Support, source: 'configured' | 'negotiated', detail?: string}} Capability
 * @typedef {{providerId: string, maxConcurrency: number | null, capabilities: Readonly<Record<string, Capability>>}} ProviderDescription
 * @typedef {{profileId: string, providerId: string, model: string, capabilities?: Readonly<Record<string, Capability>>}} Profile
 * @typedef {{sessionId: string}} ProviderSession
 * @typedef {{attemptId: string, operationId: string, actionId: string, kind: 'controller' | 'delegate',
 *   objective: string, expectedResult?: string, continuationReference?: string, instructions: readonly string[], profile: Profile, workspaceContext?: Request['workspaceContext'],
 *   attachments?: readonly Request['attachments'][number][], requiredCapabilities?: readonly string[],
 *   userConstraints: readonly string[], skillInstructions?: readonly SkillInstructions[], context: readonly ContextItem[], authorityRef: string, timeoutMs: number,
 *   signal: AbortSignal, contextAccess?: ContextPort, idempotencyKey?: string, permissions?: Pick<AttemptPermissions, 'request'>}} Invocation
 * @typedef {{outcome: Outcome, output?: unknown, findings?: unknown, dispatchCertainty: 'not_sent' | 'sent' | 'unknown'}} ProviderResult
 * @typedef {{
 *   describe: () => Promise<ProviderDescription>,
 *   supportsIdempotency?: true,
 *   open: (profile: Profile, signal: AbortSignal) => Promise<ProviderSession>,
 *   invoke: (session: ProviderSession, request: Invocation, observe: (item: ProviderObservation) => string | undefined) => Promise<ProviderResult>,
 *   lookupStatus?: (query: {operationId: string, attemptId: string, profile: Profile, signal: AbortSignal}) =>
 *     Promise<Pick<ProviderResult, 'outcome' | 'dispatchCertainty'> | undefined>,
 *   cancel: (session: ProviderSession, attemptId: string) => Promise<void>,
 *   close: (session: ProviderSession) => Promise<void>
 * }} ProviderPort
 *
 * @typedef {'corrupt_snapshot' | 'unsupported_version' | 'io'} SnapshotUnavailableReason
 * @typedef {{kind: 'unavailable', ref: string, reason: SnapshotUnavailableReason, requestMatch?: true | 'unknown'}} UnavailableSnapshot
 * @typedef {Operation | UnavailableSnapshot} StateListEntry
 * @typedef {{kind: 'committed'} | {kind: 'conflict'} | {kind: 'unavailable'}} CommitResult
 * @typedef {{
 *   open: (retention?: ArtifactRetention) => Promise<void>,
 *   load: (operationId: string) => Promise<Operation | undefined>,
 *   commit: (operationId: string, expectedRevision: number | null, next: Operation) => Promise<CommitResult>,
 *   list: (requestId?: string) => Promise<readonly StateListEntry[]>,
 *   close: () => Promise<void>,
 *   writeArtifact?: ArtifactStore['writeArtifact'],
 *   readArtifact?: ArtifactStore['readArtifact'],
 *   artifactPresence?: ArtifactStore['artifactPresence']
 * }} StateStore
 * @typedef {{maxAgeMs?: number, maxBytes?: number}} ArtifactRetention
 * @typedef {'present' | 'missing' | 'retention'} ArtifactPresence
 * @typedef {{kind: 'available', bytes: Uint8Array} | {kind: 'unavailable', reason?: 'retention'} | {kind: 'integrity_error'}} ArtifactRead
 * @typedef {{
 *   writeArtifact: (bytes: Uint8Array, maxBytes: number) => Promise<ArtifactReference>,
 *   readArtifact: (reference: ArtifactReference, maxBytes: number) => Promise<ArtifactRead>,
 *   artifactPresence: (reference: ArtifactReference) => Promise<ArtifactPresence>
 * }} ArtifactStore
 *
 * @typedef {{id: string, version?: string, description?: string, resources?: readonly string[], unavailable?: string,
 *   instructions?: string}} SkillMetadata
 * @typedef {{id: string, version?: string, status: 'complete' | 'truncated' | 'unavailable',
 *   instructions?: string, reason?: string}} SkillInstructions
 * @typedef {{kind: 'profile', value: Profile} |
 *   {kind: 'role', value: {id: string, instructions: string, purpose?: string, preferredProfiles?: readonly string[]}} |
 *   {kind: 'skill', value: SkillMetadata} |
 *   {kind: 'tool', value: {id: string, description: string}}} CatalogEntry
 * @typedef {{
 *   list: () => Promise<readonly CatalogEntry[]>,
 *   loadSkill?: (id: string, maxBytes: number, signal: AbortSignal) => Promise<SkillInstructions>,
 *   resolve: (kind: CatalogEntry['kind'], id: string) => Promise<CatalogEntry | undefined>
 * }} Catalog
 * @typedef {{
 *   list: (cursor?: number) => ContextList,
 *   fetch: (ref: string | ContextPosition, sourceOperationId?: string) => Promise<ContextFetch>,
 *   captureArtifact: (bytes: Uint8Array) => Promise<string | undefined>
 * }} ContextPort
 * @typedef {{kind: 'available', item: ContextItem, bytes?: Uint8Array} |
 *   {kind: 'unavailable', reason: 'denied' | 'missing' | 'payload' | 'ambiguous' | 'retention' | 'budget' | 'integrity_error' | 'closed'}} ContextFetch
 * @typedef {NonNullable<ContextItem['receivedSequence']>} ContextPosition
 * @typedef {Pick<ContextItem, 'source' | 'completeness' | 'attemptId' | 'receivedSequence' |
 *   'providerRef' | 'kind' | 'outputKind'> & {ref: string | ContextPosition, reportedLocation?: string}} ContextDirectoryItem
 * @typedef {{kind: 'available', items: ContextDirectoryItem[], nextCursor?: number} |
 *   {kind: 'unavailable', reason: 'closed' | 'invalid_cursor'}} ContextList
 * @typedef {(share: {sourceOperationId: string, targetOperationId: string, ref: string, profileId: string}) => boolean} ContextShare
 * @typedef {(retry: {operationId: string, attemptId: string, actionId: string, profileId: string}) => boolean} RetryApproval
 * @typedef {{reference: string, authorize: (reference: string, profileId: string) =>
 *   'ALLOWED' | 'PERMISSION_DENIED' | 'REVOKED'}} AuthorityPort
 * @typedef {{id: string, kind: 'allow' | 'deny', label?: string, scope?: 'once' | 'always'}} PermissionOption
 * @typedef {{source: 'provider_reported', title?: string, kind?: string,
 *   locations?: readonly {path: string, line?: number}[], details?: string}} PermissionAction
 * @typedef {{providerRequestId: string, resource: string, options: readonly PermissionOption[], action?: PermissionAction}} PermissionRequest
 * @typedef {{kind: 'selected', option: string} | {kind: 'denied' | 'cancelled' | 'unavailable' | 'invalid'}} PermissionResult
 * @typedef {{request: (request: PermissionRequest) => Promise<PermissionResult>, close: () => void}} AttemptPermissions
 * @typedef {{
 *   bind: (attempt: {attemptId: string, authorityRef: string, profileId: string, signal: AbortSignal,
 *     report?: (event: 'permission.requested' | 'permission.resolved' | 'permission.expired', reason: string) => void
 *   }) => AttemptPermissions
 * }} PermissionPort
 */

export {};
