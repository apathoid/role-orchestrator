// Host/provider-neutral observation of turns. Session checkpoints remain the
// authority for resumability; this is a bounded, redacted diagnostic projection.
import { randomUUID, createHash } from 'node:crypto';
import { taskSpecFailureCode } from '../routing/task-spec.mjs';
import { routingOutputFailureCode } from '../routing/output-failures.mjs';
import { acpFailureProjection } from './recovery-diagnostics.mjs';
import { executionFailureDiagnostic } from './execution-diagnostics.mjs';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getSessionStateDir } from '../session-store.mjs';

const MAX_EVENTS = 3000;
const MAX_BYTES = 2_000_000;
const MAX_FIELD = 240;
const STATUSES = new Set(['completed', 'interrupted', 'cancelled', 'failed']);
const IMPORTANT = new Set([
  'run.started', 'run.running', 'run.finished', 'run.failed', 'run.cancelled',
  'route', 'route_validation', 'semantic_intent_validation', 'router_output_diagnostic', 'role_router_context', 'trusted_continuation', 'authorization_resolution', 'routing_outcome', 'skill_invocation_resolved', 'review_progress_blocked', 'role_start', 'role_done', 'role_error', 'role_cancelled', 'plan',
  'implementation_plan_reused', 'implementation_checkpoint_resumed', 'implementation_checkpoint_rejected',
  'implementation_stage_start', 'implementation_stage_done', 'implementation_stage_interrupted',
  'review_batch_start', 'review_batch_done', 'review_batch_interrupted',
  'review_plan_created', 'review_unit_started', 'review_unit_completed', 'review_unit_interrupted',
  'review_checkpoint_persisted', 'review_continuation_ready', 'review_scope_invalidated',
  'review_scope_resolution_required', 'review_progress',
  'review_checkpoint_resumed', 'review_checkpoint_rejected', 'review_checkpoint_error',
  'review_operation_created', 'review_operation_resumed', 'review_plan_restored', 'review_report_validated', 'review_scope_reconciled',
  'verification_start', 'verification_done', 'fix_round', 'fix_resolution',
  'review_provider_retry', 'review_interrupted',
  'invocation_retry_scheduled', 'invocation_retry_started', 'invocation_retry_skipped', 'invocation_recovered', 'invocation_recovery_exhausted', 'invocation_recovery_cancelled',
  'workspace_drift', 'workspace_drift_reconciled', 'workspace_drift_ignored', 'git_metadata_drift',
  'implementation_reconciliation_approved', 'implementation_reconciliation_proposed', 'complete',
  'quality_recovery_assessed', 'quality_targeted_revalidation', 'quality_revision_changed',
  'observability.degraded',
]);
const SAFE_ID = /^[a-zA-Z0-9._-]{1,160}$/;
// Diagnostics never persist arbitrary caller-controlled identifiers verbatim.
// Known categorical labels remain useful; all other values are stable digests.
const KNOWN_LABELS=new Set([
  'router','explorer','planner','investigator','coderLow','coderMedium','coderHigh',
  'reviewerLow','reviewerMedium','reviewerHigh','responderLow','responderMedium','responderHigh','finalValidator',
  'investigate','review','change','plan','new','legacy','optimized','observe',
  'accepted','invalid','missing','denied','read_only','write_gated','cancelled','failed','completed',
  'queued','running','interrupted','started','stopped','unknown','unverified','not_verified','pending',
  'review_passed','review_findings','review_incomplete','review_interrupted','changed','investigated','planned',
  'implementation_incomplete','intent_unresolved','clarification_required','needs_user_decision',
  'completed_with_unverified_checks','benchmark','in_progress','not_started','checked','not_checked',
  'stale','rejected','resolved','validated','unresolved','open','incomplete','targeted_revalidation',
  'skill_execution_conflict','text','structured','json','markdown','HEAD',
  'PROVIDER_CANCELLED','PROVIDER_CRASH','PROVIDER_TIMEOUT','TIMEOUT','RATE_LIMIT','MODEL_UNAVAILABLE',
  'CLIENT_REQUEST_CANCELLED','SESSION_CANCELLED','TOOL_UNAVAILABLE','ENVIRONMENT_ERROR','INFRA_FAILURE',
  'CONTRACT_FAILURE','AUTHORIZATION_DENIED','EXECUTION_FAILED','SESSION_PERSISTENCE_ERROR',
  'WORKSPACE_UNSTABLE','SUPERSEDED_BY_NEW_TURN','fix','review_passed','read_only',
  'I1','I2','A','PASS','FAIL','TEST_FAILED','NOT_VERIFIED','INSUFFICIENT_EVIDENCE',
]);
const opaque=value=>'id_'+createHash('sha256').update(value).digest('hex').slice(0,20);
const code=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)
  ? KNOWN_LABELS.has(value)?value:opaque(value) : null;
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9._-]{1,100}$/.test(value)
  ? (/^[a-f0-9]{8}-[a-f0-9-]{27,}$/.test(value)||/^[a-z0-9]{1,4}$/.test(value)||/^[a-z][a-z0-9]{1,14}-[0-9]{1,6}$/.test(value))?value:opaque(value) : null;
const tiny=value=>typeof value==='string'?opaque(value):null;
const enumString=code;
const modelIdentifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,100}$/.test(value)
  ? opaque(value):null;
const finite = (value) => Number.isFinite(value) ? value : null;
const bool = (value) => value === true;
const count = (value) => Array.isArray(value) ? value.length : null;
const enumOf = (value, values) => values.includes(value) ? value : null;

