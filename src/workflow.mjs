import { findingIdentity } from './quality-state.mjs';
import { reconcileReviewFindings, renderReviewFindings } from './review-findings.mjs';
import { resolveReviewFindingLocations } from './review-source-location.mjs';
import { renderReviewSections } from './review-output-contract.mjs';
import { reviewOperationCompatible, reviewScopeReconciliationRequest, reconcileReviewUnits } from './review-continuity.mjs';
import { createReviewToolEvidenceObserver, reviewVerificationEvidence, sanitizeUnverifiedTestCounts } from './review-verification.mjs';
import { invokeWithRecovery } from './recovery/invocation-recovery.mjs';
import { buildSemanticRouterRequest, compileRouterPrompt } from './routing/request.mjs';
import { resolveRouterContextMode } from './config.mjs';
import { researchHandoff } from './efficiency/context.mjs';
import { profileRolePrompt, contextPart, trackedBody, unpackTrackedBody } from './efficiency/profiling.mjs';
import { assessReviewImpact, assessRetryProgress, suggestRoleEscalation } from './efficiency/optimization.mjs';
import { expectedReportEffects, configuredVerificationPolicies, witnessDiagnosticReports, assessDiagnosticDelta } from './verification-effects.mjs';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { cleanPlanStep, normalizeImplementationPlan, planDigest, repositoryFingerprint, buildImplementationStages, assessImplementationStage, assessImplementationAcceptance, validateImplementationCheckpoint } from './implementation-stages.mjs';
import { buildTestCoverageEvidence } from './testing/coverage-evidence.mjs';
import { assertTaskWriteScopes, assertPreWriteBoundary } from './execution/task-write-policy.mjs';
import { roleInstructions } from './roles.mjs';
import { validateRouteConsistency } from './routing/consistency.mjs';
import { validateTaskSpec, emptyTaskSpec, structuredCommandSelector, taskSpecFailureCode } from './routing/task-spec.mjs';
import { ReviewNoProgressGuard } from './review-progress.mjs';
import { applyUserReviewExclusions, chooseReviewStrategy, reviewPlanFeasibility, compactReviewEvidence } from './review-efficiency.mjs';
import { assessReviewWorkload } from './execution/workload.mjs';
import { newReviewQualityState, applyReviewRiskReport, risksForReviewBatch, assessReviewQuality } from './review-quality.mjs';
import { ExecutionBudget } from './execution/budget.mjs';
import { projectReviewEvidence } from './evidence/graph.mjs';
import { persistEvidenceSnapshot, loadEvidenceSnapshot } from './evidence/store.mjs';
import { reviewBatchEvidenceHandoff, reusableReviewVerification, validatedReviewObservations } from './review-evidence-runtime.mjs';
import { boundedReviewHistory } from './review-context.mjs';
import { findingHypothesisGroups } from './evidence/findings.mjs';
import { adjudicateReviewFindings } from './evidence/adjudication.mjs';
import { chooseVerification } from './verification/decision.mjs';
import { executeVerificationDecision } from './verification/executor.mjs';
import { configuredVerificationInputClosures, witnessVerificationInputs } from './verification-inputs.mjs';
import { compileRoleContextManifest } from './execution/context.mjs';
import { compileRoleContext } from './execution/context-compiler.mjs';
import { projectRoleInstructions } from './execution/instruction-projection.mjs';
import { compactImplementationHandoff } from './execution/stage-context.mjs';
import { resolveSkillExecutionPolicy, skillExecutionCompatibility } from './execution/skill-policy.mjs';
import { assessFixDecision, fixInterruptionReport, shouldReuseNoopValidation } from './fix-decision.mjs';
import { snapshotImplementationRepo, implementationReconciliationChanges, reconciliationOnlyRequest, reconciliationApproval, canAutoReconcile, newReconciliationProposal, reconciliationProposalMatches, assessReconciliationAnalysis, reconciliationPrompt, validatedCheckpointContext } from './implementation-reconciliation.mjs';
import { schemas } from './schemas.mjs';
import { formatInstructionContext, loadInvocationContext } from './context.mjs';
import { buildReviewContract, priorReviewHandoff } from './review-coverage.mjs';
import { resolveReviewScope } from './review-scope.mjs';
import { inspectReviewRelationships } from './review-relationships.mjs';
import { evaluateSecurityPath } from './security.mjs';
import { buildReviewWorkPlan, nextReviewBatch, assessReviewUnits, reviewWorkCoverage, reviewProgressSnapshot, MAX_BATCHES_PER_RUN } from './review-work-plan.mjs';
import { validateReviewCheckpoint, makeReviewCheckpoint, mergeReviewAttempt } from './review-checkpoint.mjs';
import { engineeringCheckpointForRole, engineeringContextForRole, engineeringFrameText } from './engineering-policy.mjs';
import {
  cancellationDetails,
  CANCELLATION_REASONS,
  diagnosticErrorMessage,
  isExpectedCancellation,
  throwIfAborted,
  cancellationErrorFromSignal,
} from './cancellation.mjs';
import {
  assertChangedPathsSafe,
  execFileSafe,
  captureDeniedPathBaseline,
  captureRepoState,
  captureGitMetadataState,
  changedDeniedPathsBetweenBaselines,
  changedPathsBetweenStates,
  gitMetadataDiff,
  workspaceReconciliationDiff,
  resolveCommitReviewTarget,
  resolveRepoRoot,
  restoreDeniedPaths,
  runPreparation,
  runVerification,
  runVerificationCommand,
  configuredVerificationCommands,
  planTargetedRevalidation,
  verificationDisposition,
} from './repo.mjs';

const json = (v) => JSON.stringify(v, null, 2);
function planPromptText(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return json(plan);
  const { engineeringFrame: _engineeringFrame, ...rest } = plan;
  return json(rest);
}
const checksPass = (xs) => xs.every((x) => x.status === 'PASS');

function textResult(callResult) {
  return {
    format: 'text',
    text: String(callResult.output ?? ''),
    parseError: callResult.parseError ?? null,
  };
}

function acceptedRoleOutput(callResult) {
  return callResult.outputFormat === 'text' ? textResult(callResult) : callResult.output;
}

function promptValue(value) {
  if (value?.format === 'text' && typeof value.text === 'string') return value.text;
  return json(value);
}

function fallbackRouting(callResult, modeOverride = null) {
  if (callResult.outputFormat !== 'text') {
    const routed = modeOverride ? { ...callResult.output, mode: modeOverride } : { ...callResult.output };
    if (modeOverride === 'change') routed.writeIntent = 'explicit';
    else if (modeOverride === 'review' || modeOverride === 'investigate') routed.writeIntent = 'not_requested';
    return routed;
  }
  return { mode: modeOverride === 'change' ? 'investigate' : modeOverride ?? 'investigate',
    writeIntent: 'not_requested', complexity: 'medium', risk: 'architecture',
    reason: 'Router returned unstructured text; safe read-only fallback.',
    outputFormat: 'text', rawText: String(callResult.output ?? ''), parseError: callResult.parseError ?? null };
}

function enforceWriteIntent(classification, modeOverride = null) {
  if (modeOverride === 'change') return { ...classification, mode: 'change', writeIntent: 'explicit' };
  if (modeOverride === 'review' || modeOverride === 'investigate') return { ...classification, mode: modeOverride, writeIntent: 'not_requested' };
  if (classification.mode === 'change' && (classification.writeIntent !== 'explicit' ||
      classification.task?.ambiguities?.length > 0)) {
    return { ...classification, mode: 'investigate', writeIntent: 'not_requested',
      reason: `${classification.reason ?? ''} Unverified or ambiguous write intent; read-only.` };
  }
  return classification;
}

function normalizeImplementation(callResult, changedPaths) {
  const actualAction = changedPaths.length > 0 ? 'changed' : 'no_change';
  if (callResult.outputFormat !== 'text') {
    const reported = callResult.output;
    return {
      ...reported,
      action: actualAction,
      ...(reported.action !== actualAction ? { reportedAction: reported.action } : {}),
    };
  }
  return {
    action: actualAction,
    summary: String(callResult.output ?? ''),
    changedFiles: [],
    notes: [],
    outputFormat: 'text',
    rawText: String(callResult.output ?? ''),
    parseError: callResult.parseError ?? null,
  };
}

function normalizeReview(callResult) {
  if (callResult.outputFormat !== 'text') return callResult.output;
  return {
    verdict: 'unknown',
    summary: String(callResult.output ?? ''),
    issues: [],
    outputFormat: 'text',
    rawText: String(callResult.output ?? ''),
    parseError: callResult.parseError ?? null,
  };
}

function normalizeFinalValidation(callResult) {
  if (callResult.outputFormat !== 'text') return callResult.output;
  return {
    verdict: 'unknown',
    summary: String(callResult.output ?? ''),
    issues: [],
    outputFormat: 'text',
    rawText: String(callResult.output ?? ''),
    parseError: callResult.parseError ?? null,
  };
}
const verificationText = (xs) => xs.map((x) => `### ${x.command}\nstatus: ${x.status ?? (x.ok ? 'PASS' : 'TEST_FAILED')}\n${x.diagnostic ? `diagnostic: ${x.diagnostic.outcome} (added=${x.diagnostic.added}, removed=${x.diagnostic.removed}); exitCode=${x.exitCode}\n` : ''}${x.output || '(no output)'}`).join('\n\n');

const findingAssessmentInstructions = `FINDING ASSESSMENT (read-only, proactive and evidence-based):
Investigate significant defects even when their remediation might be outside the current task. Never suppress a real finding just because it is outside scope.
Assess three INDEPENDENT dimensions in assessment: correctness (real defects), taskCompliance (user acceptance requirements) and fixAuthorization (whether the user authorized remediation in this task).
For EACH issue, provide origin=introduced/preexisting/unknown, taskRelation=requirement/dependency/independent/unknown, remediationScope=in_scope/outside_scope/unknown and concrete evidence (e.g. relevant code, baseline, exact tests). When actually established, include stable contractId, reproductionKey, affectedBehavior, and failureMode (do not invent either): this supports safe cross-role finding deduplication. Reuse the same keys for the same violated contract and scenario. Never infer preexisting solely from an unmodified path or a claim by another agent. Unknown origin or authorization must remain unknown; no optimistic assumption.
Use verdict=fix for a verified serious defect even when remediation requires approval. A failure found by a regression test is still a real defect. Out-of-scope does NOT imply non-blocking. Do not invent authorization to change additional production code, suppress failing tests, or mark failing checks PASS. If reviewer and validator disagree, explain the actual scope/evidence conflict explicitly.`;


function gitDriftEvidence(events) {
  if (!events.length) return '(none observed)';
  return `${json(events)}\n\nThese are observations between snapshots, NOT attribution to the named stage or command. Re-read current HEAD, refs, index, and affected files before drawing conclusions. Preserve concurrent user/editor changes; never reset, restore, or rewrite Git metadata to reconcile them. Identify unresolved conflicts explicitly.`;
}

async function emitGitDrift(reporter, stage, before, after, command = null) {
  const diff = gitMetadataDiff(before, after);
  if (!diff.fields.length) return null;
  const event = { stage, ...(command ? { command } : {}), ...diff };
  await emit(reporter, { type: 'git_metadata_drift', ...event, action: 'preserved' });
  return event;
}


const ROLE_PURPOSES = {
  router: 'classify intent, complexity and risk',
  explorer: 'inspect relevant repository context',
  planner: 'produce a grounded execution plan',
  investigator: 'produce the final read-only investigation response from repository evidence',
  coderLow: 'implement a low-complexity change in the project workspace',
  coderMedium: 'implement the change in the project workspace',
  coderHigh: 'implement a high-complexity change in the project workspace',
  reviewerLow: 'independently review the result',
  reviewerMedium: 'independently review the result',
  reviewerHigh: 'independently review high-risk/complex code',
  finalValidator: 'resolve escalation or perform final risk validation',
  responderLow: 'produce the final user-facing response',
  responderMedium: 'produce the final user-facing response',
  responderHigh: 'produce the final user-facing response',
};

function tierFor(c) {
  if (c.complexity === 'high' || c.risk === 'security_or_data') return 'high';
  if (c.complexity === 'medium' || c.risk === 'architecture') return 'medium';
  return 'low';
}

function routingPolicy(c, config) {
  const tier = tierFor(c);
  const reviewer = tier === 'high' ? 'reviewerHigh' : tier === 'medium' ? 'reviewerMedium' : 'reviewerLow';
  const coder = tier === 'high' ? 'coderHigh' : tier === 'medium' ? 'coderMedium' : 'coderLow';
  const responder = tier === 'high' ? 'responderHigh' : tier === 'medium' ? 'responderMedium' : 'responderLow';
  const plan = tier !== 'low';

  if (c.mode === 'review') {
    return {
      mode: 'review', tier, plan, coder: null, reviewer, responder,
      finalValidation: false,
      runVerification: config.policy.reviewVerification === true,
    };
  }
  if (c.mode === 'plan') {
    return {
      mode: 'plan', tier, plan: true, coder: null, reviewer: null, responder: null,
      finalValidation: false, runVerification: false,
    };
  }
  if (c.mode === 'investigate') {
    return {
      mode: 'investigate', tier, plan: false, coder: null, reviewer: null, responder,
      finalValidation: false, runVerification: false,
    };
  }
  return {
    mode: 'change', tier, plan, coder, reviewer, responder,
    finalValidation: tier === 'high' && config.policy.finalValidationForHighRisk !== false,
    runVerification: true,
  };
}

function roleBase(role) {
  if (role.startsWith('coder')) return 'coder';
  if (role.startsWith('reviewer')) return 'reviewer';
  if (role.startsWith('responder')) return 'responder';
  if (role === 'finalValidator') return 'finalValidator';
  return role;
}

function resolvePreviewRole(registry, role, { conditional = false, note = null } = {}) {
  const resolved = registry.resolveRole(role);
  return {
    role,
    purpose: ROLE_PURPOSES[role] ?? role,
    profile: resolved.profileName,
    provider: resolved.providerName,
    model: resolved.profile.model,
    conditional,
    note,
  };
}

function buildExecutionPreview(policy, registry) {
  const steps = [resolvePreviewRole(registry, 'explorer')];
  if (policy.plan) steps.push(resolvePreviewRole(registry, 'planner'));
  if (policy.mode === 'change') {
    steps.push({ role: 'workspaceWrite', purpose: 'allow the coder to edit the current project workspace under sandbox/security policy', conditional: false });
    steps.push(resolvePreviewRole(registry, policy.coder));
    if (policy.runVerification) steps.push({ role: 'verification', purpose: 'run configured/static verification', conditional: false });
    steps.push(resolvePreviewRole(registry, policy.reviewer));
    steps.push(resolvePreviewRole(registry, policy.coder, { conditional: true, note: 'only if review/verification requires a fix' }));
    steps.push(resolvePreviewRole(registry, 'finalValidator', { conditional: !policy.finalValidation, note: policy.finalValidation ? 'required by route' : 'only on escalation' }));
    steps.push(resolvePreviewRole(registry, policy.responder));
  } else if (policy.mode === 'review') {
    if (policy.runVerification) steps.push({ role: 'verification', purpose: 'run configured verification in the current project workspace as review evidence', conditional: false });
    steps.push(resolvePreviewRole(registry, policy.reviewer));
    steps.push(resolvePreviewRole(registry, 'finalValidator', { conditional: true, note: 'only if reviewer escalates' }));
    steps.push(resolvePreviewRole(registry, policy.responder));
  } else if (policy.mode === 'investigate') {
    steps.push(resolvePreviewRole(registry, 'investigator'));
  }
  return steps;
}

export function formatPlanMarkdown(plan) {
  const lines = ['## Plan', '', plan?.goal?.trim() || 'Repository task', ''];
  if (plan?.steps?.length) {
    lines.push('### Steps');
    for (const [index, step] of plan.steps.entries()) lines.push(`${index + 1}. ${cleanPlanStep(step)}`);
    lines.push('');
  }
  const sections = [
    ['Acceptance criteria', plan?.acceptanceCriteria],
    ['Relevant files', plan?.expectedFiles],
    ['Risks and unknowns', plan?.risks],
  ];
  for (const [heading, items] of sections) {
    if (!items?.length) continue;
    lines.push(`### ${heading}`, ...items.map((item) => `- ${item}`), '');
  }
  if (Array.isArray(plan?.acceptanceChecks)) {
    lines.push('### Acceptance verification bindings');
    for (const binding of plan.acceptanceChecks) lines.push(`- ${binding.id}: ${binding.commands.length ? binding.commands.map((cmd) => `\`${cmd}\``).join(', ') : 'No command-bound verification; further evidence required'}`);
    lines.push('');
  }
  if (Array.isArray(plan?.acceptanceReviews)) {
    lines.push('### Source review bindings');
    for (const binding of plan.acceptanceReviews) lines.push(`- ${binding.id}: ${binding.paths.map((p) => `\`${p}\``).join(', ')}`);
    lines.push('');
  }
  lines.push('_Planning only — no repository changes were applied._');
  return lines.join('\n');
}

function fallbackPlan(task, exploration, mode) {
  if (mode === 'review') {
    return {
      goal: task,
      steps: [
        'Inspect the relevant files and surrounding contracts identified during exploration.',
        'Check correctness, regressions, edge cases and meaningful test coverage.',
        'Report concrete findings without modifying the source repository.',
      ],
      acceptanceCriteria: ['Review findings are evidence-based and no source repository changes are applied.'],
      risks: exploration?.unknowns ?? [],
      expectedFiles: exploration?.relevantFiles ?? [],
      engineeringFrame: null,
    };
  }
  return {
    goal: task,
    steps: ['Implement the smallest correct change in the current project workspace.', 'Run verification.', 'Perform an independent review.'],
    acceptanceCriteria: ['Requested behavior works without unrelated changes.'],
    risks: exploration?.unknowns ?? [],
    expectedFiles: exploration?.relevantFiles ?? [],
    engineeringFrame: null,
  };
}

async function emit(reporter, event) {
  if (reporter) await reporter(event);
}

const DEFAULT_RECONCILIATION_STABILITY_MS = 250;

function reconciliationStabilityMs() {
  const raw = Number(process.env.AGENT_RECONCILIATION_STABILITY_MS ?? DEFAULT_RECONCILIATION_STABILITY_MS);
  if (!Number.isFinite(raw)) return DEFAULT_RECONCILIATION_STABILITY_MS;
  return Math.max(0, Math.min(2_000, Math.trunc(raw)));
}

async function waitForReconciliationStability(signal) {
  const delayMs = reconciliationStabilityMs();
  if (delayMs <= 0) return;
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellationErrorFromSignal(signal));
      return;
    }
    const timer = setTimeout(done, delayMs);
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(cancellationErrorFromSignal(signal));
    }
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function reconciliationDiagnostic(drift) {
  const pieces = [];
  if (drift.changedPaths?.length) {
    const shown = drift.changedPaths.slice(0, 8);
    pieces.push(`paths=${shown.join(', ')}${drift.changedPaths.length > shown.length ? ', …' : ''}`);
  }
  if (drift.gitFields?.length) pieces.push(`git=${drift.gitFields.join(', ')}`);
  return pieces.join('; ') || 'semantic workspace state changed';
}

async function callOnce(registry, role, schemaKind, cwd, body, {
  contextText = '', reporter = null, sandboxMode = 'read-only', signal, taskPlan = null, security = null,
  promptBlocks = [], mcpServers = [], additionalDirectories = [], presentToUser = false,
  providerOptions = {}, providerOptionsForRole = null, onProviderStateChange = null,
  roleSessionContext = null, stableContext = null, contextComposition = null,
  bodySources = [], executionScope = null, routerContextTelemetry = null, reviewProjectContext = null, contextTelemetrySecret = null,
} = {}) {
  const unpacked=unpackTrackedBody(body,bodySources);
  body=unpacked.text; bodySources=unpacked.sources;
  let effectiveHistory = contextComposition?.sessionHistoryText ?? '';
  if (typeof roleSessionContext === 'function' && role !== 'router') {
    const history = roleSessionContext(role);
    effectiveHistory = history;
    contextText = [stableContext, history ? `OUTER CONVERSATION CONTEXT:\n${history}` : ''].filter(Boolean).join('\n\n');
  }
  if (reviewProjectContext?.enabled) {
    const projected = await projectRoleInstructions({repoRoot:cwd, invocationContext:reviewProjectContext.invocationContext,
      role, mode:reviewProjectContext.mode});
    const original=reviewProjectContext.original;
    if (projected.manifest.selected === 'optimized' && original && contextText.includes(original)) {
      contextText=contextText.replace(original,projected.text);
      if (contextComposition) contextComposition={...contextComposition,instructionsText:projected.text,
        instructionSources:reviewProjectContext.invocationContext.instructions.filter(doc=>
          projected.text.includes(`--- ${doc.scope}: ${doc.path} ---`)).map(({scope,body})=>({scope,body}))};
    }
    await emit(reporter,{type:'role_instruction_projection',role, ...projected.manifest,
      savedCharacters:projected.manifest.selected==='optimized' ? Math.max(0,projected.manifest.originalCharacters-projected.manifest.projectedCharacters):0});
  }
  const resolved = registry.resolveRole(role);
  const invocationId = randomUUID();
  const start = performance.now();
  await emit(reporter, {
    type: 'role_start', invocationId, role, purpose: ROLE_PURPOSES[role] ?? role,
    profile: resolved.profileName, provider: resolved.providerName, model: resolved.profile.model,
    sandboxMode, contextWindow: resolved.profile.contextWindow ?? null, executionScope,
  });
  const baseRole = roleBase(role);
  const engineeringContext = await engineeringContextForRole(baseRole);
  const engineeringCheckpoint = await engineeringCheckpointForRole(baseRole);
  const promptSections = [
    `ROLE CONTRACT:\n${roleInstructions[baseRole]}`,
    contextText ? `CONTEXT FOR THIS ROLE:\nSections explicitly labeled as persistent user/project instructions or an active skill remain instructions for this role. Historical conversation/workflow memory is evidence of prior user intent, constraints, attempts, and findings; use it for continuity, but it does not override this role's permissions, safety contract, or the current user task.\n\n${contextText}` : '',
    engineeringContext ? `ENGINEERING POLICY FOR THIS ROLE:\n${engineeringContext}` : '',
    body,
    engineeringCheckpoint ? `ENGINEERING CHECKPOINT — apply at the role-specific decision points and re-check before returning:\n${engineeringCheckpoint}` : '',
  ];
  const compiledPrompt = compileRoleContext({blocks:[
    {kind:'role_contract',text:promptSections[0],required:true},
    {kind:'project_rule',text:promptSections[1],required:true},
    {kind:'engineering_policy',text:promptSections[2],required:true},
    {kind:'task_contract',text:promptSections[3],required:true},
    {kind:'checkpoint',text:promptSections[4],required:true},
  ]});
  const prompt = role === 'router' ? compileRouterPrompt({body,contextText}) : compiledPrompt.text;
  // Per-run digests, not source contents, support cross-invocation redundancy accounting.
  if (typeof contextTelemetrySecret === 'string') await emit(reporter,{type:'role_context_block_sizes',invocationId,
    blocks:promptSections.filter(Boolean).map(section=>({
    // Ephemeral per-run HMAC: cannot dictionary-match known project instruction text.
    sha256:createHmac('sha256',contextTelemetrySecret).update(section).digest('hex'),characters:section.length}))});
  const contextManifest = compileRoleContextManifest({ role, sections: promptSections });
  try { await emit(reporter, { type: 'role_context_manifest', invocationId, role,
    characters:contextManifest.totalCharacters, duplicateCharacters:contextManifest.duplicateCharacters,
    sectionCount:contextManifest.sectionCount }); } catch { /* observability only */ }

  // Instrumentation must not alter the bytes sent to the model.
  if (role === 'router' && routerContextTelemetry) {
    try { await emit(reporter, {type:'role_router_context',invocationId,routerContext:routerContextTelemetry}); } catch { /* monitoring only */ }
  }
  try {
    await emit(reporter, { type: 'role_context_profile', invocationId,
      profile: profileRolePrompt({ sections: promptSections, prompt, promptBlocks,
        taskBodySources: bodySources, instructionSources:contextComposition?.instructionSources, contextSubsections: {
          project_instructions_and_skills: contextComposition?.instructionsText ?? '',
          review_target: contextComposition?.reviewTargetText ?? '',
          session_history: effectiveHistory,
        } }) });
  } catch { /* Optional telemetry must never block execution. */ }
  try {
    throwIfAborted(signal);
    // Read-only constrains what this role may originate; it does not freeze the
    // user's live workspace. Concurrent editor/watcher changes are reconciled
    // inside the same invocation-scoped provider session instead of aborting the workflow.
    const readOnlyBaseline = sandboxMode === 'read-only' ? await captureRepoState(cwd) : null;
    // A Git-only witness ignores secret/ignored files. Protect the *configured*
    // denied paths separately, without inspecting every ignored build/cache file.
    const readOnlyProtectedBaseline = readOnlyBaseline && security
      ? await captureDeniedPathBaseline(cwd, security) : null;
    const assertProtectedReadOnlyState = async () => {
      if (!readOnlyProtectedBaseline) return;
      const after = await captureDeniedPathBaseline(cwd, security);
      const paths = changedDeniedPathsBetweenBaselines(readOnlyProtectedBaseline, after);
      if (paths.length) {
        const error = new Error(`Protected path changed during read-only role (${role}): ${paths.join(', ')}. Do not accept the role output; inspect the workspace.`);
        error.code = 'READ_ONLY_PROTECTED_PATH_CHANGED';
        throw error;
      }
    };
    let observedReadOnlyState = readOnlyBaseline;
    let reconciledDrift = null;
    const reconciledPaths = new Set();
    const observedIgnoredGitFields = new Set();
    const effectiveAdditionalDirectories = sandboxMode === 'workspace-write' ? [] : additionalDirectories;
    const r = await registry.invokeRole(role, {
      prompt, schemaKind, schema: schemaKind ? schemas[schemaKind] : null, cwd, sandboxMode, signal, taskPlan,
      promptBlocks, mcpServers, additionalDirectories: effectiveAdditionalDirectories, presentToUser,
      providerOptions: typeof providerOptionsForRole === 'function' ? providerOptionsForRole(role) : providerOptions,
      reconcile: readOnlyBaseline && role !== 'router' ? async () => {
        const previousState = observedReadOnlyState;
        let afterTurn = await captureRepoState(cwd);
        await assertProtectedReadOnlyState();
        let drift = workspaceReconciliationDiff(previousState, afterTurn);

        // Git/editor integrations often expose a very short transitional state
        // while refreshing an index or conflict view. Confirm semantic drift
        // once before spending another model turn. If it has already settled
        // back to the previous checkout state, keep the valid candidate answer.
        if (drift.changed && reconciliationStabilityMs() > 0) {
          await waitForReconciliationStability(signal);
          afterTurn = await captureRepoState(cwd);
          await assertProtectedReadOnlyState();
          drift = workspaceReconciliationDiff(previousState, afterTurn);
        }

        const auditDiff = gitMetadataDiff(previousState, afterTurn);
        observedReadOnlyState = afterTurn;
        if (!drift.changed) {
          const newIgnoredFields = auditDiff.fields.filter((field) => !observedIgnoredGitFields.has(field));
          for (const field of auditDiff.fields) observedIgnoredGitFields.add(field);
          if (newIgnoredFields.length > 0) {
            await emit(reporter, {
              type: 'workspace_drift_ignored', role,
              gitFields: newIgnoredFields,
              refs: auditDiff.refs,
              reason: 'non_semantic_git_metadata',
            });
          }
          return null;
        }

        for (const path of drift.changedPaths) reconciledPaths.add(path);
        const allGitFields = new Set([...(reconciledDrift?.gitFields ?? []), ...drift.gitFields]);
        const headChanged = drift.gitFields.includes('HEAD') || drift.gitFields.includes('headRef');
        reconciledDrift = {
          changedPaths: [...reconciledPaths],
          gitFields: [...allGitFields],
          headChanged: Boolean(reconciledDrift?.headChanged || headChanged),
          turns: Number(reconciledDrift?.turns ?? 0) + 1,
        };
        await emit(reporter, {
          type: 'workspace_drift', role,
          changedPaths: drift.changedPaths,
          gitFields: drift.gitFields,
          ignoredGitFields: drift.ignoredGitFields,
          headChanged,
          action: 'reconcile',
        });
        const changed = drift.changedPaths.length
          ? drift.changedPaths.map((path) => `- ${path}`).join('\n')
          : '- (working-tree file contents unchanged)';
        const gitEvidence = drift.gitFields.length
          ? `\nSemantic Git state changed: ${drift.gitFields.join(', ')}. Re-check ${drift.gitFields.includes('index') ? 'staged/unmerged index entries and ' : ''}history/diff assumptions that affect your conclusion.`
          : '';
        return {
          prompt: `LIVE WORKSPACE CHANGED WHILE YOU WERE WORKING. Treat this as concurrent external/editor state drift, not as permission to write. Re-read the affected CURRENT repository state and revise your conclusion so it is valid now. Stay strictly read-only.\n\nChanged paths since the previous stable read-only turn:\n${changed}${gitEvidence}`,
          diagnostic: reconciliationDiagnostic(drift),
        };
      } : null,
      onProgress: async (progress) => {
        if (progress?.type === 'reasoning' && progress.text) {
          await emit(reporter, {
            type: 'role_thought_chunk', role, invocationId,
            profile: resolved.profileName, provider: resolved.providerName, model: resolved.profile.model,
            text: progress.text,
          });
        } else if (progress?.type === 'commentary' && progress.text) {
          await emit(reporter, {
            type: 'role_commentary_chunk', role, invocationId,
            profile: resolved.profileName, provider: resolved.providerName, model: resolved.profile.model,
            text: progress.text,
          });
        } else if (progress?.type === 'plan_update' && Array.isArray(progress.items)) {
          await emit(reporter, {
            type: 'task_plan_progress', role,
            profile: resolved.profileName, provider: resolved.providerName, model: resolved.profile.model,
            items: progress.items,
          });
        } else if (progress?.type === 'provider_state' && progress.key) {
          if (typeof onProviderStateChange === 'function') {
            await onProviderStateChange({ role, key: progress.key, value: progress.value });
          }
          await emit(reporter, { type: 'provider_state', role, key: progress.key, value: progress.value });
        } else if (progress?.type === 'usage' && progress.usage) {
          await emit(reporter, {
            type: 'role_usage', role, invocationId, usageObservation: progress.usageObservation ?? null,
            profile: resolved.profileName, provider: resolved.providerName, model: resolved.profile.model,
            usage: progress.usage,
            contextWindow: progress.contextWindow ?? resolved.profile.contextWindow ?? null,
          });
        } else if (progress?.type === 'tool_call' && progress.update) {
          await emit(reporter, {
            type: 'role_tool_event', role, invocationId, innerSessionId: progress.innerSessionId ?? null,
            profile: resolved.profileName, provider: resolved.providerName, model: resolved.profile.model,
            update: progress.update, toolObservation: progress.observation ?? null,
          });
        } else if (progress?.type === 'prompt_profile' && progress.profile) {
          try { await emit(reporter, { type: 'role_provider_prompt_profile', role, invocationId, profile: progress.profile }); } catch { /* optional monitoring */ }
        } else if (progress?.type === 'activity' && progress.activity) {
          try { await emit(reporter, { type: 'role_activity', role, invocationId, activity: progress.activity }); } catch { /* optional monitoring */ }
        } else if (progress?.type === 'content_block' && progress.update) {
          await emit(reporter, {
            type: 'role_native_update', role, invocationId,
            profile: resolved.profileName, provider: resolved.providerName, model: resolved.profile.model,
            update: progress.update, toolObservation: progress.observation ?? null,
          });
        }
      },
    });
    if (readOnlyBaseline) {
      await assertProtectedReadOnlyState();
      const readOnlyAfter = await captureRepoState(cwd);
      const drift = workspaceReconciliationDiff(readOnlyBaseline, readOnlyAfter);
      const auditDiff = gitMetadataDiff(readOnlyBaseline, readOnlyAfter);
      const headChanged = drift.gitFields.includes('HEAD') || drift.gitFields.includes('headRef');
      if (drift.changed && !reconciledDrift) {
        await emit(reporter, {
          type: 'workspace_drift', role,
          changedPaths: drift.changedPaths,
          gitFields: drift.gitFields,
          ignoredGitFields: drift.ignoredGitFields,
          headChanged,
          action: 'accepted',
        });
      } else if (reconciledDrift) {
        await emit(reporter, { type: 'workspace_drift_reconciled', role, ...reconciledDrift });
      } else if (auditDiff.fields.length > 0) {
        const newIgnoredFields = auditDiff.fields.filter((field) => !observedIgnoredGitFields.has(field));
        if (newIgnoredFields.length > 0) {
          await emit(reporter, {
            type: 'workspace_drift_ignored', role,
            gitFields: newIgnoredFields,
            refs: auditDiff.refs,
            reason: 'non_semantic_git_metadata',
          });
        }
      }
    }
    const structuredMeta = r.meta?.structuredOutput ?? {};
    const outputFormat = structuredMeta.format ?? (typeof r.output === 'string' ? 'text' : 'structured');
    if (role === 'router') await emit(reporter, {
      type:'router_output_diagnostic', invocationId,
      format:outputFormat, source:structuredMeta.source ?? null,
      providerCompletionStatus:structuredMeta.providerCompletionStatus ?? null,
      diagnostics:structuredMeta.diagnostics ?? null,
    });
    await emit(reporter, {
      type: 'role_done', invocationId, role, purpose: ROLE_PURPOSES[role] ?? role,
      profile: r.resolved.profileName, provider: r.resolved.providerName, model: r.resolved.profile.model,
      elapsedMs: Math.max(0, Math.floor(performance.now() - start)),
      usage: r.meta.usage ?? null,
      contextWindow: r.resolved.profile.contextWindow ?? null,
      outputFormat,
    });
    return {
      output: r.output,
      outputFormat,
      parseError: structuredMeta.parseError ?? null,
      outputDiagnostics: structuredMeta.diagnostics ?? null,
      providerCompletionStatus:structuredMeta.providerCompletionStatus ?? null,
      rawText: structuredMeta.rawText ?? (typeof r.output === 'string' ? r.output : null),
      finalAnswerPresented: r.meta?.finalAnswerPresented === true,
      run: { role, profile: r.resolved.profileName, provider: r.resolved.providerName, model: r.resolved.profile.model, elapsedMs: Math.max(0, Math.floor(performance.now() - start)), outputFormat },
    };
  } catch (error) {
    const elapsedMs = Math.max(0, Math.floor(performance.now() - start));
    const cancellation = cancellationDetails(error);
    await emit(reporter, {
      type: isExpectedCancellation(error) ? 'role_cancelled' : 'role_error',
      invocationId, role,
      message: diagnosticErrorMessage(error),
      elapsedMs,
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      ...(cancellation?.reason ? { reason: cancellation.reason } : {}),
      ...(cancellation?.source ? { source: cancellation.source } : {}),
      ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      diagnostics: error?.diagnostics ?? null,
      recovery: error?.recovery ?? null,
    });
    throw error;
  }
}

