import { normalizeExecutionOutcome } from './efficiency/outcome.mjs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { ensureQuality } from './quality-state.mjs';
import { normalizeTokenUsage } from './efficiency/analytics.mjs';
import { normalizeContextProfile, normalizeProviderPromptProfile } from './efficiency/profiling.mjs';
import { normalizeRouterContextTelemetry } from './routing/context.mjs';
import { projectName } from './project.mjs';
import { deleteEvidenceSnapshot } from './evidence/store.mjs';
import {
  cleanupSessionAttachments,
  deleteSessionAttachments,
  normalizeAttachmentRefs,
} from './attachment-store.mjs';

const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;
const saveTails = new Map();
// Cooperating host processes must never overwrite a newer snapshot.
const lastObservedRevisions = new Map();
// Each loaded session carries its own optimistic-concurrency token. A global
// per-ID last-seen revision alone lets an unrelated load/save silently advance
// a stale session's expected revision, producing lost updates within one host.
// An enumerable symbol survives object spread but is omitted from persisted JSON.
const sessionRevision = Symbol('role-orchestrator.session-revision');
const revisionHash = (payload) => createHash('sha256').update(payload).digest('hex');

async function withSessionWriteLock(sessionId, task) {
  await ensureSafeDirectory(sessionsDir());
  if (process.platform === 'linux') {
    // Kernel-owned advisory lock: unlike PID lock files, this automatically
    // releases on process death. Keep the lock inode; unlinking it would allow
    // another writer to create a different inode and bypass an active lock.
    const lockPath = path.join(sessionsDir(), `${sessionId}.lock`);
    const handle = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      let acquired = false;
      for (let attempt = 0; attempt < 200 && !acquired; attempt++) {
        const status = await new Promise((resolve, reject) => {
          const child = spawn('flock', ['-n', '-x', '3'], { stdio: ['ignore', 'ignore', 'pipe', handle.fd] });
          let errorText = '';
          child.stderr.on('data', chunk => { errorText = `${errorText}${chunk}`.slice(-2000); });
          child.once('error', reject);
          child.once('close', (code) => {
            if (code === 0) resolve(true);
            else if (code === 1) resolve(false);
            else reject(Object.assign(new Error(`Cannot acquire session lock: ${errorText}`), { code: 'SESSION_LOCK_UNAVAILABLE' }));
          });
        });
        acquired = status;
        if (!acquired) await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!acquired) throw Object.assign(new Error(`Session ${sessionId} is owned by another writer.`), { code: 'SESSION_BUSY' });
      return await task();
    } finally { await handle.close(); }
  }
  // Portable conservative fallback for hosts without Linux flock support.
  // A stale owner is checked explicitly instead of ever allowing last-write-wins.
  const lockPath = path.join(sessionsDir(), `${sessionId}.lock`);
  let lock;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // Lock ownership is explicit; do not steal an active process's lock.
      // A dead process may leave a stale file behind after a crash.
      try {
        const meta = JSON.parse(await readFile(lockPath, 'utf8'));
        if (Number.isSafeInteger(meta.pid) && meta.pid > 0 && meta.pid !== process.pid) {
          let alive = true;
          try { process.kill(meta.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
          if (!alive) { await rm(lockPath, { force: true }); continue; }
        }
      } catch (e) { if (e?.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!lock) throw Object.assign(new Error(`Session ${sessionId} is owned by another writer.`), { code: 'SESSION_BUSY' });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
    await lock.sync();
    return await task();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function assertSessionRevision(sessionId, expected) {
  let actual = null;
  try { actual = revisionHash(await readFile(sessionPath(sessionId), 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (actual !== expected) {
    throw Object.assign(new Error(`Concurrent session update detected for ${sessionId}; reload required.`), {
      code: 'SESSION_REVISION_CONFLICT',
    });
  }
}

function stateRoot() {
  if (process.env.AGENT_STATE_DIR) return path.resolve(process.env.AGENT_STATE_DIR);
  const base = process.env.XDG_STATE_HOME
    ? path.resolve(process.env.XDG_STATE_HOME)
    : path.join(homedir(), '.local', 'state');
  return path.join(base, projectName);
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(sessionId)) {
    throw new Error(`Invalid ACP session id: ${String(sessionId)}`);
  }
}

function sessionsDir() {
  return path.join(stateRoot(), 'sessions');
}

async function ensureSafeDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe session store directory (must not be a symlink): ${dir}`);
  }
  await chmod(dir, 0o700).catch(() => {});
}

async function assertSafeExistingDirectory(dir) {
  let info;
  try { info = await lstat(dir); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe session store directory (must not be a symlink): ${dir}`);
  }
  return true;
}

function sessionPath(sessionId) {
  assertSessionId(sessionId);
  return path.join(sessionsDir(), `${sessionId}.json`);
}

export function getSessionStateDir() {
  return stateRoot();
}

function serializeSessionOperation(sessionId, operation) {
  const previous = saveTails.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  saveTails.set(sessionId, current);
  return current.finally(() => {
    if (saveTails.get(sessionId) === current) saveTails.delete(sessionId);
  });
}

function normalizeTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript.map((turn) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return { user: '', assistant: '', attachments: [] };
    return {
      user: typeof turn.user === 'string' ? turn.user : '',
      assistant: typeof turn.assistant === 'string' ? turn.assistant : '',
      attachments: normalizeAttachmentRefs(turn.attachments),
    };
  });
}

