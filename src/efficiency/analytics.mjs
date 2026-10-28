import { normalizeContextProfile, normalizeProviderPromptProfile } from './profiling.mjs';
import { normalizeRouterContextTelemetry } from '../routing/context.mjs';
import { createUsageAccumulator } from './usage-observations.mjs';
import { summarizeExecutionOutcome, executionGroupId } from './outcome.mjs';
import { createToolMetricsAccumulator, legacyToolObservation } from './tool-metrics.mjs';
// P3 aggregate-only telemetry. Never persist prompts, raw tool output or model reasoning.
const FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens', 'totalTokens'];
const MAX_RUNS = 80;
const MAX_INVOCATIONS = 128;
const MAX_TIMELINE_SAMPLES = 40;
function quantity(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
// Persist only opaque identifiers, never arbitrary provider/user text or URLs.
function safeLabel(value, max = 90) { return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/.test(value) ? value : null; }
function snapshot(usage) {
  const result = {};
  for (const key of FIELDS) result[key] = quantity(usage?.[key]);
  // Cached and reasoning tokens are included in input/output counters respectively.
  return result;
}
// Validate related counters at the observation boundary. An inconsistent
// provider snapshot is not evidence of cache savings or total usage. Keep
// independently valid counters, but reject the conflicting derived/subset
// value. Partial snapshots remain partial rather than being filled with zero.
export function normalizeTokenUsage(usage) {
  const result = snapshot(usage);
  if (result.inputTokens !== null && result.cachedInputTokens !== null &&
      result.cachedInputTokens > result.inputTokens) result.cachedInputTokens = null;
  if (result.outputTokens !== null && result.reasoningOutputTokens !== null &&
      result.reasoningOutputTokens > result.outputTokens) result.reasoningOutputTokens = null;
  if (result.totalTokens !== null && result.inputTokens !== null && result.outputTokens !== null &&
      (result.inputTokens + result.outputTokens !== result.totalTokens ||
       !Number.isSafeInteger(result.inputTokens + result.outputTokens))) result.totalTokens = null;
  return result;
}
// Never publish an inexact JavaScript number as observed token usage.
export function addExactNonnegative(a, b) {
  if (a === null || b === null) return null;
  const value = a + b;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function createEfficiencyRun(runId) {
  const invocations = new Map();
  let fixRounds = 0, reviewBatches = 0, retries = 0, recoveredOperations = 0, exhaustedOperations = 0, retrySuppressed = 0, verificationFailures = 0, droppedInvocations = 0;
  let verificationCommandsObserved=0, verificationCacheHits=0, verificationCacheMisses=0;
  const verificationFailureReasons=Object.create(null);
  let recoveryElapsedMs = 0;
  let reviewUnitsTotal = 0, reviewUnitsVerified = 0, reviewUnitsPending = 0, reviewUnitsResumed = 0, reviewWorkRepeated = 0;
  let reviewBatchLimit = null, reviewScopeStatus = null, reviewScopeReason = null;
  let reviewFilesTotal = null, reviewFilesKnown = null, reviewFilesVerified = null;
  let reviewFindingsRaw = null, reviewFindingsUnique = null, reviewFindingsPotentialDuplicates = null, reviewFindingsReconciled = null, reviewFindingsReported = null;
  let reviewObservations = null, reviewCanonicalFindings = null, reviewConfirmedMerges = null, reviewPotentialDuplicatePairs = null;
  let reviewVerificationSource = null, reviewObservedExecuteCalls = null, reviewQualityGateMode = null;
  const reviewRiskEvidenceRejectedReasons = Object.create(null);
  const knownRiskRejections = new Set(['contradictory_evidence','unsupported_risk_assessment',
    'missing_finding','unassigned_or_duplicate_risk','requires_independent_conflict_resolution',
    'risk_capacity_exhausted','other_rejected_evidence']);
  let reviewExecutionStrategy = null, reviewEstimatedInvocations = null;
  let reviewScopeExcludedFiles = 0, reviewRolesBypassed = 0, reviewPriorEvidenceCharacters = 0;
  let reviewSemanticCandidateGroups = 0;
  let reviewWorkloadRisk = null, reviewEvidenceRecorded = 0, reviewObligationsSatisfied = 0;
  let reviewRiskObligationsTotal = null, reviewRiskObligationsAssessed = null, reviewMaterialRisksOpen = null;
  let reviewRiskContradictions = null, reviewRiskHypothesesPreserved = null, reviewQualityFollowUps = null;
  let reviewQualityGateDisposition = null, reviewRiskEvidenceRejected = 0;
  let reviewVerificationStrategy = null, executionBudgetPauseReason = null;
  let reviewExecutionSegments=null, reviewSegmentInvocations=null, reviewOperationInvocations=null;
  let reviewOperationHardLimitReached=null, reviewSegmentBudgetExhausted=null;
  let reviewSegmentFeasible=null, reviewContinuationRequired=null;
  let rolePromptCharacters = 0, roleDuplicateCharacters = 0;
  let contextCrossInvocationRepeatedCharacters = 0, reviewInstructionCharactersSaved = 0, reviewInstructionDocumentsDeferred = 0;
  let reviewLocationsResolved = 0, reviewLocationsTotal = 0;
  const contextDigestsSeen = new Map();
  let evidenceMirrorWrites = 0, evidenceMirrorFailures = 0, targetedVerificationExecutions = 0, targetedVerificationObservations = 0;
  let reviewEvidenceUnrelatedOmitted = 0, targetedVerificationReused = 0, reviewHistoryCharactersSaved = 0;
  let reviewOperationId = null;
  let skillInvocationSource = null, skillResolutionStatus = null;
  let routeValidationStatus = null, routeCorrectionReason = null;
  let reviewStopReason = null, reviewNoProgressBatches = 0;
  const reviewSeenUnits = new Set();
  const reviewCompletedUnits = new Set();
  let currentStage = null, currentReviewBatch = null, currentFixRound = null;
  function onEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'verification_command_result') {
      verificationCommandsObserved++;
      if (event.cacheHit === true) verificationCacheHits++;
      else if (event.cacheEligible === true) verificationCacheMisses++;
      const code = event.reasonCode;
      if (typeof code === 'string' && /^[A-Z_]{2,48}$/.test(code) &&
          Object.keys(verificationFailureReasons).length < 16)
        verificationFailureReasons[code] = Math.min(100000, (verificationFailureReasons[code]??0)+1);
    }
    const id = event.invocationId;
    if (event.type === 'fix_round') { fixRounds++; currentFixRound = quantity(event.round); }
    if (['review_operation_created','review_operation_resumed','review_scope_reconciled'].includes(event.type)) reviewOperationId = safeLabel(event.operationId, 128);
    if (event.type === 'review_execution_strategy' && ['focused','standard','deep','legacy'].includes(event.strategy))
      reviewExecutionStrategy = event.strategy;
    if (event.type === 'review_plan_feasibility') {
      reviewEstimatedInvocations = quantity(event.estimatedInvocations);
      reviewSegmentFeasible = typeof event.fitsCurrentSegment === 'boolean' ? event.fitsCurrentSegment : null;
      reviewContinuationRequired = typeof event.continuationRequired === 'boolean' ? event.continuationRequired : null;
    }
    if (event.type === 'review_budget_snapshot') {
      reviewExecutionSegments=quantity(event.segments);
      reviewSegmentInvocations=quantity(event.segmentInvocations);
      reviewOperationInvocations=quantity(event.operationInvocations);
      reviewOperationHardLimitReached=event.operationExhausted===true;
      reviewSegmentBudgetExhausted=event.segmentExhausted===true;
    }
    if (event.type === 'review_user_scope_excluded') reviewScopeExcludedFiles += quantity(event.count) ?? 0;
    if (event.type === 'review_role_bypassed') reviewRolesBypassed++;
    if (event.type === 'review_batch_start') reviewPriorEvidenceCharacters += quantity(event.priorEvidenceCharacters) ?? 0;
    if (event.type === 'review_semantic_candidates') reviewSemanticCandidateGroups = quantity(event.groups) ?? 0;
    if (event.type === 'review_evidence_handoff') reviewEvidenceUnrelatedOmitted += quantity(event.omittedUnrelated) ?? 0;
    if (event.type === 'review_history_bounded') reviewHistoryCharactersSaved += quantity(event.savedCharacters) ?? 0;
    if (event.type === 'review_workload_assessed' && ['normal','medium','high'].includes(event.risk)) reviewWorkloadRisk = event.risk;
    if (event.type === 'review_evidence_progress') {
      reviewEvidenceRecorded = quantity(event.records) ?? reviewEvidenceRecorded;
      reviewObligationsSatisfied = quantity(event.obligationsSatisfied) ?? reviewObligationsSatisfied;
    }
    if (event.type === 'review_verification_decision' && ['none','source_inspection','targeted_test','independent_review','full_verification'].includes(event.strategy))
      reviewVerificationStrategy = event.strategy;
    if (event.type === 'execution_budget_paused' && ['invocations','elapsed','input_tokens','output_tokens','usage_unavailable'].includes(event.reason))
      executionBudgetPauseReason = event.reason;
    if (event.type === 'role_context_block_sizes' && Array.isArray(event.blocks)) {
      for (const block of event.blocks.slice(0,16)) {
        if (!/^[a-f0-9]{64}$/.test(block?.sha256) || quantity(block?.characters)===null) continue;
        if (contextDigestsSeen.has(block.sha256)) {
          if (contextDigestsSeen.get(block.sha256) !== event.invocationId) contextCrossInvocationRepeatedCharacters += block.characters;
        } else contextDigestsSeen.set(block.sha256,event.invocationId ?? null);
      }
    }
    if (event.type === 'role_instruction_projection') {
      reviewInstructionCharactersSaved += quantity(event.savedCharacters) ?? 0;
      if (event.selected === 'optimized') reviewInstructionDocumentsDeferred += quantity(event.deferredDocuments) ?? 0;
    }
    if (event.type === 'review_source_locations') {
      reviewLocationsResolved = quantity(event.resolved) ?? reviewLocationsResolved;
      reviewLocationsTotal = quantity(event.total) ?? reviewLocationsTotal;
    }
    if (event.type === 'role_context_manifest') {
      rolePromptCharacters += quantity(event.characters) ?? 0;
      roleDuplicateCharacters += quantity(event.duplicateCharacters) ?? 0;
    }
    if (event.type === 'review_evidence_mirror_persisted') evidenceMirrorWrites++;
    if (['review_evidence_mirror_unavailable','review_evidence_mirror_mismatch'].includes(event.type)) evidenceMirrorFailures++;
    if (event.type === 'review_targeted_verification' && event.disposition === 'reused_verified') targetedVerificationReused++;
    if (event.type === 'review_targeted_verification' && event.disposition === 'executed') {
      targetedVerificationExecutions++;
      targetedVerificationObservations += quantity(event.observations) ?? 0;
    }
    if (event.type === 'review_quality_assessed') {
      reviewRiskObligationsTotal = quantity(event.total);
      reviewRiskObligationsAssessed = quantity(event.assessed);
      reviewMaterialRisksOpen = quantity(event.open);
      reviewRiskContradictions = quantity(event.contradictions);
      reviewRiskHypothesesPreserved = quantity(event.preserved);
      reviewQualityFollowUps = quantity(event.followUps);
      reviewQualityGateDisposition = ['satisfied','incomplete','not_enforced'].includes(event.status) ? event.status : null;
      reviewQualityGateMode = ['off','observe','enforce'].includes(event.mode) ? event.mode : null;
    }
    if (event.type === 'review_quality_evidence_rejected') {
      reviewRiskEvidenceRejected += quantity(event.count) ?? 0;
      for (const [reason,count] of Object.entries(event.reasonCounts ?? {})) {
        if (!knownRiskRejections.has(reason) || quantity(count) === null) continue;
        reviewRiskEvidenceRejectedReasons[reason] = (reviewRiskEvidenceRejectedReasons[reason] ?? 0) + count;
      }
    }
    if (event.type === 'review_report_validated') reviewFindingsReported = quantity(event.reported);
    if (event.type === 'skill_invocation_resolved') {
      skillInvocationSource = ['slash','named-reference'].includes(event.source) ? event.source : null;
      skillResolutionStatus = ['resolved','unresolved'].includes(event.status) ? event.status : null;
    }
    if (event.type === 'route_validation') {
      routeValidationStatus = ['accepted','corrected','ambiguous'].includes(event.status) ? event.status : null;
      routeCorrectionReason = safeLabel(event.reason);
    }
    if (event.type === 'review_progress_blocked') {
      reviewStopReason = safeLabel(event.reason);
      reviewNoProgressBatches = quantity(event.consecutiveBatches) ?? 0;
    }
    if (event.type === 'review_plan_created') reviewUnitsTotal = quantity(event.total) ?? reviewUnitsTotal;
    if (event.type === 'review_progress') {
      const value = event.progress;
      if (value && typeof value === 'object') {
        reviewBatchLimit = quantity(value.maxBatches);
        reviewScopeStatus = ['resolved', 'partial', 'unresolved'].includes(value.scope?.status) ? value.scope.status : null;
        reviewScopeReason = typeof value.scope?.reason === 'string' && /^[a-z_]{1,80}$/.test(value.scope.reason)
          ? value.scope.reason : null;
        reviewFilesTotal = quantity(value.files?.total);
        reviewFilesKnown = quantity(value.files?.known);
        reviewFilesVerified = quantity(value.files?.verified);
        reviewUnitsTotal = quantity(value.units?.total) ?? reviewUnitsTotal;
        reviewUnitsVerified = quantity(value.units?.verified) ?? reviewUnitsVerified;
        reviewUnitsPending = quantity(value.units?.pending) ?? reviewUnitsPending;
      }
      reviewFindingsRaw = quantity(event.rawFindings);
      reviewFindingsUnique = quantity(event.uniqueFindings);
      reviewFindingsPotentialDuplicates = quantity(event.potentialDuplicates);
      reviewFindingsReconciled = quantity(event.reconciledFindings);
      reviewObservations = reviewFindingsRaw;
      reviewCanonicalFindings = reviewFindingsUnique;
      reviewConfirmedMerges = reviewFindingsReconciled;
      reviewPotentialDuplicatePairs = reviewFindingsPotentialDuplicates;
      reviewVerificationSource = ['workflow','observed','unverified'].includes(event.verificationSource) ? event.verificationSource : null;
      reviewObservedExecuteCalls = quantity(event.observedExecuteCalls);
    }
    if (event.type === 'review_checkpoint_resumed') {
      reviewUnitsResumed = quantity(event.completed) ?? reviewUnitsResumed;
      reviewUnitsVerified = Math.max(reviewUnitsVerified, reviewUnitsResumed);
    }
    if (event.type === 'review_unit_completed' && event.checked === true && typeof event.unitId === 'string' &&
        !reviewCompletedUnits.has(event.unitId)) {
      reviewCompletedUnits.add(event.unitId);
      reviewUnitsVerified++;
    }
    if (event.type === 'review_unit_started' && typeof event.unitId === 'string') {
      if (reviewSeenUnits.has(event.unitId)) reviewWorkRepeated++;
      reviewSeenUnits.add(event.unitId);
    }
    if (event.type === 'review_checkpoint_persisted') reviewUnitsVerified = Math.max(reviewUnitsVerified, quantity(event.verified) ?? 0);
    if (event.type === 'review_continuation_ready') {
      reviewUnitsVerified = Math.max(reviewUnitsVerified, quantity(event.verified) ?? 0);
      reviewUnitsPending = quantity(event.pending) ?? reviewUnitsPending;
    }
    if (event.type === 'review_batch_start') { reviewBatches++; currentReviewBatch = quantity(event.batch); }
    if (event.type === 'review_batch_done' || event.type === 'review_batch_interrupted') currentReviewBatch = null;
    if (event.type === 'implementation_stage_start') currentStage = safeLabel(event.stage);
    if (event.type === 'implementation_stage_done' || event.type === 'implementation_stage_interrupted') currentStage = null;
    if (event.type === 'invocation_retry_started' || event.type === 'review_provider_retry') retries++;
    if (event.type === 'invocation_recovered') recoveredOperations++;
    if (event.type === 'invocation_recovery_exhausted') exhaustedOperations++;
    if (event.type === 'invocation_retry_skipped') retrySuppressed++;
    if (['invocation_recovered', 'invocation_recovery_exhausted', 'invocation_recovery_cancelled'].includes(event.type))
      recoveryElapsedMs += quantity(event.recoveryElapsedMs) ?? 0;
    if (event.type === 'verification_done' && event.disposition === 'FAIL') verificationFailures++;
    if (!['role_start', 'role_done', 'role_usage', 'role_error', 'role_cancelled',
      'role_context_profile', 'role_router_context', 'role_provider_prompt_profile', 'role_tool_event', 'role_thought_chunk', 'role_commentary_chunk', 'role_native_update', 'role_activity'].includes(event.type)) return;
    if (typeof id !== 'string' || id.length > 120) return;
    let row = invocations.get(id);
    if (!row) {
      if (invocations.size >= MAX_INVOCATIONS) { if (event.type === 'role_start') droppedInvocations++; return; }
      row = { invocationId: id, role: null, provider: null, model: null, status: 'incomplete', elapsedMs: null, timingBasis:'monotonic_invocation',
        usage: snapshot(null), usageCoverage: 'unknown', usageCompleteness: 'unknown', usageObservations: 0, usageRejected: 0, usageAmbiguous: false, providerPromptProfile: null, contextProfile: null,
        contextOccupancy: { first: null, peak: null, last: null, window: null, updates: 0 },
        contextTimeline: { samples: [], droppedSamples: 0, truncated: false },
        toolCalls: 0, toolEvents: 0, toolCallsTruncated: false, firstContentElapsedMs: null,
        firstReasoningElapsedMs: null, firstCommentaryElapsedMs: null, firstAnswerElapsedMs: null,
        firstToolCallElapsedMs: null, firstActivityElapsedMs: null, toolUpdatesAfterStart: 0,
        stageId: null, reviewBatch: null, fixRound: null, executionScope: null,
        toolCompleted:0,toolDurationMs:0,observedToolContentCharacters:0,toolMetrics:null, usageAvailability: { contextOccupancy:'unknown',inputTokens:'unknown',outputTokens:'unknown',cachedTokens:'unknown',providerPrompt:'unknown' }, routerContext: null, toolCategories: {}, outcome: null };
      // Only transient, non-persisted handles for correlating streaming tool updates.
      Object.defineProperty(row, '_toolMetrics', { value: createToolMetricsAccumulator(), enumerable: false });
      Object.defineProperty(row, '_startedAt', { value: performance.now(), enumerable: false });
      Object.defineProperty(row, '_usageAccumulator', { value: createUsageAccumulator(), enumerable: false });
      invocations.set(id, row);
    }
    // Provider updates arriving after a terminal event cannot rewrite completed
    // measurements or create impossible first-activity timestamps.
    if (row.status !== 'incomplete') return;
    if (event.type === 'role_start') {
      row.role = safeLabel(event.role); row.provider = safeLabel(event.provider); row.model = safeLabel(event.model);
      const scope = event.executionScope && typeof event.executionScope === 'object' ? event.executionScope : null;
      const phase = safeLabel(scope?.phase, 30) ?? (event.role === 'router' ? 'routing' : event.role === 'explorer' ? 'exploration' : event.role === 'planner' ? 'planning' : event.role === 'investigator' ? 'investigation' : event.role?.startsWith('reviewer') ? 'review' : event.role?.startsWith('coder') ? 'implementation' : event.role === 'finalValidator' ? 'validation' : 'response');
      row.executionScope = { phase, attempt: quantity(scope?.attempt), retryReason: safeLabel(scope?.retryReason, 48), operationId: safeLabel(scope?.operationId, 128) };
      row.stageId = scope ? safeLabel(scope.stageId) : currentStage;
      row.reviewBatch = scope ? quantity(scope.reviewBatch) : (phase === 'review' ? currentReviewBatch : null);
      row.fixRound = scope ? quantity(scope.fixRound) : (phase === 'fix' ? currentFixRound : null);
      row.contextOccupancy.window = quantity(event.contextWindow);
    }
    if (event.type === 'role_context_profile') row.contextProfile = normalizeContextProfile(event.profile);
    if (event.type === 'role_router_context') row.routerContext = normalizeRouterContextTelemetry(event.routerContext);
    if (event.type === 'role_provider_prompt_profile') { row.providerPromptProfile = normalizeProviderPromptProfile(event.profile); row.usageAvailability.providerPrompt = row.providerPromptProfile ? 'observed' : 'unknown'; }
    const now = Math.max(0, Math.floor(performance.now() - row._startedAt));
    let activity = null;
    if (event.type === 'role_thought_chunk') activity = 'reasoning';
    else if (event.type === 'role_commentary_chunk') activity = 'commentary';
    else if (event.type === 'role_tool_event') activity = 'toolCall';
    else if (event.type === 'role_activity') activity = ['reasoning','commentary','answer','toolCall'].includes(event.activity) ? event.activity : null;
    else if (event.type === 'role_native_update' && event.update?.sessionUpdate === 'agent_message_chunk') activity = 'answer';
    if (activity) {
      if (row.firstActivityElapsedMs === null) row.firstActivityElapsedMs = now;
      if (row.firstContentElapsedMs === null) row.firstContentElapsedMs = now; // backward-compatible any activity
      const field = { reasoning:'firstReasoningElapsedMs', commentary:'firstCommentaryElapsedMs',
        answer:'firstAnswerElapsedMs', toolCall:'firstToolCallElapsedMs' }[activity];
      if (field && row[field] === null) row[field] = now;
    }
    if (event.type === 'role_tool_event') {
      // ACP-specific interpretation is performed by the provider adapter.
      // Legacy fake/in-process providers can still send a minimal update.
      const observation=event.toolObservation ?? legacyToolObservation(event.update);
      row._toolMetrics.observe(observation,now);
      const metrics=row._toolMetrics.counters();
      row.toolCalls=metrics.calls;
      row.toolEvents=metrics.events;
      row.toolUpdatesAfterStart=metrics.updates;
      row.toolCallsTruncated=metrics.truncated;
    }
    if (event.type === 'role_usage' || event.type === 'role_done') {
      if (event.usage) {
        const hasTokenUsage = FIELDS.some(key=>quantity(event.usage?.[key])!==null);
        // Occupancy-only ACP updates, including the final done snapshot, must
        // never materialize a fictitious cumulative token-usage scope.
        if(hasTokenUsage) row._usageAccumulator.observe(event.usageObservation ?? event.usage);
        const observed = row._usageAccumulator.summary();
        row.usage = observed.usage;
        row.usageCoverage = observed.observations && observed.scopeCount ? 'observed_snapshot' : 'unknown';
        row.usageCompleteness = observed.completeness;
        row.usageAvailability.inputTokens = row.usage.inputTokens === null ? 'unknown' : observed.knownFields.inputTokens.complete ? 'complete' : 'partial';
        row.usageAvailability.outputTokens = row.usage.outputTokens === null ? 'unknown' : observed.knownFields.outputTokens.complete ? 'complete' : 'partial';
        row.usageAvailability.cachedTokens = row.usage.cachedInputTokens === null ? 'unknown' : observed.knownFields.cachedInputTokens.complete ? 'complete' : 'partial';
        row.usageObservations = observed.observations;
        row.usageRejected = observed.rejected;
        row.usageAmbiguous = observed.ambiguous;
        const used = quantity(event.usage.contextUsedTokens);
        const window = quantity(event.usage.contextWindow) ?? quantity(event.contextWindow);
        if (used !== null) {
          row.usageAvailability.contextOccupancy = 'observed';
          const c = row.contextOccupancy;
          if (c.first === null) c.first = used;
          c.last = used; c.peak = Math.max(c.peak ?? 0, used);
          c.updates = Math.min(1_000_000, c.updates + 1);
          if (window !== null && window > 0) c.window = window;
          const timeline = row.contextTimeline;
          const sample = { elapsedMs:now, usedTokens:used, windowTokens:c.window, toolOrdinal:row.toolCalls };
          const previous=timeline.samples.at(-1);
          if (!previous || previous.usedTokens !== sample.usedTokens || previous.windowTokens !== sample.windowTokens) {
            if (timeline.samples.length >= MAX_TIMELINE_SAMPLES) {
              // Keep first, global max and recent points without retaining unbounded stream.
              const first=timeline.samples[0];
              const peak=timeline.samples.reduce((a,b)=>a.usedTokens>=b.usedTokens?a:b);
              const kept=[first,peak,...timeline.samples.slice(-Math.floor(MAX_TIMELINE_SAMPLES/2))];
              timeline.samples=[...new Map(kept.map(x=>[x.elapsedMs+':'+x.usedTokens,x])).values()].slice(-MAX_TIMELINE_SAMPLES+1);
              timeline.droppedSamples+=Math.max(1,MAX_TIMELINE_SAMPLES-timeline.samples.length); timeline.truncated=true;
            }
            timeline.samples.push(sample);
          }
        }
      }
    }
    if (['role_done', 'role_error', 'role_cancelled'].includes(event.type)) {
      row.status = event.type === 'role_done' ? 'completed' : event.type === 'role_error' ? 'failed' : 'cancelled';
      // Use the same monotonic clock for observed first activity and completion.
      // Provider meta.elapsedMs measures a different (inner) interval.
      row.elapsedMs = Math.max(now, quantity(event.elapsedMs) ?? 0);
    }
  }
  function finish({ status = 'unknown', taskId = null, presetId = null, result = null } = {}) {
    const groupReviewId = result?.reviewOperationId ?? reviewOperationId;
    return {
      version: 1, runId: safeLabel(runId, 128), taskId: safeLabel(taskId, 128), presetId: safeLabel(presetId),
      status: safeLabel(status, 48), completedAt: new Date().toISOString(),
      reviewOperationId: safeLabel(groupReviewId, 128),
      executionGroupId: executionGroupId({runId,taskId,reviewOperationId:groupReviewId}), outcome: result ? summarizeExecutionOutcome(result) : null,
      skillInvocationSource, skillResolutionStatus, routeValidationStatus, routeCorrectionReason, reviewStopReason, reviewNoProgressBatches,
      reviewRiskObligationsTotal, reviewRiskObligationsAssessed, reviewMaterialRisksOpen,
      reviewRiskContradictions, reviewRiskHypothesesPreserved, reviewQualityFollowUps,
      reviewQualityGateDisposition, reviewQualityGateMode, reviewRiskEvidenceRejected,
      reviewSemanticCandidateGroups, reviewWorkloadRisk, reviewEvidenceRecorded, reviewObligationsSatisfied, reviewVerificationStrategy,
      executionBudgetPauseReason,reviewExecutionSegments,reviewSegmentInvocations,
      reviewOperationInvocations,reviewOperationHardLimitReached,reviewSegmentBudgetExhausted,
      reviewSegmentFeasible,reviewContinuationRequired,rolePromptCharacters, roleDuplicateCharacters,
      contextCrossInvocationRepeatedCharacters, reviewInstructionCharactersSaved, reviewInstructionDocumentsDeferred,
      reviewLocationsResolved,reviewLocationsTotal,
      evidenceMirrorWrites, evidenceMirrorFailures, targetedVerificationExecutions, targetedVerificationObservations,
      verificationCommandsObserved, verificationCacheHits, verificationCacheMisses, verificationFailureReasons,
      reviewEvidenceUnrelatedOmitted, targetedVerificationReused, reviewHistoryCharactersSaved,
      fixRounds, reviewBatches, reviewExecutionStrategy, reviewEstimatedInvocations, reviewScopeExcludedFiles, reviewRolesBypassed, reviewPriorEvidenceCharacters, reviewBatchLimit, reviewScopeStatus, reviewScopeReason, reviewFilesTotal, reviewFilesKnown, reviewFilesVerified, reviewFindingsRaw, reviewFindingsUnique, reviewFindingsPotentialDuplicates, reviewFindingsReconciled, reviewFindingsReported, reviewObservations, reviewCanonicalFindings, reviewConfirmedMerges, reviewPotentialDuplicatePairs, reviewRiskEvidenceRejectedReasons, reviewVerificationSource, reviewObservedExecuteCalls, reviewUnitsTotal, reviewUnitsVerified, reviewUnitsPending, reviewUnitsResumed, reviewWorkRepeated, retries, recoveredOperations, exhaustedOperations, retrySuppressed, recoveryElapsedMs, verificationFailures, droppedInvocations,
      invocations: [...invocations.values()].map(row => {
        const toolMetrics=row._toolMetrics.snapshot();
        return { ...row,usage:normalizeTokenUsage(row.usage),toolMetrics,
          toolCalls:toolMetrics.calls,toolEvents:toolMetrics.events,toolCallsTruncated:toolMetrics.truncated,
          toolCompleted:toolMetrics.completed,toolDurationMs:toolMetrics.lifecycleMs,
          observedToolContentCharacters:toolMetrics.contentCharacters,toolCategories:toolMetrics.kinds };
      }),
    };
  }
  return { onEvent, finish };
}
export function retainEfficiencyRun(session, record) {
  if (!record?.runId || !Array.isArray(record.invocations)) return;
  const existing = Array.isArray(session.efficiencyRuns) ? session.efficiencyRuns : [];
  // Replace, do not append on retries or post-commit replay.
  session.efficiencyRuns = [...existing.filter(r => r.runId !== record.runId), record].slice(-MAX_RUNS);
}
export function efficiencyView(session) {
  const input = Array.isArray(session?.efficiencyRuns) ? session.efficiencyRuns : [];
  const uniqueRuns = new Map(input.filter(r => r?.runId).map(r => [r.runId, r]));
  const runs = [...uniqueRuns.values()];
  const droppedInvocations = runs.reduce((n, run) => n + (quantity(run.droppedInvocations) ?? 0), 0);
  const grouped = new Map();
  const tasks = new Map();
  const outcomes = new Map();
  const groups = new Map();
  for (const run of runs) {
    const category = run.outcome?.category ?? 'unknown';
    const o = outcomes.get(category) ?? {category, runs:0, invocations:0, knownElapsedMs:0};
    o.runs++;o.invocations+=run.invocations?.length??0;
    for(const i of run.invocations??[]) if(quantity(i.elapsedMs)!==null) o.knownElapsedMs=addExactNonnegative(o.knownElapsedMs,i.elapsedMs);
    outcomes.set(category,o);
    const groupId=run.executionGroupId ?? (run.taskId?`task:${run.taskId}`:`run:${run.runId}`);
    const g=groups.get(groupId) ?? {groupId,runs:0,invocations:0,statuses:[]};
    g.runs++;g.invocations+=run.invocations?.length??0;
    if(g.statuses.length<80) g.statuses.push(run.status);
    groups.set(groupId,g);
    if (run.taskId) {
      const t = tasks.get(run.taskId) ?? { taskId: run.taskId, runs: 0, completed: 0, invocations: 0 };
      t.runs++; if (run.status === 'completed') t.completed++; t.invocations += run.invocations?.length ?? 0;
      tasks.set(run.taskId, t);
    }
    for (const invocation of run.invocations ?? []) {
      const key = `${invocation.role ?? 'unknown'} / ${invocation.model ?? 'unknown'}`;
      const row = grouped.get(key) ?? { role: invocation.role, model: invocation.model, calls: 0, failed: 0, knownInputTokens: 0, knownOutputTokens: 0, inputCoverage: 0, outputCoverage: 0, elapsedMs: 0, durationCoverage: 0, numericOverflow: false, preparedCharacters: 0, contextProfileCoverage: 0, peakContextTokens: null, contextCoverage: 0, toolCalls: 0 };
      row.calls++;
      if (invocation.status !== 'completed') row.failed++;
      if (quantity(invocation.usage?.inputTokens) !== null) {
        const sum = addExactNonnegative(row.knownInputTokens, invocation.usage.inputTokens);
        if (sum === null) row.numericOverflow = true;
        row.knownInputTokens = sum; row.inputCoverage++;
      }
      if (quantity(invocation.usage?.outputTokens) !== null) {
        const sum = addExactNonnegative(row.knownOutputTokens, invocation.usage.outputTokens);
        if (sum === null) row.numericOverflow = true;
        row.knownOutputTokens = sum; row.outputCoverage++;
      }
      if (quantity(invocation.contextProfile?.promptCharacters) !== null) {
        row.preparedCharacters = addExactNonnegative(row.preparedCharacters, invocation.contextProfile.promptCharacters);
        row.contextProfileCoverage++;
        if (row.preparedCharacters === null) row.numericOverflow = true;
      }
      if (quantity(invocation.contextOccupancy?.peak) !== null) {
        row.peakContextTokens = Math.max(row.peakContextTokens ?? 0, invocation.contextOccupancy.peak);
        row.contextCoverage++;
      }
      row.toolCalls = addExactNonnegative(row.toolCalls, quantity(invocation.toolCalls) ?? 0);
      if (row.toolCalls === null) row.numericOverflow = true;
      if (quantity(invocation.elapsedMs) !== null) {
        const sum = addExactNonnegative(row.elapsedMs, invocation.elapsedMs);
        if (sum === null) row.numericOverflow = true;
        row.elapsedMs = sum; row.durationCoverage++;
      }
      grouped.set(key, row);
    }
  }
  return { version: 1, retainedRuns: runs.length, truncatedInvocations: droppedInvocations, truncated: session?.efficiencyTelemetryTruncated === true || droppedInvocations > 0 || input.length >= MAX_RUNS, roles: [...grouped.values()], tasks: [...tasks.values()], outcomes:[...outcomes.values()], executionGroups:[...groups.values()],
    note: 'Retained-window lower bounds only. ACP context occupancy is not billed usage; missing token usage is unknown. Capped runs/invocations are incomplete; no inferred quota or pricing.' };
}