// All roles and skills share the same invocation boundary. The replay policy
// depends on operation effects, never on the route, role name or skill name.
async function call(registry, role, schemaKind, cwd, body, options = {}) {
  const sandboxMode = options.sandboxMode ?? 'read-only';
  // This check precedes the FIRST provider action; an ACP notification/host
  // permission request cannot guarantee interception of all provider writes.
  if (sandboxMode === 'workspace-write') {
    assertPreWriteBoundary(options.taskWriteSpecs, { sandboxMode });
  }
  const replaySafety = sandboxMode === 'read-only' && !options.presentToUser &&
    (!options.mcpServers || options.mcpServers.length === 0) &&
    !options.promptBlocks?.some?.(block => block?.type === 'resource_link')
    ? 'verified-read-only' : 'none';
  // The witness is captured prior to first attempt. A missing/failed capture
  // prohibits a replay, but must not prevent a legitimate initial operation.
  let baseline = null;
  let protectedBaseline = null;
  if (replaySafety === 'verified-read-only') {
    try {
      baseline = await captureRepoState(cwd);
      protectedBaseline = options.security ? await captureDeniedPathBaseline(cwd, options.security) : null;
    } catch { baseline = null; }
  }
  return invokeWithRecovery({
    role, options: { ...options, sandboxMode }, replaySafety,
    invoke: (attemptOptions) => callOnce(registry, role, schemaKind, cwd, body, attemptOptions),
    checkWorkspace: async () => {
      if (!baseline) return false;
      const after = await captureRepoState(cwd);
      if (repositoryFingerprint(baseline) !== repositoryFingerprint(after)) return false;
      if (protectedBaseline) {
        const protectedAfter = await captureDeniedPathBaseline(cwd, options.security);
        if (changedDeniedPathsBetweenBaselines(protectedBaseline, protectedAfter).length) return false;
      }
      return true;
    },
    emit: event => emit(options.reporter, { ...event, role }),
  });
}

async function deniedMutations(repo, security, beforeDenied, changedPaths) {
  const afterDenied = await captureDeniedPathBaseline(repo, security);
  const sensitiveChanged = changedDeniedPathsBetweenBaselines(beforeDenied, afterDenied);
  const denied = new Set(sensitiveChanged);
  for (const path of changedPaths) {
    try { assertChangedPathsSafe([path], security); } catch { denied.add(path); }
  }
  return [...denied].sort();
}

async function runWorkflowVerification(repo, reporter, signal, {
  allowWorkspaceMutations = false, security = null, onGitDrift = null,
  onlyCommands = null, phase = 'mandatory', onAttemptStart = null,
} = {}) {
  // Read-only workflows must not invoke trusted effectful verifiers: ignored
  // outputs are invisible to Git reconciliation and restoring them could erase
  // concurrent user edits. Fail before any such command is executed.
  if (!allowWorkspaceMutations) {
    const configured = await configuredVerificationCommands(repo);
    const selected = onlyCommands === null ? configured.map((args) => args.join(' ')) : onlyCommands;
    const policies = configuredVerificationPolicies();
    const effectful = selected.filter((name) => Object.hasOwn(policies, name));
    if (effectful.length) {
      throw new Error(`Read-only verification unavailable: effectful command(s) require writable or isolated execution: ${effectful.join(', ')}. No verification commands were run.`);
    }
  }
  const before = await captureRepoState(repo);
  const deniedBefore = security ? await captureDeniedPathBaseline(repo, security) : null;
  let observed = before;
  const gitDrift = [];
  const report = async (previous, current, command = null) => {
    const event = await emitGitDrift(reporter, 'verification', previous, current, command);
    if (event) {
      gitDrift.push(event);
      await onGitDrift?.(event);
    }
  };
  await emit(reporter, { type: 'verification_start', phase });
  // Snapshot after every command to narrow down the *time* of a Git change.
  // This is not proof the command caused it: external editor/Git processes may
  // mutate the same checkout at any moment.
  const results = await runVerification(repo, { signal, onAttemptStart, onlyCommands, phase: phase === 'mandatory' ? 'mandatory_final' : 'targeted', onCommandComplete: async (item) => {
    await emit(reporter,{type:'verification_command_result',checkId:item.checkId,status:item.status,
      cacheHit:item.cache?.hit===true,cacheEligible:item.cache?.reason!=='unsafe_or_incomplete_inputs' && Boolean(item.cache),
      reasonCode:item.reasonCode??null});
    const next = await captureGitMetadataState(repo);
    await report(observed, next, item.command);
    observed = next;
  } });
  const after = await captureRepoState(repo);
  await report(observed, after, '(after last verification command)');
  const changedPaths = changedPathsBetweenStates(before, after);
  const denied = security ? await deniedMutations(repo, security, deniedBefore, changedPaths) : [];
  const metadataStable = !gitMetadataDiff(before, after).fields.some((field) => ['HEAD', 'headRef', 'index'].includes(field));
  const expectedEffects = expectedReportEffects(results, changedPaths, metadataStable);
  // A declaration is not enough: only actual report deltas inspected by the
  // host can be accepted. Unknown effects remain workspace mutations.
  const unexpectedPaths = expectedEffects ? [] : changedPaths;
  if (denied.length > 0) await restoreDeniedPaths(repo, denied, security, deniedBefore);

  if (denied.length > 0) {
    throw new Error(`Verification modified security-denied path(s): ${denied.join(', ')}. Those paths were restored to their pre-verification state; other workspace edits were preserved.`);
  }
  // In review-only mode, a verification command may still write files. Never
  // restore them from a stale snapshot: concurrent user edits are indistinguishable.
  // Surface the violation and leave the real workspace untouched.
  if (!allowWorkspaceMutations && (changedPaths.length > 0 || gitDrift.length > 0)) {
    throw new Error(`Read-only review verification observed workspace mutations: paths=${changedPaths.join(', ') || '(none)'}, Git metadata=${gitDrift.flatMap((event) => event.fields).join(', ') || '(unchanged)'}. Changes were preserved, not automatically restored; inspect the current repository state.`);
  }
  if (allowWorkspaceMutations && security && changedPaths.length > 0) {
    assertChangedPathsSafe(changedPaths, security);
  }
  const disposition = verificationDisposition(results);
  await emit(reporter, {
    type: 'verification_done',
    ok: disposition === 'PASS',
    disposition,
    results,
    changedPaths,
    gitDrift, phase, expectedEffects, unexpectedPaths,
  });
  return { results, attempt: results.attempt, disposition, diff: after.diff, state: after,
    changedPaths, unexpectedPaths, expectedEffects, gitDrift };
}

function modelTaskForReview(task, target) {
  if (!target) return task;
  return [
    `Review Git commit ${target.sourceCommit}.`,
    'The actual source repository and full reachable Git history are available read-only. Use normal Git commands to inspect the commit, its parents, related history and surrounding code.',
    task?.trim() ? `USER REVIEW FOCUS:\n${task.trim()}` : '',
  ].filter(Boolean).join('\n');
}

function reviewTargetContext(target) {
  if (!target) return '';
  const parents = target.sourceParents?.length ? target.sourceParents.join(', ') : '(root commit)';
  return `COMMIT REVIEW TARGET:\n- commit: ${target.sourceCommit}\n- parents: ${parents}\n- subject: ${target.subject || '(no subject)'}\n- author: ${target.author || '(unknown)'}\n- authored at: ${target.authoredAt || '(unknown)'}\n- inspect with normal Git commands such as: git show ${target.sourceCommit}; git diff ${target.sourceCommit}^ ${target.sourceCommit}; git log; git blame; git grep.\n- For merge commits, inspect the actual parent set and choose the comparison(s) relevant to the review instead of assuming a first-parent-only view.`;
}

function normalizeRepoPath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '');
}

function compareImplementationReportToWorkspace(implementation, changedPaths) {
  const changed = changedPaths.length > 0;
  // A command executed by the write-capable provider may legitimately generate/update reports,
  // snapshots, manifests, lockfiles or similar project artifacts. Therefore
  // changedFiles is model-reported intent/summary, never an authoritative
  // filesystem allowlist. The actual workspace delta is the source of truth.
  const reportedFiles = [...new Set((implementation.changedFiles ?? []).map(normalizeRepoPath))];
  const actual = new Set(changedPaths.map(normalizeRepoPath));
  const reported = new Set(reportedFiles);
  return {
    reportedFiles,
    unreportedFiles: changedPaths.filter((path) => !reported.has(normalizeRepoPath(path))),
    reportedButUnchanged: reportedFiles.filter((path) => !actual.has(path)),
    actionMismatch: implementation.reportedAction !== undefined || (implementation.action === 'no_change' && changed),
  };
}


async function produceUserResponse({
  registry, role, repoRoot, body, contextText, reporter, runtimeRoleOptions, signal, streamFinalResponse, runs, bodySources = [],
}) {
  try {
    const responded = await call(
      registry, role, null, repoRoot, body,
      {
        contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
        presentToUser: streamFinalResponse, bodySources, executionScope:{phase:'response'},
      },
    );
    runs.push(responded.run);
    return {
      text: String(responded.output ?? responded.rawText ?? ''),
      streamed: responded.finalAnswerPresented === true,
      error: null,
    };
  } catch (error) {
    // Presentation is deliberately non-authoritative. A failure to phrase the
    // final answer must not discard a completed review/change workflow.
    return { text: '', streamed: false, error: String(error?.message ?? error) };
  }
}