function normalizeStoredImplementationTasks(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid saved implementation task archive size or format; no tasks were discarded.');
  const ids = new Set();
  for (const task of value) {
    if (task?.version !== 1 || typeof task.taskId !== 'string' || !task.taskId || ids.has(task.taskId)
      || !(task.plan?.version === 1 || task.checkpoint?.version === 1)
      || (task.plan && task.checkpoint && task.plan.planId !== task.checkpoint.planId)) {
      throw new Error('Invalid saved implementation task archive; refusing to silently discard or misassociate checkpoints.');
    }
    if (task.quality !== undefined && task.quality !== null) ensureQuality(task);
    ids.add(task.taskId);
  }
  return value;
}

function safeCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function safeEfficiencyId(value, max = 90) {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/.test(value)
    ? value : null;
}

// v2 aggregate-only tool measurements. Never persist provider identifiers,
// names, arbitrary categories or raw tool data from an imported session.
const TOOL_KINDS_V2 = new Set(['read','edit','delete','move','search','execute','think','fetch','switch_mode','other','unknown']);
function safeToolKinds(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([k,v])=>TOOL_KINDS_V2.has(k)&&safeCount(v)!==null).slice(0,11));
}
function normalizeToolMetrics(value) {
  if (!value || value.version!==2) return null;
  const calls=safeCount(value.calls), events=safeCount(value.events);
  if (calls===null || events===null || calls>2048 || events>100_000 || calls>events) return null;
  const kinds=safeToolKinds(value.kinds);
  const int=(v)=>safeCount(v)??0;
  const outcome={completed:int(value.completed),failed:int(value.failed),cancelled:int(value.cancelled),incomplete:int(value.incomplete)};
  if (Object.values(outcome).reduce((a,b)=>a+b,0)!==calls || Object.values(kinds).reduce((a,b)=>a+b,0)!==calls) return null;
  const kindCoverage={declared:int(value.kindCoverage?.declared),inferred:int(value.kindCoverage?.inferred),unknown:int(value.kindCoverage?.unknown)};
  if (Object.values(kindCoverage).reduce((a,b)=>a+b,0)!==calls) return null;
  const coverage={observed:int(value.contentCoverage?.observed),partial:int(value.contentCoverage?.partial),unknown:int(value.contentCoverage?.unknown),notObserved:int(value.contentCoverage?.notObserved)};
  if (coverage.observed+coverage.unknown+coverage.notObserved!==calls || coverage.partial>coverage.observed) return null;
  if (int(value.lifecycleCoverage)>outcome.completed+outcome.failed+outcome.cancelled || int(value.runningCoverage)>outcome.completed+outcome.failed+outcome.cancelled) return null;
  return {version:2,calls,events,updates:int(value.updates),...outcome,kinds,kindCoverage,
    lifecycleMs:int(value.lifecycleMs),lifecycleCoverage:int(value.lifecycleCoverage),
    runningMs:int(value.runningMs),runningCoverage:int(value.runningCoverage),
    contentCharacters:safeCount(value.contentCharacters),contentUtf8Bytes:safeCount(value.contentUtf8Bytes),
    contentCoverage:coverage,invalidEvents:int(value.invalidEvents),truncated:value.truncated===true};
}