const providerFailureCodes=new Set(['PROVIDER_CANCELLED','PROVIDER_CRASH','RATE_LIMIT','TIMEOUT','PROVIDER_TIMEOUT',
  'MODEL_UNAVAILABLE','SESSION_CANCELLED','CLIENT_REQUEST_CANCELLED','UNCLASSIFIED_PROVIDER_FAILURE',
  'ENVIRONMENT_ERROR','ENVIRONMENT_FAILURE','INFRA_FAILURE','STORAGE_FAILURE','TOOL_UNAVAILABLE',
  'INVALID_TASK_SPEC','INVALID_STRUCTURED_OUTPUT','MISSING_TASK_SPEC','CONTRACT_FAILURE','AUTHORIZATION_DENIED']);
const providerFailureCode = value => providerFailureCodes.has(value) ? value :
  typeof value==='string'&&/^(?:invalid_task_spec_|task_spec_|missing_task_spec|conflicting_semantic_|unsupported_task_spec)/.test(value)
    ? 'CONTRACT_FAILURE' : null;
const diagnosticReasons=new Set(['NON_SEMANTIC_GIT_METADATA','SEMANTIC_WORKSPACE_DRIFT','WORKSPACE_RECONCILED',
  'PROVIDER_CANCELLED','PROVIDER_CRASH','PROVIDER_TIMEOUT','TIMEOUT','RATE_LIMIT','MODEL_UNAVAILABLE',
  'CLIENT_REQUEST_CANCELLED','SESSION_CANCELLED','TOOL_UNAVAILABLE','ENVIRONMENT_ERROR','INFRA_FAILURE',
  'CONTRACT_FAILURE','AUTHORIZATION_DENIED','INVALID_TASK_SPEC','CHECKPOINT_PERSISTENCE_ERROR',
  'FIX_ROUND','FIX_DECISION','outer_cancelled','INSUFFICIENT_EVIDENCE','UNKNOWN','stale','missing','invalid','degraded']);
const diagnosticReason=value=>diagnosticReasons.has(value)?value:null;
const semanticReason = value => typeof value === 'string' && /^(?:invalid_task_spec_[a-z_]+|missing_task_spec|conflicting_semantic_and_legacy_route|unsupported_task_spec_version|task_spec_unauthorized_change|invalid_[a-z_]+|unauthorized_saved_plan)$/.test(value) ? value : null;
const usageCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// Opaque step IDs may contain model-generated content. Preserve correlation
// via a hash, never the supplied string. Git metadata fields are enums only.
const strings = (values) => Array.isArray(values) ? values.slice(0, 12).filter(v=>typeof v==='string')
  .map(v=>'id_'+createHash('sha256').update(v).digest('hex').slice(0,16)) : [];
const gitFields = values=>Array.isArray(values)?values.filter(x=>['HEAD','index','worktree','staged','unstaged',
  'branch','refs','untracked','status','commit','tree','merge_base'].includes(x)).slice(0,12):[];

