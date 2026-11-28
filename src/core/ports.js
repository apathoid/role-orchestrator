/** @import {ArtifactReference, ContextItem, ProviderObservation} from './observation.js' */
/** @import {Outcome, Request} from './contracts.js' */
/** @import {Operation} from './operation.js' */

/**
 * @typedef {'supported' | 'unsupported' | 'unknown'} Support
 * @typedef {{support: Support, source: 'configured' | 'negotiated', detail?: string}} Capability
 * @typedef {{providerId: string, maxConcurrency: number | null, capabilities: Readonly<Record<string, Capability>>}} ProviderDescription
 * @typedef {{mode: 'native'} | {mode: 'selectable', levels: readonly string[], defaultLevel: string,
 *   capability?: Capability}} ReasoningCatalog
 * @typedef {{mode: 'native', level?: 'native', selectionSource?: 'model' | 'default' | 'user'} | {mode: 'selectable', level: string, nativeValue: string,
 *   selectionSource: 'model' | 'default' | 'user'}} ReasoningSelection
 * @typedef {{id:string, source:'user'|'default', nativeValue?:string|boolean, binding?:unknown}} NativeSetting
 * @typedef {{profileId:string,providerId:string,model:string,configurationRef:string,
 *   overrides?:import('./contracts.js').UserSettings,approvalMappingsRef?:string,reasoningEffort?:NativeSetting,collaborationMode?:NativeSetting,approvalMode?:NativeSetting}} AcceptedSettings
 * @typedef {{explicit?:import('./contracts.js').UserSettings,inherited?:import('./contracts.js').UserSettings,recovery?:AcceptedSettings}} SettingsInput
 * @typedef {{kind: 'selected', selection: ReasoningSelection} |
 *   {kind: 'rejected', profileId: string, requestedLevel?: string, availableLevels: readonly string[]}} ReasoningResolution
 * @typedef {{profileId: string, providerId: string, model: string, capabilities?: Readonly<Record<string, Capability>>,
 *   reasoning?: ReasoningCatalog, unavailable?: string}} Profile
 * @typedef {{sessionId: string}} ProviderSession
 * @typedef {Request['attachments'][number]|import('./contracts.js').ContentAttachment} UserAttachment
 * @typedef {{requestId:string,text:string,content:readonly import('./contracts.js').ContentSegment[]}} OrderedTurn
 * @typedef {{attemptId: string, operationId: string, actionId: string, kind: 'controller' | 'delegate',
 *   objective: string, expectedResult?: string, continuationReference?: string, instructions: readonly string[], profile: Profile, workspaceContext?: Request['workspaceContext'],
 *   attachments?: readonly UserAttachment[], orderedTurns?:readonly OrderedTurn[], readUserPayload?:(ref:string)=>Promise<Uint8Array|undefined>, requiredCapabilities?: readonly string[], reasoning?: ReasoningSelection, collaborationMode?: NativeSetting, approvalMode?: NativeSetting,
 *   userConstraints: readonly string[], skillInstructions?: readonly SkillInstructions[], context: readonly ContextItem[], authorityRef: string, timeoutMs: number | null,
 *   signal: AbortSignal, isActive?: () => boolean, contextAccess?: ContextPort, evidenceAccess?: LiveEvidencePort, preflightIntent?: ControllerPreflight, externalTools?: AttemptTools, idempotencyKey?: string, permissions?: Pick<AttemptPermissions, 'request'>, interactions?: Pick<AttemptInteractions, 'request' | 'supports'>,
 *   controllerDelivery?: 'intent_text' | 'intent_mcp', controllerDecisionToolName?: string}} Invocation
 * @typedef {{kind: 'reasoning' | 'user_message' | 'tool' | 'plan' | 'finding', payload: unknown,
 *   nativeId?: string, nativeKind?: string}} ProviderActivity
 * @typedef {(item: ProviderActivity) => void} ActivityCallback
 * @typedef {ProviderActivity & {operationId: string, attemptId: string, profileId: string, providerId: string,
 *   source: 'provider_activity', sequence: number, actionId?:string, invocationKind?:'controller'|'delegate'}} ActivityEvent
 * @typedef {{operationId: string, attemptId?: string}} ActivityScope
 * @typedef {ActivityEvent | {kind: 'gap', operationId: string, attemptId?: string, droppedCount: number,
 *   reason: 'overflow', sequenceRange?: {first: number, last: number}}} ActivityNotice
 * @typedef {(event: ActivityNotice) => void | Promise<void>} ActivityListener
 * Adapter-owned result identity: outputObservationRef names the exact report already
 * emitted for this attempt. outputObservationParsed:true additionally attests
 * that output/decisionTextError were derived by parsing that complete reported
 * text, not another message. Omit for unproven correlation or structured output.
 * This is optional technical provenance, not a capability or an admission field.
 * @typedef {{outcome: Outcome, output?: unknown, outputObservationRef?: string, outputObservationParsed?: true, findings?: unknown, dispatchCertainty: 'not_sent' | 'sent' | 'unknown',
 *   reasoningUnavailable?: 'session_option_unavailable' | 'session_option_rejected',
 *   decisionTextError?: 'invalid_json' | 'non_object' | 'depth',
 *   controllerDeclaration?: {kind:'intent',value:unknown,observationRef?:string} |
 *     {kind:'missing'|'conflict'} | {kind:'invalid',reason:import('./decode.js').FieldError}}} ProviderResult
 * @typedef {{
 *   describe: () => Promise<ProviderDescription>,
 *   supportsIdempotency?: true,
 *   supportsReasoningSelection?: true,
 *   supportsCollaborationMode?: true,
 *   supportsApprovalMode?: true,
 *   supportsOrderedContent?: true,
 *   negotiatesCapabilities?: readonly string[],
 *   open: (profile: Profile, signal: AbortSignal) => Promise<ProviderSession>,
 *   invoke: (session: ProviderSession, request: Invocation, observe: (item: ProviderObservation) => string | undefined, activity?: ActivityCallback) => Promise<ProviderResult>,
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
 *   readArtifactSlice?: ArtifactStore['readArtifactSlice'],
 *   artifactPresence?: ArtifactStore['artifactPresence']
 * }} StateStore
 * @typedef {{maxAgeMs?: number, maxBytes?: number}} ArtifactRetention
 * @typedef {'present' | 'missing' | 'retention'} ArtifactPresence
 * @typedef {{kind: 'available', bytes: Uint8Array} | {kind: 'unavailable', reason?: 'retention'} | {kind: 'integrity_error'}} ArtifactRead
 * @typedef {{
 *   writeArtifact: (bytes: Uint8Array, maxBytes: number) => Promise<ArtifactReference>,
 *   readArtifact: (reference: ArtifactReference, maxBytes: number) => Promise<ArtifactRead>,
 *   readArtifactSlice?: (reference: ArtifactReference, offset: number, length: number) => Promise<ArtifactRead>,
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
 *   {kind: 'tool', value: Omit<ToolMetadata, 'inputSchema'>}} CatalogEntry
 * @typedef {{
 *   list: () => Promise<readonly CatalogEntry[]>,
 *   preferences?: Readonly<{roleId?: string, skillIds: readonly string[]}>,
 *   loadSkill?: (id: string, maxBytes: number, signal: AbortSignal) => Promise<SkillInstructions>,
 *   resolve: (kind: CatalogEntry['kind'], id: string) => Promise<CatalogEntry | undefined>,
 *   selectReasoning?: (profileId: string, level?: string) => ReasoningResolution
 * }} Catalog
 * @typedef {{id: string, description: string, resource: string, effect: 'read' | 'write',
 *   inputSchema: Record<string, unknown>}} ToolMetadata
 * @typedef {{attemptId: string, operationId: string, callId: string, signal: AbortSignal}} ToolScope
 * @typedef {ToolMetadata & {invoke: (input: unknown, scope: ToolScope) => Promise<unknown>,
 *   cancel?: (scope: ToolScope) => void | Promise<void>, permissionPreviewFields?: readonly string[]}} ToolDefinition
 * @typedef {{status: 'completed' | 'failed' | 'truncated' | 'invalid_input' | 'denied' | 'unavailable' | 'closed' | 'unknown' | 'budget',
 *   effect: 'none' | 'possible' | 'unknown', output?: unknown, callId?: string, ref?: string}} ToolResult
 * @typedef {ToolResult & {callId: string, toolId: string, attemptId: string, late?: true}} ToolReceipt
 * @typedef {{list: () => ToolMetadata[], call: (id: string, input: unknown) => Promise<ToolResult>}} AttemptTools
 * @typedef {{bind: (scope: {attemptId: string, operationId: string, signal: AbortSignal, isActive: () => boolean,
 *   permissions?: Pick<AttemptPermissions, 'request'>, newId: () => string, maxBytes: number,
 *   receive: (toolId: string, receipt: ToolReceipt) => string}) => AttemptTools}} ToolPort
 * @typedef {'closed' | 'invalid_cursor' | 'invalid_ref' | 'invalid_offset' | 'missing' | 'payload' | 'budget'} LiveEvidenceUnavailableReason
 * @typedef {Pick<import('./observation.js').Observation, 'ref' | 'source' | 'completeness' | 'providerRef' | 'provenance' | 'reportedContext' | 'artifact' | 'summary' | 'native'> & {omittedMetadataFields?: string[], hasCapturedValue?: boolean}} LiveEvidenceItem
 * @typedef {LiveEvidenceItem | {kind:'unavailable',reason:'budget',index:number}} LiveEvidenceListItem
 * @typedef {{kind:'available',cursor:number,items:LiveEvidenceListItem[],resumeCursor:number,nextCursor?:number} |
 *   {kind:'unavailable',reason:LiveEvidenceUnavailableReason}} LiveEvidenceList
 * @typedef {{kind:'chunk',item:LiveEvidenceItem,format:'utf8'|'json',offset:number,totalBytes:number,
 *   base64:string,nextOffset?:number} | {kind:'unavailable',reason:LiveEvidenceUnavailableReason}} LiveEvidenceFetch
 * @typedef {{list:(cursor?:number)=>LiveEvidenceList,
 *   fetch:(ref:string,range?:{offset:number,maxBytes?:number})=>LiveEvidenceFetch}} LiveEvidencePort
 * @typedef {{kind:'checked',issues:{path:string,expected:string,availability?:'not_in_snapshot'|'ambiguous'}[],
 *   omittedCount:number,advisory:true} | {kind:'unchecked',reason:'budget'|'closed'|'unavailable',advisory:true}} PreflightResult
 * @typedef {(intent:unknown)=>PreflightResult} ControllerPreflight
 * @typedef {{
 *   list: (cursor?: HistoryCursor) => ContextList,
 *   fetch: (ref: string | ContextPosition, sourceOperationId?: string, range?: {offset: number, maxBytes?: number}) => Promise<ContextFetch>,
 *   captureArtifact: (bytes: Uint8Array) => Promise<string | undefined>
 * }} ContextPort
 * @typedef {{kind: 'available', item: ContextItem, bytes?: Uint8Array} |
 *   {kind: 'chunk', item: ContextDirectoryItem & {provenance?: ContextItem['provenance'], artifact?: ContextItem['artifact']},
 *     format: 'utf8' | 'json' | 'binary', offset: number, totalBytes: number, base64: string, nextOffset?: number} |
 *   {kind: 'unavailable', reason: 'denied' | 'missing' | 'payload' | 'ambiguous' | 'retention' | 'budget' | 'integrity_error' | 'closed' | 'invalid_offset'}} ContextFetch
 * @typedef {NonNullable<ContextItem['receivedSequence']>} ContextPosition
 * @typedef {Pick<ContextItem, 'source' | 'completeness' | 'attemptId' | 'receivedSequence' |
 *   'providerRef' | 'kind' | 'outputKind' | 'unavailableReason' | 'native' | 'omittedMetadataFields'> & {ref: string | ContextPosition, reportedLocation?: string}} ContextDirectoryItem
 * @typedef {number | {revision: number, index: number}} HistoryCursor
 * @typedef {{kind: 'available', cursor: {revision: number, index: number}, items: ContextDirectoryItem[], nextCursor?: {revision: number, index: number}} |
 *   {kind: 'unavailable', reason: 'closed' | 'invalid_cursor' | 'budget'}} ContextList
 * @typedef {(share: {sourceOperationId: string, targetOperationId: string, ref: string, profileId: string}) => boolean} ContextShare
 * @typedef {(retry: {operationId: string, attemptId: string, actionId: string, profileId: string}) => boolean} RetryApproval
 * @typedef {{reference: string, authorize: (reference: string, profileId: string) =>
 *   'ALLOWED' | 'PERMISSION_DENIED' | 'REVOKED'}} AuthorityPort
 * @typedef {{kind: 'input', nativeKind: string, providerRequestId: string, payload: unknown}} InteractionRequest
 * @typedef {InteractionRequest & {requestId: string, operationId: string, attemptId: string, profileId: string, deadlineAt: number | null}} PendingInteraction
 * @typedef {{kind: 'answered', payload: unknown} | {kind: 'unavailable' | 'cancelled' | 'timed_out' | 'invalid'} |
 *   {kind: 'error', code: number, message: string, data?: unknown}} InteractionResult
 * @typedef {{requestId: string, operationId: string, attemptId: string, providerRequestId: string, payload: unknown}} InteractionReply
 * @typedef {{supports: (kind: InteractionRequest['kind']) => boolean,
 *   request: (input: InteractionRequest, requestSignal?: AbortSignal) => Promise<InteractionResult>, close: () => void}} AttemptInteractions
 * @typedef {{bind: (scope: {operationId: string, attemptId: string, profileId: string, signal: AbortSignal,
 *   isActive: () => boolean, deadline: number | null, clock: import('./diagnostics.js').Clock,
 *   report?: (event: string, reason: string) => void}) => AttemptInteractions}} InteractionPort
 * @typedef {{id: string, kind: 'allow' | 'deny', label?: string, scope?: 'once' | 'always'}} PermissionOption
 * @typedef {{source: 'provider_reported', title?: string, kind?: string, nativeToolCallId?: string,
 *   locations?: readonly {path: string, line?: number}[], details?: string}} PermissionAction
 * @typedef {{providerRequestId: string, resource: string, options: readonly PermissionOption[], action?: PermissionAction}} PermissionRequest
 * @typedef {{kind: 'selected', option: string} | {kind: 'denied' | 'cancelled' | 'unavailable' | 'invalid'}} PermissionResult
 * @typedef {{request: (request: PermissionRequest) => Promise<PermissionResult>, close: () => void}} AttemptPermissions
 * @typedef {{
 *   bind: (attempt: {operationId?: string, attemptId: string, authorityRef: string, profileId: string, signal: AbortSignal,
 *     report?: (event: 'permission.requested' | 'permission.resolved' | 'permission.expired', reason: string) => void
 *   }) => AttemptPermissions
 * }} PermissionPort
 */

export {};