export function normalizeEfficiencyRuns(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-80).filter(row => row?.version === 1 && safeEfficiencyId(row.runId, 128) !== null)
    .map(row => ({
      version: 1, runId: safeEfficiencyId(row.runId, 128),
      taskId: safeEfficiencyId(row.taskId, 128),
      // Never trust an imported group label: derive only from the sanitized,
      // authoritative task ID or the validated run ID. No raw text can enter it.
      reviewOperationId: typeof row.reviewOperationId === 'string' && /^[a-f0-9-]{20,64}$/i.test(row.reviewOperationId)
        ? row.reviewOperationId : null,
      executionGroupId: safeEfficiencyId(row.taskId,128)
        ? `task:${safeEfficiencyId(row.taskId,128)}`
        : typeof row.reviewOperationId === 'string' && /^[a-f0-9-]{20,64}$/i.test(row.reviewOperationId)
          ? `review:${row.reviewOperationId}` : `run:${safeEfficiencyId(row.runId,128)}`,
      outcome: row.outcome ? normalizeExecutionOutcome(row.outcome) : null,
      presetId: safeEfficiencyId(row.presetId),
      status: typeof row.status === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(row.status) ? row.status : 'unknown',
      completedAt: typeof row.completedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.completedAt) && Number.isFinite(Date.parse(row.completedAt)) ? row.completedAt : null,
      fixRounds: Number.isSafeInteger(row.fixRounds) && row.fixRounds >= 0 ? row.fixRounds : 0,
      reviewBatches: Number.isSafeInteger(row.reviewBatches) && row.reviewBatches >= 0 ? row.reviewBatches : 0,
      skillInvocationSource: ['slash','named-reference'].includes(row.skillInvocationSource) ? row.skillInvocationSource : null,
      skillResolutionStatus: ['resolved','unresolved'].includes(row.skillResolutionStatus) ? row.skillResolutionStatus : null,
      routeValidationStatus: ['accepted','corrected','ambiguous'].includes(row.routeValidationStatus) ? row.routeValidationStatus : null,
      routeCorrectionReason: typeof row.routeCorrectionReason === 'string' && /^[a-z_]{1,80}$/.test(row.routeCorrectionReason) ? row.routeCorrectionReason : null,
      reviewStopReason: typeof row.reviewStopReason === 'string' && /^[A-Z_]{1,80}$/.test(row.reviewStopReason) ? row.reviewStopReason : null,
      reviewNoProgressBatches: safeCount(row.reviewNoProgressBatches),
      reviewSemanticCandidateGroups: safeCount(row.reviewSemanticCandidateGroups),
      reviewRiskObligationsTotal: safeCount(row.reviewRiskObligationsTotal),
      reviewRiskObligationsAssessed: safeCount(row.reviewRiskObligationsAssessed),
      reviewMaterialRisksOpen: safeCount(row.reviewMaterialRisksOpen),
      reviewRiskContradictions: safeCount(row.reviewRiskContradictions),
      reviewRiskHypothesesPreserved: safeCount(row.reviewRiskHypothesesPreserved),
      reviewQualityFollowUps: safeCount(row.reviewQualityFollowUps),
      reviewQualityGateDisposition: ['satisfied','incomplete','not_enforced'].includes(row.reviewQualityGateDisposition)
        ? row.reviewQualityGateDisposition : null,
      reviewQualityGateMode: ['off','observe','enforce'].includes(row.reviewQualityGateMode) ? row.reviewQualityGateMode : null,
      reviewRiskEvidenceRejected: safeCount(row.reviewRiskEvidenceRejected),
      reviewRiskEvidenceRejectedReasons: Object.fromEntries(Object.entries(row.reviewRiskEvidenceRejectedReasons && typeof row.reviewRiskEvidenceRejectedReasons === 'object' && !Array.isArray(row.reviewRiskEvidenceRejectedReasons) ? row.reviewRiskEvidenceRejectedReasons : {})
        .filter(([key,value]) => ['contradictory_evidence','unsupported_risk_assessment',
          'missing_finding','unassigned_or_duplicate_risk','requires_independent_conflict_resolution',
          'risk_capacity_exhausted','other_rejected_evidence'].includes(key) && safeCount(value) !== null).slice(0,16)),
      reviewWorkloadRisk: ['normal','medium','high'].includes(row.reviewWorkloadRisk) ? row.reviewWorkloadRisk : null,
      reviewEvidenceRecorded: safeCount(row.reviewEvidenceRecorded),
      reviewObligationsSatisfied: safeCount(row.reviewObligationsSatisfied),
      reviewVerificationStrategy: ['none','source_inspection','targeted_test','independent_review','full_verification'].includes(row.reviewVerificationStrategy) ? row.reviewVerificationStrategy : null,
      executionBudgetPauseReason: ['invocations','elapsed','input_tokens','output_tokens','usage_unavailable'].includes(row.executionBudgetPauseReason) ? row.executionBudgetPauseReason : null,
      reviewExecutionSegments:safeCount(row.reviewExecutionSegments),
      reviewSegmentInvocations:safeCount(row.reviewSegmentInvocations),
      reviewOperationInvocations:safeCount(row.reviewOperationInvocations),
      reviewOperationHardLimitReached:typeof row.reviewOperationHardLimitReached==='boolean'?row.reviewOperationHardLimitReached:null,
      reviewSegmentBudgetExhausted:typeof row.reviewSegmentBudgetExhausted==='boolean'?row.reviewSegmentBudgetExhausted:null,
      reviewSegmentFeasible:typeof row.reviewSegmentFeasible==='boolean'?row.reviewSegmentFeasible:null,
      reviewContinuationRequired:typeof row.reviewContinuationRequired==='boolean'?row.reviewContinuationRequired:null,
      rolePromptCharacters: safeCount(row.rolePromptCharacters),
      roleDuplicateCharacters: safeCount(row.roleDuplicateCharacters),
      contextCrossInvocationRepeatedCharacters: safeCount(row.contextCrossInvocationRepeatedCharacters),
      reviewInstructionCharactersSaved: safeCount(row.reviewInstructionCharactersSaved),
      reviewInstructionDocumentsDeferred: safeCount(row.reviewInstructionDocumentsDeferred),
      reviewLocationsResolved: safeCount(row.reviewLocationsResolved),
      reviewLocationsTotal: safeCount(row.reviewLocationsTotal),
      evidenceMirrorWrites: safeCount(row.evidenceMirrorWrites),
      evidenceMirrorFailures: safeCount(row.evidenceMirrorFailures),
      targetedVerificationExecutions: safeCount(row.targetedVerificationExecutions),
      targetedVerificationReused: safeCount(row.targetedVerificationReused),
      reviewEvidenceUnrelatedOmitted: safeCount(row.reviewEvidenceUnrelatedOmitted),
      reviewHistoryCharactersSaved: safeCount(row.reviewHistoryCharactersSaved),
      targetedVerificationObservations: safeCount(row.targetedVerificationObservations),
      reviewExecutionStrategy: ['focused','standard','deep','legacy'].includes(row.reviewExecutionStrategy) ? row.reviewExecutionStrategy : null,
      reviewEstimatedInvocations: safeCount(row.reviewEstimatedInvocations),
      reviewScopeExcludedFiles: safeCount(row.reviewScopeExcludedFiles),
      reviewRolesBypassed: safeCount(row.reviewRolesBypassed),
      reviewPriorEvidenceCharacters: safeCount(row.reviewPriorEvidenceCharacters),
      reviewBatchLimit: safeCount(row.reviewBatchLimit),
      reviewScopeStatus: ['resolved', 'partial', 'unresolved'].includes(row.reviewScopeStatus) ? row.reviewScopeStatus : null,
      reviewScopeReason: typeof row.reviewScopeReason === 'string' && /^[a-z_]{1,80}$/.test(row.reviewScopeReason) ? row.reviewScopeReason : null,
      reviewFilesTotal: safeCount(row.reviewFilesTotal),
      reviewFilesKnown: safeCount(row.reviewFilesKnown),
      reviewFilesVerified: safeCount(row.reviewFilesVerified),
      reviewFindingsRaw: safeCount(row.reviewFindingsRaw),
      reviewFindingsUnique: safeCount(row.reviewFindingsUnique),
      reviewFindingsPotentialDuplicates: safeCount(row.reviewFindingsPotentialDuplicates),
      reviewFindingsReconciled: safeCount(row.reviewFindingsReconciled),
      reviewFindingsReported: safeCount(row.reviewFindingsReported),
      reviewObservations: safeCount(row.reviewObservations),
      reviewCanonicalFindings: safeCount(row.reviewCanonicalFindings),
      reviewConfirmedMerges: safeCount(row.reviewConfirmedMerges),
      reviewPotentialDuplicatePairs: safeCount(row.reviewPotentialDuplicatePairs),
      reviewVerificationSource: ['workflow','observed','unverified'].includes(row.reviewVerificationSource) ? row.reviewVerificationSource : null,
      reviewObservedExecuteCalls: safeCount(row.reviewObservedExecuteCalls),
      reviewUnitsTotal: safeCount(row.reviewUnitsTotal) ?? 0,
      reviewUnitsVerified: safeCount(row.reviewUnitsVerified) ?? 0,
      reviewUnitsPending: safeCount(row.reviewUnitsPending) ?? 0,
      reviewUnitsResumed: safeCount(row.reviewUnitsResumed) ?? 0,
      reviewWorkRepeated: safeCount(row.reviewWorkRepeated) ?? 0,
      retries: Number.isSafeInteger(row.retries) && row.retries >= 0 ? row.retries : 0,
      recoveredOperations: safeCount(row.recoveredOperations) ?? 0,
      exhaustedOperations: safeCount(row.exhaustedOperations) ?? 0,
      retrySuppressed: safeCount(row.retrySuppressed) ?? 0,
      recoveryElapsedMs: safeCount(row.recoveryElapsedMs) ?? 0,
      verificationFailures: Number.isSafeInteger(row.verificationFailures) && row.verificationFailures >= 0 ? row.verificationFailures : 0,
      droppedInvocations: Number.isSafeInteger(row.droppedInvocations) && row.droppedInvocations >= 0 ? row.droppedInvocations : 0,
      invocations: Array.isArray(row.invocations) ? row.invocations.slice(0, 128).map(item => {
        const metric=normalizeToolMetrics(item?.toolMetrics);
        return ({
        invocationId: safeEfficiencyId(item?.invocationId, 120),
        role: safeEfficiencyId(item?.role),
        provider: safeEfficiencyId(item?.provider),
        model: safeEfficiencyId(item?.model),
        status: ['incomplete', 'completed', 'failed', 'cancelled'].includes(item?.status) ? item.status : 'incomplete',
        elapsedMs: Number.isSafeInteger(item?.elapsedMs) && item.elapsedMs >= 0 ? item.elapsedMs : null,
        timingBasis: item?.timingBasis === 'monotonic_invocation' ? 'monotonic_invocation' : null,
        usageCoverage: item?.usageCoverage === 'observed_snapshot' ? 'observed_snapshot' : 'unknown',
        usage: normalizeTokenUsage(item?.usage),
        contextProfile: normalizeContextProfile(item?.contextProfile),
        providerPromptProfile: normalizeProviderPromptProfile(item?.providerPromptProfile),
        routerContext: normalizeRouterContextTelemetry(item?.routerContext),
        usageAvailability: {
          contextOccupancy: item?.usageAvailability?.contextOccupancy==='observed'||safeCount(item?.contextOccupancy?.peak)!==null?'observed':'unknown',
          inputTokens: ['complete','partial'].includes(item?.usageAvailability?.inputTokens)?item.usageAvailability.inputTokens:'unknown',
          outputTokens: ['complete','partial'].includes(item?.usageAvailability?.outputTokens)?item.usageAvailability.outputTokens:'unknown',
          cachedTokens: ['complete','partial'].includes(item?.usageAvailability?.cachedTokens)?item.usageAvailability.cachedTokens:'unknown',
          providerPrompt:item?.usageAvailability?.providerPrompt==='observed'||safeCount(item?.providerPromptProfile?.characters)!==null?'observed':'unknown',
        },
        toolCategories:metric?.kinds ?? Object.fromEntries(Object.entries(item?.toolCategories && typeof item.toolCategories==='object' && !Array.isArray(item.toolCategories)?item.toolCategories:{}).filter(([k,v])=>[...TOOL_KINDS_V2,'git','verification'].includes(k)&&safeCount(v)!==null).slice(0,13)),
        toolMetrics:metric,
        toolCompleted:metric?.completed ?? safeCount(item?.toolCompleted)??0,
        toolDurationMs:metric?.lifecycleMs ?? safeCount(item?.toolDurationMs)??0,
        observedToolContentCharacters:metric?metric.contentCharacters:safeCount(item?.observedToolContentCharacters)??0,
        contextOccupancy: {
          first: safeCount(item?.contextOccupancy?.first),
          peak: safeCount(item?.contextOccupancy?.peak),
          last: safeCount(item?.contextOccupancy?.last),
          window: safeCount(item?.contextOccupancy?.window),
          updates: safeCount(item?.contextOccupancy?.updates) ?? 0,
        },
        contextTimeline: (() => {
          const raw = item?.contextTimeline;
          const samples = Array.isArray(raw?.samples) ? raw.samples.slice(-40).map(sample => ({
            elapsedMs: safeCount(sample?.elapsedMs), usedTokens: safeCount(sample?.usedTokens),
            windowTokens: safeCount(sample?.windowTokens), toolOrdinal: safeCount(sample?.toolOrdinal),
          })).filter(sample => sample.elapsedMs !== null && sample.usedTokens !== null) : [];
          return { samples, droppedSamples: safeCount(raw?.droppedSamples) ?? 0, truncated: raw?.truncated === true || (raw?.samples?.length ?? 0) > 40 };
        })(),
        usageCompleteness: ['complete','partial','unknown'].includes(item?.usageCompleteness) ? item.usageCompleteness : 'unknown',
        usageObservations: safeCount(item?.usageObservations) ?? 0,
        usageRejected: safeCount(item?.usageRejected) ?? 0,
        usageAmbiguous: item?.usageAmbiguous === true,
        executionScope: item?.executionScope && typeof item.executionScope === 'object' ? {
          phase: safeEfficiencyId(item.executionScope.phase, 30),
          attempt: safeCount(item.executionScope.attempt),
          retryReason: safeEfficiencyId(item.executionScope.retryReason, 48),
          operationId: safeEfficiencyId(item.executionScope.operationId, 128),
        } : null,
        toolUpdatesAfterStart: metric?.updates ?? safeCount(item?.toolUpdatesAfterStart) ?? 0,
        firstReasoningElapsedMs: safeCount(item?.firstReasoningElapsedMs),
        firstCommentaryElapsedMs: safeCount(item?.firstCommentaryElapsedMs),
        firstAnswerElapsedMs: safeCount(item?.firstAnswerElapsedMs),
        firstToolCallElapsedMs: safeCount(item?.firstToolCallElapsedMs),
        firstActivityElapsedMs: safeCount(item?.firstActivityElapsedMs),
        toolCalls: metric?.calls ?? safeCount(item?.toolCalls) ?? 0,
        toolEvents: metric?.events ?? safeCount(item?.toolEvents) ?? 0,
        toolCallsTruncated: metric?.truncated ?? (item?.toolCallsTruncated === true),
        firstContentElapsedMs: safeCount(item?.firstContentElapsedMs),
        stageId: safeEfficiencyId(item?.stageId),
        reviewBatch: safeCount(item?.reviewBatch),
        fixRound: safeCount(item?.fixRound),
      }); }) : [],
    }));
}