// Explicit allowlist: no prompts, outputs, token values, paths, raw tool payloads,
// diffs, provider errors, reasoning or transcript text are written to disk.
export function observableEventData(event) {
  switch (event?.type) {
    case 'run.started': case 'run.running': return {};
    case 'run.finished': return { resultStatus: code(event.resultStatus), committed: bool(event.committed), droppedTelemetry: finite(event.droppedTelemetry), truncated: bool(event.truncated), degraded: bool(event.degraded) };
    case 'run.failed': case 'run.cancelled': {
      const diagnostic=executionFailureDiagnostic({code:code(event.code)??'EXECUTION_FAILED'});
      return {code:diagnostic.code,origin:diagnostic.origin,reason:diagnosticReason(event.reason),severity:diagnostic.severity,
        retryable:diagnostic.retryable,summary:diagnostic.summary,nextAction:diagnostic.nextAction,
        droppedTelemetry:finite(event.droppedTelemetry),truncated:bool(event.truncated),degraded:bool(event.degraded)};
    }
    case 'route': return {
      schemaVersion: 1, mode: enumOf(event.policy?.mode,['investigate','review','change','plan']),
      tier: enumOf(event.policy?.tier,['low','medium','high']),
      writeIntent: enumOf(event.classification?.writeIntent,['explicit','ambiguous','not_requested']),
      targetKind: enumOf(event.classification?.task?.target?.kind,['none','git']),
      selectorType: enumOf(event.classification?.task?.target?.selector?.type,
        ['recent_commits','commit','range','relative_ref','worktree','staged','unstaged','ticket_commits','union']),
      continuation: enumOf(event.classification?.task?.continuation?.mode,
        ['new','current_review','current_implementation','saved_implementation','saved_review','information','revise_plan','reconcile','ambiguous']),
      ambiguity: !!event.classification?.task?.ambiguities?.length,
      policyMode: enumOf(event.policy?.mode,['investigate','review','change','plan']),
    };
    case 'router_output_diagnostic': return {schemaVersion:1,
      format:enumOf(event.format,['structured','text']),
      source:enumOf(event.source,['final-answer','unphased-answer','fenced-final']),
      providerCompletionStatus:enumOf(event.providerCompletionStatus,['end_turn','max_tokens','max_turn_requests','refusal','cancelled','process_exited_successfully']),
      stage:enumOf(event.diagnostics?.stage,['structured_extraction','shape_validation','validated']),
      code:enumOf(event.diagnostics?.code,['ROUTER_TASK_MISSING','ROUTER_TASK_INVALID','ROUTER_OUTPUT_UNSTRUCTURED','ROUTER_OUTPUT_MALFORMED','ROUTER_OUTPUT_INCOMPLETE','ROUTER_OUTPUT_AMBIGUOUS','ROUTER_OUTPUT_INVALID']),
      taskFailureCode:taskSpecFailureCode(event.diagnostics?.taskFailureCode),
      outputFailureCode:routingOutputFailureCode(event.diagnostics?.outputFailureCode),
      jsonRecognized:event.diagnostics?.jsonRecognized===null||event.diagnostics?.jsonRecognized===undefined?null:bool(event.diagnostics.jsonRecognized),
      taskPresent:event.diagnostics?.taskPresent===null||event.diagnostics?.taskPresent===undefined?null:bool(event.diagnostics.taskPresent),
      incomplete:event.diagnostics?.incomplete===null||event.diagnostics?.incomplete===undefined?null:bool(event.diagnostics.incomplete),
      ambiguousFragments:event.diagnostics?.ambiguousFragments===null||event.diagnostics?.ambiguousFragments===undefined?null:bool(event.diagnostics.ambiguousFragments)};
    case 'semantic_intent_validation': return {schemaVersion:1,status:enumOf(event.status,['accepted','invalid','missing']),
      code:enumOf(event.code,['ROUTER_TASK_MISSING','ROUTER_TASK_INVALID','ROUTER_OUTPUT_UNSTRUCTURED','ROUTER_OUTPUT_MALFORMED','ROUTER_OUTPUT_INCOMPLETE','ROUTER_OUTPUT_AMBIGUOUS','ROUTER_OUTPUT_INVALID']),
      stage:enumOf(event.stage,['structured_extraction','shape_validation','workflow_validation','task_validation','validated']),
      failureClass:enumOf(event.failureClass,['contract','provider','environment','authorization']),
      taskFailureCode:taskSpecFailureCode(event.taskFailureCode),
      outputFailureCode:routingOutputFailureCode(event.outputFailureCode),
      jsonRecognized:event.jsonRecognized===null||event.jsonRecognized===undefined?null:bool(event.jsonRecognized),
      taskPresent:event.taskPresent===null||event.taskPresent===undefined?null:bool(event.taskPresent),
      incomplete:event.incomplete===null||event.incomplete===undefined?null:bool(event.incomplete),
      ambiguousFragments:event.ambiguousFragments===null||event.ambiguousFragments===undefined?null:bool(event.ambiguousFragments),
      providerCompletionStatus:enumOf(event.providerCompletionStatus,['end_turn','max_tokens','max_turn_requests','refusal','cancelled','process_exited_successfully']),
      recovery:enumOf(event.recovery,['not_attempted','attempted','recovered','exhausted','suppressed']),
      reason:semanticReason(event.reason),operation:enumOf(event.operation,['investigate','review','change','plan']),
      targetKind:enumOf(event.targetKind,['none','git']),
      selectorType:enumOf(event.selectorType,['recent_commits','commit','range','relative_ref','worktree','staged','unstaged','ticket_commits','union']),
      ambiguityCount:finite(event.ambiguityCount)};
    case 'trusted_continuation': return {schemaVersion:1,kind:enumOf(event.kind,['saved_review','saved_implementation','current_review','current_implementation']),status:enumOf(event.status,['validated','rejected'])};
    case 'authorization_resolution': return {schemaVersion:1,status:enumOf(event.status,['read_only','write_gated','denied']),
      operation:enumOf(event.operation,['investigate','review','change','plan']),
      writeIntent:enumOf(event.writeIntent,['explicit','not_requested','ambiguous']),
      policyMode:enumOf(event.policyMode,['investigate','review','change','plan'])};
    case 'routing_outcome': return {schemaVersion:1,status:enumOf(event.status,['investigate_passed','review_passed','change_passed','plan_passed','completed','failed','cancelled','unknown','review_findings','changed','investigated'])};
    case 'role_router_context': {
      const c=event.routerContext;
      return {schemaVersion:1,requestedMode:enumOf(c?.mode,['legacy','observe','optimized']),
        selectedMode:enumOf(c?.selected,['legacy','optimized']),
        fallbackReason:enumOf(c?.reason,['legacy_mode','manifest_missing','manifest_unavailable','manifest_invalid','document_digest_mismatch','no_reduction','observe_only','explicit_digest_verified']),
        originalCharacters:usageCount(c?.originalCharacters),projectedCharacters:usageCount(c?.projectedCharacters),
        documentsExcluded:usageCount(c?.documentsExcluded)};
    }
    case 'role_start': case 'role_done': return {
      role: code(event.role), invocationId: identifier(event.invocationId), profile: modelIdentifier(event.profile), preset: modelIdentifier(event.presetId), provider: modelIdentifier(event.provider),
      model: modelIdentifier(event.model), elapsedMs: finite(event.elapsedMs),
      usage: {inputTokens:usageCount(event.usage?.inputTokens),outputTokens:usageCount(event.usage?.outputTokens),
        cachedInputTokens:usageCount(event.usage?.cachedInputTokens)}, outputFormat: enumOf(event.outputFormat,['structured','text','json','markdown']),
      operationId: identifier(event.executionScope?.operationId),
      attempt: finite(event.executionScope?.attempt),
    };
    case 'role_error': case 'role_cancelled': return {
      role: code(event.role), invocationId: identifier(event.invocationId), code: providerFailureCode(event.code),
      reason: null, source: enumOf(event.source,['provider','client','host','workflow','local','timeout']), elapsedMs: finite(event.elapsedMs),
      retryable: bool(event.retryable), acp: acpFailureProjection(event.diagnostics),
    };
    case 'plan': return { steps: count(event.plan?.steps), acceptanceCriteria: count(event.plan?.acceptanceCriteria) };
    case 'implementation_stage_start': case 'implementation_stage_done': case 'implementation_stage_interrupted': return {
      stage: code(event.stage), index: finite(event.index), total: finite(event.total),
      completedSteps: finite(event.completedSteps), reason: diagnosticReason(event.reason),
      stepIds: strings(event.completedStepIds ?? event.steps?.map?.((s) => s.id)).filter((id) => code(id)),
    };
    case 'implementation_checkpoint_resumed': case 'review_checkpoint_resumed': return {
      completed: finite(event.completed), total: finite(event.total), completedStepIds: strings(event.completedStepIds),
    };
    case 'implementation_checkpoint_rejected': case 'review_checkpoint_rejected': return { reason: diagnosticReason(event.reason) };
    case 'review_checkpoint_error': return { code: 'CHECKPOINT_PERSISTENCE_ERROR' };
    case 'review_operation_created': case 'review_operation_resumed': return { operationId: code(event.operationId), units: finite(event.units), reusedUnits: finite(event.reusedUnits) };
    case 'review_plan_restored': return { operationId: code(event.operationId), units: finite(event.units) };
    case 'review_scope_reconciled': return { operationId: code(event.operationId), reusedUnits: finite(event.reusedUnits), invalidatedUnits: finite(event.invalidatedUnits) };
    case 'review_report_validated': return { operationId: code(event.operationId), reported: finite(event.reported), required: finite(event.required) };
    case 'skill_invocation_resolved': return { source: code(event.source), status: code(event.status) };
    case 'route_validation': return { status: code(event.status), reason: diagnosticReason(event.reason) };
    case 'review_progress_blocked': return { reason: diagnosticReason(event.reason), consecutiveBatches: finite(event.consecutiveBatches) };
    case 'review_plan_created': return { total: finite(event.total), files: finite(event.files), manifestAvailable: bool(event.manifestAvailable) };
    case 'review_unit_started': case 'review_unit_completed': case 'review_unit_interrupted': return {
      unitId: code(event.unitId), checked: bool(event.checked), code: code(event.code) };
    case 'review_checkpoint_persisted': case 'review_continuation_ready': return {
      verified: finite(event.verified), pending: finite(event.pending), total: finite(event.total), durable: bool(event.durable) };
    case 'review_scope_invalidated': return { reason: diagnosticReason(event.reason) };
    case 'review_scope_resolution_required': return { reason: diagnosticReason(event.reason), status: code(event.status),
      unresolved: finite(event.unresolved), verified: finite(event.verified) };
    case 'review_progress': return { scope: code(event.progress?.scope?.status),
      scopeReason: code(event.progress?.scope?.reason),
      unitsTotal: finite(event.progress?.units?.total), unitsVerified: finite(event.progress?.units?.verified),
      unitsPending: finite(event.progress?.units?.pending),
      filesTotal: finite(event.progress?.files?.total), filesVerified: finite(event.progress?.files?.verified),
      filesKnown: finite(event.progress?.files?.known),
      batchLimit: finite(event.progress?.maxBatches), batches: finite(event.progress?.batches),
      findingsRaw: finite(event.rawFindings), findingsUnique: finite(event.uniqueFindings),
      verificationSource: code(event.verificationSource) };
    case 'review_batch_start': case 'review_batch_done': case 'review_batch_interrupted': return {
      batch: finite(event.batch), total: finite(event.total), maxBatchesPerRun: finite(event.maxBatchesPerRun),
      assignedUnits: finite(event.assignedUnits), remainingUnits: finite(event.remainingUnits),
      checked: finite(event.checked),
      assigned: finite(event.assigned), incomplete: finite(event.incomplete), code: enumString(event.code),
    };
    case 'review_provider_retry': case 'review_interrupted': return { role: code(event.role), attempt: finite(event.attempt), attempts: finite(event.attempts), reason: diagnosticReason(event.reason) };
    case 'invocation_retry_scheduled': case 'invocation_retry_started': case 'invocation_retry_skipped':
    case 'invocation_recovered': case 'invocation_recovery_exhausted': case 'invocation_recovery_cancelled': return {
      role: code(event.role), operationId: identifier(event.operationId),
      attempt: finite(event.attempt), attempts: finite(event.attempts), reason: diagnosticReason(event.reason),
      recoveryElapsedMs: finite(event.recoveryElapsedMs),
    };
    case 'quality_recovery_assessed': return { completedStages: finite(event.completedStages), staleEvidence: finite(event.staleEvidence),
      unknownEvidence: finite(event.unknownEvidence), findings: finite(event.findings) };
    case 'quality_targeted_revalidation': return { commandCount: count(event.commands), disposition: code(event.disposition) };
    case 'quality_revision_changed': return { revision: finite(event.revision), taskId: identifier(event.taskId) };
    case 'verification_done': return { ok: bool(event.ok), disposition: enumString(event.disposition), changedPathCount: count(event.changedPaths),
      expectedEffects: bool(event.expectedEffects), semanticImproved: count(event.results?.filter((r) => r.diagnostic?.outcome === 'improved')),
      semanticRegressed: count(event.results?.filter((r) => r.diagnostic?.outcome === 'regressed')) };
    case 'fix_round': return { round: finite(event.round), maxRounds: finite(event.maxRounds) };
    case 'fix_resolution': return { decision: code(event.decision), reason: diagnosticReason(event.reason) };
    case 'workspace_drift': case 'workspace_drift_reconciled': case 'workspace_drift_ignored': return {
      role: enumString(event.role), gitFields: gitFields(event.gitFields), changedPathCount: count(event.changedPaths),
      turns: finite(event.turns), action: enumString(event.action), reason: diagnosticReason(event.reason),
    };
    case 'git_metadata_drift': return { stage: code(event.stage), fields: gitFields(event.fields), action: enumString(event.action) };
    case 'implementation_reconciliation_approved': return { automatic: bool(event.automatic) };
    case 'complete': return { resultStatus: enumString(event.result?.status), planCompleted: event.result?.planCompleted !== false };
    default: return {};
  }
}