export async function runWorkflow({
  task,
  config,
  registry,
  repoStart = process.env.AGENT_REPO ?? process.cwd(),
  modeOverride = null,
  planOnly = false,
  skillName = null,
  skillInvocation = null,
  reviewTarget = null,
  sessionContextText = '', roleSessionContext = null, efficiency = {},
  reporter = null,
  signal,
  promptBlocks = [],
  mcpServers = [],
  additionalDirectories = [],
  streamFinalResponse = false,
  providerOptions = {},
  providerOptionsForRole = null,
  onProviderStateChange = null, reviewCheckpoint = null, onReviewCheckpoint = null,
  onReviewFindingAdjudication = null,
  authoritativePlan = null, implementationCheckpoint = null, onImplementationCheckpoint = null, onImplementationPlan = null, onQualityAssessment = null, onApprovedFindings = null, onRecoveryAssessment = null, onReconciliationDecision = null, onResolveReconciliationIntent = null, onRevalidationResult = null, onVerificationAttempt = null,
  implementationReconciliation = null, onImplementationReconciliation = null,
  onSelectSavedImplementation = null, savedOperationMetadata = [],
} = {}) {
  if (!task?.trim()) throw new Error('Task must be non-empty.');
  // For non-review work, account for ALL role invocations in this turn.
  // The existing review-specific budget retains its checkpoint-aware control.
  const configuredTaskBudget = config.policy?.workflowEfficiency?.executionBudget;
  const taskBudget = configuredTaskBudget ? new ExecutionBudget(configuredTaskBudget) : null;
  if (taskBudget) {
    const upstream = reporter;
    reporter = async event => {
      if (event.type === 'role_start') taskBudget.observe();
      if (event.type === 'role_done') taskBudget.observeUsage(event.usage);
      await upstream?.(event);
    };
  }
  // A purely observational projection, not a second semantic authority. It
  // emits completion status even for early returns before the route event.
  const telemetrySink = reporter;
  reporter = async event => {
    if (event.type === 'complete') {
      // The workflow's `complete` event is terminal for ACP presentation and
      // downstream consumers. Emit observational routing data first; it must
      // neither move `complete` from the end nor block it on telemetry failure.
      try { await telemetrySink?.({type:'routing_outcome',status:event.result?.status ?? 'unknown'}); }
      catch { /* diagnostic failures may not change the workflow */ }
    }
    await telemetrySink?.(event);
  };
  const runs = [];
  const repoRoot = await resolveRepoRoot(repoStart);
  const mergeParentReconciliation = !planOnly ? reviewScopeReconciliationRequest(task) : null;
  const wantsReviewResume = (/^\/review-resume(?:\s|$)/i.test(task.trim()) || mergeParentReconciliation !== null) && !planOnly;
  let continuingReview = wantsReviewResume && reviewOperationCompatible(reviewCheckpoint, { repoRoot });
  let reconcilingReview = continuingReview && mergeParentReconciliation !== null;
  if (wantsReviewResume && !continuingReview) {
    const result = { status: 'review_incomplete', planCompleted: false, runs,
      responseText: 'No compatible saved Review Operation is available in this session. Start a new review or restore the original session/checkpoint; no review was automatically restarted.' };
    await emit(reporter, { type: 'complete', result });
    return result;
  }
  if (continuingReview) {
    // Legacy checkpoints remain readable but cannot reconstitute a missing
    // semantic authority by re-parsing the original prompt on resume.
    let validSavedReview=false;
    try {
      const spec=validateTaskSpec(reviewCheckpoint.operation.taskSpec);
      validSavedReview=spec.operation==='review' && spec.writeIntent==='not_requested';
    } catch { /* legacy or invalid task spec */ }
    if (!validSavedReview) {
      const result={status:'review_incomplete',runs,planCompleted:false,
        errorCode:'legacy_review_checkpoint_without_validated_intent',
        responseText:'Saved Review checkpoint has no valid typed intent. Start a fresh review; no stored scope or evidence was silently reinterpreted.'};
      await emit(reporter,{type:'complete',result});return result;
    }
  }
  let sourceReviewTask = reconcilingReview
    ? reviewCheckpoint.operation.task.replace(/\s+merge-parent\s*[:=]\s*\d{1,2}/gi, '') + ` merge-parent=${mergeParentReconciliation}`
    : continuingReview ? reviewCheckpoint.operation.task : task;
  const resumedReviewToken = wantsReviewResume ? task.trim().match(/^\/review-resume\s+([a-f\d-]{8,64})$/i)?.[1] : null;
  if (continuingReview && resumedReviewToken && reviewCheckpoint.operation.id !== resumedReviewToken) {
    const result = { status: 'review_incomplete', runs, planCompleted: false,
      responseText: 'The requested Review Operation ID does not match this session. No evidence was reused.' };
    await emit(reporter, { type: 'complete', result }); return result;
  }
  let reviewSkillName = continuingReview ? reviewCheckpoint.operation.skillName : skillName;
  await emit(reporter, { type: 'workspace_start', repoRoot, access: 'source-read-only' });
  let inferredReviewTarget = continuingReview ? reviewCheckpoint.operation.reviewTarget : reviewTarget;
  if (inferredReviewTarget && modeOverride && modeOverride !== 'review' && !planOnly) {
    throw new Error(`A commit review target cannot be combined with task mode '${modeOverride}'.`);
  }
  // A selected Plan mode is an explicit read-only user constraint. Slash
  // commands (including /change) must not override it or unlock writes.
  // Explicit read-only invocations override any supplied saved Plan. Ordinary
  // questions (including those about plans) also remain read-only even if
  // routing or host code accidentally passes a saved implementation Plan.
  // No pre-router natural-language parsing. Saved plans do not grant write
  // permissions; the post-router policy must authorize their execution.
  if (!planOnly && ['review', 'investigate'].includes(modeOverride)) authoritativePlan = null;
  // An orphan or unrelated checkpoint is never evidence of authority to
  // resume. This is a core invariant even for callers bypassing the execution
  // service: new tasks always begin without another task's stage state.
  if (!authoritativePlan) {
    implementationCheckpoint = null;
    implementationReconciliation = null;
  }
  const effectiveModeOverride = continuingReview ? 'review' : planOnly ? null : modeOverride === 'review' || modeOverride === 'investigate'
    ? modeOverride : inferredReviewTarget ? 'review'
      : modeOverride;
  let invocationContext = await loadInvocationContext(repoRoot, { skillName: reviewSkillName, scopePaths: [repoStart] });
  let persistentContext = formatInstructionContext(invocationContext);
  let activeReviewTarget = inferredReviewTarget?.type === 'commit'
    ? { ...await resolveCommitReviewTarget(repoRoot, inferredReviewTarget.revision),
      ...(Number.isInteger(inferredReviewTarget.mergeParentIndex) &&
        inferredReviewTarget.mergeParentIndex >= 1 && inferredReviewTarget.mergeParentIndex <= 16
        ? { mergeParentIndex: inferredReviewTarget.mergeParentIndex } : {}) }
    : null;
  const selectedSkillInvocation = reviewSkillName && !continuingReview
    ? skillInvocation ?? { kind: 'explicit', name: reviewSkillName, source: 'slash',
      arguments: sourceReviewTask, originalRequest: sourceReviewTask } : null;
  const skillDirective = selectedSkillInvocation ?
    `EXPLICIT SKILL INVOCATION (authoritative user request):\nSkill: ${selectedSkillInvocation.name}\nArguments: ${selectedSkillInvocation.arguments || '(none)'}\nOriginal user request: ${selectedSkillInvocation.originalRequest}\nExecute the ACTIVE SKILL instructions using the supplied arguments. Do not treat these arguments as conversation metadata, and do not infer write authorization from the skill name.` :
    continuingReview && reviewSkillName ? `PERSISTED ACTIVE SKILL: ${reviewSkillName}. Honor the saved skill contract and source task.` : '';
  let modelTask = [modelTaskForReview(sourceReviewTask, activeReviewTarget), skillDirective].filter(Boolean).join('\n\n');
  let contextText = [
    persistentContext,
    reviewTargetContext(activeReviewTarget),
    sessionContextText ? `OUTER CONVERSATION CONTEXT:\n${sessionContextText}` : '',
  ].filter(Boolean).join('\n\n');

  const runtimeRoleOptions = { contextTelemetrySecret:randomUUID(), promptBlocks, mcpServers, additionalDirectories, providerOptions, providerOptionsForRole, onProviderStateChange, security: config.security, roleSessionContext, stableContext: [persistentContext, reviewTargetContext(activeReviewTarget)].filter(Boolean).join('\n\n'),
    contextComposition: { instructionSources: [...invocationContext.instructions.map(({scope,body})=>({scope,body})),
      ...(invocationContext.skill ? [{scope:'active-skill',body:invocationContext.skill.body}] : [])], instructionsText: persistentContext,
      reviewTargetText: reviewTargetContext(activeReviewTarget), sessionHistoryText: sessionContextText } };

  // Review-only: do not alter instruction compilation for other task modes.
  runtimeRoleOptions.reviewProjectContext={enabled:effectiveModeOverride==='review',
    mode:config.policy?.reviewEfficiency?.projectContext?.mode ?? 'legacy',
    invocationContext,original:persistentContext};

  if (selectedSkillInvocation) await emit(reporter, { type: 'skill_invocation_resolved',
    source: selectedSkillInvocation.source, status: invocationContext.skill ? 'resolved' : 'unresolved' });
  await emit(reporter, {
    type: 'context_loaded',
    projectInstructions: invocationContext.instructions.map((x) => ({ scope: x.scope, path: x.path })),
    skill: invocationContext.skill ? { name: invocationContext.skill.name, scope: invocationContext.skill.scope, path: invocationContext.skill.path } : null,
  });
  await emit(reporter, { type: 'workspace_ready', repoRoot, access: 'source-read-only', reviewTarget: activeReviewTarget });

  // Persisted metadata informs semantic interpretation but never authorizes writes.
  // Production and offline evaluation share this request builder.
  const routerHistoryText = typeof roleSessionContext === 'function' && !continuingReview
    ? roleSessionContext('router') : sessionContextText;
  const routerRequest = continuingReview ? null : await buildSemanticRouterRequest({
    repoRoot,userTask:task,modelTask,invocationContext,
    reviewTargetText:reviewTargetContext(activeReviewTarget),
    sessionHistoryText:routerHistoryText,savedOperationMetadata,
    modeOverride:effectiveModeOverride,planOnly,promptBlocks,mcpServers,additionalDirectories,
    routerContextMode:resolveRouterContextMode(config,{diagnosticOverride:efficiency.routerContextMode}),
  });
  let classification;
  let semanticResolutionFailure = null;
  if (continuingReview) {
    await emit(reporter,{type:'trusted_continuation',kind:'saved_review',status:'validated'});
    classification = { ...(reviewCheckpoint.operation.classification ?? {}),
      mode: 'review', writeIntent: 'not_requested',
      complexity: ['low','medium','high'].includes(reviewCheckpoint.operation.classification?.complexity)
        ? reviewCheckpoint.operation.classification.complexity : 'medium',
      risk: ['normal','architecture','security_or_data'].includes(reviewCheckpoint.operation.classification?.risk)
        ? reviewCheckpoint.operation.classification.risk : 'normal',
      reason: 'Explicit continuation of a persisted, scope-validated Review Operation.' };
    await emit(reporter, { type: 'review_plan_restored', operationId: reviewCheckpoint.operation.id,
      units: reviewCheckpoint.operation.workPlan.totalUnits });
  } else {
    const routed = await call(registry,'router',routerRequest.schemaKind,repoRoot,
      routerRequest.body,{
        reporter,...runtimeRoleOptions,contextText:routerRequest.contextText,
        stableContext:routerRequest.stableContext,
        contextComposition:routerRequest.contextComposition,
        routerContextTelemetry:routerRequest.routerContextTelemetry,
        sandboxMode:'read-only',signal,bodySources:routerRequest.bodySources,
        promptBlocks:routerRequest.promptBlocks,mcpServers:routerRequest.mcpServers,
        additionalDirectories:routerRequest.additionalDirectories,
        executionScope:{phase:'routing'},
      });
    runs.push(routed.run);
    const rawClassification = fallbackRouting(routed, effectiveModeOverride);
    const routedClassification = enforceWriteIntent(rawClassification, effectiveModeOverride);
    let semanticTask;
    let semanticValidationStatus = 'accepted';
    let semanticValidationReason = null;
    let taskValidationFailureCode = routed.outputDiagnostics?.taskFailureCode ?? null;
    const outputValidationFailureCode = routed.outputDiagnostics?.outputFailureCode ?? null;
    try {
      // Host commands constrain a valid semantic interpretation; they cannot
      // fabricate the required task specification when the Router fails.
      if (!routedClassification.task) throw new Error(routed.outputDiagnostics?.code ?? 'missing_task_spec');
      semanticTask = validateTaskSpec(routedClassification.task,
        {modeOverride:effectiveModeOverride,planOnly});
      if (!effectiveModeOverride && !planOnly &&
          (rawClassification.writeIntent === 'ambiguous' || rawClassification.task?.writeIntent === 'ambiguous'))
        throw new Error('ambiguous_write_intent');
      // Detect a malicious or internally inconsistent Router response. A
      // syntactically valid nested task never overrides conflicting top-level
      // claims unless a trusted host command imposes a narrower mode.
      if (routedClassification.task && !effectiveModeOverride && !planOnly &&
          ((routedClassification.mode !== semanticTask.operation &&
             !(routedClassification.mode === 'investigate' && semanticTask.operation === 'plan')) ||
            routedClassification.writeIntent !== semanticTask.writeIntent))
        throw new Error('conflicting_semantic_and_legacy_route');
    } catch (error) {
      taskValidationFailureCode ??= taskSpecFailureCode(error);
      semanticTask = { ...emptyTaskSpec(), ambiguities:[String(error.message).slice(0,200)] };
      semanticValidationStatus = ['missing_task_spec','ROUTER_TASK_MISSING'].includes(error.message) ? 'missing' : 'invalid';
      semanticValidationReason = String(error.message);
    }
    if (semanticTask.ambiguities.length && semanticTask.operation === 'change') {
      semanticTask = {...semanticTask,operation:'investigate',writeIntent:'not_requested'};
    }
    if (semanticValidationStatus !== 'accepted') semanticResolutionFailure = semanticValidationReason;
    classification = { ...routedClassification, mode:semanticTask.operation,
      writeIntent:semanticTask.writeIntent, task:semanticTask,
      reason: routedClassification.reason ?? 'Semantic task specification' };
    if (planOnly) classification = {...classification,mode:'plan',writeIntent:'not_requested'};
    await emit(reporter,{type:'semantic_intent_validation',status:semanticValidationStatus,
      ...(semanticValidationReason ? {reason:semanticValidationReason} : {}),
      version:semanticTask.version,operation:semanticTask.operation,
      targetKind:semanticTask.target.kind,selectorType:semanticTask.target.selector?.type??null,
      ambiguityCount:semanticTask.ambiguities.length,
      failureClass:semanticValidationStatus==='accepted' ? null : 'contract',
      stage:routed.outputDiagnostics?.stage ?? (semanticValidationStatus==='accepted'?'task_validation':'workflow_validation'),
      code:routed.outputDiagnostics?.code ?? (semanticValidationStatus==='missing'?'ROUTER_TASK_MISSING':
        semanticValidationStatus==='invalid'?'ROUTER_TASK_INVALID':null),
      taskFailureCode:semanticValidationStatus==='accepted' ? null : taskValidationFailureCode,
      outputFailureCode:semanticValidationStatus==='accepted' ? null : outputValidationFailureCode,
      jsonRecognized:routed.outputDiagnostics?.jsonRecognized ?? null,
      taskPresent:routed.outputDiagnostics?.taskPresent ?? null,
      incomplete:routed.outputDiagnostics?.incomplete ?? null,
      ambiguousFragments:routed.outputDiagnostics?.ambiguousFragments ?? null,
      providerCompletionStatus:routed.providerCompletionStatus ?? null,
      recovery:'not_attempted'});
  }
  // A malformed/missing Router task is NOT a successful Investigate or Review.
  // Explicit host commands retain their independent operation constraints,
  // but cannot synthesize omitted natural-language targets or requirements.
  if (semanticResolutionFailure) {
    const result={status:'intent_unresolved',runs,planCompleted:false,
      errorCode:semanticResolutionFailure,
      responseText:'Router intent validation failed. The requested operation was not executed.'};
    await emit(reporter,{type:'complete',result});return result;
  }
  if (classification.task?.continuation?.mode === 'ambiguous') {
    const result={status:'clarification_required',runs,planCompleted:false,
      responseText:'The requested continuation is ambiguous; no saved operation was activated.'};
    await emit(reporter,{type:'complete',result});return result;
  }
  // Explicitly ambiguous targets or continuation cannot silently expand a
  // review or activate a plan. Investigation may still return safe evidence.
  if (classification.task?.ambiguities?.length && ['review','change'].includes(classification.mode)) {
    const result = {status:'clarification_required',runs,planCompleted:false,
      responseText:`The task requires clarification before the requested operation can start: ${classification.task.ambiguities.join('; ')}`};
    await emit(reporter,{type:'complete',result});return result;
  }
  // A saved Plan supplied by a caller is not a trusted authorization signal.
  // Unless a structured continuation or explicit host /change requested it,
  // it must not override an independent question or read-only workflow.
  if (authoritativePlan &&
      !['current_implementation','saved_implementation','reconcile'].includes(classification.task?.continuation?.mode)) {
    authoritativePlan=null;
    implementationCheckpoint=null;
    implementationReconciliation=null;
  }
  if (authoritativePlan && !planOnly &&
      ['current_implementation','saved_implementation'].includes(classification.task?.continuation?.mode) &&
      (classification.mode !== 'change' || classification.writeIntent !== 'explicit')) {
    const result={status:'intent_unresolved',runs,planCompleted:false,errorCode:'unauthorized_saved_plan',
      responseText:'Saved implementation cannot be executed without an explicit Change intent.'};
    await emit(reporter,{type:'complete',result});return result;
  }
  // Authorize selection of a stored implementation only from the single
  // validated semantic intent. Plan existence is not execution authorization.
  if (!authoritativePlan && !planOnly &&
      ['current_implementation','saved_implementation','reconcile'].includes(classification.task?.continuation?.mode)) {
    const semantic = classification.task;
    if (((semantic.continuation.mode === 'reconcile') ?
        classification.mode !== 'investigate' : classification.mode !== 'change' || classification.writeIntent !== 'explicit') ||
        semantic.ambiguities.length) {
      const result={status:'implementation_incomplete',runs,planCompleted:false,
        responseText:'Saved implementation continuation was not explicitly authorized. No changes were started.'};
      await emit(reporter,{type:'complete',result});return result;
    }
    const requestedId=semantic.continuation.operationId ?? null;
    if (!onSelectSavedImplementation) {
      const result={status:'implementation_incomplete',runs,planCompleted:false,
        responseText:'There is no persistent session capable of resolving this saved implementation. No changes were started.'};
      await emit(reporter,{type:'complete',result});return result;
    }
    const selected=await onSelectSavedImplementation({mode:semantic.continuation.mode === 'reconcile'
      ? (requestedId?'saved_implementation':'current_implementation') : semantic.continuation.mode,operationId:requestedId});
    if (!selected?.plan) {
      const result={status:'implementation_incomplete',runs,planCompleted:false,
        responseText:'The requested saved implementation could not be selected. No changes were started.'};
      await emit(reporter,{type:'complete',result});return result;
    }
    authoritativePlan=selected.plan;
    implementationCheckpoint=selected.checkpoint??null;
    implementationReconciliation=selected.reconciliation??null;
    await emit(reporter,{type:'implementation_plan_selected',planId:authoritativePlan.planId,
      continuation:semantic.continuation.mode});
  }

  // Reconciliation runs before routing, preparation, or any writable role.
  // Model judgments cannot bypass the deterministic checkout/security gates.
  // Semantic intent can request a user decision, but only the selected Plan's
  // existing exact-checkout gate can record it. A bare resume never consents.
  const semanticCheckoutDecision = classification.task?.continuation?.decision ?? null;
  if (semanticCheckoutDecision && !planOnly) {
    const resolved = effectiveModeOverride !== 'review' && effectiveModeOverride !== 'investigate' &&
      authoritativePlan && onResolveReconciliationIntent &&
      !classification.task.ambiguities?.length
      ? await onResolveReconciliationIntent(semanticCheckoutDecision) : null;
    if (resolved?.status !== 'resolved' || resolved.selection !== semanticCheckoutDecision) {
      const result = { status:'implementation_incomplete', planCompleted:false, runs,
        responseText: 'The requested checkout decision cannot be applied to a current, matching pending gate. No implementation was started.',
        implementationCoverage:{complete:false,reason:'reconciliation_decision_not_applicable'} };
      await emit(reporter,{type:'complete',result});return result;
    }
    await emit(reporter,{type:'reconciliation_decision_recorded',decision:semanticCheckoutDecision});
  }
  const recordedReconciliationDecision = authoritativePlan && !planOnly && onReconciliationDecision
    ? await onReconciliationDecision() : null;
  const approval = reconciliationApproval(recordedReconciliationDecision);
  const reconciliationOnly = reconciliationOnlyRequest(classification.task);
  if (recordedReconciliationDecision === 'decline') {
    const result = { status: 'implementation_incomplete', planCompleted: false, runs,
      responseText: 'Checkout reconciliation was declined. No implementation started. Reassess the checkout or update the saved Plan.',
      implementationCoverage: { complete: false, reason: 'reconciliation_declined' } };
    await emit(reporter, { type: 'complete', result });
    return result;
  }
  if (approval && !authoritativePlan && !planOnly) {
    const result = { status: 'implementation_incomplete', planCompleted: false, runs,
      responseText: 'There is no saved implementation Plan and pending reconciliation for this request. No files were modified.',
      implementationCoverage: { complete: false, reason: 'no_pending_reconciliation' } };
    await emit(reporter, { type: 'complete', result });
    return result;
  }
  if (authoritativePlan && !planOnly) {
    const savedPlan = normalizeImplementationPlan(authoritativePlan.plan);
    if (!savedPlan || authoritativePlan.version !== 1 || authoritativePlan.repoRoot !== repoRoot
      || authoritativePlan.planId !== planDigest(savedPlan)) {
      throw new Error('Invalid saved implementation plan. No repository edits were started.');
    }
    const stagesForReconciliation = buildImplementationStages(savedPlan);
    const completedStages = implementationCheckpoint?.completedStages ?? [];
    const checkpointStructureValid = !implementationCheckpoint || validateImplementationCheckpoint(implementationCheckpoint, {
      planId: authoritativePlan.planId, scopeKey: authoritativePlan.planId,
      repoKey: implementationCheckpoint.repoKey, stages: stagesForReconciliation,
    });
    if (!checkpointStructureValid) {
      const result = { status: 'implementation_incomplete', planCompleted: false, runs,
        responseText: 'The saved implementation checkpoint is structurally invalid. No files were modified. Review the saved Plan/checkpoint instead of overriding it with reconciliation.',
        implementationCoverage: { complete: false, reason: 'invalid_checkpoint' } };
      await emit(reporter, { type: 'complete', result });
      return result;
    }
    const current = await captureRepoState(repoRoot);
    const currentKey = repositoryFingerprint(current);
    const baseKey = implementationCheckpoint?.repoKey ?? authoritativePlan.reconciledRepoKey ?? authoritativePlan.repoKey;
    if (baseKey !== currentKey) {
      const identity = { planId: authoritativePlan.planId, baseKey, repoKey: currentKey, completedStages };
      const proposalValid = reconciliationProposalMatches(implementationReconciliation, identity);
      if (approval && (!proposalValid || (approval.legacyToken && approval.legacyToken !== implementationReconciliation.token))) {
        const result = { status: 'implementation_incomplete', planCompleted: false, runs,
          responseText: 'No valid reconciliation proposal exists for this exact Plan, completed-stage prefix and checkout. Request a fresh reconciliation; no implementation started.',
          implementationCoverage: { complete: false, reason: 'invalid_reconciliation_confirmation' } };
        await emit(reporter, { type: 'complete', result });
        return result;
      }
      let proposal = proposalValid ? implementationReconciliation : null;
      const baseline = implementationCheckpoint?.repoSnapshot ?? authoritativePlan.repoSnapshot ?? null;
      // Verify the current checkout EVEN when reusing a persisted proposal.
      const changes = implementationReconciliationChanges(baseline, current);
      if (changes.headChanged || changes.branchChanged || changes.changedPaths.length > (changes.exact ? 200 : 1000)) {
        const result = { status: 'implementation_incomplete', planCompleted: false, runs,
          responseText: `Reconciliation blocked: ${changes.headChanged || changes.branchChanged ? 'HEAD/branch changed' : 'too many paths for bounded reconciliation'}. Update the Plan against the current checkout; no files were modified.`,
          implementationCoverage: { complete: false, reason: 'reconciliation_unsafe_scope' } };
        await emit(reporter, { type: 'complete', result });
        return result;
      }
      try { assertChangedPathsSafe(changes.changedPaths, config.security); }
      catch (error) {
        const result = { status: 'implementation_incomplete', planCompleted: false, runs,
          responseText: `Reconciliation cannot approve protected paths: ${String(error.message)}. No files were modified.`,
          implementationCoverage: { complete: false, reason: 'reconciliation_protected_path' } };
        await emit(reporter, { type: 'complete', result });
        return result;
      }
      if (!proposal) {
        const analyzed = await call(registry, 'investigator', 'implementationReconciliation', repoRoot,
          `TASK MODE: READ-ONLY IMPLEMENTATION RECONCILIATION. DO NOT EDIT FILES.\nUSER TASK:\n${modelTask}\n\nAUTHORITATIVE SAVED PLAN:\n${planPromptText(savedPlan)}\n\nVERIFIED CHECKPOINT CONTEXT (DETERMINISTIC ORCHESTRATOR RESULT):\n${json(validatedCheckpointContext(implementationCheckpoint, stagesForReconciliation))}\n\nREPOSITORY DELTA FROM CHECKPOINT:\n${json(changes)}\n\nCURRENT GIT DIFF (not necessarily only changes since checkpoint):\n${current.diff.slice(0, 20000)}\n\nRESPONSIBILITY BOUNDARY:\nThe orchestrator has ALREADY verified the checkpoint structure, completed-stage prefix and implemented record IDs against the saved Plan. You are not being asked to validate the checkpoint JSON. Lack of the raw checkpoint JSON in your context is NOT a reason to block reconciliation or to demand re-planning. The checkpoint status and next/interrupted stage above are factual session-state observations; an interrupted stage is NOT complete. Your ONLY decision is whether the observed checkout changes remain semantically compatible with the saved Plan and previously completed work, what specific behavior needs re-verification, and what material risks remain. Do not assert that the code or tests are correct merely because the checkpoint structure passed validation.\n\nThe legacy baseline may lack historical file hashes; do not attribute current dirty files to the user without evidence. Inspect the relevant source and evaluate compatibility on repository evidence. Return 'blocked' if requirements, contracts, or architecture changed substantially, if the actual changes cannot be assessed from available repository evidence, or if HEAD changed. Return 'reverify' when affected work needs new tests; list exact stage IDs. Report material unresolved risks in 'risks', not generic statements that tests should run. A compatible result is NOT evidence that tests have passed. Do not create new requirements, write code, or silently replan.`,
          { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
            bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(savedPlan)},
              {kind:'working_diff',value:current.diff.slice(0,20000)},{kind:'git_reconciliation',value:json(changes)}],
            executionScope:{phase:'reconciliation'} });
        runs.push(analyzed.run);
        const analysis = assessReconciliationAnalysis(analyzed.output, analyzed.outputFormat, stagesForReconciliation);
        if (repositoryFingerprint(await captureRepoState(repoRoot)) !== currentKey) {
          const result = { status: 'implementation_incomplete', planCompleted: false, runs,
            responseText: 'Checkout changed during read-only reconciliation. No baseline was accepted; rerun reconciliation.',
            implementationCoverage: { complete: false, reason: 'reconciliation_checkout_drift' } };
          await emit(reporter, { type: 'complete', result });
          return result;
        }
        if (!analysis || analysis.decision === 'blocked') {
          const result = { status: 'implementation_incomplete', planCompleted: false, runs,
            responseText: `Read-only reconciliation cannot confirm the existing Plan remains valid. ${analysis?.summary ?? 'The provider returned invalid evidence.'} Review/update the Plan. No implementation started.`,
            implementationCoverage: { complete: false, reason: 'reconciliation_blocked' } };
          await emit(reporter, { type: 'complete', result });
          return result;
        }
        proposal = newReconciliationProposal({ ...identity, currentState: current, changes, analysis, completedStages });
      }
      const baselineCleanTrackedPaths = [];
      if (!approval && !reconciliationOnly && changes.exact && !changes.headChanged
          && !changes.branchChanged && !changes.indexChanged && changes.changedPaths.length <= 20) {
        for (const path of changes.changedPaths) {
          if (Object.hasOwn(baseline?.workspaceHashes ?? {}, path)) continue;
          const tracked = await execFileSafe('git', ['ls-files', '--error-unmatch', '--', path], {
            cwd: repoRoot, allowFailure: true, maxResultChars: 4096,
            env: { GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' },
          });
          if (tracked.code === 0) baselineCleanTrackedPaths.push(path);
        }
      }
      const automatic = !approval && !reconciliationOnly && canAutoReconcile(proposal, {
        snapshot: baseline, currentState: current, baselineCleanTrackedPaths,
      });
      if (automatic || approval) {
        if (!onImplementationReconciliation) {
          const result = { status: 'implementation_incomplete', planCompleted: false, runs,
            responseText: 'Reconciliation requires persistent session storage. No changes were made.',
            implementationCoverage: { complete: false, reason: 'reconciliation_persistence_unavailable' } };
          await emit(reporter, { type: 'complete', result });
          return result;
        }
        // Recheck at the point of saving. The pre-write stage separately checks
        // the same fingerprint after router/explorer/preparation.
        if (repositoryFingerprint(await captureRepoState(repoRoot)) !== currentKey) {
          const result = { status: 'implementation_incomplete', planCompleted: false, runs,
            responseText: 'Checkout changed while reconciliation was being accepted. No implementation was started.',
            implementationCoverage: { complete: false, reason: 'reconciliation_checkout_drift' } };
          await emit(reporter, { type: 'complete', result });
          return result;
        }
        const updatedPlan = { ...authoritativePlan, reconciledRepoKey: currentKey };
        const updatedCheckpoint = implementationCheckpoint ? {
          ...implementationCheckpoint, repoKey: currentKey,
          repoSnapshot: snapshotImplementationRepo(current),
          reconciliationHistory: [...(implementationCheckpoint.reconciliationHistory ?? []).slice(-9), {
            repoKey: currentKey, changedPaths: changes.changedPaths,
            exact: changes.exact, affectedStages: proposal.analysis.affectedStages,
            revalidationRequired: true, automatic,
          }],
        } : null;
        await onImplementationReconciliation({ plan: updatedPlan, checkpoint: updatedCheckpoint, proposal: null });
        authoritativePlan = updatedPlan;
        implementationCheckpoint = updatedCheckpoint;
        implementationReconciliation = null;
        await emit(reporter, { type: 'implementation_reconciliation_approved', repoKey: currentKey, automatic,
          changedPaths: changes.changedPaths, affectedStages: proposal.analysis.affectedStages });
        if (reconciliationOnly || (approval && !['current_implementation','saved_implementation'].includes(classification.task?.continuation?.mode))) {
          const result = { status: 'investigated', planCompleted: false, runs,
            responseText: 'Reconciliation accepted for this exact checkout. Completed stages remain preserved; changed behavior requires integration revalidation. No implementation was started.' };
          await emit(reporter, { type: 'complete', result });
          return result;
        }
      } else {
        // Save the evaluated proposal atomically, without rewriting the Plan or
        // stage checkpoint. Subsequent turns do not spend another model call.
        if (!onImplementationReconciliation && !proposalValid) {
          const result = { status: 'implementation_incomplete', planCompleted: false, runs,
            responseText: 'Reconciliation requires persistent session storage. No changes were made.',
            implementationCoverage: { complete: false, reason: 'reconciliation_persistence_unavailable' } };
          await emit(reporter, { type: 'complete', result });
          return result;
        }
        // Even a legacy saved proposal may need its P2 gate materialized.
        // This persists the proposal and gate atomically, without new model calls.
        const gate = onImplementationReconciliation
          ? await onImplementationReconciliation({ plan: authoritativePlan, checkpoint: implementationCheckpoint, proposal }) : null;
        const gateInstructions = gate
          ? `\n\nAlternatively, choose \`/decide ${gate.id} accept_checkout\` (then explicitly continue the saved Plan), or \`/decide ${gate.id} decline\`.`
          : '';
        const result = { status: 'implementation_incomplete', planCompleted: false, runs,
          responseText: `${reconciliationPrompt(proposal)}${gateInstructions}`,
          ...(gate ? { decisionGateId: gate.id } : {}),
          implementationCoverage: { complete: false, reason: 'reconciliation_confirmation_required' } };
        await emit(reporter, { type: 'implementation_reconciliation_proposed' });
        await emit(reporter, { type: 'complete', result });
        return result;
      }
    } else if (reconciliationOnly) {
      const result = { status: 'investigated', planCompleted: false, runs,
        responseText: 'The saved implementation baseline already matches the current checkout. No reconciliation or implementation was needed; no files were modified.' };
      await emit(reporter, { type: 'complete', result });
      return result;
    } else if (approval) {
      const result = { status: 'implementation_incomplete', planCompleted: false, runs,
        responseText: 'No reconciliation is pending for the current checkout. No changes were made by this request.',
        implementationCoverage: { complete: false, reason: 'no_pending_reconciliation' } };
      await emit(reporter, { type: 'complete', result });
      return result;
    }
  }

  // Semantic review continuation: resolve only a validated persisted operation,
  // never infer its identity from a loose keyword or from repository content.
  // The original task spec, scope, and budgets remain authoritative on resume.
  if (!continuingReview && classification.task &&
      ['current_review','saved_review'].includes(classification.task.continuation.mode)) {
    const requestedId = classification.task.continuation.operationId;
    if (!reviewOperationCompatible(reviewCheckpoint,{repoRoot}) ||
        (requestedId && requestedId !== reviewCheckpoint.operation.id)) {
      const result={status:'review_incomplete',runs,planCompleted:false,
        responseText:'The requested saved Review Operation is not available or does not match this session. No review was restarted.'};
      await emit(reporter,{type:'complete',result});return result;
    }
    let persistedReviewIntent;
    try { persistedReviewIntent=validateTaskSpec(reviewCheckpoint.operation.taskSpec); }
    catch { /* legacy checkpoint: no natural-language upgrade */ }
    if (persistedReviewIntent?.operation !== 'review' || persistedReviewIntent.writeIntent !== 'not_requested') {
      const result={status:'review_incomplete',runs,planCompleted:false,
        errorCode:'legacy_review_checkpoint_without_validated_intent',
        responseText:'Saved Review checkpoint lacks a valid typed intent; no work was resumed.'};
      await emit(reporter,{type:'complete',result});return result;
    }
    continuingReview=true;
    sourceReviewTask=reviewCheckpoint.operation.task;
    reviewSkillName=reviewCheckpoint.operation.skillName;
    if (reviewSkillName && invocationContext.skill?.name !== reviewSkillName) {
      invocationContext=await loadInvocationContext(repoRoot,{skillName:reviewSkillName,scopePaths:[repoStart]});
      persistentContext=formatInstructionContext(invocationContext);
      runtimeRoleOptions.contextComposition.instructionsText=persistentContext;
      runtimeRoleOptions.contextComposition.instructionSources=[...invocationContext.instructions.map(({scope,body})=>({scope,body})),
        ...(invocationContext.skill?[{scope:'active-skill',body:invocationContext.skill.body}]:[])];
    }
    inferredReviewTarget=reviewCheckpoint.operation.reviewTarget;
    activeReviewTarget=inferredReviewTarget?.type==='commit'
      ? await resolveCommitReviewTarget(repoRoot,inferredReviewTarget.revision) : null;
    modelTask=modelTaskForReview(sourceReviewTask,activeReviewTarget);
    contextText=[persistentContext,reviewTargetContext(activeReviewTarget),
      sessionContextText ? `OUTER CONVERSATION CONTEXT:\n${sessionContextText}` : ''].filter(Boolean).join('\n\n');
    runtimeRoleOptions.contextComposition.reviewTargetText=reviewTargetContext(activeReviewTarget);
    runtimeRoleOptions.stableContext=[persistentContext,reviewTargetContext(activeReviewTarget)].filter(Boolean).join('\n\n');
    classification={...classification,mode:'review',writeIntent:'not_requested',
      complexity:reviewCheckpoint.operation.classification?.complexity??'high',
      risk:reviewCheckpoint.operation.classification?.risk??'architecture',
      task:reviewCheckpoint.operation.taskSpec??emptyTaskSpec('review'),
      reason:'Validated persisted Review Operation continuation.'};
    await emit(reporter,{type:'review_plan_restored',operationId:reviewCheckpoint.operation.id,
      units:reviewCheckpoint.operation.workPlan.totalUnits});
  }
  // A model selects a commit reference; Git independently resolves its
  // identity and parents before anything is handed to the reviewer.
  if (classification.mode === 'review' && !activeReviewTarget &&
      classification.task?.target?.selector?.type === 'commit') {
    try {
      const concrete = await resolveCommitReviewTarget(repoRoot,classification.task.target.selector.ref);
      activeReviewTarget={...concrete,
        ...(classification.task.target.selector.mergeParentIndex ?
          {mergeParentIndex:classification.task.target.selector.mergeParentIndex}:{})};
      modelTask=modelTaskForReview(sourceReviewTask,activeReviewTarget);
      contextText=[persistentContext,reviewTargetContext(activeReviewTarget),
        sessionContextText ? `OUTER CONVERSATION CONTEXT:\n${sessionContextText}` : ''].filter(Boolean).join('\n\n');
      runtimeRoleOptions.contextComposition.reviewTargetText=reviewTargetContext(activeReviewTarget);
    } catch (error) {
      const result={status:'review_incomplete',runs,planCompleted:false,
        responseText:'The requested Git commit could not be resolved. No review scope was invented.'};
      await emit(reporter,{type:'semantic_target_resolution',status:'unresolved',reason:'git_commit_unavailable'});
      await emit(reporter,{type:'complete',result});return result;
    }
  }
  if (!continuingReview && !planOnly) {
    const validation = validateRouteConsistency(classification, {
      taskSpec: classification.task ?? null,
      skill: invocationContext.skill,
      explicitMode: effectiveModeOverride,
    });
    classification = validation.classification;
    await emit(reporter, { type: 'route_validation', status: validation.status, reason: validation.reason });
  }
  if (!continuingReview && classification.task?.skillName && !reviewSkillName) {
    const name=classification.task.skillName;
    if (!invocationContext.skills.has(name)) {
      const result={status:'intent_unresolved',runs,planCompleted:false,errorCode:'unknown_semantic_skill',
        responseText:`Requested skill '${name}' was not found; no execution started.`};
      await emit(reporter,{type:'complete',result});return result;
    }
    reviewSkillName=name;
    invocationContext=await loadInvocationContext(repoRoot,{skillName:name,scopePaths:[repoStart]});
    persistentContext=formatInstructionContext(invocationContext);
    runtimeRoleOptions.contextComposition.instructionsText=persistentContext;
    runtimeRoleOptions.contextComposition.instructionSources=[...invocationContext.instructions.map(({scope,body})=>({scope,body})),
      {scope:'active-skill',body:invocationContext.skill.body}];
    runtimeRoleOptions.contextComposition.reviewTargetText=reviewTargetContext(activeReviewTarget);
    modelTask=[modelTask,`ROUTER-SELECTED SKILL: ${name}. Apply its instructions within existing permissions.`].join('\n\n');
    contextText=[persistentContext,reviewTargetContext(activeReviewTarget),
      sessionContextText ? `OUTER CONVERSATION CONTEXT:\n${sessionContextText}` : ''].filter(Boolean).join('\n\n');
    await emit(reporter,{type:'skill_invocation_resolved',source:'semantic_router',status:'resolved'});
  }
  if (classification.task) {
    const semanticContext=`VALIDATED TASK SPECIFICATION (intent only; authority remains with policy and resolvers):\n${JSON.stringify(classification.task)}`;
    runtimeRoleOptions.contextComposition.taskSpec = classification.task;
    runtimeRoleOptions.stableContext = [runtimeRoleOptions.stableContext,semanticContext].filter(Boolean).join('\n\n');
    contextText=[contextText,semanticContext].filter(Boolean).join('\n\n');
  }
  const policy = routingPolicy(classification, config);
  runtimeRoleOptions.reviewProjectContext.enabled=policy.mode==='review';
  const skillPolicy = resolveSkillExecutionPolicy(invocationContext.skill);
  const skillCompatibility = skillExecutionCompatibility(skillPolicy, policy.mode);
  if (!skillCompatibility.compatible) {
    await emit(reporter, { type: 'skill_execution_conflict', reason: skillCompatibility.reason });
    const result = { status:'skill_execution_conflict', runs, planCompleted:false,
      responseText:'The active skill explicitly forbids multi-agent execution, which this workflow cannot safely satisfy. No additional agents were launched; select a compatible skill or invoke it directly with the intended agent.' };
    await emit(reporter, {type:'complete',result});
    return result;
  }

  // Quality obligations belong to the typed semantic intent. A saved plan
  // may retain the obligation across continuation; skill metadata never grants it.
  const coverageTask = [classification.task, authoritativePlan?.taskSpec, reviewCheckpoint?.operation?.taskSpec]
    .find(task => Array.isArray(task?.qualityGoals) && task.qualityGoals.length > 0) ?? null;
  const collectRequestedCoverageEvidence = async () => {
    if (!coverageTask) return null;
    if (!coverageTask.qualityGoals.some(goal => ['test_inventory','scenario_assessment'].includes(goal)))
      return {status:'UNVERIFIED',reason:'instrumented_or_executed_evidence_not_collected',
        qualityGoals:coverageTask.qualityGoals};
    if (coverageTask.target?.kind !== 'git') return {status:'UNVERIFIED',reason:'git_scope_not_selected',
      qualityGoals:coverageTask.qualityGoals};
    try { return await buildTestCoverageEvidence(repoRoot,coverageTask,{signal,maxProductionFiles:25}); }
    catch (error) {
      if (signal?.aborted) throw error;
      return {status:'UNVERIFIED',reason:'collection_failed',qualityGoals:coverageTask.qualityGoals};
    }
  };
  let testCoverageEvidence = await collectRequestedCoverageEvidence();
  if (testCoverageEvidence) await emit(reporter,{type:'quality_evidence_inventory',
    status:testCoverageEvidence.status,goals:coverageTask.qualityGoals});
  const adaptiveReviewEnabled = policy.mode === 'review' && config.policy?.reviewEfficiency?.enabled === true;
  // A structured command is a trusted host signal; all other target
  // selectors and exclusions come exclusively from the validated Router task.
  const commandSelector = structuredCommandSelector(reviewTarget);
  const authoritativeSelector = continuingReview
    ? (reviewCheckpoint.operation.taskSpec?.target?.selector ?? (reviewCheckpoint.operation.taskSpec ? commandSelector : reviewCheckpoint.operation.task))
    : commandSelector ?? classification.task?.target?.selector ?? null;
  const userReviewExclusions = policy.mode === 'review'
    ? (continuingReview ? reviewCheckpoint.operation.taskSpec?.constraints?.excludedPaths : classification.task?.constraints?.excludedPaths) ?? []
    : [];
  const resolvedReviewScope = () => resolveReviewScope(repoRoot,
    authoritativeSelector ?? { ...emptyTaskSpec('review'), target:{kind:'none',selector:null} },activeReviewTarget,signal);
  // A deterministic Git preflight is cheaper than an unnecessary planning or
  // exploration invocation. It never authorizes writes and is revalidated by
  // the existing checkout/commit drift guards before every reviewer batch.
  const preflightReviewScope = adaptiveReviewEnabled && !continuingReview
    ? applyUserReviewExclusions(await resolvedReviewScope(), userReviewExclusions)
    : null;
  const efficiencyStrategy = adaptiveReviewEnabled ? chooseReviewStrategy({
    scope: preflightReviewScope ?? applyUserReviewExclusions(
      await resolvedReviewScope(), userReviewExclusions),
    classification, requirements:classification.task?.constraints,
    workload: assessReviewWorkload(preflightReviewScope, classification),
    policy: { ...config.policy?.reviewEfficiency,
      persistedStrategy: continuingReview ? reviewCheckpoint.operation.executionStrategy : null },
    resume: continuingReview,
  }) : null;
  if (efficiencyStrategy?.skipPlanning) {
    policy.plan = false;
    await emit(reporter, { type: 'review_role_bypassed', role: 'planner', reason: 'scope_preflight_available' });
  }
  await emit(reporter, { type: 'review_execution_strategy',
    strategy: efficiencyStrategy?.name ?? (policy.mode === 'review' ? 'legacy' : null),
    adaptive: !!efficiencyStrategy });
  const preview = buildExecutionPreview(policy, registry);
  await emit(reporter, { type: 'route', classification, policy, preview });
  try { await emit(reporter,{type:'authorization_resolution',status:policy.mode === 'change' ? 'write_gated' : 'read_only',operation:policy.mode,writeIntent:classification.writeIntent,policyMode:policy.mode}); } catch { /* diagnostic only */ }

  let exploration;
  if (continuingReview) {
    exploration = { summary: 'Continuing the persisted Review Work Plan; previous evidence is retained in its checkpoint.' };
  } else if (policy.mode === 'investigate' && config.policy?.workflowEfficiency?.investigationDirect === true &&
      classification.complexity === 'low' && classification.risk === 'normal' && !planOnly && !activeReviewTarget) {
    // A low-risk, bounded investigation can inspect the repository directly.
    // The investigator's tools and read-only protection remain unchanged.
    exploration = { summary: 'Direct investigator execution: inspect primary evidence with read-only tools.',
      relevantFiles: [], constraints: [], existingPatterns: [], likelyVerification: [], unknowns: [] };
    await emit(reporter, { type: 'review_role_bypassed', role: 'explorer', reason: 'direct_low_risk_investigation' });
  } else if (efficiencyStrategy?.skipExploration && preflightReviewScope?.available) {
    exploration = { summary: 'Git inventory established by the orchestrator; the reviewer must inspect the source directly.',
      relevantFiles: preflightReviewScope.paths.map(entry => entry.path), constraints: [], existingPatterns: [],
      likelyVerification: [], unknowns: [] };
    await emit(reporter, { type: 'review_role_bypassed', role: 'explorer', reason: 'scope_preflight_available' });
  } else {
    const explored = await call(
      registry, 'explorer', 'exploration', repoRoot,
      `TASK MODE: ${policy.mode}\nUSER TASK:\n${modelTask}\n\nYou have read-only access to the current source checkout. Choose the evidence and tools needed for this task yourself.\n\nQUALITY EVIDENCE INVENTORY (candidate associations only; never proven test coverage):\n${json(testCoverageEvidence)}`,
      { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
        bodySources: [{kind:'user_task',value:modelTask}], executionScope:{phase:'exploration'} },
    );
    runs.push(explored.run);
    exploration = acceptedRoleOutput(explored);
  }
  // Handoff is only a hint; if it cannot be represented compactly, the
  // original untrusted report remains available and must be used.
  const hintedExploration = efficiency.handoff === true ? researchHandoff(exploration) : null;

  let plan = null;
  let plannerOutput = null;
  let hasNativeTaskPlan = false;
  if (continuingReview) {
    plan = reviewCheckpoint.operation.plannerPlan ?? fallbackPlan(modelTask, exploration, 'review');
  } else if (policy.mode === 'change' && authoritativePlan) {
    plan = normalizeImplementationPlan(authoritativePlan.plan);
    if (!plan || authoritativePlan.version !== 1 || authoritativePlan.planId !== planDigest(plan) || authoritativePlan.repoRoot !== repoRoot) {
      throw new Error('Saved implementation plan is invalid or belongs to a different repository. No files were changed.');
    }
    hasNativeTaskPlan = true;
    await emit(reporter, { type: 'implementation_plan_reused', planId: authoritativePlan.planId });
  } else if (policy.plan) {
    const planned = await call(
      registry, 'planner', 'plan', repoRoot,
      `TASK MODE: ${policy.mode}\nUSER TASK:\n${modelTask}\n\nREPOSITORY EXPLORATION:\n${hintedExploration?.text ?? promptValue(exploration)}\n\nQUALITY EVIDENCE INVENTORY (candidates only, not observed coverage):\n${json(testCoverageEvidence)}\n\nUse any additional read-only repository evidence you consider necessary.${policy.mode === 'plan' ? '\nReturn a concrete, self-contained implementation/review plan with ordered steps, acceptance criteria, risks and verification. Do not edit the repository.' : ''}`,
      { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'exploration',value:hintedExploration?.text ?? promptValue(exploration)}],
        executionScope:{phase:'planning'} },
    );
    runs.push(planned.run);
    if (planned.outputFormat === 'structured') {
      plan = normalizeImplementationPlan(planned.output);
      hasNativeTaskPlan = Array.isArray(plan?.steps) && plan.steps.length > 0;
    } else {
      plannerOutput = textResult(planned);
      plan = fallbackPlan(modelTask, exploration, policy.mode);
    }
  } else if (policy.mode !== 'investigate') {
    // Low-tier change/review workflows may skip the planner. Keep a minimal
    // internal execution scaffold for downstream roles, but do not present it
    // as a planner-authored host task plan.
    plan = fallbackPlan(modelTask, exploration, policy.mode);
  }
  if (policy.plan && !plan) {
    const result = { status: planOnly ? 'plan_incomplete' : 'implementation_incomplete',
      route: { classification, policy }, exploration, plan: null, planCompleted: false, runs,
      responseText: 'Planner returned an invalid or incomplete structured plan. No repository edits were started; request a corrected Plan before implementation.' };
    await emit(reporter, { type: 'complete', result });
    return result;
  }
  if (hasNativeTaskPlan) await emit(reporter, { type: 'plan', plan, preview });

  if (policy.mode === 'plan') {
    // The planner, not the investigator, is the authoritative final output for
    // this mode. Text fallback stays visible instead of a fabricated scaffold.
    const responseText = plannerOutput?.text?.trim() || formatPlanMarkdown(plan);
    const normalized = plannerOutput ? null : normalizeImplementationPlan(plan);
    const planState = normalized ? await captureRepoState(repoRoot) : null;
    const planArtifact = normalized ? { version: 1, repoRoot, planId: planDigest(normalized), plan: normalized, repoKey: repositoryFingerprint(planState), repoSnapshot: snapshotImplementationRepo(planState), taskSpec:classification.task??null } : null;
    const result = {
      status: 'planned', route: { classification, policy }, exploration, plan, plannerOutput, planArtifact,
      responseText, responseStreamed: false, planCompleted: true,
      reviewTarget: activeReviewTarget, runs,
      ...(testCoverageEvidence ? {testCoverageEvidence} : {}),
    };
    await emit(reporter, { type: 'complete', result });
    return result;
  }

  if (policy.mode === 'investigate') {
    const investigated = await call(
      registry, 'investigator', null, repoRoot,
      `TASK MODE: investigate\nUSER TASK:\n${modelTask}\n\nREPOSITORY EXPLORATION:\n${hintedExploration?.text ?? promptValue(exploration)}\n\nQUALITY EVIDENCE INVENTORY (if requested, NOT verified scenario coverage):\n${json(testCoverageEvidence)}\n\nGive the user the best final answer. Re-check repository evidence when needed; remain read-only. If proposed code, a code block, or a unified diff would answer the request better, present it naturally in the chat.`,
      { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal, presentToUser: streamFinalResponse,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'exploration',value:hintedExploration?.text ?? promptValue(exploration)}],
        executionScope:{phase:'investigation'} },
    );
    runs.push(investigated.run);
    const investigation = textResult(investigated);
    const result = {
      status: 'investigated', route: { classification, policy }, exploration, investigation, plannerOutput,
      responseText: investigation.text, responseStreamed: investigated.finalAnswerPresented,
      reviewTarget: activeReviewTarget, runs,
      ...(testCoverageEvidence ? {testCoverageEvidence} : {}),
    };
    await emit(reporter, { type: 'complete', result });
    return result;
  }

  if (policy.mode === 'review') {
    let verification = [];
    if (policy.runVerification) {
      if (activeReviewTarget) {
        throw new Error('policy.reviewVerification is not supported for historical commit review; review the commit read-only or disable review verification.');
      }
      const checked = await runWorkflowVerification(repoRoot, reporter, signal, { security: config.security });
      verification = checked.results;
    }

    const reviewWorkspaceBaseline = await captureRepoState(repoRoot);
    const contract = continuingReview ? reviewCheckpoint.operation.contract : buildReviewContract(sourceReviewTask, plan, {requirements:classification.task?.constraints??{}});
    if (!contract.checks.length) {
      const fallback = { id: 'S1', description: 'Review the explicitly requested scope and report concrete evidence.', source: 'fallback' };
      contract.checks = [fallback];
      contract.batches = [[fallback]];
    }
    // Scope/Unit planning belongs to the workflow, never a named slash command.
    // Unknown Git scope is explicit incomplete evidence, not a guessed base.
    const scope = applyUserReviewExclusions(preflightReviewScope ??
      await resolvedReviewScope(), userReviewExclusions);
    if (contract.expectedFileCount !== null) {
      scope.required = true;
      if (!scope.available && !scope.reason) scope.reason = 'requested_file_inventory_unverified';
    }
    if (scope.available) {
      // A rename/copy includes both source and destination: never disclose a
      // denied oldPath via the work assignment, imports, or Git change metadata.
      const permitted = (entry) => [entry.path, entry.oldPath, ...(entry.oldPaths ?? []),
        ...(entry.changes ?? []).map((change) => change.oldPath)].filter(Boolean)
        .every((path) => !evaluateSecurityPath(path, config.security).denied);
      const denied = scope.paths.filter((entry) => !permitted(entry));
      scope.paths = scope.paths.filter(permitted);
      scope.deniedCount = denied.length;
      scope.relationships = await inspectReviewRelationships(repoRoot, scope, { signal });
    }
    const reviewGitContext = scope.available ? JSON.stringify({ selector: scope.selector, revisions: scope.revisions,
      status: scope.status, unresolved: (scope.unresolved ?? []).map((entry) => ({ commit: entry.commit, reason: entry.reason })) })
      : `unresolved: ${scope.reason ?? 'git_scope_not_specified'}`;
    const reviewWorkload = assessReviewWorkload(scope, classification, contract);
    await emit(reporter, { type: 'review_workload_assessed', files: reviewWorkload.files,
      risk: reviewWorkload.highRisk ? 'high' : reviewWorkload.mediumRisk ? 'medium' : 'normal',
      confidence: reviewWorkload.confidence });
    const reviewWorkPolicy = {
      maxFilesPerUnit: config.policy?.reviewWork?.maxFilesPerUnit ?? efficiencyStrategy?.maxFilesPerUnit ?? 4,
      maxUnitsPerBatch: config.policy?.reviewWork?.maxUnitsPerBatch ?? efficiencyStrategy?.maxUnitsPerBatch ?? 2,
      coScheduleDependents: efficiencyStrategy?.coScheduleDependents ?? false,
      batchLimit: config.policy?.reviewWork?.maxBatchesPerRun ?? MAX_BATCHES_PER_RUN,
    };
    const workPlan = buildReviewWorkPlan(contract, scope, {
      ...reviewWorkPolicy, maxFilesPerUnit: continuingReview
        ? reviewCheckpoint.operation.maxFilesPerUnit : reviewWorkPolicy.maxFilesPerUnit });
    const savedWorkPlan = continuingReview ? reviewCheckpoint.operation.workPlan : null;
    const reviewToolEvidence = createReviewToolEvidenceObserver();
    const reviewToolReporter = async (event) => {
      reviewToolEvidence.observe(event);
      if (event.type === 'role_done') executionBudget.observeUsage(event.usage);
      await emit(reporter, event);
    };
    const qualityConfig = config.policy?.reviewEfficiency?.qualityDepth ?? {};
    const qualityMode = qualityConfig.mode ?? 'off';
    const qualityEnabled = qualityMode !== 'off';
    const maxQualityFollowUps = qualityConfig.maxAdditionalInvocations ?? 1;
    const qualityPolicy = { mode:qualityMode, followUpPolicy:'material_only', maxAdditionalInvocations:maxQualityFollowUps };
    let qualityState = qualityEnabled ? newReviewQualityState(workPlan,reviewWorkload,contract) : null;
    const checkedRecords = [];
    const coverageProblems = [];
    const reviewReports = [];
    const completedBatches = [];
    const reviewVerificationObservations = [];
    // Operation hard ceilings cannot be raised or erased by changing config
    // between explicit continuations. A newly configured tighter ceiling is
    // allowed and becomes durable for later segments.
    const budgetConfig={...(config.policy?.reviewEfficiency?.executionBudget??{})};
    const hardKeys=['maxOperationInvocations','maxOperationElapsedMs',
      'maxOperationInputTokens','maxOperationOutputTokens'];
    const inheritedHard=continuingReview ? reviewCheckpoint?.operation?.reviewHardLimits : null;
    for (const key of hardKeys) if (Number.isSafeInteger(inheritedHard?.[key]))
      budgetConfig[key]=Math.min(budgetConfig[key]??Infinity,inheritedHard[key]);
    const executionBudget = new ExecutionBudget(budgetConfig);
    const fingerprint = (value) => createHash('sha256').update(json(value)).digest('hex');
    const reviewScopeKey = fingerprint({ task: sourceReviewTask, repoRoot, reviewTarget: activeReviewTarget?.sourceCommit ?? null,
      skill: invocationContext.skill ?? null, instructions: invocationContext.instructions,
      securityPolicy: config.security });
    const repoKey = (state) => fingerprint({ head: state.head, headRef: state.gitMetadata?.headRef,
      index: state.gitMetadata?.stagedHash, workspaceHashes: state.workspaceHashes });
    const baselineKey = repoKey(reviewWorkspaceBaseline);
    const previous = reviewCheckpoint;
    const operation = continuingReview ? (reconcilingReview ? { ...previous.operation, task: sourceReviewTask, workPlan: structuredClone(workPlan) } : structuredClone(previous.operation)) : {
      id: randomUUID(), repoRoot, task: sourceReviewTask,
      skillName: reviewSkillName ?? null, reviewTarget: inferredReviewTarget ?? null,
      classification: { complexity: classification.complexity, risk: classification.risk },
      taskSpec: classification.task ?? (continuingReview ? reviewCheckpoint.operation.taskSpec : null),
      contract: structuredClone(contract),
      workPlan: structuredClone(workPlan),
      plannerPlan: plan && JSON.stringify(plan).length <= 40000 ? structuredClone(plan) : null,
      maxFilesPerUnit: reviewWorkPolicy.maxFilesPerUnit,
      executionStrategy: efficiencyStrategy?.name ?? 'legacy',
      ...(qualityEnabled ? {qualityPolicy} : {}),
    };
    const qualityCompatible = !continuingReview || previous?.version === 3 ||
      JSON.stringify(previous?.operation?.qualityPolicy ?? {mode:'off'}) ===
      JSON.stringify(qualityEnabled ? qualityPolicy : {mode:'off'});
    if (qualityEnabled) operation.qualityPolicy = qualityPolicy;
    operation.reviewHardLimits=Object.fromEntries(hardKeys.map(key=>[key,executionBudget.limits[key]]));
    if (inheritedHard && hardKeys.some(key=>inheritedHard[key]!==null &&
      (config.policy?.reviewEfficiency?.executionBudget?.[key]??Infinity)>inheritedHard[key]))
      await emit(reporter,{type:'review_budget_hard_limit_preserved',operationId:operation.id});
    const scopeMatches = qualityCompatible && (!continuingReview || (fingerprint(savedWorkPlan) === fingerprint(workPlan) && savedWorkPlan.planKey === workPlan.planKey &&
      savedWorkPlan.scope.revisionKey === workPlan.scope.revisionKey &&
      savedWorkPlan.scope.manifestKey === workPlan.scope.manifestKey));
    let resumed = scopeMatches ? validateReviewCheckpoint(previous, { scopeKey: reviewScopeKey, plan: workPlan, repoKey: baselineKey }) : null;
    if (reconcilingReview) {
      // Confirm that the old evidence really belonged to the same repository,
      // policy, instructions and unmodified checkout before migrating any Unit.
      const previousScopeKey = fingerprint({ task: previous.operation.task, repoRoot,
        reviewTarget: activeReviewTarget?.sourceCommit ?? null, skill: invocationContext.skill ?? null,
        instructions: invocationContext.instructions, securityPolicy: config.security });
      const oldScope = await resolveReviewScope(repoRoot, previous.operation.taskSpec?.target?.selector ?? (previous.operation.taskSpec ? { ...emptyTaskSpec('review'), target:{kind:'none',selector:null} } : previous.operation.task), activeReviewTarget, signal);
      if (oldScope.available) {
        const oldPermitted = entry => [entry.path, entry.oldPath, ...(entry.oldPaths ?? []),
          ...(entry.changes ?? []).map(change => change.oldPath)].filter(Boolean)
          .every(path => !evaluateSecurityPath(path, config.security).denied);
        oldScope.deniedCount = oldScope.paths.filter(entry => !oldPermitted(entry)).length;
        oldScope.paths = oldScope.paths.filter(oldPermitted);
        oldScope.relationships = await inspectReviewRelationships(repoRoot, oldScope, { signal });
      }
      if (previous.operation.contract.expectedFileCount !== null) oldScope.required = true;
      const originalPlan = buildReviewWorkPlan(previous.operation.contract, oldScope, {
        maxFilesPerUnit: previous.operation.maxFilesPerUnit });
      const grounded = fingerprint(originalPlan) === fingerprint(previous.operation.workPlan);
      const original = grounded ? validateReviewCheckpoint(previous, { scopeKey: previousScopeKey,
        plan: originalPlan, repoKey: baselineKey }) : null;
      resumed = original && originalPlan.scope.selector === workPlan.scope.selector
        ? reconcileReviewUnits(originalPlan, workPlan, original) : null;
      if (resumed) await emit(reporter, { type: 'review_scope_reconciled', operationId: operation.id,
        reusedUnits: resumed.records.length, invalidatedUnits: resumed.invalidated });
    }
    if (resumed) {
      if (qualityEnabled && resumed.qualityState && !reconcilingReview) qualityState = resumed.qualityState;
      // Carry reviewer invocation/token accounting across validated Review
      // continuation, never across changed source/scope/security.
      if (continuingReview && (!previous?.operation?.reviewBudget ||
          !executionBudget.restore(previous.operation.reviewBudget, { newSegment:true })) &&
          (previous?.operation?.reviewBudget || hardKeys.some(key=>executionBudget.limits[key]!==null))) {
        const result={status:'review_incomplete',runs,planCompleted:false,reviewOperationId:operation.id,
          responseText:'Saved review budget is invalid or unavailable for a configured hard limit. No reviewer invocations were started; checkpoint remains unchanged.'};
        await emit(reporter,{type:'review_checkpoint_rejected',reason:'invalid_review_budget'});
        await emit(reporter,{type:'complete',result});return result;
      }
      checkedRecords.push(...resumed.records);
      reviewReports.push(...resumed.reports);
      await emit(reporter, { type: 'review_operation_resumed', operationId: operation.id,
        reusedUnits: checkedRecords.length });
      await emit(reporter, { type: 'review_checkpoint_resumed', completed: checkedRecords.length,
        total: workPlan.totalUnits });
    } else if (previous?.status === 'in_progress') {
      await emit(reporter, { type: 'review_checkpoint_rejected', reason: 'scope_or_repository_changed' });
      if (previous.version === 2 && previous.planKey !== workPlan.planKey) {
        await emit(reporter, { type: 'review_scope_invalidated', reason: 'plan_or_scope_changed' });
      }
    }
    if (continuingReview && !resumed) {
      const result = { status: 'review_incomplete', runs,
        responseText: 'The saved Review Operation is incompatible with the current Git scope, security policy, instructions or checkout. Existing evidence was preserved; no Unit was rerun. Start a new review or explicitly reconcile the Git scope.',
        reviewOperationId: operation.id, planCompleted: false };
      await emit(reporter, { type: 'review_scope_invalidated', reason: 'saved_review_operation_incompatible' });
      await emit(reporter, { type: 'complete', result });
      return result;
    }
    await emit(reporter, { type: 'review_plan_created', total: workPlan.totalUnits,
      files: scope.available ? scope.total : null, manifestAvailable: scope.available });
    const feasibility = reviewPlanFeasibility(workPlan, {
      ...reviewWorkPolicy, ...executionBudget.limits,
    }, checkedRecords.map(row => row.id), executionBudget.disposition());
    await emit(reporter, { type: 'review_plan_feasibility', estimatedInvocations: feasibility.minInvocations,
      obligations: feasibility.obligations, exceedsOneRun: feasibility.exceedsOneRun,
      fitsCurrentSegment:feasibility.fitsCurrentSegment,
      continuationRequired:feasibility.continuationRequired,
      hardLimitPotentiallyInsufficient:feasibility.hardLimitPotentiallyInsufficient,
      segmentRemainingInvocations:feasibility.segmentRemainingInvocations,
      operationRemainingInvocations:feasibility.operationRemainingInvocations });
    if (scope.excludedFiles) await emit(reporter, { type: 'review_user_scope_excluded', count: scope.excludedFiles });
    // Optional CAS mirror. A mirror is neither a completion authority nor a
    // substitute for validating the original v3 checkpoint on every resume.
    const persistentEvidenceEnabled = config.policy?.evidence?.persistentStore === true;
    if (persistentEvidenceEnabled && continuingReview && resumed) {
      try {
        const mirror = await loadEvidenceSnapshot({ operationId:operation.id,
          scopeKey:reviewScopeKey, sourceKey:baselineKey });
        if (mirror && mirror.evidence.length !== projectReviewEvidence({plan:workPlan,
          records:checkedRecords, reports:reviewReports, sourceKey:baselineKey}).evidence.length)
          await emit(reporter,{type:'review_evidence_mirror_mismatch',reason:'authoritative_checkpoint_differs'});
        else if (mirror) reviewVerificationObservations.push(...validatedReviewObservations(
          mirror.verificationObservations,baselineKey));
      } catch(error) {
        await emit(reporter,{type:'review_evidence_mirror_unavailable',reason:'integrity_or_io_failure'});
      }
    }
    let interrupted = null;
    let checkpointSaved = true;
    const persistReviewCheckpoint = async (status = 'in_progress') => {
      if (!onReviewCheckpoint) return false;
      try {
        operation.reviewBudget = executionBudget.snapshot();
        const state = makeReviewCheckpoint({ scopeKey: reviewScopeKey, plan: workPlan,
          repoKey: baselineKey, status, records: checkedRecords, reports: reviewReports, operation, qualityState });
        await onReviewCheckpoint(state);
        if (persistentEvidenceEnabled) {
          try {
            const derived = projectReviewEvidence({plan:workPlan,records:checkedRecords,
              reports:reviewReports,sourceKey:baselineKey});
            derived.verificationObservations = validatedReviewObservations(reviewVerificationObservations, baselineKey);
            const mirror = await persistEvidenceSnapshot({operationId:operation.id,
              scopeKey:reviewScopeKey,graph:derived});
            await emit(reporter,{type:'review_evidence_mirror_persisted',records:mirror.records});
          } catch(error) {
            // The authoritative checkpoint is durable; mirror failure cannot
            // downgrade its truth or turn a review pass into a false failure.
            await emit(reporter,{type:'review_evidence_mirror_unavailable',reason:'integrity_or_io_failure'});
          }
        }
        await emit(reporter, { type: 'review_checkpoint_persisted', verified: checkedRecords.length, total: workPlan.totalUnits });
        return true;
      } catch (error) {
        checkpointSaved = false;
        await emit(reporter, { type: 'review_checkpoint_error', message: String(error?.message ?? error) });
        return false;
      }
    };
    if (!continuingReview || reconcilingReview) {
      await emit(reporter, { type: 'review_operation_created', operationId: operation.id,
        units: workPlan.totalUnits });
      await persistReviewCheckpoint(); // plan durable before first reviewer invocation
    }
    // Schedule after each completed batch. A prerequisite that was not checked
    // must never enable its dependents in a precomputed queue.
    const attemptedUnits = new Set();
    const progressGuard = new ReviewNoProgressGuard();
    const reviewSourceMoved = async (state) => {
      if (!scope.selector || reviewWorkspaceBaseline.gitMetadata?.refsHash === state.gitMetadata?.refsHash) return false;
      const current = applyUserReviewExclusions(
        await resolvedReviewScope(), userReviewExclusions);
      return current.revisionKey !== scope.revisionKey || current.manifestKey !== scope.manifestKey || current.status !== scope.status;
    };
    for (let batchIndex = 0; batchIndex < reviewWorkPolicy.batchLimit; batchIndex++) {
      throwIfAborted(signal);
      const units = nextReviewBatch(workPlan, checkedRecords.map((row) => row.id),
        attemptedUnits, reviewWorkPolicy);
      const openQuality = qualityEnabled ? assessReviewQuality(qualityState,{mode:qualityMode,
        coverageComplete:units.length===0}) : null;
      const riskFollowUp = qualityMode === 'enforce' && units.length===0 &&
        checkedRecords.length===workPlan.totalUnits && openQuality.open>0 &&
        qualityState.followUps < maxQualityFollowUps;
      // Exhaustion matters only when there is remaining work. A fully checked
      // operation must not become incomplete merely because its last allowed
      // invocation used the budget exactly.
      if (!units.length && !riskFollowUp) break;
      const budgetState = executionBudget.disposition();
      if (budgetState.exhausted) {
        coverageProblems.push('Review execution budget exhausted; unresolved coverage preserved for continuation.');
        await emit(reporter, { type:'execution_budget_paused', reason:budgetState.reasons[0],
          invocations:budgetState.invocations,operationInvocations:budgetState.operationInvocations,
          segments:budgetState.segments,hardLimit:budgetState.operationExhausted,tokenAccounting:budgetState.tokenAccounting });
        break;
      }
      for (const unit of units) attemptedUnits.add(unit.id);
      const assignedRisks = qualityEnabled ? risksForReviewBatch(qualityState,units,{followUp:riskFollowUp}) : [];
      const riskInstructions = qualityEnabled ? JSON.stringify(assignedRisks.map(r=>({
        id:r.id,question:r.question,impact:r.impact,sourceRefs:r.sourceRefs,
        relatedUnitIds:r.relatedUnitIds,status:r.status}))) : '[]';
      if (riskFollowUp) qualityState.followUps++;
      // Never accept a checkpointed conclusion after concurrent scope drift.
      const beforeBatch = await captureRepoState(repoRoot);
      const beforeDrift = workspaceReconciliationDiff(reviewWorkspaceBaseline, beforeBatch);
      if (beforeDrift.changed) {
        coverageProblems.push('Repository changed before next review unit; remaining work was not run.');
        await emit(reporter, { type: 'review_workspace_drift', changedPaths: beforeDrift.changedPaths,
          gitFields: beforeDrift.gitFields, action: 'preserved' });
        break;
      }
      const batchId = `${riskFollowUp ? 'risk_follow_up' : units.map((u) => u.id).join('_')}_${reviewReports.length + 1}`;
      const assignment = units.map(({ id, kind, description, paths, changes, criterionIds, subsystem, dependencies, relatedUnits }) =>
        `${id}: ${description}\n  type=${kind}\n  subsystem=${subsystem}\n  criterionIds=${criterionIds.join(',') || '(none)'}\n  prerequisites=${(dependencies ?? []).join(',') || '(none)'}\n  relatedUnits=${(relatedUnits ?? []).join(',') || '(none)'}\n  requiredPaths=${JSON.stringify(paths)}\n  changes=${JSON.stringify(changes ?? [])}`).join('\n');
      const targetedHandoff = efficiencyStrategy ? reviewBatchEvidenceHandoff(
        units, workPlan, checkedRecords, reviewReports) : null;
      const handoff = targetedHandoff?.text ?? priorReviewHandoff(checkedRecords, reviewReports);
      if (targetedHandoff) await emit(reporter, {type:'review_evidence_handoff',
        relevant:targetedHandoff.relevantEvidence,
        omittedUnrelated:targetedHandoff.unrelatedEvidenceOmitted,
        characters:handoff.length});
      await emit(reporter, { type: 'review_batch_start', batch: batchIndex + 1, total: reviewWorkPolicy.batchLimit,
        maxBatchesPerRun: reviewWorkPolicy.batchLimit, assignedUnits: units.length,
        remainingUnits: workPlan.totalUnits - checkedRecords.length - units.length, riskFollowUp,
        ids: units.map((unit) => unit.id), previousBatches: reviewReports.length,
        priorEvidenceCharacters: handoff.length });
      for (const unit of units) await emit(reporter, { type: 'review_unit_started', unitId: unit.id });
      const scopedExploration = efficiencyStrategy
        ? (hintedExploration?.text ?? promptValue(exploration)).slice(0, 3500)
        : (hintedExploration?.text ?? promptValue(exploration));
      const scopedPlan = efficiencyStrategy ? JSON.stringify({
        steps: (plan?.steps ?? []).slice(0, 8), acceptanceCriteria: (plan?.acceptanceCriteria ?? []).slice(0, 8),
      }) : planPromptText(plan);
      const batchPrompt = trackedBody`TASK MODE: review (READ ONLY)\nUSER TASK AND AUTHORITATIVE SCOPE:\n${contextPart('user_task',modelTask)}\n\nPLAN (supporting context, never a reason to narrow explicit user scope):\n${contextPart('plan',scopedPlan)}\n\nENGINEERING FRAME:\n${contextPart('engineering_frame',engineeringFrameText(plan))}\n\nREPOSITORY EXPLORATION:\n${contextPart('exploration',scopedExploration)}\n\nVERIFICATION:\n${contextPart('verification',verification.length ? verificationText(verification) : '(not run)')}\n\nPRIOR REVIEW EVIDENCE (model-reported; not independently verified):\n${contextPart('review',handoff)}\n\nVERIFIED GIT SOURCE REVISIONS (or unresolved reason):\n${contextPart('review', reviewGitContext)}\n\nREVIEW WORK BATCH ${batchIndex + 1} (limit ${reviewWorkPolicy.batchLimit} batches per run). Assigned UNITS:\n${assignment}\n\n${qualityEnabled ? `REVIEW RISK OBLIGATIONS (source-anchored questions, NOT known defects):\n${riskInstructions}\nFor each risk you actually assess, provide riskAssessments[{riskId,status,outcome,evidence,sourceRefs}]. Status investigated requires outcome issue_found or no_issue_supported, concrete source evidence, and coverage of its related Units. If an issue is found, emit an atomic issue entry with a matching source path. State blocked+uncertain when evidence is unavailable; do not invent a resolution. Preserve significant unexamined hypotheses as openQuestions[{statement,sourceRefs,relatedUnitIds,materiality}]; do not emit generic or duplicate speculations. A checked file Unit does NOT imply risks were resolved. Follow source dependencies and consumers where behavior warrants it; do not substitute a fixed number of tool calls for evidence.\n` : ''}\n${riskFollowUp ? 'RISK-ONLY FOLLOW-UP: resolve only the specified open material risks. Coverage must be an EMPTY array; no already checked Unit can be re-certified here.\n' : ''}\nReturn scopedReview JSON. Coverage must contain exactly the assigned UNIT IDs once each. For a file-group, inspect EVERY requiredPaths entry and return reviewedPaths as an array containing EXACTLY those paths ONLY if actually inspected; provide fileEvidence with a distinct concrete path/evidence item for EVERY required file. Do not guess. For criterion units, reviewedPaths may be empty. Every checked unit needs concrete evidence (files, code behavior, or executed commands), otherwise mark not_checked or blocked. Do not mark a unit checked if only some required paths were inspected. These units are independent of the original S/A criteria; the orchestrator aggregates coverage. Report concrete findings even if unfinished. Report one reproducible root cause per issue and preserve related observations as evidence; use stable contractId/reproductionKey plus failureMode/affectedBehavior only when grounded; don't invent identifiers. Inventory {changedFiles,reviewedFiles,source} is required by the schema; use null counts when not verifiable, never guess. Never claim that model-reported cumulative inventory alone proves file coverage. No repository edits. Avoid repeating completed investigation without reason; revisit source when a material unresolved risk, conflicting evidence, changed assumptions, or independent verification justifies it. Reuse applicable evidence, but independently inspect source when necessary; prioritize NEW unverified risks. If a criterion is assigned with its prerequisite source file unit in this batch, return separate evidence for both and mark the criterion checked only if the source was actually inspected.\n\nReturn scopedReview JSON.`;
      // Optional bounded *historical* Review context. Mandatory role, task,
      // skill and project instructions are composed by callOnce unchanged.
      const reviewContextMode = config.policy?.reviewEfficiency?.contextMode ?? 'legacy';
      const historyLimit = config.policy?.reviewEfficiency?.maxHistoryCharacters ?? 10000;
      const activeHistory = reviewContextMode === 'bounded_history' && runtimeRoleOptions.roleSessionContext
        ? runtimeRoleOptions.roleSessionContext(policy.reviewer)
        : runtimeRoleOptions.contextComposition?.sessionHistoryText;
      const boundedHistory = boundedReviewHistory(activeHistory, {
        task:sourceReviewTask,maxCharacters:historyLimit,mode:reviewContextMode});
      const reviewerContextOptions = boundedHistory.reduced ? {
        ...runtimeRoleOptions,
        contextComposition:{...runtimeRoleOptions.contextComposition,sessionHistoryText:boundedHistory.text},
        roleSessionContext:runtimeRoleOptions.roleSessionContext
          ? role => role === policy.reviewer ? boundedHistory.text : runtimeRoleOptions.roleSessionContext(role)
          : null,
      } : runtimeRoleOptions;
      const reviewerContextText = boundedHistory.reduced && !runtimeRoleOptions.roleSessionContext
        ? [runtimeRoleOptions.stableContext,
          `OUTER CONVERSATION CONTEXT:
${boundedHistory.text}`].filter(Boolean).join('\n\n') : contextText;
      if (boundedHistory.reduced) await emit(reporter,{type:'review_history_bounded',
        savedCharacters:boundedHistory.savedCharacters,reason:boundedHistory.reason});
      let reviewed;
      executionBudget.observe(); // attempts count even if the provider fails; tokens remain unknown.
      try {
        reviewed = await call(
          registry, policy.reviewer, 'scopedReview', repoRoot, batchPrompt,
          { contextText: reviewerContextText, reporter: reviewToolReporter, ...reviewerContextOptions, sandboxMode: 'read-only', signal, taskPlan: null,
            bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:scopedPlan},
              {kind:'engineering_frame',value:engineeringFrameText(plan)},
              {kind:'exploration',value:scopedExploration},
              {kind:'verification',value:verification.length ? verificationText(verification) : '(not run)'},
              {kind:'review',value:handoff}],
            executionScope:{phase:'review',reviewBatch:batchIndex+1} },
        );
      } catch (error) {
        if (signal?.aborted || isExpectedCancellation(error)) throw error;
        interrupted = { batch: batchIndex + 1, code: error?.code ?? error?.cancellationReason ?? 'ROLE_FAILED',
          message: String(error?.message ?? error).slice(0, 1000) };
        for (const unit of units) await emit(reporter, { type: 'review_unit_interrupted', unitId: unit.id, code: interrupted.code });
        await persistReviewCheckpoint();
        coverageProblems.push(`Batch ${batchIndex + 1} interrupted (${interrupted.code}): ${interrupted.message}`);
        await emit(reporter, { type: 'review_batch_interrupted', ...interrupted });
        break;
      }
      runs.push(reviewed.run);
      const afterBatch = await captureRepoState(repoRoot);
      const batchDrift = workspaceReconciliationDiff(reviewWorkspaceBaseline, afterBatch);
      if (batchDrift.changed) {
        coverageProblems.push(`Repository changed after batch ${batchIndex + 1}; results discarded and remaining work stopped.`);
        await emit(reporter, { type: 'review_workspace_drift', changedPaths: batchDrift.changedPaths,
          gitFields: batchDrift.gitFields, action: 'preserved' });
        break;
      }
      if (await reviewSourceMoved(afterBatch)) {
        coverageProblems.push('The Git review base or selected commit set changed during a batch; new evidence discarded.');
        await emit(reporter, { type: 'review_scope_invalidated', reason: 'git_revision_changed' });
        break;
      }
      const assessment = assessReviewUnits(units, reviewed);
      const verified = assessment.records.filter((record) => record.status === 'checked');
      const allowed = new Set(checkedRecords.map(row => row.id));
      for (let index = 0; index < verified.length; index++) {
        const unit = workPlan.units.find(row => row.id === verified[index].id);
        if (unit?.dependencies.every(id => allowed.has(id))) allowed.add(unit.id);
      }
      // Repeat until all valid prerequisites are resolved, regardless of row
      // ordering. Dependent conclusions lacking valid evidence stay pending.
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const record of verified) {
          const unit = workPlan.units.find(row => row.id === record.id);
          if (!allowed.has(record.id) && unit?.dependencies.every(id => allowed.has(id))) {
            allowed.add(record.id); progressed = true;
          }
        }
      }
      const accepted = verified.filter(record => allowed.has(record.id));
      if (accepted.length !== verified.length) coverageProblems.push('Dependent review evidence rejected: prerequisite not verified.');
      checkedRecords.push(...accepted);
      if (qualityEnabled && reviewed.outputFormat === 'structured') {
        const qualityResult = applyReviewRiskReport(qualityState, reviewed.output, {
          plan:workPlan, assignedRisks, unitIds:units.map(u=>u.id),
          completedUnitIds:checkedRecords.map(r=>r.id),
        });
        qualityState = qualityResult.state;
        if (qualityResult.problems.length) {
          // Only allowlisted diagnostic *codes*. No source references, risk IDs,
          // prompts, private paths or model-authored evidence enter telemetry.
          const known = new Set(['contradictory_evidence','unsupported_risk_assessment',
            'missing_finding','unassigned_or_duplicate_risk','requires_independent_conflict_resolution',
            'risk_capacity_exhausted']);
          const reasonCounts = {};
          for (const problem of qualityResult.problems) {
            const suffix = String(problem).split(':').at(-1).trim();
            const reason = known.has(suffix) ? suffix : 'other_rejected_evidence';
            reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
          }
          await emit(reporter,{type:'review_quality_evidence_rejected',
            count:qualityResult.problems.length,reasonCounts});
        }
      }
      const evidenceProjection = projectReviewEvidence({ plan: workPlan, records: checkedRecords,
        reports: reviewReports, sourceKey: baselineKey });
      await emit(reporter, { type: 'review_evidence_progress',
        records: evidenceProjection.evidence.length, obligationsSatisfied: evidenceProjection.obligations.filter(x => x.status === 'satisfied').length });
      // Retain findings from a completed batch even if some assignments were
      // unchecked. Never make unchecked evidence authoritative.
      const normalizedOutput = reviewed.outputFormat === 'structured' ? reviewed.output : null;
      if (normalizedOutput && (verified.length || normalizedOutput.issues?.length || riskFollowUp ||
          (qualityEnabled && ((normalizedOutput.riskAssessments?.length ?? 0) || (normalizedOutput.openQuestions?.length ?? 0))))) {
        const existing = reviewReports.find((report) =>
          report.unitIds.length === units.length && report.unitIds.every((id, index) => id === units[index].id));
        if (existing) {
          // Repeated incomplete attempts must not discard earlier findings or
          // create an unbounded succession of identical checkpoint reports.
          existing.output = mergeReviewAttempt(existing, normalizedOutput,
            {batchId,unitIds:units.map(unit=>unit.id)});
        } else {
          // Attempt provenance belongs to the orchestration, never a model
          // field supplied inside a structured finding.
          const cleanIssues=(normalizedOutput.issues ?? []).map(({reportedBatchId:_batch,
            reportedUnitIds:_units,...claim})=>claim);
          reviewReports.push({ batchId, unitIds: units.map((unit) => unit.id),
            ...(riskFollowUp ? { kind:'risk_follow_up' } : {}),
            outputFormat: 'structured', output: {...normalizedOutput,issues:cleanIssues} });
        }
      }
      completedBatches.push(batchId);
      for (const unit of units) await emit(reporter, { type: 'review_unit_completed', unitId: unit.id,
        checked: accepted.some((r) => r.id === unit.id) });
      await persistReviewCheckpoint();
      const stall = progressGuard.observe({ assigned: units.length, verified: accepted.length,
        problems: assessment.problems, outputFormat: reviewed.outputFormat });
      await emit(reporter, { type: 'review_batch_done', batch: batchIndex + 1, total: reviewWorkPolicy.batchLimit,
        maxBatchesPerRun: reviewWorkPolicy.batchLimit,
        checked: accepted.length, assigned: units.length, incomplete: assessment.problems.length });
      if (riskFollowUp) {
        // One bounded targeted continuation per policy; it cannot satisfy Units.
        if (assessReviewQuality(qualityState,{mode:qualityMode}).open === 0) break;
        continue;
      }
      if (stall.blocked) {
        coverageProblems.push(`Review stopped early: ${stall.reason}. Assigned Units remain pending for continuation.`);
        await emit(reporter, { type: 'review_progress_blocked', reason: stall.reason, consecutiveBatches: stall.consecutiveBatches });
        break;
      }
      // Unchecked Units remain pending for a later invocation, not an implicit
      // retry inside this same run. Earlier verified Units stay durable.
    }
    if (scope.available && contract.expectedFileCount !== null && contract.expectedFileCount !== scope.total) {
      coverageProblems.push(`Requested file count ${contract.expectedFileCount} differs from verified Git manifest ${scope.total}.`);
    }
    const reviewWorkspaceAfter = await captureRepoState(repoRoot);
    const reviewDrift = workspaceReconciliationDiff(reviewWorkspaceBaseline, reviewWorkspaceAfter);
    if (await reviewSourceMoved(reviewWorkspaceAfter)) {
      coverageProblems.push('The selected Git source changed while review evidence was collected; re-evaluate the scope.');
      await emit(reporter, { type: 'review_scope_invalidated', reason: 'git_revision_changed' });
    }
    if (reviewDrift.changed) {
      coverageProblems.push(`Repository changed during review; evidence may be stale.`);
      await emit(reporter, { type: 'review_workspace_drift', changedPaths: reviewDrift.changedPaths,
        gitFields: reviewDrift.gitFields, action: 'preserved' });
    }
    const evidenceGraph = projectReviewEvidence({ plan: workPlan, records: checkedRecords, reports: reviewReports, sourceKey: baselineKey });
    const availableReviewChecks = config.policy?.verificationEfficiency?.autoExecute === true && !activeReviewTarget
      ? await configuredVerificationCommands(repoRoot) : [];
    // Only the host-configured AND operator-approved commands may influence
    // scheduling. Unapproved configured commands are not a model suggestion
    // to execute checks and never become eligible by a naming heuristic.
    const approvedReviewCommands = config.policy?.verificationEfficiency?.safeCommands ?? [];
    const eligibleReviewCommands = availableReviewChecks.map(args => args.join(' '))
      .filter(command => approvedReviewCommands.includes(command));
    const verificationDecision = chooseVerification({ obligations: evidenceGraph.obligations,
      evidence:evidenceGraph.evidence, availableCommands:eligibleReviewCommands,
      risk: reviewWorkload.riskFlags });
    if (config.policy?.verificationEfficiency?.autoExecute === true && !activeReviewTarget) {
      try {
        const approved = approvedReviewCommands;
        const candidate = eligibleReviewCommands[0];
        // A Git/source fingerprint alone is insufficient for test reuse:
        // the host-owned complete input closure also fingerprints dependency
        // files and environment. Unknown closures disable cache reuse.
        const closure = candidate ? configuredVerificationInputClosures()[candidate] : null;
        const binding = closure ? await witnessVerificationInputs(repoRoot,closure) : null;
        const bindingDigest = binding?.kind === 'paths' && binding.completeness === 'complete'
          ? createHash('sha256').update(JSON.stringify(binding)).digest('hex') : null;
        const cached = reusableReviewVerification(reviewVerificationObservations, {
          sourceKey:baselineKey, command:candidate, approvedCommands:approved,inputDigest:bindingDigest });
        // Reuse only host-observed PASS from the matching Review Operation,
        // source snapshot, security-scoped mirror and still-approved command.
        const decisionResult = cached ? {disposition:'reused_verified',observations:[cached]} :
          await executeVerificationDecision({decision:verificationDecision,
            configuredCommands:availableReviewChecks,
            approvedCommands:approved,
            sourceKey:baselineKey, invocationId:operation.id, allowed:true,
            run: async (commands) => await runWorkflowVerification(repoRoot, reporter, signal,
              {security:config.security,onlyCommands:commands,phase:'targeted'})});
        if (!cached) reviewVerificationObservations.push(...validatedReviewObservations(
          decisionResult.observations,baselineKey));
        await emit(reporter,{type:'review_targeted_verification',disposition:decisionResult.disposition,
          observations:decisionResult.observations.length,
          passed:decisionResult.observations.filter(x => x.passed).length});
        if (decisionResult.observations.some(x => !x.passed))
          coverageProblems.push('Targeted verification failed or could not be confirmed.');
        const afterVerification = await captureRepoState(repoRoot);
        if (workspaceReconciliationDiff(reviewWorkspaceBaseline,afterVerification).changed)
          coverageProblems.push('Workspace changed during targeted verification; review evidence cannot establish complete coverage.');
        else if (!cached && reviewVerificationObservations.length) await persistReviewCheckpoint();
      } catch (error) {
        coverageProblems.push('Targeted verification was unavailable or unsafe to execute.');
        await emit(reporter,{type:'review_targeted_verification',disposition:'unavailable',observations:0});
      }
    }
    const reviewCoverage = reviewWorkCoverage(contract, workPlan, checkedRecords, coverageProblems);
    const budgetEnd=executionBudget.disposition();
    await emit(reporter,{type:'review_budget_snapshot',segments:budgetEnd.segments,
      segmentInvocations:budgetEnd.invocations,operationInvocations:budgetEnd.operationInvocations,
      segmentExhausted:budgetEnd.segmentExhausted,operationExhausted:budgetEnd.operationExhausted,
      tokenAccounting:budgetEnd.tokenAccounting});
    const qualityAssessment = qualityEnabled ? assessReviewQuality(qualityState,{
      mode:qualityMode,coverageComplete:reviewCoverage.complete}) : null;
    if (qualityAssessment) await emit(reporter,{
      type:'review_quality_assessed',mode:qualityMode,...qualityAssessment});
    const qualityComplete = !qualityAssessment || qualityAssessment.status !== 'incomplete';
    const overallComplete = reviewCoverage.complete && qualityComplete;
    if (!qualityComplete) {
      reviewCoverage.complete = false;
      reviewCoverage.gapCodes.push('MATERIAL_RISK_UNRESOLVED');
      reviewCoverage.gaps.push(...qualityAssessment.openRiskIds.map(id => {
        const risk=qualityState.risks.find(r=>r.id===id);
        return `${id}: ${String(risk?.question ?? 'material risk unresolved').slice(0,240)}`;
      }));
      if (qualityAssessment.coverageOverflow) reviewCoverage.gaps.push('Risk coverage exceeded bounded review plan; split the review scope.');
    }
    await emit(reporter, { type: 'review_verification_decision', strategy: verificationDecision.strategy,
      outstanding: verificationDecision.obligationIds.length, reason: verificationDecision.reason });
    if (overallComplete && !interrupted) await persistReviewCheckpoint('finished');
    else if (reviewCoverage.units.pending === 0 && reviewCoverage.scope.blocked) {
      await emit(reporter, { type: 'review_scope_resolution_required', reason: reviewCoverage.scope.reason,
        status: reviewCoverage.scope.status, unresolved: reviewCoverage.scope.unresolvedChanges,
        verified: reviewCoverage.units.verified });
    }
    else if (reviewCoverage.units.pending > 0 || !qualityComplete) await emit(reporter, { type: 'review_continuation_ready',
      verified: reviewCoverage.units.verified, pending: reviewCoverage.units.pending,
      durable: checkpointSaved && !!onReviewCheckpoint });
    const individualReviews = reviewReports.map((report) => {
      const normalized = normalizeReview(report);
      return normalized && typeof normalized === 'object' && typeof normalized.verdict === 'string'
        ? normalized
        : { verdict: 'unknown', summary: 'Reviewer result missing or inconsistent.', issues: [] };
    });
    const review = {
      verdict: individualReviews.some((entry) => entry.verdict === 'escalate') ? 'escalate'
        : individualReviews.some((entry) => entry.verdict === 'fix' || entry.issues?.length) ? 'fix'
          : individualReviews.length === 0 || individualReviews.some((entry) => entry.verdict !== 'pass') ? 'unknown' : 'pass',
      summary: individualReviews.map((entry, i) => `Batch ${i + 1}: ${entry.summary}`).join('\n'),
      issues: reconcileReviewFindings(reviewReports.flatMap((report) => (report.output.issues ?? [])
        .map((issue) => ({ ...issue, batchId: issue.reportedBatchId ?? report.batchId,
          unitIds: issue.reportedUnitIds ?? report.unitIds })))).issues,
      batches: individualReviews.map(({ verdict, summary, issues }) => ({ verdict, summary, issues })),
    };
    const findingObservations = reviewReports.flatMap((report) => (report.output.issues ?? [])
      .map((issue) => ({ ...issue, batchId: issue.reportedBatchId ?? report.batchId,
          unitIds: issue.reportedUnitIds ?? report.unitIds })));
    let findingsReport = reconcileReviewFindings(findingObservations);
    const semanticCandidates = findingHypothesisGroups(findingObservations);
    // An optional trusted host may independently verify ambiguous semantic
    // equivalence. No new LLM invocation and no model-authored witness digest
    // may authorize merging unrelated findings. The source checkpoint remains
    // unchanged; this affects only the derived presentation registry.
    if (typeof onReviewFindingAdjudication === 'function' && semanticCandidates.length) {
      try {
        const adjudication = await onReviewFindingAdjudication({
          operationId:operation.id, scopeKey:reviewScopeKey, sourceKey:baselineKey,
          candidates:semanticCandidates, ledger:findingsReport.ledger });
        if (Array.isArray(adjudication?.decisions)) {
          const reconciled = adjudicateReviewFindings(findingObservations,adjudication.decisions,
            {scopeKey:reviewScopeKey,sourceKey:baselineKey,
              verifiedWitnesses:adjudication.verifiedWitnesses});
          const newlyMerged = findingsReport.unique - reconciled.unique;
          findingsReport = reconciled;
          await emit(reporter,{type:'review_semantic_adjudicated',
            merged:newlyMerged,rejected:reconciled.rejected.length});
        }
      } catch {
        await emit(reporter,{type:'review_semantic_adjudication_unavailable',reason:'trusted_host_failure'});
      }
    }
    review.issues = findingsReport.issues;
    await emit(reporter, { type: 'review_semantic_candidates', groups: semanticCandidates.length,
      candidates: semanticCandidates.reduce((n,g) => n + g.count,0) });
    const verificationEvidence = reviewVerificationEvidence(verification, reviewToolEvidence.snapshot());
    const progress = reviewProgressSnapshot(reviewCoverage, { batches: completedBatches.length, maxBatches: reviewWorkPolicy.batchLimit });
    await emit(reporter, { type: 'review_progress', progress, rawFindings: findingsReport.raw,
      uniqueFindings: findingsReport.unique, reconciledFindings: findingsReport.reconciledDuplicates,
      potentialDuplicates: findingsReport.potentialDuplicates,
      verificationSource: verificationEvidence.source,
      observedExecuteCalls: verificationEvidence.observedExecuteCalls });
    await emit(reporter, { type: 'review_coverage', coverage: reviewCoverage });

    let finalValidation = null;
    if (review.verdict === 'escalate' || (review.verdict === 'unknown' && reviewCoverage.complete)) {
      const validated = await call(
        registry, 'finalValidator', 'finalValidation', repoRoot,
        trackedBody`TASK MODE: review\nUSER TASK:\n${contextPart('user_task',modelTask)}\n\nPLAN:\n${contextPart('plan',planPromptText(plan))}\n\nREVIEW COVERAGE:\n${contextPart('review',json(reviewCoverage))}\n\nREVIEW TO VALIDATE:\n${contextPart('review',json(review))}\n\nNo repository edits are permitted. Resolve substantive concerns, not missing checklist evidence. A validator cannot mark unexamined scope complete.`,
        { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
          bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},{kind:'review',value:json(review)}],
          executionScope:{phase:'validation'} },
      );
      runs.push(validated.run);
      finalValidation = normalizeFinalValidation(validated);
    }
    const unresolvedReview = finalValidation?.verdict === 'unknown' || (review.verdict === 'unknown' && !finalValidation);
    const hasFindings = review.verdict === 'fix' || review.issues.length > 0 || finalValidation?.verdict === 'fix';
    const status = !reviewCoverage.complete ? 'review_incomplete'
      : unresolvedReview ? 'review_unresolved' : hasFindings ? 'review_findings' : 'review_passed';
    if (efficiencyStrategy?.skipRedundantResponder)
      await emit(reporter, { type: 'review_role_bypassed', role: 'responder', reason: 'deterministic_findings_report' });
    const response = efficiencyStrategy?.skipRedundantResponder
      ? { text: '', streamed: false, error: null }
      : await produceUserResponse({
      registry, role: policy.responder, repoRoot, contextText, reporter, runtimeRoleOptions, signal,
      // Incomplete output needs a deterministic coverage warning; streaming a
      // misleading premature verdict would make that impossible.
      streamFinalResponse: false, runs,
      bodySources:[{kind:'user_task',value:modelTask},{kind:'exploration',value:hintedExploration?.text ?? promptValue(exploration)},
        {kind:'review',value:json(review)},{kind:'verification',value:verification.length ? verificationText(verification) : '(not run)'}],
      body: trackedBody`TASK MODE: review\nUSER TASK:\n${contextPart('user_task',modelTask)}\n\nREPOSITORY EXPLORATION:\n${contextPart('exploration',hintedExploration?.text ?? promptValue(exploration))}\n\nMACHINE REVIEW DECISION:\n${contextPart('review',json(review))}\n\nREVIEW COVERAGE (authoritative for completion):\n${contextPart('review',json(reviewCoverage))}\n\nFINAL VALIDATION:\n${contextPart('review',json(finalValidation))}\n\nVERIFICATION EVIDENCE (authoritative):\n${contextPart('verification',json(verificationEvidence))}\n\nVERIFICATION:\n${contextPart('verification',verification.length ? verificationText(verification) : '(not run)')}\n\nREVIEW STATUS: ${status}\n\nIf review_incomplete, explicitly report unexamined scope; no production-readiness claim is permitted. Preserve the active skill's required report headings. Distinguish confirmed findings from unchecked scenarios. Never state a numeric count of passed tests as verified without authoritative evidence; model-reported tool results are not such evidence. State the number of distinct findings in the machine review decision and do not silently omit any. Give the final review response in clear Markdown; do not edit files.`,
    });
    const gapText = reviewCoverage.gaps.slice(0, 12).map((gap) => `- ${gap}`).join('\n');
    const warning = `**Ревью не завершено:** подтверждено ${reviewCoverage.checked} из ${reviewCoverage.total} пунктов. Отсутствие найденных дефектов не означает готовность к production.\n\nНепроверенное покрытие:\n${gapText}${reviewCoverage.gaps.length > 12 ? `\n- …ещё ${reviewCoverage.gaps.length - 12}` : ''}\n\n`;
    // The model is allowed to provide a short narrative but never owns the
    // authoritative finding list. Rendering comes from the durable ledger only.
    // The responder may summarize the review, but arbitrary generated text
    // cannot be certified as a list of findings and is not inserted as such.
    // Findings are rendered from the authoritative ledger, not responder prose.
    // The legacy responder remains supported for compatibility; its narration
    // cannot add unverified findings or override the completion verdict.
    const summaryParagraphs = String(review.summary ?? '').replace(/[\r\n]+/g,' ').trim();
    const reportedSummary = summaryParagraphs.length > 700
      ? (summaryParagraphs.slice(0,701).match(/^([\s\S]*[.!?。])(?:\s|$)/)?.[1] ?? summaryParagraphs.slice(0,697).trimEnd()+'…')
      : summaryParagraphs;
    const resolvedLocations=await resolveReviewFindingLocations(findingsReport.ledger,repoRoot,
      {sourceKind:activeReviewTarget?'commit':'worktree'});
    await emit(reporter,{type:'review_source_locations',resolved:[...resolvedLocations.values()].filter(v=>v?.url).length,
      total:resolvedLocations.size});
    const summary = `${status === 'review_incomplete' ? warning : ''}` +
      `${reviewCoverage.complete ? 'Ревью завершено.' : 'Ревью требует продолжения.'} ` +
      `Канонических записей о проблемах: ${findingsReport.unique} (наблюдений: ${findingsReport.raw}, объединений по идентичности: ${findingsReport.exactIdentityMerges}, host-подтверждённых семантических объединений: ${findingsReport.semanticMerges}, возможных пар дубликатов: ${findingsReport.potentialDuplicates}). ` +
      `Обработано ${reviewCoverage.units.verified} из ${reviewCoverage.units.total} Review Units.` +
      `${reportedSummary ? `\n\nНаблюдения reviewer (не независимая верификация): ${reportedSummary}` : ''}`;
    const positive = 'Положительные стороны реализации не выделены в структурированных свидетельствах. ' +
      `Покрытие ревью: ${reviewCoverage.units.verified} из ${reviewCoverage.units.total} Review Units; ` +
      'это не подтверждение выполнения тестов.';
    const responseText = renderReviewSections({
      'Краткое резюме': summary,
      'Что хорошо': positive,
      'Замечания и проблемы': renderReviewFindings(findingsReport.ledger,{locations:resolvedLocations}),
      'Рекомендации улучшений':reviewCoverage.complete
        ? 'Устранить обоснованные замечания, подтвердить их поведение целевыми проверками там, где они необходимы.'
        : 'Продолжить сохранённую проверку через «Продолжи ревью», затем устранить найденные дефекты.',
    }, {skill:invocationContext.skill, supplementarySections: {
      // A skill may request an Evidence section, but it must be generated from
      // authoritative coverage/verification state, never from responder prose.
      Evidence: `Покрытие, принятое по структурированным отчётам reviewer: ${reviewCoverage.units.verified} из ${reviewCoverage.units.total} Review Units. ` +
        `Источник данных о проверках: ${verificationEvidence.source}; ` +
        `workflow-проверок: ${verificationEvidence.confirmedChecks}, успешных: ${verificationEvidence.passedChecks}. ` +
        'Структурированные замечания и связанные с ними свидетельства приведены в разделе «Замечания и проблемы». ' +
        'Утверждений о количестве пройденных тестов без независимых свидетельств нет.',
    }});
    const renderedIds = new Set(findingsReport.ledger.map((row) => row.findingId));
    await emit(reporter, { type: 'review_report_validated', operationId: operation.id,
      reported: renderedIds.size, required: findingsReport.unique });
    const result = {
      status,
      route: { classification, policy }, exploration, plan, plannerOutput, review, reviewCoverage, reviewProgress: progress, reviewFindingsReport: { ...findingsReport, reported: renderedIds.size }, verificationEvidence, finalValidation, verification, reviewTarget: activeReviewTarget, reviewOperationId: operation.id, reviewQuality:qualityAssessment, executionStrategy: efficiencyStrategy?.name ?? 'legacy',
      activeSkill: invocationContext.skill ? { name: invocationContext.skill.name, scope: invocationContext.skill.scope, path: invocationContext.skill.path } : null,
      responseText, responseStreamed: response.streamed, responseError: response.error,
      diff: '', planCompleted: reviewCoverage.complete && !unresolvedReview, runs,
      reviewLimits: { maxBatches: reviewWorkPolicy.batchLimit, repairAttemptsUsed: 0, completedBatches: completedBatches.length,
        budget:executionBudget.disposition(),
        verifiedUnits: reviewCoverage.units.verified, pendingUnits: reviewCoverage.units.pending, checkpointDurable: checkpointSaved && !!onReviewCheckpoint },
      ...(interrupted ? { reviewInterruption: interrupted } : {}),
    };
    await emit(reporter, { type: 'complete', result });
    return result;
  }

  // Persist every new Change Plan BEFORE preparation or any coder edits.
  // Otherwise a failed later stage can leave an orphan checkpoint that is
  // impossible to resume. The session owner archives any older task atomically.
  if (policy.mode === 'change' && !authoritativePlan) {
    const durablePlan = normalizeImplementationPlan(plan);
    if (durablePlan && onImplementationPlan) {
      const planState = await captureRepoState(repoRoot);
      await onImplementationPlan({
        version: 1, repoRoot, planId: planDigest(durablePlan), plan: durablePlan,
        repoKey: repositoryFingerprint(planState), repoSnapshot: snapshotImplementationRepo(planState),
        taskSpec:classification.task??null,
      });
      await emit(reporter, { type: 'implementation_plan_saved', planId: planDigest(durablePlan) });
    }
  }

  // A saved Plan is authoritative, but not an assertion that the checkout
  // still matches its assumptions. Stop before preparation or writing when
  // those assumptions have gone stale; never silently replan over them.
  if (authoritativePlan && repositoryFingerprint(await captureRepoState(repoRoot)) !== (authoritativePlan.reconciledRepoKey ?? authoritativePlan.repoKey)
      && !validateImplementationCheckpoint(implementationCheckpoint, {
        planId: authoritativePlan.planId,
        scopeKey: authoritativePlan.planId,
        repoKey: repositoryFingerprint(await captureRepoState(repoRoot)),
        stages: buildImplementationStages(plan),
      })) {
    const result = {
      status: 'implementation_incomplete', route: { classification, policy }, exploration, plan, plannerOutput,
      responseText: 'The checkout has changed since the saved Plan (or the saved implementation checkpoint is invalid). No implementation was started. Review/update the Plan or explicitly reconcile the changed workspace first.',
      planCompleted: false, runs, implementationCoverage: { complete: false, reason: 'stale_plan_or_checkpoint' },
    };
    await emit(reporter, { type: 'complete', result });
    return result;
  }

  // Everything observed during routing/exploration/planning is a live-workspace
  // baseline, not an edit attributable to the coder. Refresh immediately before
  // the first mutating stage so concurrent editor/watcher drift is not charged to
  // implementation and does not trip stale Git metadata checks later.
  const executionBaseline = await captureRepoState(repoRoot);
  const gitDrift = [];
  const noteGitDrift = async (stage, before, after) => {
    const event = await emitGitDrift(reporter, stage, before, after);
    if (event) gitDrift.push(event);
  };
  const onVerificationGitDrift = async (event) => { gitDrift.push(event); };

  // Preparation and verification scripts can mutate files too. Check the
  // provider-owned write boundary before ANY writable project operation.
  assertPreWriteBoundary([classification.task, authoritativePlan?.taskSpec]);
  await emit(reporter, { type: 'coding_workspace_ready', workspace: repoRoot, sourceRepo: repoRoot, purpose: 'change', mode: 'real-workspace' });

  const preparationDeniedBaseline = await captureDeniedPathBaseline(repoRoot, config.security);
  const preparationStateBefore = await captureRepoState(repoRoot);
  const prep = await runPreparation(repoRoot, { signal });
  const preparationStateAfter = await captureRepoState(repoRoot);
  const preparationChangedPaths = changedPathsBetweenStates(preparationStateBefore, preparationStateAfter);
  const deniedAfterPreparation = await deniedMutations(repoRoot, config.security, preparationDeniedBaseline, preparationChangedPaths);
  if (deniedAfterPreparation.length) {
    await restoreDeniedPaths(repoRoot, deniedAfterPreparation, config.security, preparationDeniedBaseline);
  }
  await noteGitDrift('preparation', preparationStateBefore, preparationStateAfter);
  if (deniedAfterPreparation.length) {
    throw new Error(`Project preparation modified security-denied path(s): ${deniedAfterPreparation.join(', ')}. Those paths were restored to their pre-preparation state; other workspace edits were preserved.`);
  }
  assertTaskWriteScopes(preparationChangedPaths, [classification.task, authoritativePlan?.taskSpec]);
  if (preparationChangedPaths.length) {
    assertChangedPathsSafe(preparationChangedPaths, config.security);
    await emit(reporter, {
      type: 'workspace_mutations', stage: 'Preparation', reportedFiles: [],
      unreportedFiles: preparationChangedPaths, reportedButUnchanged: [], actionMismatch: false,
      actualFiles: preparationChangedPaths,
    });
  }
  if (prep.length) {
    const prepVerification = prep.map((item) => ({ ...item, status: item.status ?? (item.ok ? 'PASS' : 'ENVIRONMENT_ERROR') }));
    const prepDisposition = verificationDisposition(prepVerification);
    await emit(reporter, { type: 'preparation_done', results: prepVerification, disposition: prepDisposition });
    if (!checksPass(prepVerification)) {
      const response = await produceUserResponse({
        registry, role: policy.responder, repoRoot, contextText, reporter, runtimeRoleOptions, signal, streamFinalResponse, runs,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'verification',value:verificationText(prepVerification)}],
        body: `TASK MODE: change\nUSER TASK:\n${modelTask}\n\nThe workflow could not safely proceed to implementation because project preparation/tooling checks were unavailable or failed. No coder edits were applied. Preparation may have produced the project-artifact changes listed below.\n\nPREPARATION CHANGED PATHS:\n${json(preparationChangedPaths)}\n\nPREPARATION RESULTS:\n${verificationText(prepVerification)}\n\nExplain the current state and the useful next step to the user. Do not edit files.`,
      });
      const result = {
        status: 'completed_with_unverified_checks', route: { classification, policy }, exploration, plan, plannerOutput,
        review: null, finalValidation: null, verification: prepVerification, gitMetadataDrift: gitDrift,
        responseText: response.text, responseStreamed: response.streamed, responseError: response.error,
        reviewTarget: activeReviewTarget, diff: preparationStateAfter.diff,
        changedPaths: changedPathsBetweenStates(executionBaseline, preparationStateAfter), planCompleted: false, runs,
      };
      await emit(reporter, { type: 'complete', result });
      return result;
    }
  }

  // A checkout can drift between the initial Plan check and the first
  // mutating stage (e.g. an editor or preparation command). Never silently
  // restart from I1 with an empty checkpoint in that case.
  if (authoritativePlan) {
    const expectedKey = implementationCheckpoint?.repoKey ?? authoritativePlan.reconciledRepoKey ?? authoritativePlan.repoKey;
    if (repositoryFingerprint(preparationStateAfter) !== expectedKey) {
      const result = { status: 'implementation_incomplete', route: { classification, policy }, exploration, plan,
        responseText: 'The checkout changed after the saved Plan/checkpoint was checked, before coding began. No coder was run; completed stages remain preserved. Request explicit reconciliation again.',
        implementationCoverage: { complete: false, reason: 'pre_write_checkout_drift' },
        planCompleted: false, runs };
      await emit(reporter, { type: 'complete', result });
      return result;
    }
  }

  // Phase 2: independently re-read the P2 Quality projection immediately
  // before any workspace write. Its evidence/finding state informs continuing
  // stages and review, but it never replaces the workflow checkpoint authority.
  let recoveryAssessment = null;
  if (authoritativePlan && onRecoveryAssessment) {
    recoveryAssessment = await onRecoveryAssessment();
    const afterAssessment = await captureRepoState(repoRoot);
    if (repositoryFingerprint(afterAssessment) !== repositoryFingerprint(preparationStateAfter)) {
      const result = { status: 'implementation_incomplete', planCompleted: false, runs,
        responseText: 'Checkout changed during the read-only recovery preflight. No coder was started; reassess the workspace.',
        implementationCoverage: { complete: false, reason: 'recovery_preflight_drift' } };
      await emit(reporter, { type: 'complete', result });
      return result;
    }
    if (recoveryAssessment?.blockers?.length) {
      const result = { status: 'implementation_incomplete', planCompleted: false, runs,
        responseText: `Recovery blocked by saved task state: ${recoveryAssessment.blockers.join(', ')}. No coder was started.`,
        implementationCoverage: { complete: false, reason: 'recovery_state_blocked' } };
      await emit(reporter, { type: 'complete', result });
      return result;
    }
    await emit(reporter, { type: 'quality_recovery_assessed',
      completedStages: recoveryAssessment?.completedStages?.length ?? 0,
      staleEvidence: recoveryAssessment?.staleEvidenceIds?.length ?? 0,
      unknownEvidence: recoveryAssessment?.unknownEvidenceIds?.length ?? 0,
      findings: recoveryAssessment?.unresolvedFindings?.length ?? 0 });
  }
  // Only run targeted diagnostics when incomplete saved implementation will
  // actually resume. A resumed review goes straight to its mandatory verifier;
  // repeating the same checks twice would only add cost. The selected commands
  // come from trusted local verification configuration, never model text.
  let targetedRevalidation = null;
  if (authoritativePlan && recoveryAssessment?.revalidationTargets?.length &&
      implementationCheckpoint &&
      (implementationCheckpoint.completedStages?.length ?? 0) < buildImplementationStages(plan).length) {
    const selection = await planTargetedRevalidation(repoRoot, recoveryAssessment.revalidationTargets);
    if (selection.mode === 'targeted' && selection.commands.some((cmd) =>
      Object.hasOwn(configuredVerificationPolicies(), cmd))) {
      // Advisory recovery is read-only. An effectful configured analyzer must
      // not be invoked here: let the normal mandatory verification own its
      // declared mutations after implementation, rather than causing an
      // avoidable checkout-drift failure before coder can resume.
      targetedRevalidation = { selection, disposition: 'SKIPPED_EFFECTFUL', results: [] };
      await emit(reporter, { type: 'quality_targeted_revalidation',
        commands: selection.commands, disposition: 'SKIPPED_EFFECTFUL' });
    } else if (selection.mode === 'targeted') {
      const rechecked = await runWorkflowVerification(repoRoot, reporter, signal, {
        security: config.security, allowWorkspaceMutations: false, onAttemptStart: onVerificationAttempt,
        onlyCommands: selection.commands, phase: 'targeted_recovery',
      });
      targetedRevalidation = { selection, results: rechecked.results, disposition: rechecked.disposition };
      await onRevalidationResult?.({ status: 'targeted_revalidation', verification: rechecked.results,
        verificationRepoKey: repositoryFingerprint(rechecked.state),
        verificationWorkspaceChanged: rechecked.unexpectedPaths.length > 0 || !rechecked.expectedEffects, verificationAttempt: rechecked.attempt });
      await emit(reporter, { type: 'quality_targeted_revalidation',
        commands: selection.commands, disposition: rechecked.disposition });
    }
  }
  const preCoderState = preparationStateAfter;
  const stages = plan?.steps?.length >= 4 || authoritativePlan ? buildImplementationStages(plan) : [];
  const staged = stages.length > 0;
  const implementationPlanId = plan ? planDigest(plan) : null;
  const stageScopeKey = implementationPlanId;
  let stageCheckpoint = null;
  let implementationCoverage = null;
  let implementation = null;
  let currentState = preparationStateAfter;
  let stepChangedPaths = [];

  if (staged) {
    const checkpointKey = repositoryFingerprint(preparationStateAfter);
    const canResume = validateImplementationCheckpoint(implementationCheckpoint, {
      planId: implementationPlanId, scopeKey: stageScopeKey, repoKey: checkpointKey, stages,
    });
    if (implementationCheckpoint && !canResume) {
      const result = { status: 'implementation_incomplete', route: { classification, policy }, exploration, plan,
        responseText: 'Saved implementation checkpoint is inconsistent with the current stage state. It has NOT been replaced or reset; no coder was run.',
        implementationCoverage: { complete: false, reason: 'checkpoint_not_reusable' },
        planCompleted: false, runs };
      await emit(reporter, { type: 'complete', result });
      return result;
    }
    stageCheckpoint = canResume ? structuredClone(implementationCheckpoint) : {
      version: 1, planId: implementationPlanId, scopeKey: stageScopeKey,
      repoKey: checkpointKey, repoSnapshot: snapshotImplementationRepo(preparationStateAfter), completedStages: [], records: [], reports: [], status: 'in_progress',
    };
    if (canResume) await emit(reporter, { type: 'implementation_checkpoint_resumed', completed: stageCheckpoint.completedStages.length, completedStepIds: stageCheckpoint.records.map((row) => row.id), total: stages.length });
    else if (implementationCheckpoint) await emit(reporter, { type: 'implementation_checkpoint_rejected', reason: 'plan_or_workspace_changed' });

    const persistStage = async (status = 'in_progress') => {
      stageCheckpoint.status = status;
      stageCheckpoint.repoKey = repositoryFingerprint(currentState);
      stageCheckpoint.repoSnapshot = snapshotImplementationRepo(currentState);
      await onImplementationCheckpoint?.(structuredClone(stageCheckpoint));
    };
    for (const [index, stage] of stages.entries()) {
      if (index < stageCheckpoint.completedStages.length) continue;
      throwIfAborted(signal);
      const budgetDisposition = taskBudget?.disposition();
      if (budgetDisposition?.exhausted) {
        stageCheckpoint.interruptedStage = stage.id;
        stageCheckpoint.interruption = {stage:stage.id,reason:'execution_budget_exhausted',
          problems:['Configured execution budget exhausted before the next stage.'],observedChangedPaths:[]};
        await persistStage('interrupted');
        await emit(reporter,{type:'execution_budget_paused',reason:budgetDisposition.reasons[0],
          invocations:budgetDisposition.invocations,tokenAccounting:budgetDisposition.tokenAccounting});
        const result={status:'implementation_incomplete',route:{classification,policy},exploration,plan,
          implementationCoverage:{complete:false,records:stageCheckpoint.records,stage:stage.id,
            reason:'execution_budget_exhausted'},
          responseText:`Execution budget exhausted before ${stage.id}. Completed stages are durable; the current stage was not started. Resume the saved plan/checkpoint to continue.`,
          planCompleted:false,runs};
        await emit(reporter,{type:'complete',result});
        return result;
      }
      const beforeStage = await captureRepoState(repoRoot);
      if (repositoryFingerprint(beforeStage) !== stageCheckpoint.repoKey) {
        stageCheckpoint.interruptedStage = stage.id;
        stageCheckpoint.status = 'interrupted';
        stageCheckpoint.status = 'interrupted';
        await onImplementationCheckpoint?.(structuredClone(stageCheckpoint)); // Preserve old repoKey: drift is NOT reconciled.
        await emit(reporter, { type: 'implementation_stage_interrupted', stage: stage.id, reason: 'workspace_drift' });
        const result = { status: 'implementation_incomplete', route: { classification, policy }, exploration, plan,
          implementationCoverage: { complete: false, records: stageCheckpoint.records, reason: 'workspace_drift' },
          responseText: `Implementation stopped before ${stage.id}: the checkout changed outside the previous completed stage. Existing changes were preserved.`,
          planCompleted: false, runs, changedPaths: changedPathsBetweenStates(executionBaseline, beforeStage) };
        await emit(reporter, { type: 'complete', result });
        return result;
      }
      await emit(reporter, { type: 'implementation_stage_start', stage: stage.id, index: index + 1, total: stages.length, steps: stage.steps });
      const stageContext = config.policy?.workflowEfficiency?.compactImplementationContext === true
        ? compactImplementationHandoff(stageCheckpoint) : null;
      if (stageContext) await emit(reporter, { type:'implementation_context_compacted', characters:stageContext.length });
      const deniedBaseline = await captureDeniedPathBaseline(repoRoot, config.security);
      const stagePolicies = configuredVerificationPolicies();
      const allowedStageCommands = new Map((await configuredVerificationCommands(repoRoot))
        .map((args) => [args.join(' '), args]));
      const stageReportBaselines = new Map();
      for (const [name, policy] of Object.entries(stagePolicies)) {
        if (allowedStageCommands.has(name)) {
          stageReportBaselines.set(name, await witnessDiagnosticReports(repoRoot, policy));
        }
      }
      let coded;
      let stageError = null;
      try {
        coded = await call(registry, policy.coder, 'stagedImplementation', repoRoot,
          trackedBody`TASK MODE: change; STAGE ${index + 1}/${stages.length} (${stage.id})\nUSER TASK:\n${contextPart('user_task',modelTask)}\n\nAUTHORITATIVE PLAN:\n${contextPart('plan',planPromptText(plan))}\n\nTASK WRITE SCOPE:\n${json(classification.task?.constraints?.writeScope ?? authoritativePlan?.taskSpec?.constraints?.writeScope ?? 'unspecified')}\nEXCLUDED PATHS:\n${json(classification.task?.constraints?.excludedPaths ?? authoritativePlan?.taskSpec?.constraints?.excludedPaths ?? [])}\nQUALITY EVIDENCE OBLIGATIONS (not measured code coverage):\n${json(testCoverageEvidence)}\n\nCURRENT STAGE ONLY:\n${contextPart('implementation',json(stage.steps))}\n\nCOMPLETED STAGES (context; do not repeat them):\n${contextPart('implementation',stageContext ?? json(stageCheckpoint.records))}\n\nPERSISTED QUALITY / RECOVERY (read-only assessment; stale/unknown evidence is NOT verification):\n${contextPart('quality_recovery',json(recoveryAssessment))}\n\nTARGETED RECOVERY CHECKS (observed, diagnostic only; final full verification still mandatory):\n${contextPart('verification',json(targetedRevalidation))}\n\nPREVIOUS STAGE REPORTS:\n${contextPart('implementation',stageContext ? '(included in compact completed-stage summary)' : json(stageCheckpoint.reports.slice(-3)))}\n\n${stageCheckpoint.interruptedStage === stage.id ? 'THIS STAGE PREVIOUSLY STOPPED AFTER POSSIBLE PARTIAL EDITS. Inspect and reconcile existing changes before performing any additional work. Do not blindly replay mutations.\n\n' : ''}ENGINEERING FRAME:\n${contextPart('engineering_frame',engineeringFrameText(plan))}\n\nWork in the real checkout. Implement only assigned stage requirements plus necessary cross-cutting dependencies. Do not mark other steps completed. Return one stepResults row per assigned step with concrete evidence. For code changes use status=implemented, proofKind=change. For a verification-only step which made no code changes, use proofKind=verification and provide checks with each actually executed command, outcome=passed/failed/unavailable and concrete evidence; for a non-mutating analysis use proofKind=analysis. The status already_satisfied is valid only if requirements really hold. A failing or unavailable check MUST be reported as such, never disguised as passed. Verification steps need no new diff, but unverified claims cannot be marked complete. Never modify Git metadata or unrelated files; preserve user edits. If blocked, report blocked rather than claiming completion.`,
          { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'workspace-write', taskWriteSpecs: [classification.task, authoritativePlan?.taskSpec], signal, taskPlan: null,
            bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},
              {kind:'quality_recovery',value:json(recoveryAssessment)},{kind:'engineering_frame',value:engineeringFrameText(plan)}],
            executionScope:{phase:'implementation',stageId:stage.id} });
        runs.push(coded.run);
      } catch (error) {
        stageError = error;
      }
      currentState = await captureRepoState(repoRoot);
      stepChangedPaths = changedPathsBetweenStates(beforeStage, currentState);
      const denied = await deniedMutations(repoRoot, config.security, deniedBaseline, stepChangedPaths);
      if (denied.length) await restoreDeniedPaths(repoRoot, denied, config.security, deniedBaseline);
      await noteGitDrift(`coder:${stage.id}`, beforeStage, currentState);
      if (denied.length) throw new Error(`Stage ${stage.id} modified denied paths: ${denied.join(', ')}. Denied paths were restored; other changes preserved.`);
      assertChangedPathsSafe(stepChangedPaths, config.security);
      assertTaskWriteScopes(stepChangedPaths, [classification.task, authoritativePlan?.taskSpec]);
      const report = coded ? normalizeImplementation(coded, stepChangedPaths) : null;
      // A model's nonzero-code interpretation is not an observed domain failure.
      // Only rerun a policy-declared command that is ALSO in the operator's
      // configured mandatory verifier; never execute arbitrary model commands.
      if (report && !stageError && coded?.outputFormat === 'structured') {
        const allowedCommands = allowedStageCommands;
        const toRecheck = new Map();
        for (const row of report.stepResults ?? []) for (const check of row.checks ?? []) {
          if (check.outcome === 'failed' && Object.hasOwn(stagePolicies, check.command) && allowedCommands.has(check.command)) {
            toRecheck.set(check.command, allowedCommands.get(check.command));
          }
        }
        for (const [name, args] of toRecheck) {
          const beforeRecheck = await captureRepoState(repoRoot);
          const observed = await runVerificationCommand(repoRoot, args, { signal, policies: stagePolicies,
            timeoutMs: Number(process.env.AGENT_VERIFY_TIMEOUT_MS ?? 300_000) });
          const afterRecheck = await captureRepoState(repoRoot);
          const paths = changedPathsBetweenStates(beforeRecheck, afterRecheck);
          currentState = afterRecheck;
          stepChangedPaths = changedPathsBetweenStates(beforeStage, currentState);
          const protectedChanges = await deniedMutations(repoRoot, config.security, deniedBaseline, paths);
          if (protectedChanges.length) {
            await restoreDeniedPaths(repoRoot, protectedChanges, config.security, deniedBaseline);
            throw new Error(`Stage verification touched denied paths: ${protectedChanges.join(', ')}`);
          }
          assertChangedPathsSafe(paths, config.security);
          assertTaskWriteScopes(paths, [classification.task, authoritativePlan?.taskSpec]);
          const compatible = expectedReportEffects([observed], paths,
            !gitMetadataDiff(beforeRecheck, afterRecheck).fields.some((f) => ['HEAD', 'headRef', 'index'].includes(f)));
          await emit(reporter, { type: 'verification_done', phase: 'stage_semantic_recheck',
            disposition: observed.status, semanticOutcome: observed.diagnostic?.outcome ?? 'unknown',
            expectedEffects: compatible, changedPaths: paths });
          // The coder may have refreshed reports before our observation. Compare
          // with the pre-stage baseline too; a second run returning 0 cannot
          // erase a newly introduced diagnostic regression.
          const fromStageStart = assessDiagnosticDelta(stageReportBaselines.get(name),
            await witnessDiagnosticReports(repoRoot, stagePolicies[name]), stagePolicies[name],
            observed.exitCode, { timedOut: observed.timedOut, signal: observed.signal,
              completionVerified: observed.diagnostic?.completionVerified === true });
          const observedExecValid = observed.status === 'PASS' || (
            observed.exitCode != null && stagePolicies[name].acceptedExitCodes.includes(observed.exitCode) &&
            observed.diagnostic?.outcome === 'unchanged' && observed.diagnostic?.completionVerified === true &&
            fromStageStart.outcome === 'improved');
          if (!observedExecValid || !compatible || !fromStageStart.accepted) continue;
          for (const row of report.stepResults ?? []) for (const check of row.checks ?? []) {
            if (check.command === name && check.outcome === 'failed') {
              check.outcome = 'passed';
              check.evidence = `${String(check.evidence ?? '').slice(0, 500)}; Independently rerun by host: ${fromStageStart.outcome} (added ${fromStageStart.added}, removed ${fromStageStart.removed}); observed exit ${observed.exitCode}`;
            }
          }
        }
      }
      const assessed = assessImplementationStage(stage, report, coded?.outputFormat, { changedPaths: stepChangedPaths });
      const lightweight = stepChangedPaths.length && !stageError
        ? await execFileSafe('git', ['diff', '--check', '--', ...stepChangedPaths], { cwd: repoRoot, signal, allowFailure: true, timeoutMs: 30_000 })
        : null;
      if (lightweight && (lightweight.code !== 0 || lightweight.timedOut)) assessed.issues.push(`git diff --check failed for ${stage.id}: ${String(lightweight.stderr || lightweight.stdout).slice(0, 700)}`);
      const gitSemanticDrift = gitMetadataDiff(beforeStage, currentState).fields.some((field) => ['HEAD', 'headRef', 'index'].includes(field));
      const stageComplete = !stageError && !assessed.issues.length && !gitSemanticDrift;
      const stageFailureReason = stageError?.code ?? (gitSemanticDrift ? 'git_drift'
        : assessed.issues.some((issue) => issue.includes('verification_failed') || issue.includes('git diff --check failed')) ? 'verification_failed'
          : assessed.issues.some((issue) => issue.includes('verification_unavailable')) ? 'verification_unavailable'
            : 'invalid_stage_evidence');
      if (!stageComplete) {
        stageCheckpoint.interruptedStage = stage.id;
        stageCheckpoint.interruption = {
          stage: stage.id,
          reason: stageFailureReason,
          problems: assessed.issues.slice(0, 30),
          observedChangedPaths: stepChangedPaths.slice(0, 100),
        };
        await persistStage('interrupted');
        if (signal?.aborted && stageError) throw stageError; // Preserve typed outer cancellation semantics.
        await emit(reporter, { type: 'implementation_stage_interrupted', stage: stage.id,
          reason: stageFailureReason, problems: assessed.issues });
        const result = {
          status: 'implementation_incomplete', route: { classification, policy }, exploration, plan,
          implementationCoverage: { complete: false, records: stageCheckpoint.records, stage: stage.id, reason: stageFailureReason, gaps: assessed.issues },
          responseText: `Implementation stopped at ${stage.id}/${stages.length}. Completed stages: ${stageCheckpoint.completedStages.length}. ${stageError ? `Provider error: ${String(stageError.code ?? stageError.message)}. ` : ''}Problems: ${assessed.issues.length ? assessed.issues.slice(0, 8).join('; ') : 'stage interrupted by Git drift or provider failure'}. Current-stage edits have been preserved, but not marked complete. No automatic retry was attempted. Inspect/reconcile the workspace before requesting continuation.`,
          changedPaths: changedPathsBetweenStates(executionBaseline, currentState), planCompleted: false, runs,
        };
        await emit(reporter, { type: 'complete', result });
        return result;
      }
      stageCheckpoint.interruptedStage = null;
      delete stageCheckpoint.interruption;
      stageCheckpoint.completedStages.push(stage.id);
      stageCheckpoint.records.push(...assessed.records);
      stageCheckpoint.reports.push({ stage: stage.id, summary: report.summary, changedPaths: stepChangedPaths, notes: report.notes });
      implementation = report;
      await persistStage();
      await emit(reporter, { type: 'implementation_stage_done', stage: stage.id, index: index + 1, total: stages.length,
        completedSteps: assessed.records.length, completedStepIds: assessed.records.map((row) => row.id), changedPaths: stepChangedPaths });
    }
    implementationCoverage = { complete: stageCheckpoint.completedStages.length === stages.length,
      records: stageCheckpoint.records, completedStages: stageCheckpoint.completedStages, totalStages: stages.length };
    implementation = { action: changedPathsBetweenStates(preCoderState, currentState).length ? 'changed' : 'no_change',
      summary: stageCheckpoint.reports.map((row) => `${row.stage}: ${row.summary}`).join('\n'),
      changedFiles: [...new Set(stageCheckpoint.reports.flatMap((row) => row.changedPaths ?? []))], notes: [] };
  } else {
  const coderDeniedBaseline = await captureDeniedPathBaseline(repoRoot, config.security);

  const coded = await call(
    registry, policy.coder, 'implementation', repoRoot,
    `TASK MODE: change\nUSER TASK:\n${modelTask}\n\nEXPLORATION:\n${hintedExploration?.text ?? promptValue(exploration)}\n\nPLAN:\n${planPromptText(plan)}\n\nENGINEERING FRAME:\n${engineeringFrameText(plan)}\n\nQUALITY EVIDENCE OBLIGATIONS:\n${json(testCoverageEvidence)}\n\nTASK WRITE SCOPE (semantic restriction; do not broaden):\n${json(classification.task?.constraints?.writeScope ?? authoritativePlan?.taskSpec?.constraints?.writeScope ?? 'unspecified')}\nEXCLUDED PATHS:\n${json(classification.task?.constraints?.excludedPaths ?? authoritativePlan?.taskSpec?.constraints?.excludedPaths ?? [])}\n\nPROJECT WORKSPACE:\n- Edit files directly in the current real project workspace.\n- Existing dependencies and package-manager workspace state are available in place.\n- Preserve unrelated pre-existing user/editor changes.\n- Never commit, push, rebase, reset, change refs, or modify .git.\n- Security-denied paths must not be written.`,
    { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'workspace-write', taskWriteSpecs: [classification.task, authoritativePlan?.taskSpec], signal, taskPlan: plan.steps,
      bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},
        {kind:'exploration',value:hintedExploration?.text ?? promptValue(exploration)},{kind:'engineering_frame',value:engineeringFrameText(plan)}],
      executionScope:{phase:'implementation'} },
  );
  runs.push(coded.run);
  currentState = await captureRepoState(repoRoot);
  stepChangedPaths = changedPathsBetweenStates(preCoderState, currentState);
  const deniedAfterCoder = await deniedMutations(repoRoot, config.security, coderDeniedBaseline, stepChangedPaths);
  if (deniedAfterCoder.length) await restoreDeniedPaths(repoRoot, deniedAfterCoder, config.security, coderDeniedBaseline);
  await noteGitDrift('coder', preCoderState, currentState);
  if (deniedAfterCoder.length) {
    throw new Error(`Coder attempted to modify security-denied path(s): ${deniedAfterCoder.join(', ')}. Those paths were restored to their pre-coder state; other workspace edits were preserved.`);
  }
  assertChangedPathsSafe(stepChangedPaths, config.security);
  assertTaskWriteScopes(stepChangedPaths, [classification.task, authoritativePlan?.taskSpec]);
  implementation = normalizeImplementation(coded, stepChangedPaths);
  const coderMutationReport = compareImplementationReportToWorkspace(implementation, stepChangedPaths);
  await emit(reporter, { type: 'workspace_mutations', stage: 'Coder', ...coderMutationReport, actualFiles: stepChangedPaths });

  }
  let checked = await runWorkflowVerification(repoRoot, reporter, signal, { allowWorkspaceMutations: true, security: config.security, onAttemptStart: onVerificationAttempt, onGitDrift: onVerificationGitDrift });
  assertTaskWriteScopes(checked.changedPaths, [classification.task, authoritativePlan?.taskSpec]);
  if (checked.changedPaths.length) {
    await emit(reporter, { type: 'workspace_mutations', stage: 'verification', reportedFiles: [], unreportedFiles: checked.changedPaths, reportedButUnchanged: [], actionMismatch: false, actualFiles: checked.changedPaths });
  }
  let verification = checked.results;
  let verificationRepoKey = repositoryFingerprint(checked.state);
  let verificationAttempt = checked.attempt;
  let verificationWorkspaceChanged = checked.unexpectedPaths.length > 0 || !checked.expectedEffects;
  let disposition = checked.disposition;
  currentState = checked.state;
  let diff = currentState.diff;
  let changedPaths = changedPathsBetweenStates(executionBaseline, currentState);
  let review = null;
  let finalValidation = null;
  let round = 0;
  const assessScopeFix = async (input) => {
    const decision = assessFixDecision(input);
    if (decision.action !== 'approval_required' || !decision.findings?.length || !onApprovedFindings) return decision;
    const authorized = new Set(await onApprovedFindings()); // freshly bound to checkout
    if (!decision.findings.every((issue) => authorized.has(findingIdentity(issue)))) return decision;
    return { ...decision, action: 'fix', reason: 'explicit_state_bound_remediation_approval' };
  };
  let fixDecision = null;

  try {
  while (true) {
    const reviewed = await call(
      registry, policy.reviewer, staged || onQualityAssessment ? 'implementationReview' : 'review', repoRoot,
      trackedBody`TASK MODE: change\nUSER TASK:\n${contextPart('user_task',modelTask)}\n\nPLAN:\n${contextPart('plan',planPromptText(plan))}\n\nENGINEERING FRAME:\n${contextPart('engineering_frame',engineeringFrameText(plan))}\n\nFILES CHANGED SINCE WORKFLOW START:\n${json(changedPaths)}\n\nBASELINE WORKING DIFF (pre-existing before the coder ran):\n${contextPart('working_diff',executionBaseline.diff || '(clean baseline)')}\n\nCURRENT WORKING DIFF:\n${contextPart('working_diff',diff || '(no diff)')}\n\nVERIFICATION (${disposition}):\n${contextPart('verification',verificationText(verification))}\n\nGIT METADATA CHANGE OBSERVATIONS:\n${contextPart('git_reconciliation',gitDriftEvidence(gitDrift))}\n\n${staged || onQualityAssessment ? `ACCEPTANCE CRITERIA (verify every A-ID independently):\n${json(plan.acceptanceCriteria.map((criterion, index) => ({ id: `A${index + 1}`, criterion })))}\n\nSTAGE IMPLEMENTATION EVIDENCE:\n${contextPart('implementation',json(implementationCoverage))}\n\nPERSISTED OPEN FINDINGS AND RECOVERY LIMITS (historical; verify freshness against current checkout):\n${contextPart('quality_recovery',json(recoveryAssessment))}\n\nUSER/EXTERNAL CHANGE RECONCILIATIONS (independently revalidate affected behavior; this is not proof of correctness):\n${json(stageCheckpoint?.reconciliationHistory ?? [])}\n\nReturn acceptanceResults for every A-ID. Where the Plan specifies acceptanceChecks, cite the exact observed command(s) if they actually ran and meaningfully exercise the criterion; a generic unrelated PASS is not enough. For source-inspection-only criteria, if the Plan supplies acceptanceReviews, return sourceAnchors with a path and an EXACT 12–300-character excerpt taken from each specified file. The orchestrator independently checks that those excerpts really exist in these files. An anchor proves source provenance, not behavioral correctness; report verified only when your independent semantic review genuinely supports the criterion. Without suitable evidence, report blocked/not_verified; do not invent executions.\n\n` : ''}Review the requested change proactively, including meaningful related and pre-existing defects. Report them with evidence even if fixing them is outside the user's task. Do not treat remediation scope as a limit on discovery. The repository is the real user workspace; preserve and distinguish pre-existing editor changes from changes made during this workflow. Choose any additional evidence needed for the review yourself.`,
      { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},
          {kind:'engineering_frame',value:engineeringFrameText(plan)},
          {kind:'working_diff',value:diff || '(no diff)'},
          {kind:'verification',value:verificationText(verification)},
          {kind:'review',value:json(review)},
          {kind:'quality_recovery',value:json(recoveryAssessment)}],
        },
    );
    runs.push(reviewed.run);
    review = normalizeReview(reviewed);

    if (review.verdict === 'escalate' || review.verdict === 'unknown') {
      const validated = await call(
        registry, 'finalValidator', 'finalValidation', repoRoot,
        trackedBody`TASK MODE: change\nUSER TASK:\n${contextPart('user_task',modelTask)}\n\nPLAN:\n${contextPart('plan',planPromptText(plan))}\n\nENGINEERING FRAME:\n${contextPart('engineering_frame',engineeringFrameText(plan))}\n\nFILES CHANGED SINCE WORKFLOW START:\n${json(changedPaths)}\n\nBASELINE WORKING DIFF:\n${contextPart('working_diff',executionBaseline.diff || '(clean baseline)')}\n\nCURRENT WORKING DIFF:\n${contextPart('working_diff',diff || '(no diff)')}\n\nVERIFICATION (${disposition}):\n${contextPart('verification',verificationText(verification))}\n\nGIT METADATA CHANGE OBSERVATIONS:\n${contextPart('git_reconciliation',gitDriftEvidence(gitDrift))}\n\nINDEPENDENT REVIEW:\n${contextPart('review',json(review))}\n\nPERSISTED QUALITY / RECOVERY (independently revalidate open findings and stale evidence):\n${contextPart('quality_recovery',json(recoveryAssessment))}\n\n${findingAssessmentInstructions}`,
        { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},
          {kind:'engineering_frame',value:engineeringFrameText(plan)},
          {kind:'working_diff',value:diff || '(no diff)'},
          {kind:'verification',value:verificationText(verification)},
          {kind:'review',value:json(review)},
          {kind:'quality_recovery',value:json(recoveryAssessment)}],
        },
      );
      runs.push(validated.run);
      finalValidation = normalizeFinalValidation(validated);
    } else if (review.verdict === 'pass' && policy.finalValidation) {
      const validated = await call(
        registry, 'finalValidator', 'finalValidation', repoRoot,
        trackedBody`TASK MODE: change\nUSER TASK:\n${contextPart('user_task',modelTask)}\n\nPLAN:\n${contextPart('plan',planPromptText(plan))}\n\nENGINEERING FRAME:\n${contextPart('engineering_frame',engineeringFrameText(plan))}\n\nFILES CHANGED SINCE WORKFLOW START:\n${json(changedPaths)}\n\nBASELINE WORKING DIFF:\n${contextPart('working_diff',executionBaseline.diff || '(clean baseline)')}\n\nCURRENT WORKING DIFF:\n${contextPart('working_diff',diff || '(no diff)')}\n\nVERIFICATION (${disposition}):\n${contextPart('verification',verificationText(verification))}\n\nGIT METADATA CHANGE OBSERVATIONS:\n${contextPart('git_reconciliation',gitDriftEvidence(gitDrift))}\n\nINDEPENDENT REVIEW:\n${contextPart('review',json(review))}\n\nPERSISTED QUALITY / RECOVERY (independently revalidate open findings and stale evidence):\n${contextPart('quality_recovery',json(recoveryAssessment))}\n\n${findingAssessmentInstructions}`,
        { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},
          {kind:'engineering_frame',value:engineeringFrameText(plan)},
          {kind:'working_diff',value:diff || '(no diff)'},
          {kind:'verification',value:verificationText(verification)},
          {kind:'review',value:json(review)},
          {kind:'quality_recovery',value:json(recoveryAssessment)}],
        },
      );
      runs.push(validated.run);
      finalValidation = normalizeFinalValidation(validated);
    }

    // A failing configured check needs a scope-aware independent assessment,
    // even when the reviewer passed and high-risk validation was not selected.
    if ((disposition === 'CODE_FAILURE' || (review.verdict === 'fix' &&
      review.issues?.some((issue) => issue.remediationScope === 'outside_scope'))) && !finalValidation) {
      const validated = await call(
        registry, 'finalValidator', 'finalValidation', repoRoot,
        trackedBody`TASK MODE: change\nUSER TASK:\n${contextPart('user_task',modelTask)}\n\nPLAN:\n${contextPart('plan',planPromptText(plan))}\n\nCURRENT WORKING DIFF:\n${contextPart('working_diff',diff || '(no diff)')}\n\nBASELINE WORKING DIFF:\n${contextPart('working_diff',executionBaseline.diff || '(clean baseline)')}\n\nVERIFICATION (${disposition}):\n${contextPart('verification',verificationText(verification))}\n\nINDEPENDENT REVIEW:\n${contextPart('review',json(review))}\n\nPERSISTED QUALITY / RECOVERY (independently revalidate open findings and stale evidence):\n${contextPart('quality_recovery',json(recoveryAssessment))}\n\n${findingAssessmentInstructions}`,
        { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},
          {kind:'engineering_frame',value:engineeringFrameText(plan)},
          {kind:'working_diff',value:diff || '(no diff)'},
          {kind:'verification',value:verificationText(verification)},
          {kind:'review',value:json(review)},
          {kind:'quality_recovery',value:json(recoveryAssessment)}],
        },
      );
      runs.push(validated.run);
      finalValidation = normalizeFinalValidation(validated);
    }

    fixDecision = await assessScopeFix({ review, finalValidation, verificationDisposition: disposition });
    if (fixDecision.action === 'none') break;
    if (fixDecision.action === 'approval_required' || fixDecision.action === 'report_only') {
      await emit(reporter, { type: 'fix_resolution', decision: fixDecision.action, reason: fixDecision.reason });
      break;
    }

    if (round >= config.policy.maxFixRounds) {
      fixDecision = { ...fixDecision, action: 'fix_round_limit', reason: 'bounded_fix_rounds_exhausted' };
      await emit(reporter, { type: 'fix_resolution', decision: fixDecision.action, reason: fixDecision.reason });
      break;
    }
    round++;
    const reviewImpact = assessReviewImpact({ changedPaths, dependencyClosureComplete: false, findings: review.issues ?? [] });
    await emit(reporter, { type: 'efficiency_review_impact', mode: reviewImpact.mode, reason: reviewImpact.reasons[0] });
    await emit(reporter, { type: 'fix_round', round, maxRounds: config.policy.maxFixRounds, review, finalValidation, verificationDisposition: disposition });

    const beforeFix = currentState;
    const fixerDeniedBaseline = await captureDeniedPathBaseline(repoRoot, config.security);
    const fixed = await call(
      registry, policy.coder, 'implementation', repoRoot,
      `TASK MODE: change\nUSER TASK:\n${modelTask}\n\nPLAN:\n${planPromptText(plan)}\n\nENGINEERING FRAME:\n${engineeringFrameText(plan)}\n\nFILES CHANGED SINCE WORKFLOW START:\n${json(changedPaths)}\n\nCURRENT WORKING DIFF:\n${diff || '(no diff)'}\n\nREVIEW:\n${json(review)}\n\nFINAL VALIDATION:\n${json(finalValidation)}\n\nVERIFICATION (${disposition}):\n${verificationText(verification)}\n\nGIT METADATA CHANGE OBSERVATIONS:\n${gitDriftEvidence(gitDrift)}\n\nUSER REMEDIATION AUTHORIZATION FOR THIS FIX ROUND:\n${fixDecision.reason === 'explicit_state_bound_remediation_approval'
        ? `The user explicitly approved remediation for exactly these findings in this checkout: ${json(fixDecision.findings)}. This is NOT blanket write authorization and does not bypass tool permissions or security-denied paths.`
        : 'No additional scope expansion is authorized.'}

Fix only issues justified by the user's original task or the explicit authorization above. Investigate serious additional defects and report them, but do not silently expand scope or weaken failing regression tests. If a fix is outside authorized scope, return no_change with an explicit explanation. Preserve unrelated pre-existing user/editor changes.`,
      { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'workspace-write', taskWriteSpecs: [classification.task, authoritativePlan?.taskSpec], signal, taskPlan: plan.steps,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},
          {kind:'engineering_frame',value:engineeringFrameText(plan)},{kind:'working_diff',value:diff || '(no diff)'},
          {kind:'verification',value:verificationText(verification)},{kind:'review',value:json(review)}],
        executionScope:{phase:'fix',fixRound:round} },
    );
    runs.push(fixed.run);
    let afterFix = await captureRepoState(repoRoot);
    stepChangedPaths = changedPathsBetweenStates(beforeFix, afterFix);
    const deniedFix = await deniedMutations(repoRoot, config.security, fixerDeniedBaseline, stepChangedPaths);
    if (deniedFix.length) await restoreDeniedPaths(repoRoot, deniedFix, config.security, fixerDeniedBaseline);
    await noteGitDrift('fixer', beforeFix, afterFix);
    if (deniedFix.length) {
      throw new Error(`Fixer attempted to modify security-denied path(s): ${deniedFix.join(', ')}. Those paths were restored to their pre-fix state; other workspace edits were preserved.`);
    }
    assertChangedPathsSafe(stepChangedPaths, config.security);
    assertTaskWriteScopes(stepChangedPaths, [classification.task, authoritativePlan?.taskSpec]);
    implementation = normalizeImplementation(fixed, stepChangedPaths);
    const fixerMutationReport = compareImplementationReportToWorkspace(implementation, stepChangedPaths);
    await emit(reporter, { type: 'workspace_mutations', stage: 'Fixer', ...fixerMutationReport, actualFiles: stepChangedPaths });

    if (implementation.action === 'no_change') {
      // Keep the existing one-shot independent adjudication and no-op stop.
      // Efficiency policy observes the lack of repository progress but NEVER
      // labels that alone a model failure or authorizes another model.
      const progress = assessRetryProgress({ checkoutFingerprint: repositoryFingerprint(beforeFix),
        evidenceRevision: disposition, findingRevision: review.verdict, blockerCode: fixDecision.reason,
        strategyId: policy.coder, observationDigest: verification.map(x => x.status).join('|') },
      { checkoutFingerprint: repositoryFingerprint(afterFix),
        evidenceRevision: disposition, findingRevision: review.verdict, blockerCode: fixDecision.reason,
        strategyId: policy.coder, observationDigest: verification.map(x => x.status).join('|') });
      await emit(reporter, { type: 'efficiency_retry_assessed', role: policy.coder, state: progress.state,
        reason: progress.reasons[0], recommendation: suggestRoleEscalation({ role: policy.coder,
          failureCode: 'NO_CHANGE', progress, samples: 0 }).action });
      // If the first independent validator already evaluated the same checkout,
      // review and verification evidence, repeating it after a no-op coder adds
      // no new evidence. Only adjudicate when there was no prior validation.
      if (shouldReuseNoopValidation({previousValidation:finalValidation,
        beforeRepoKey:repositoryFingerprint(beforeFix),afterRepoKey:repositoryFingerprint(afterFix)})) {
        await emit(reporter,{type:'efficiency_validation_reused',reason:'no_checkout_or_verification_change'});
      } else {
      const validated = await call(
        registry, 'finalValidator', 'finalValidation', repoRoot,
        trackedBody`TASK MODE: change\nUSER TASK:\n${contextPart('user_task',modelTask)}\n\nPLAN:\n${contextPart('plan',planPromptText(plan))}\n\nENGINEERING FRAME:\n${contextPart('engineering_frame',engineeringFrameText(plan))}\n\nCURRENT WORKING DIFF:\n${contextPart('working_diff',diff || '(no diff)')}\n\nREVIEW REQUESTING A FIX:\n${contextPart('review',json(review))}\n\nPREVIOUS FINAL VALIDATION:\n${contextPart('review',json(finalValidation))}\n\nCODER RESPONSE (NO WORKSPACE CHANGES):\n${contextPart('implementation',json(implementation))}\n\nVERIFICATION (${disposition}):\n${contextPart('verification',verificationText(verification))}\n\nGIT METADATA CHANGE OBSERVATIONS:\n${contextPart('git_reconciliation',gitDriftEvidence(gitDrift))}\n\n${findingAssessmentInstructions}\n\nResolve the disagreement exactly once: identify whether a fix is in scope, outside scope and awaiting approval, or uncertain. Do not mark known failing checks as passed merely because code changes were unauthorized.`,
        { contextText, reporter, ...runtimeRoleOptions, sandboxMode: 'read-only', signal,
        bodySources:[{kind:'user_task',value:modelTask},{kind:'plan',value:planPromptText(plan)},
          {kind:'engineering_frame',value:engineeringFrameText(plan)},
          {kind:'working_diff',value:diff || '(no diff)'},
          {kind:'verification',value:verificationText(verification)},
          {kind:'review',value:json(review)},
          {kind:'quality_recovery',value:json(recoveryAssessment)}],
        },
      );
      runs.push(validated.run);
      finalValidation = normalizeFinalValidation(validated);
      }
      fixDecision = await assessScopeFix({ review, finalValidation, verificationDisposition: disposition });
      if (fixDecision.action === 'fix') {
        fixDecision = { ...fixDecision, action: 'no_change_conflict', reason: 'coder_declined_required_fix' };
      } else if (fixDecision.action === 'none' && disposition === 'CODE_FAILURE') {
        fixDecision = { action: 'no_change_conflict', reason: 'unresolved_failing_verification', findings: finalValidation.issues ?? review.issues ?? [] };
      }
      await emit(reporter, { type: 'fix_resolution', decision: fixDecision.action, reason: fixDecision.reason });
      break;
    }

    checked = await runWorkflowVerification(repoRoot, reporter, signal, { allowWorkspaceMutations: true, security: config.security, onAttemptStart: onVerificationAttempt, onGitDrift: onVerificationGitDrift });
    assertTaskWriteScopes(checked.changedPaths, [classification.task, authoritativePlan?.taskSpec]);
    if (checked.changedPaths.length) {
      assertChangedPathsSafe(checked.changedPaths, config.security);
      await emit(reporter, { type: 'workspace_mutations', stage: 'verification', reportedFiles: [], unreportedFiles: checked.changedPaths, reportedButUnchanged: [], actionMismatch: false, actualFiles: checked.changedPaths });
    }
    verification = checked.results;
    verificationRepoKey = repositoryFingerprint(checked.state);
    verificationAttempt = checked.attempt;
    verificationWorkspaceChanged ||= checked.unexpectedPaths.length > 0 || !checked.expectedEffects;
    disposition = checked.disposition;
    currentState = checked.state;
    diff = currentState.diff;
    changedPaths = changedPathsBetweenStates(executionBaseline, currentState);
    finalValidation = null;
    fixDecision = null;
  }

  } catch (error) {
    const details = cancellationDetails(error);
    const isProviderCancellation = details?.reason === CANCELLATION_REASONS.PROVIDER_CANCELLED &&
      details.source === 'provider' && details.expected === false;
    if ((!isProviderCancellation && !error.reviewInterruption && !(error.recovery?.attempts > 1)) || signal?.aborted) throw error;
    const interruption = error.reviewInterruption ?? {
      role: error.recovery?.role ?? 'read_only_role',
      attempts: error.recovery?.attempts ?? 1,
      reason: error.recovery?.reason === 'workspace_changed' ? 'checkout_changed_during_review'
        : isProviderCancellation ? 'provider_cancelled' : 'retry_attempt_failed',
      diagnostics: {
        providerStopReason: details?.diagnostics?.providerStopReason ?? 'cancelled',
        elapsedMs: details?.diagnostics?.elapsedMs ?? null,
        acpUpdateCount: details?.diagnostics?.innerAcp?.acpUpdateCount ?? null,
        outgoingCancelCount: details?.diagnostics?.innerAcp?.outgoingCancelCount ?? null,
      },
    };
    const validCurrentState = await captureRepoState(repoRoot);
    const unchanged = repositoryFingerprint(currentState) === repositoryFingerprint(validCurrentState);
    // Neither a failed review nor an incidental concurrent edit is allowed to
    // certify acceptance or silently rebaseline an implementation checkpoint.
    if (staged) {
      stageCheckpoint.status = 'review_interrupted';
      stageCheckpoint.interruption = {
        stage: 'integration_review',
        reason: !unchanged ? 'checkout_changed_during_review' :
          interruption.reason === 'retry_attempt_failed' ? 'review_retry_attempt_failed' : 'review_provider_cancelled',
        role: interruption.role,
        attempts: interruption.attempts,
        cancellation: { reason: isProviderCancellation ? 'PROVIDER_CANCELLED' : (error?.code ?? 'ROLE_FAILED'),
          source: isProviderCancellation ? 'provider' : (error?.origin ?? 'unknown'), expected: false,
          ...interruption.diagnostics },
        ...(review ? { completedReview: {
          verdict: review.verdict,
          summary: String(review.summary ?? '').slice(0, 1000),
          acceptanceResults: Array.isArray(review.acceptanceResults) ? review.acceptanceResults.slice(0, 64) : [],
        } } : {}),
      };
      await onImplementationCheckpoint?.(structuredClone(stageCheckpoint));
    }
    await emit(reporter, {
      type: 'review_interrupted', role: interruption.role, attempts: interruption.attempts,
      reason: !unchanged ? 'checkout_changed_during_review' : interruption.reason,
    });
    const result = {
      status: 'review_interrupted', route: { classification, policy }, exploration, plan, implementation,
      verification, verificationDisposition: disposition, review, finalValidation: null,
      implementationCoverage, changedPaths, gitMetadataDrift: gitDrift,
      planCompleted: false, runs,
      responseText: [
        '## Independent review interrupted', '',
        `The read-only ${interruption.role} failed (${interruption.reason}) after ${interruption.attempts} invocation(s); no coder or completed implementation stage was rerun.`,
        `Verification disposition: ${disposition}. ${review ? `Reviewer verdict ${review.verdict} was preserved as evidence;` : 'Independent reviewer has no validated result;'} final acceptance is NOT complete.`,
        !unchanged ? 'The checkout also changed during review. Reconcile its current state before retrying.' : 'The previous implementation checkpoint remains preserved.',
        'The result is not accepted. Resume the saved Plan to retry review and final validation.',
      ].join('\n'),
    };
    await emit(reporter, { type: 'complete', result });
    return result;
  }

  // P2 quality assessment is persisted by the task owner before any final
  // verdict is exposed. Legacy hosts without this hook keep P1 semantics.
  const qualityAssessment = onQualityAssessment ? await onQualityAssessment({
    status: 'assessment', verification, review, finalValidation, changedPaths,
    verificationWorkspaceChanged, verificationRepoKey, verificationAttempt,
  }) : null;
  const acceptanceCoverage = staged ? assessImplementationAcceptance(plan.acceptanceCriteria, review, review?.outputFormat === 'text' ? 'text' : 'structured') : null;
  const scopeOnlyFindings = fixDecision?.action === 'report_only';
  const reviewerResolved = review?.verdict === 'pass' || scopeOnlyFindings || (review?.verdict === 'escalate' && finalValidation?.verdict === 'pass');
  const fixUnresolved = Boolean(fixDecision && fixDecision.action !== 'none');
  const integrationComplete = (!fixUnresolved || scopeOnlyFindings) && qualityAssessment?.complete !== false && (!staged || (implementationCoverage?.complete && acceptanceCoverage.complete && reviewerResolved && disposition === 'PASS' && (scopeOnlyFindings || finalValidation?.verdict !== 'fix') && finalValidation?.verdict !== 'unknown'));
  if (staged) {
    stageCheckpoint.acceptanceCoverage = acceptanceCoverage;
    stageCheckpoint.verificationDisposition = disposition;
    currentState = await captureRepoState(repoRoot);
    stageCheckpoint.repoKey = repositoryFingerprint(currentState);
    stageCheckpoint.repoSnapshot = snapshotImplementationRepo(currentState);
    stageCheckpoint.status = integrationComplete ? 'finished' : 'integration_incomplete';
    await onImplementationCheckpoint?.(structuredClone(stageCheckpoint));
  }
  const unresolvedDecision = finalValidation?.verdict === 'unknown' || (review?.verdict === 'unknown' && !finalValidation);
  const acceptanceEvidenceComplete = !staged || (implementationCoverage?.complete && acceptanceCoverage?.complete);
  const status = fixUnresolved
    ? fixDecision.action === 'report_only' && disposition === 'PASS' && acceptanceEvidenceComplete && qualityAssessment?.complete !== false ? 'completed_with_findings'
      : fixDecision.action === 'approval_required' ? 'needs_user_decision' : 'implementation_blocked'
    : !integrationComplete ? 'implementation_incomplete' : unresolvedDecision
    ? 'completed_with_unresolved_review'
    : changedPaths.length === 0
      ? 'no_change'
      : disposition === 'UNVERIFIED'
        ? 'completed_with_unverified_checks'
        : 'applied';
  // For incomplete staged work, publish a deterministic completion report.
  // A free-form responder must not accidentally turn an incomplete coverage
  // decision into a reassuring but unsupported success statement.
  const incompleteStageResponse = !integrationComplete && (staged || qualityAssessment?.complete === false) ? [
    '## Implementation incomplete', '',
    `Implementation stages: ${implementationCoverage?.completedStages?.length ?? 0}/${implementationCoverage?.totalStages ?? '?'} reported.`,
    `Verification: ${disposition}.`,
    `Independent reviewer: ${review?.verdict ?? 'unknown'}.`,
    `Acceptance criteria (review claims): ${acceptanceCoverage?.results?.filter((entry) => entry.status === 'verified').length ?? 0}/${plan.acceptanceCriteria.length}.`,
    ...(qualityAssessment ? [`Independently grounded evidence: ${qualityAssessment.results.filter((r) => ['verified', 'verified_current_run'].includes(r.state)).length}/${qualityAssessment.results.length} criteria verified.`] : []),
    '', '### Remaining or unverified criteria',
    ...(qualityAssessment?.results?.filter((r) => !['verified', 'verified_current_run'].includes(r.state)).map((r) => `- ${r.id}: ${r.state} (${r.nextAction})`) ?? []),
    ...(acceptanceCoverage?.issues?.length ? acceptanceCoverage.issues.map((issue) => `- ${issue}`) : []),
    '', '### Files modified since workflow start',
    ...(changedPaths.length ? changedPaths.map((path) => `- ${path}`) : ['- None observed']),
    '', 'Existing workspace edits were preserved. The orchestrator did not mark this task complete or retry it automatically.',
  ].join('\n') : null;
  const interruptedResponse = fixUnresolved ? fixInterruptionReport({
    status, decision: fixDecision, review, finalValidation, implementation, implementationCoverage, acceptanceCoverage, verificationDisposition: disposition, changedPaths, verification,
  }) : null;
  // Refresh after implementation: any pre-planning inventory is stale once
  // the coder has modified the workspace. No skill-name-based activation.
  if (coverageTask) testCoverageEvidence = await collectRequestedCoverageEvidence();
  const response = interruptedResponse || incompleteStageResponse
    ? { text: interruptedResponse ?? incompleteStageResponse, streamed: false, error: null }
    : await produceUserResponse({
    registry, role: policy.responder, repoRoot, contextText, reporter, runtimeRoleOptions, signal, streamFinalResponse, runs,
    bodySources:[{kind:'user_task',value:modelTask},{kind:'exploration',value:hintedExploration?.text ?? promptValue(exploration)},
      {kind:'verification',value:verificationText(verification)},{kind:'implementation',value:json(implementation)},
      {kind:'review',value:json(review)}],
    body: `TASK MODE: change\nUSER TASK:\n${modelTask}\n\nREPOSITORY EXPLORATION:\n${hintedExploration?.text ?? promptValue(exploration)}\n\nFINAL WORKFLOW STATUS: ${status}\nIMPLEMENTATION COVERAGE:\n${json(implementationCoverage)}\nACCEPTANCE COVERAGE:\n${json(acceptanceCoverage)}\nDo not claim complete when acceptance evidence is missing.\nTEST COVERAGE EVIDENCE (inventory only, not measured code coverage):\n${json(testCoverageEvidence)}\nFILES CHANGED SINCE WORKFLOW START:\n${json(changedPaths)}\n\nIMPLEMENTATION REPORT:\n${json(implementation)}\n\nVERIFICATION (${disposition}):\n${verificationText(verification)}\n\nINDEPENDENT REVIEW:\n${json(review)}\n\nFINAL VALIDATION:\n${json(finalValidation)}\n\nGIT METADATA CHANGE OBSERVATIONS:\n${gitDriftEvidence(gitDrift)}\n\nIf Git metadata changed, report the warning without assigning blame or suggesting an automatic rollback. The current real workspace already contains the accepted edits. Give the user the final answer in the most useful natural format. You may inspect the current diff read-only. Use concise Markdown, code blocks, or a unified diff if that materially helps explain the result. Do not edit files.`,
  });
  const result = {
    status,
    route: { classification, policy }, exploration, plan, plannerOutput, implementation, review, finalValidation, verification,
    verificationDisposition: disposition,
    qualityAssessment, verificationRepoKey, verificationWorkspaceChanged, verificationAttempt,
    fixDisposition: fixUnresolved ? fixDecision : null,
    unresolvedFindings: fixUnresolved ? [...new Map(
      [...(fixDecision.findings ?? []), ...(fixDecision.outOfScopeFindings ?? [])]
        .map((issue) => [findingIdentity(issue), issue])).values()] : [],
    gitMetadataDrift: gitDrift,
    ...(testCoverageEvidence ? {testCoverageEvidence} : {}),
    responseText: response.text, responseStreamed: response.streamed, responseError: response.error,
    reviewTarget: activeReviewTarget,
    diff,
    baselineDiff: executionBaseline.diff,
    diffIncludesPreexistingChanges: Boolean(executionBaseline.diff.trim()),
    changedPaths,
    workspace: repoRoot,
    planCompleted: integrationComplete && !unresolvedDecision && !fixUnresolved,
    ...(staged ? { implementationCoverage, acceptanceCoverage } : {}),
    runs,
  };
  await emit(reporter, { type: 'complete', result });
  return result;
}