function normalizeStoredReviewCheckpoint(checkpoint) {
  if (checkpoint === null || checkpoint === undefined) return null;
  if (![1, 2, 3, 4].includes(checkpoint?.version) || typeof checkpoint.scopeKey !== 'string') {
    throw new Error('Unsupported or invalid review checkpoint: refusing to silently discard persisted evidence.');
  }
  return checkpoint;
}

function normalizeSession(parsed) {
  return {
    cwd: parsed.cwd,
    repoRoot: typeof parsed.repoRoot === 'string' ? parsed.repoRoot : null,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    history: Array.isArray(parsed.history) ? parsed.history : [],
    transcript: normalizeTranscript(parsed.transcript),
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null,
    selectedProfile: typeof parsed.selectedProfile === 'string' ? parsed.selectedProfile : null,
    roleEditor: typeof parsed.roleEditor === 'string' ? parsed.roleEditor : null,
    profileOverrides: parsed.profileOverrides && typeof parsed.profileOverrides === 'object' && !Array.isArray(parsed.profileOverrides) ? parsed.profileOverrides : {},
    roleAssignments: parsed.roleAssignments && typeof parsed.roleAssignments === 'object' && !Array.isArray(parsed.roleAssignments) ? parsed.roleAssignments : null,
    fastModeOverride: typeof parsed.fastModeOverride === 'boolean' ? parsed.fastModeOverride : null,
    codexAgentMode: typeof parsed.codexAgentMode === 'string' ? parsed.codexAgentMode : null,
    codexCollaborationMode: typeof parsed.codexCollaborationMode === 'string' ? parsed.codexCollaborationMode : null,
    implementationTasks: normalizeStoredImplementationTasks(parsed.implementationTasks),
    activeImplementationTaskId: typeof parsed.activeImplementationTaskId === 'string' ? parsed.activeImplementationTaskId : null,
    implementationPlan: parsed.implementationPlan?.version === 1 && typeof parsed.implementationPlan.planId === 'string' ? parsed.implementationPlan : null,
    implementationCheckpoint: parsed.implementationCheckpoint?.version === 1 && typeof parsed.implementationCheckpoint.planId === 'string' ? parsed.implementationCheckpoint : null,
    implementationReconciliation: parsed.implementationReconciliation?.version === 1 && typeof parsed.implementationReconciliation.planId === 'string' ? parsed.implementationReconciliation : null,
    efficiencyRuns: normalizeEfficiencyRuns(parsed.efficiencyRuns),
    efficiencyTelemetryTruncated: parsed.efficiencyTelemetryTruncated === true,
    reviewCheckpoint: normalizeStoredReviewCheckpoint(parsed.reviewCheckpoint),
  };
}