function initial(runId, sessionId, at) {
  return {
    version: 1, sessionId, runId, status: 'queued', resultStatus: null, phase: null,
    startedAt: at, updatedAt: at, finishedAt: null, lastSequence: 0,
    activeInvocations: [], stages: [], verification: { status: 'not_started' },
    workspace: { status: 'unknown', driftCount: 0 },
    lastDecision: null, diagnostics: [], trace: { degraded: false, droppedTelemetry: 0, truncated: false },
    activity: { roleInvocations: 0, reconciliationChecks: 0, fixRounds: 0 },
    qualityActivity: { recoveryAssessments: 0, targetedChecks: 0, lastDisposition: null, revision: null },
  };
}
const clone = (value) => structuredClone(value);

export function projectExecutionEvent(view, event) {
  const next = clone(view);
  next.lastSequence = event.sequence;
  next.updatedAt = event.timestamp;
  const d = event.data;
  switch (event.kind) {
    case 'run.running': next.status = 'running'; break;
    case 'run.started': break;
    case 'run.finished':
      next.status = 'completed'; next.resultStatus = d.resultStatus; next.finishedAt = event.timestamp;
      next.trace.droppedTelemetry = d.droppedTelemetry ?? next.trace.droppedTelemetry;
      next.trace.truncated = d.truncated || next.trace.truncated;
      next.trace.degraded = d.degraded || next.trace.degraded; break;
    case 'run.failed': case 'run.cancelled':
      next.status = event.kind === 'run.failed' ? 'failed' : 'cancelled'; next.finishedAt = event.timestamp;
      next.trace.truncated = d.truncated || next.trace.truncated;
      next.trace.degraded = d.degraded || next.trace.degraded;
      next.trace.droppedTelemetry = d.droppedTelemetry ?? next.trace.droppedTelemetry;
      next.diagnostics.push({ code: d.code ?? 'EXECUTION_FAILED', origin: d.origin ?? 'workflow', reason: d.reason ?? null, severity: d.severity ?? 'error', retryable: d.retryable, summary: d.summary, nextAction: d.nextAction }); break;
    case 'route': next.phase = d.mode === 'change' ? 'implementation' : d.mode; break;
    case 'role_start':
      next.activity.roleInvocations++;
      next.activeInvocations.push({ id: d.invocationId, role: d.role, provider: d.provider, model: d.model, startedAt: event.timestamp }); break;
    case 'role_done': case 'role_error': case 'role_cancelled':
      next.activeInvocations = next.activeInvocations.filter((x) => x.id !== d.invocationId);
      if (event.kind !== 'role_done') next.diagnostics.push({ code: d.code ?? (event.kind === 'role_cancelled' ? 'ROLE_CANCELLED' : 'ROLE_FAILURE'), origin: 'provider', role: d.role });
      break;
    case 'implementation_stage_start':
      next.phase = 'implementation';
      next.stages = [...next.stages.filter((x) => x.id !== d.stage), { id: d.stage, index: d.index, total: d.total, status: 'running', stepIds: d.stepIds }]; break;
    case 'implementation_stage_done': {
      const current = next.stages.find((x) => x.id === d.stage);
      // A stage_done event is not authoritative by itself; durable checkpoint
      // reconciliation is required before presenting it as safely completed.
      if (current) current.status = 'awaiting_checkpoint_confirmation';
      break;
    }
    case 'implementation_stage_interrupted': {
      const current = next.stages.find((x) => x.id === d.stage);
      if (current) current.status = 'interrupted';
      break;
    }
    case 'implementation_checkpoint_resumed': next.phase = 'implementation'; break;
    case 'quality_recovery_assessed': next.qualityActivity = { ...(next.qualityActivity ?? {}),
      recoveryAssessments: (next.qualityActivity?.recoveryAssessments ?? 0) + 1,
      completedStages: d.completedStages, staleEvidence: d.staleEvidence, unknownEvidence: d.unknownEvidence, findings: d.findings }; break;
    case 'quality_targeted_revalidation': next.qualityActivity = { ...(next.qualityActivity ?? {}),
      targetedChecks: (next.qualityActivity?.targetedChecks ?? 0) + 1, lastDisposition: d.disposition, commandCount: d.commandCount }; break;
    case 'quality_revision_changed': next.qualityActivity = { ...(next.qualityActivity ?? {}), revision: d.revision, taskId: d.taskId }; break;
    case 'verification_start': next.phase = 'verification'; next.verification.status = 'running'; break;
    case 'verification_done': next.verification.status = d.ok ? 'passed' : 'failed'; break;
    case 'review_provider_retry': next.phase = 'review'; break;
    case 'invocation_recovery_cancelled': next.lastDecision = { type: 'recovery', decision: 'cancelled', reason: d.reason }; break;
    case 'invocation_recovered': next.lastDecision = { type: 'recovery', decision: 'recovered', reason: d.reason }; break;
    case 'invocation_recovery_exhausted': case 'invocation_retry_skipped':
      next.lastDecision = { type: 'recovery', decision: event.kind === 'invocation_retry_skipped' ? 'suppressed' : 'exhausted', reason: d.reason }; break;
    case 'review_interrupted': next.phase = 'review'; next.lastDecision = { type: 'review', decision: 'interrupted', reason: d.reason }; break;
    case 'fix_round': next.activity.fixRounds++; break;
    case 'fix_resolution': next.lastDecision = { type: 'fix', decision: d.decision, reason: d.reason }; break;
    case 'workspace_drift':
      next.activity.reconciliationChecks++;
      next.workspace.status = 'reconciling'; next.workspace.driftCount++; next.workspace.gitFields = d.gitFields; break;
    case 'workspace_drift_reconciled': next.workspace.status = 'reconciled'; break;
    case 'workspace_drift_ignored': next.workspace.status = 'unchanged_semantically'; break;
    case 'complete': next.resultStatus = d.resultStatus; break;
  }
  next.diagnostics = next.diagnostics.slice(-12);
  return next;
}