async function fsyncPath(file) {
  const handle = await open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fsyncDir(dir) {
  try {
    const handle = await open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  }
}

function prepareSessionSave(sessionId, session) {
  const transcript = normalizeTranscript(session.transcript);
  const efficiencyRuns = normalizeEfficiencyRuns(session.efficiencyRuns);
  // Keep telemetry subordinate to authoritative Plan, P2 quality and history.
  // Drop oldest optional runs; do not fail session persistence due to metrics.
  let telemetryBytes = Buffer.byteLength(JSON.stringify(efficiencyRuns), 'utf8');
  let pruned = Array.isArray(session.efficiencyRuns) && session.efficiencyRuns.length > efficiencyRuns.length;
  while (efficiencyRuns.length > 1 && telemetryBytes > 2_000_000) {
    efficiencyRuns.shift(); pruned = true;
    telemetryBytes = Buffer.byteLength(JSON.stringify(efficiencyRuns), 'utf8');
  }
  // One large run: discard oldest *details*, retaining the run's aggregate
  // identity and most recent invocation results. This is last-resort capping.
  while (efficiencyRuns.length && telemetryBytes > 2_000_000 && efficiencyRuns[0].invocations.length > 1) {
    efficiencyRuns[0].invocations.shift(); pruned = true;
    efficiencyRuns[0].droppedInvocations++;
    telemetryBytes = Buffer.byteLength(JSON.stringify(efficiencyRuns), 'utf8');
  }
  const telemetryTruncated = session.efficiencyTelemetryTruncated === true || pruned;
  // Cap is intentionally below the overall 20 MB session guard; canonical
  // task state remains subject to the existing strict durability limit.

  const persisted = {
    version: STORE_VERSION,
    sessionId,
    cwd: session.cwd,
    repoRoot: typeof session.repoRoot === 'string' ? session.repoRoot : null,
    createdAt: session.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: Array.isArray(session.history) ? session.history : [],
    transcript,
    title: typeof session.title === 'string' && session.title.trim() ? session.title.trim() : null,
    selectedProfile: typeof session.selectedProfile === 'string' ? session.selectedProfile : null,
    roleEditor: typeof session.roleEditor === 'string' ? session.roleEditor : null,
    profileOverrides: session.profileOverrides && typeof session.profileOverrides === 'object' && !Array.isArray(session.profileOverrides) ? session.profileOverrides : {},
    roleAssignments: session.roleAssignments && typeof session.roleAssignments === 'object' && !Array.isArray(session.roleAssignments) ? session.roleAssignments : null,
    fastModeOverride: typeof session.fastModeOverride === 'boolean' ? session.fastModeOverride : null,
    codexAgentMode: typeof session.codexAgentMode === 'string' ? session.codexAgentMode : null,
    codexCollaborationMode: typeof session.codexCollaborationMode === 'string' ? session.codexCollaborationMode : null,
    implementationTasks: Array.isArray(session.implementationTasks) ? session.implementationTasks : [],
    activeImplementationTaskId: typeof session.activeImplementationTaskId === 'string' ? session.activeImplementationTaskId : null,
    implementationPlan: session.implementationPlan?.version === 1 ? session.implementationPlan : null,
    implementationCheckpoint: session.implementationCheckpoint?.version === 1 ? session.implementationCheckpoint : null,
    implementationReconciliation: session.implementationReconciliation?.version === 1 ? session.implementationReconciliation : null,
    efficiencyRuns,
    efficiencyTelemetryTruncated: telemetryTruncated,
    reviewCheckpoint: normalizeStoredReviewCheckpoint(session.reviewCheckpoint),
  };
  let payload = JSON.stringify(persisted, null, 2);
  // Two independent limits: telemetry budget and canonical session budget.
  // Never let optional telemetry cause a previously persistable session to fail.
  while (Buffer.byteLength(payload, 'utf8') > 20_000_000 && persisted.efficiencyRuns.length > 0) {
    persisted.efficiencyRuns.shift();
    persisted.efficiencyTelemetryTruncated = true;
    payload = JSON.stringify(persisted, null, 2);
  }
  if (Buffer.byteLength(payload, 'utf8') > 20_000_000) throw new Error('Session state exceeds 20 MB; refusing unbounded persistence.');
  return { payload, transcript };
}

async function saveSessionUnlocked(sessionId, prepared) {
  const dir = sessionsDir();
  await ensureSafeDirectory(dir);

  const target = sessionPath(sessionId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const { payload, transcript } = prepared;

  try {
    await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600).catch(() => {});
    await fsyncPath(temp);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }

  lastObservedRevisions.set(sessionId, revisionHash(payload));
  // Once rename succeeds, the new JSON is the process-visible source of truth.
  // A later directory-fsync failure must NOT be reported as a pre-commit save
  // failure: callers could otherwise release pending protection and delete a
  // blob referenced by the already-installed target. Instead, keep the save
  // committed but skip destructive eager cleanup when rename durability is
  // uncertain, retaining both old and new blobs until reconciliation can see a
  // stable persisted session after restart.
  await chmod(target, 0o600).catch(() => {});
  let durableRename = true;
  try {
    await fsyncDir(dir);
  } catch (error) {
    durableRename = false;
    console.error(`[session-store] session directory fsync failed for ${sessionId}; attachment cleanup deferred: ${error?.message ?? error}`);
  }

  if (durableRename) {
    await cleanupSessionAttachments(sessionId, transcript).catch((error) => {
      console.error(`[session-store] attachment cleanup failed for ${sessionId}: ${error?.message ?? error}`);
    });
  }
}

export async function saveSession(sessionId, session) {
  assertSessionId(sessionId);
  // Snapshot synchronously at call time before entering the per-session queue.
  // Otherwise a later mutation of the shared in-memory session object could
  // change what an already-enqueued save eventually writes.
  const prepared = prepareSessionSave(sessionId, session);
  return await serializeSessionOperation(sessionId, () => withSessionWriteLock(sessionId, async () => {
    // Track the version of THIS state object, not the version another load or
    // save of the same session happened to observe. Untagged new-session and
    // legacy direct-save callers retain the original per-process semantics.
    await assertSessionRevision(sessionId, session[sessionRevision] ?? lastObservedRevisions.get(sessionId) ?? null);
    await saveSessionUnlocked(sessionId, prepared);
    // Persistence has committed: attaching an in-memory hint must not turn a
    // successful write into a reported failure (e.g. frozen caller object).
    try { Object.defineProperty(session, sessionRevision, { value: lastObservedRevisions.get(sessionId), configurable: true, writable: true, enumerable: true }); } catch {}
  }));
}

export async function loadSession(sessionId) {
  assertSessionId(sessionId);
  if (!await assertSafeExistingDirectory(sessionsDir())) return null;
  let raw;
  try {
    raw = await readFile(sessionPath(sessionId), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (![LEGACY_STORE_VERSION, STORE_VERSION].includes(parsed?.version) || parsed?.sessionId !== sessionId || typeof parsed?.cwd !== 'string') {
    throw new Error(`Invalid persisted ACP session: ${sessionId}`);
  }

  const normalized = normalizeSession(parsed);
  lastObservedRevisions.set(sessionId, revisionHash(raw));
  Object.defineProperty(normalized, sessionRevision, { value: revisionHash(raw), configurable: true, writable: true, enumerable: true });
  if (parsed.version === LEGACY_STORE_VERSION) {
    // v1 carried text-only transcript entries. Rewriting it as v2 is lossless:
    // each legacy turn simply acquires an empty attachments array.
    await saveSession(sessionId, normalized);
  }
  return normalized;
}

export async function deleteSession(sessionId) {
  assertSessionId(sessionId);
  await serializeSessionOperation(sessionId, async () => withSessionWriteLock(sessionId, async () => {
    await assertSessionRevision(sessionId, lastObservedRevisions.get(sessionId) ?? null);
    if (!await assertSafeExistingDirectory(sessionsDir())) {
      await deleteSessionAttachments(sessionId).catch(() => {});
      return;
    }
    // Capture the active Review Operation before deleting the authoritative
    // session. Evidence mirrors are secondary and may be removed only after
    // durable session removal. Do not deserialize/repair the session here.
    let evidenceOperationId = null;
    try {
      const original = JSON.parse(await readFile(sessionPath(sessionId),'utf8'));
      const candidate = original?.reviewCheckpoint?.operation?.id;
      if (typeof candidate === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(candidate))
        evidenceOperationId = candidate;
    } catch { /* Corrupt/missing session cannot authorize arbitrary cleanup. */ }
    await rm(sessionPath(sessionId), { force: true });
    lastObservedRevisions.delete(sessionId);
    let durableRemoval = true;
    try {
      await fsyncDir(sessionsDir());
    } catch (error) {
      durableRemoval = false;
      console.error(`[session-store] session deletion fsync failed for ${sessionId}; attachment deletion deferred: ${error?.message ?? error}`);
    }
    // Eager normal-path cleanup only after the session-file removal is durable.
    // If durability is uncertain, retaining blobs is safer: a reboot could make
    // the old session JSON visible again. Reconciliation can remove them later
    // once the absence of the session file is stable.
    if (durableRemoval) {
      await deleteSessionAttachments(sessionId).catch((error) => {
        console.error(`[session-store] attachment delete failed for ${sessionId}: ${error?.message ?? error}`);
      });
      if (evidenceOperationId) await deleteEvidenceSnapshot(evidenceOperationId).catch(error => {
        console.error(`[session-store] evidence mirror cleanup failed for ${sessionId}: ${error?.message ?? error}`);
      });
    }
  }));
}