async function assertSafeAncestors(target) {
  let current=path.resolve(target);
  while (true) {
    try {
      const st=await lstat(current);
      if(st.isSymbolicLink() || !st.isDirectory())throw new Error('Unsafe execution trace directory: ancestor symlink or non-directory');
    } catch(error){if(error.code!=='ENOENT')throw error;}
    const parent=path.dirname(current);
    if(parent===current)break;
    current=parent;
  }
}
async function safeDir(dir) {
  await assertSafeAncestors(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertSafeAncestors(dir);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe execution trace directory: ${dir}`);
  await chmod(dir, 0o700).catch(() => {});
}
async function appendSafe(file, payload, durable = false) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 ||
      (typeof process.getuid==='function' && st.uid!==process.getuid()) ||
      st.size + Buffer.byteLength(payload, 'utf8') > MAX_BYTES) throw new Error('Execution trace size limit reached');
    await handle.writeFile(payload, 'utf8');
    if (durable) await handle.sync();
  } finally { await handle.close(); }
}

function checkpointOverlay(view, session) {
  const current = clone(view);
  const checkpoint = session?.implementationCheckpoint;
  if (!checkpoint) return current;
  const completed = new Set(checkpoint.completedStages ?? []);
  // On resume a checkpoint may be older than the first recorded run. Make
  // durable completed stage IDs visible even without a stage_start event.
  for (const id of completed) {
    if (!current.stages.some((stage) => stage.id === id)) current.stages.push({ id, status: 'completed', index: null, total: null, stepIds: [] });
  }
  current.stages = current.stages.map((stage) => ({
    ...stage, status: completed.has(stage.id) ? 'completed' :
      (stage.status === 'awaiting_checkpoint_confirmation' ? 'unconfirmed' : stage.status),
  }));
  current.checkpoint = {
    status: checkpoint.status ?? null,
    completedStages: [...completed].slice(0, 200),
    savedPlanId: checkpoint.planId ?? null,
    nextStage: Array.isArray(session.implementationPlan?.stages)
      ? session.implementationPlan.stages.find((s) => !completed.has(s.id))?.id ?? null : null,
  };
  return current;
}

export function createExecutionObserver({
  root = path.join(getSessionStateDir(), 'execution'), onError = () => {},
  maxRunsPerSession = 20, maxAgeDays = 14,
} = {}) {
  const runs = new Map();
  const latest = new Map();
  const watchers = new Map();
  const writes = new Map();
  const retentionTails = new Map();

  function prune() {
    if (runs.size <= 64) return;
    for (const [id, record] of runs) {
      if (runs.size <= 48) break;
      if (STATUSES.has(record.view.status)) runs.delete(id);
    }
  }

  const where = (sessionId, runId) => {
    if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(runId)) throw new TypeError('Invalid execution identifier');
    return path.join(root, sessionId, `${runId}.jsonl`);
  };

  function publish(sessionId, view) {
    // A superseded run may finish after a newer run has started. Do not let
    // its terminal event overwrite the currently displayed execution.
    if (latest.get(sessionId) !== view.runId) return;
    for (const listener of watchers.get(sessionId) ?? []) {
      try { listener(clone(view)); } catch (error) { onError(error); }
    }
  }
  // Cleanup occurs after terminal persistence, and never deletes an active
  // run. Per-session quotas bound growth without introducing a second store of
  // authoritative task state. Old traces are optional diagnostics only.
  async function applyRetention(sessionId) {
    const dir = path.join(root, sessionId);
    const entries = await readdir(dir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-zA-Z0-9._-]{1,160}\.jsonl$/.test(entry.name)) continue;
      const runId = entry.name.slice(0, -6);
      const st = await lstat(path.join(dir, entry.name));
      if (!st.isFile() || st.isSymbolicLink()) continue;
      candidates.push({ runId, file: path.join(dir, entry.name), mtime: st.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime || b.runId.localeCompare(a.runId));
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * 86400_000;
    let kept = 0;
    for (const item of candidates) {
      const active = runs.get(item.runId);
      const running = active && !STATUSES.has(active.view.status);
      if (running || (kept < Math.max(1, maxRunsPerSession) && item.mtime >= cutoff)) {
        kept++;
        continue;
      }
      // A live observer might still have a read in progress. Unlinking its
      // inode is safe; new readers will not see the removed trace.
      await unlink(item.file);
      runs.delete(item.runId);
      writes.delete(item.runId);
    }
  }
  function pruneSession(sessionId) {
    const previous = retentionTails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => applyRetention(sessionId));
    retentionTails.set(sessionId, current);
    return current.finally(() => {
      if (retentionTails.get(sessionId) === current) retentionTails.delete(sessionId);
    });
  }

  function enqueue(run, event) {
    const file = where(run.sessionId, run.runId);
    const prev = writes.get(run.runId) ?? Promise.resolve();
    const operation = prev.catch(() => {}).then(async () => {
      await safeDir(root);
      await safeDir(path.join(root, run.sessionId));
      await appendSafe(file, `${JSON.stringify(event)}\n`, /^run\.|implementation_stage_done|fix_resolution|implementation_checkpoint_resumed/.test(event.kind));
    }).catch((error) => {
      run.view.trace.degraded = true;
      run.writeError = error;
      onError(error);
    });
    writes.set(run.runId, operation);
  }

  // Correlation is derived from events actually emitted by the core. Never
  // infer new role invocations from Git reconciliation turns: those turns run
  // inside the existing provider invocation.
  function correlation(run, type, fields) {
    const role = code(fields.role);
    const explicitId = identifier(fields.invocationId);
    let invocationId = explicitId;
    if (type === 'role_start' && invocationId) {
      const current = run.activeByRole.get(role) ?? new Set();
      current.add(invocationId);
      run.activeByRole.set(role, current);
    } else if (!invocationId && role) {
      const active = run.activeByRole.get(role);
      // Concurrent invocations of the same role are ambiguous; never guess.
      if (active?.size === 1) invocationId = [...active][0];
    }
    const stageId = /^implementation_stage_/.test(type)
      ? code(fields.stage)
      : run.activeStageId;
    const result = { invocationId, stageId, parentId: invocationId ?? stageId ?? null };
    if (type === 'role_start') result.parentId = stageId ?? null;
    if (type === 'workspace_drift' || type === 'workspace_drift_reconciled' || type === 'workspace_drift_ignored') {
      if (invocationId) {
        const previous = run.reconciliationAttempts.get(invocationId) ?? 0;
        const attempt = type === 'workspace_drift' ? previous + 1 : previous;
        if (type === 'workspace_drift') run.reconciliationAttempts.set(invocationId, attempt);
        result.attempt = attempt || null;
      }
      result.reasonCode = type === 'workspace_drift_ignored' ? 'NON_SEMANTIC_GIT_METADATA'
        : type === 'workspace_drift_reconciled' ? 'WORKSPACE_RECONCILED' : 'SEMANTIC_WORKSPACE_DRIFT';
    } else if (type === 'fix_round' || type === 'fix_resolution') {
      result.reasonCode = type === 'fix_round' ? 'FIX_ROUND' : 'FIX_DECISION';
      if (type === 'fix_round' && Number.isInteger(fields.round)) result.attempt = fields.round;
    } else if (type === 'role_error' || type === 'role_cancelled') {
      result.reasonCode = type === 'role_error' ? 'ROLE_ERROR' : 'ROLE_CANCELLED';
    }
    if (type === 'implementation_stage_start') run.activeStageId = stageId;
    if (type === 'implementation_stage_done' || type === 'implementation_stage_interrupted') {
      if (run.activeStageId === stageId) run.activeStageId = null;
    }
    if (['role_done', 'role_error', 'role_cancelled'].includes(type) && explicitId) {
      const active = run.activeByRole.get(role);
      active?.delete(explicitId);
      if (active?.size === 0) run.activeByRole.delete(role);
    }
    return result;
  }

  function record(run, type, fields = {}) {
    if (!IMPORTANT.has(type)) {
      run.view.trace.droppedTelemetry++;
      return;
    }
    if (run.recorded >= MAX_EVENTS && !/^run\.(finished|failed|cancelled)$/.test(type)) {
      run.view.trace.truncated = true;
      return;
    }
    const event = {
      version: 1, eventId: randomUUID(), sessionId: run.sessionId, runId: run.runId,
      sequence: run.view.lastSequence + 1, timestamp: new Date().toISOString(),
      kind: type, correlation: correlation(run, type, fields),
      data: observableEventData({ type, ...fields }),
    };
    run.recorded++;
    run.view = projectExecutionEvent(run.view, event);
    enqueue(run, event);
    publish(run.sessionId, run.view);
  }

  function begin(sessionId) {
    if (!SAFE_ID.test(sessionId)) throw new TypeError('Invalid execution session id');
    const runId = randomUUID();
    const run = { sessionId, runId, view: initial(runId, sessionId, new Date().toISOString()),
      recorded: 0, activeByRole: new Map(), reconciliationAttempts: new Map(), activeStageId: null };
    runs.set(runId, run);
    prune();
    latest.set(sessionId, runId);
    record(run, 'run.started');
    return {
      runId,
      running() { record(run, 'run.running'); },
      event(evt) { record(run, evt.type, evt); },
      async finish({ status, resultStatus, code, reason, origin, severity, retryable, summary, nextAction, committed } = {}) {
        if (STATUSES.has(run.view.status)) return;
        await (writes.get(runId) ?? Promise.resolve());
        record(run, status === 'cancelled' ? 'run.cancelled' : status === 'failed' ? 'run.failed' : 'run.finished',
          { resultStatus, code, reason, origin, severity, retryable, summary, nextAction, committed, droppedTelemetry: run.view.trace.droppedTelemetry, truncated: run.view.trace.truncated,
            degraded:run.view.trace.degraded });
        await (writes.get(runId) ?? Promise.resolve());
        if (run.writeError) onError(run.writeError);
        else await pruneSession(run.sessionId).catch(onError);
      },
    };
  }

  async function readRun(sessionId, runId) {
    const file = where(sessionId, runId);
    const inMemory = runs.get(runId);
    if (inMemory?.sessionId === sessionId) await (writes.get(runId) ?? Promise.resolve());
    let content;
    try {
      await assertSafeAncestors(path.join(root, sessionId));
      for (const dir of [root, path.join(root, sessionId)]) {
        await assertSafeAncestors(dir);
        const st = await lstat(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Unsafe execution trace directory: ${dir}`);
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st=await handle.stat();
        if (!st.isFile()||st.nlink!==1||(st.mode&0o077)!==0||
            (typeof process.getuid==='function'&&st.uid!==process.getuid()))
          throw new Error('Unsafe execution trace file');
        content = await handle.readFile('utf8');
      } finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (content.length > MAX_BYTES + 2048) throw new Error('Trace exceeds read limit');
    const events = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { break; } // possible partial final line after crash
      if (event.version !== 1 || event.sessionId !== sessionId || event.runId !== runId || event.sequence !== events.length + 1) throw new Error('Invalid execution trace sequence');
      events.push(event);
    }
    if (!events.length) return null;
    let view = initial(runId, sessionId, events[0].timestamp);
    for (const event of events) view = projectExecutionEvent(view, event);
    if (!STATUSES.has(view.status)) { view.status = 'interrupted'; view.activeInvocations = []; }
    return { events, view };
  }

  async function latestRun(sessionId) {
    if (!SAFE_ID.test(sessionId)) throw new TypeError('Invalid execution session id');
    let runId = latest.get(sessionId);
    if (!runId) {
      const dir = path.join(root, sessionId);
      let entries;
      try {
        const st = await lstat(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe execution trace session directory');
        entries = await readdir(dir);
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      let best = null;
      for (const name of entries.filter((s) => /^[a-zA-Z0-9._-]{1,160}\.jsonl$/.test(s)).slice(0, 1000)) {
        const file = path.join(dir, name);
        const st = await lstat(file);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        const runId = name.slice(0, -6);
        // Only the first bounded line is needed; do not parse/read entire runs.
        let startedAt = null;
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buf = Buffer.alloc(2048);
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
          const first = buf.toString('utf8', 0, bytesRead).split('\n', 1)[0];
          const event = JSON.parse(first);
          if (event.kind === 'run.started' && event.sessionId === sessionId && event.runId === runId) startedAt = event.timestamp;
        } catch { /* invalid or unfinished trace, ignore */ }
        finally { await handle.close(); }
        if (startedAt && (!best || startedAt > best.startedAt || (startedAt === best.startedAt && runId > best.runId))) {
          best = { runId, startedAt };
        }
      }
      runId = best?.runId;
    }
    return runId ?? null;
  }

  async function getView(sessionId, { runId = null, session = null } = {}) {
    const target = runId ?? await latestRun(sessionId);
    if (!target) return null;
    const live = runs.get(target);
    let view = live?.sessionId === sessionId ? live.view : (await readRun(sessionId, target))?.view;
    if (!view) return null;
    const isLatest = target === await latestRun(sessionId);
    return isLatest ? checkpointOverlay(view, session) : { ...clone(view), historicalSnapshot: true };
  }
  async function getTrace(sessionId, { runId = null, limit = 100, full = false } = {}) {
    const target = runId ?? await latestRun(sessionId);
    if (!target) return [];
    const restored = await readRun(sessionId, target);
    // Full sanitized traces are only for explicit offline evaluation. Normal
    // UI consumers retain a strict bounded-response limit.
    return restored?.events.slice(full ? 0 : -Math.max(1, Math.min(500, limit))) ?? [];
  }
  // Historical runs are diagnostics, not current checkpoints. This list is
  // ordered using the initial run event rather than filesystem mtimes.
  async function listRuns(sessionId, { limit = 10 } = {}) {
    if (!SAFE_ID.test(sessionId)) throw new TypeError('Invalid execution session id');
    const dir = path.join(root, sessionId);
    let names;
    try {
      await assertSafeAncestors(dir);
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe execution trace session directory');
      names = (await readdir(dir)).filter((name) => /^[a-zA-Z0-9._-]{1,160}\.jsonl$/.test(name)).slice(0, 1000);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const results = [];
    for (const name of names) {
      const runId = name.slice(0, -6);
      const result = await readRun(sessionId, runId);
      if (!result) continue;
      const view = result.view;
      results.push({ runId, startedAt: view.startedAt, finishedAt: view.finishedAt,
        status: view.status, resultStatus: view.resultStatus,
        lastSequence: view.lastSequence, diagnosticCode: view.diagnostics.at(-1)?.code ?? null });
    }
    results.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
    return results.slice(0, Math.max(1, Math.min(20, Number.isFinite(limit) ? Math.trunc(limit) : 10)));
  }

  function subscribe(sessionId, listener) {
    if (!SAFE_ID.test(sessionId)) throw new TypeError('Invalid execution session id');
    if (typeof listener !== 'function') throw new TypeError('Expected execution listener');
    const set = watchers.get(sessionId) ?? new Set();
    set.add(listener);
    watchers.set(sessionId, set);
    return () => { set.delete(listener); if (!set.size) watchers.delete(sessionId); };
  }

  // Subscribe *before* reading the snapshot and buffer live updates until the
  // snapshot arrives. The subscription never delivers an older event from the
  // same run after a newer snapshot, and never misses a run started mid-read.
  // Callbacks receive the same sequence-bearing view shape as getView().
  async function watchWithSnapshot(sessionId, listener, { getSession = () => null } = {}) {
    if (typeof listener !== 'function') throw new TypeError('Expected execution listener');
    let pending = [];
    let opening = true;
    let closed = false;
    let last = null;
    const deliver = (view) => {
      if (closed || !view) return;
      if (last?.runId === view.runId && view.lastSequence <= last.lastSequence) return;
      if (last?.runId !== view.runId && last?.startedAt &&
          view.startedAt < last.startedAt) return;
      last = { runId: view.runId, lastSequence: view.lastSequence, startedAt: view.startedAt };
      try { listener(checkpointOverlay(view, getSession())); } catch (error) { onError(error); }
    };
    const unsubscribe = subscribe(sessionId, (view) => {
      if (opening) pending.push(view);
      else deliver(view);
    });
    try {
      const snapshot = await getView(sessionId, { session: getSession() });
      if (!closed) {
        deliver(snapshot);
        // Buffer order is the observer's total publication order. A new run
        // supersedes older runs, even if the old run publishes its terminal
        // event after the new run is created.
        for (const view of pending) deliver(view);
      }
      opening = false;
      pending = [];
      return () => { closed = true; unsubscribe(); };
    } catch (error) { closed = true; unsubscribe(); throw error; }
  }
  // Enumerate trace filenames without parsing all entries, allowing reporting
  // to skip an individual corrupt history file rather than losing a session.
  async function listRunIds(sessionId,{limit=1000}={}) {
    if(!SAFE_ID.test(sessionId))throw new TypeError('Invalid execution session id');
    const dir=path.join(root,sessionId);
    try {
      await assertSafeAncestors(dir);
      const st=await lstat(dir);
      if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Unsafe execution trace session directory');
      const names=await readdir(dir,{withFileTypes:true});
      return names.filter(e=>e.isFile()&&/^[a-zA-Z0-9._-]{1,160}\.jsonl$/.test(e.name))
        .slice(0,Math.max(1,Math.min(1000,limit))).map(e=>({runId:e.name.slice(0,-6)}));
    }catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  async function listSessions({ limit = 100 } = {}) {
    let names;
    try { await assertSafeAncestors(root); const st=await lstat(root); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe execution root');
      names=await readdir(root,{withFileTypes:true}); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return names.filter(entry => entry.isDirectory() && SAFE_ID.test(entry.name))
      .slice(0,Math.max(1,Math.min(1000,limit))).map(entry=>entry.name);
  }
  return { begin, getView, getTrace, listRuns, listRunIds, listSessions, subscribe, watchWithSnapshot };
}
