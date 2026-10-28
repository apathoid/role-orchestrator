// A host-neutral execution boundary. The host supplies only presentation,
// permission/elicitation bridges and native session control snapshots.
// All workflow continuation, checkpoints, reconciliation and durable turn
// accounting live here rather than in an ACP request handler.
import { runWorkflow } from './workflow.mjs';
import { resolveRouterContextMode } from './config.mjs';
import { compileRoleHistory } from './efficiency/context.mjs';
import { beginVerificationAttempt, ingestStageCheckpoint, ingestWorkflowResult, evidenceMatrix, proposeWorkflowDecision, applicableApproval, resolveDecision, currentDecisionBinding, activeQuality, assessRecovery, proposeReconciliationDecision, reconciliationDecision, expireReconciliationDecisions } from './quality-state.mjs';
import { formatResultMarkdown } from './reporters.mjs';
import { configuredVerificationInputClosures } from './verification-inputs.mjs';
import { normalizeImplementationPlan, planDigest } from './implementation-stages.mjs';
import { validateTaskSpec } from './routing/task-spec.mjs';
import { ensureImplementationTasks, activeImplementationTask, selectImplementationTask, registerImplementationPlan, updateActiveImplementationTask, findImplementationTask, implementationTaskSummaries } from './implementation-tasks.mjs';
import { buildSessionContextText } from './conversation-context.mjs';
import { ensureSessionConfigState, applySessionProfileOverrides } from './session-config.mjs';
import {
  persistTurnAttachments, buildHistoricalAttachmentBlocks, cleanupSessionAttachments,
} from './attachment-store.mjs';

function historySummary(result) {
  const exploration = result.exploration?.format === 'text'
    ? result.exploration.text
    : result.exploration?.summary ?? '';
  const constraints = Array.isArray(result.exploration?.constraints) && result.exploration.constraints.length
    ? ` Constraints: ${result.exploration.constraints.slice(0, 8).join('; ')}`
    : '';
  const unknowns = Array.isArray(result.exploration?.unknowns) && result.exploration.unknowns.length
    ? ` Unknowns: ${result.exploration.unknowns.slice(0, 6).join('; ')}`
    : '';

  if (result.status === 'review_findings' || result.status === 'review_passed' || result.status === 'review_unresolved' || result.status === 'review_incomplete') {
    const issues = result.review?.issues?.map((x) => `${x.severity}${x.path ? ` ${x.path}` : ''}: ${x.message}`).join('; ') || 'none';
    return `Review status=${result.status}. Exploration: ${String(exploration).slice(0, 2500)}${constraints}${unknowns} Review: ${result.review?.summary ?? ''}. Findings: ${issues}. Coverage: ${result.reviewCoverage ? `${result.reviewCoverage.checked}/${result.reviewCoverage.total}; unresolved=${result.reviewCoverage.gaps?.slice(0, 6).join('; ')}` : 'unknown'}`.slice(0, 7000);
  }
  if (result.status === 'planned') {
    return `Planned (read-only): ${(result.plan?.goal ?? '').slice(0, 1000)}. Steps: ${(result.plan?.steps ?? []).join('; ').slice(0, 3500)}. Response: ${String(result.responseText ?? '').slice(0, 1800)}`.slice(0, 7000);
  }
  if (result.status === 'investigated') {
    const investigation = result.investigation?.format === 'text'
      ? result.investigation.text
      : result.investigation?.summary ?? '';
    return `Investigation: ${String(investigation).slice(0, 4500)} Exploration: ${String(exploration).slice(0, 1800)}${constraints}${unknowns}`.slice(0, 7000);
  }
  const implementation = result.implementation?.summary ?? '';
  const review = result.review?.summary ?? '';
  const files = Array.isArray(result.changedPaths) && result.changedPaths.length ? result.changedPaths.join(', ') : 'none';
  const discovered = (result.unresolvedFindings ?? []).slice(0, 5).map((issue) =>
    `${issue.severity ?? 'unknown'}${issue.path ? ` ${issue.path}` : ''}: ${issue.message}`).join('; ');
  const fixState = result.fixDisposition ? ` Fix disposition=${result.fixDisposition.action} (${result.fixDisposition.reason}). Findings: ${discovered}.` : '';
  return `Change status=${result.status}.${fixState} Goal=${result.plan?.goal ?? ''}. Exploration: ${String(exploration).slice(0, 2200)}${constraints}${unknowns} Implementation: ${implementation}. Review: ${review}. Verification=${result.verificationDisposition ?? 'unknown'}. Changed paths: ${files}`.slice(0, 7000);
}

/**
 * Dependencies are injectable for headless hosts and integration tests.
 * A session comes from createSessionLifecycle; the saved JSON schema is unchanged.
 */
export function createExecutionService({
  getConfig,
  persist,
  workflow = runWorkflow,
  createRegistry = async (config, bridge) => {
    const { createModelRegistry } = await import('./models.mjs');
    return createModelRegistry(config, bridge);
  },
  attachments = { persistTurnAttachments, buildHistoricalAttachmentBlocks, cleanupSessionAttachments },
}) {
  if (typeof getConfig !== 'function' || typeof persist !== 'function') {
    throw new TypeError('Execution service needs getConfig and persist callbacks');
  }

  // Persist changes to a Plan, checkpoint and task registry in one atomic
  // session update. Roll back all in-memory aliases if persistence fails.
  async function persistTaskChange(sessionId, session, mutate) {
    const previous = {
      implementationTasks: structuredClone(session.implementationTasks),
      activeImplementationTaskId: session.activeImplementationTaskId,
      implementationPlan: session.implementationPlan,
      implementationCheckpoint: session.implementationCheckpoint,
      implementationReconciliation: session.implementationReconciliation,
    };
    try {
      const value = await mutate();
      await persist(sessionId, session);
      return value;
    } catch (error) {
      Object.assign(session, previous);
      throw error;
    }
  }

  async function saveField(sessionId, session, field, value) {
    if (field === 'implementationCheckpoint' || field === 'implementationReconciliation') {
      return persistTaskChange(sessionId, session, async () => {
        updateActiveImplementationTask(session, field === 'implementationCheckpoint' ? 'checkpoint' : 'reconciliation', value);
        if (field === 'implementationCheckpoint') await ingestStageCheckpoint(activeImplementationTask(session), value, session.repoRoot);
      });
    }
    const previous = session[field];
    session[field] = value;
    try { await persist(sessionId, session); }
    catch (error) { session[field] = previous; throw error; }
  }

  async function saveReconciliation(sessionId, session, { plan, checkpoint, proposal }) {
    return persistTaskChange(sessionId, session, async () => {
      updateActiveImplementationTask(session, 'plan', plan);
      updateActiveImplementationTask(session, 'checkpoint', checkpoint);
      updateActiveImplementationTask(session, 'reconciliation', proposal);
      const task = activeImplementationTask(session);
      if (!proposal) { expireReconciliationDecisions(task); return null; }
      return proposeReconciliationDecision(task, proposal, session.repoRoot);
    });
  }

  async function decide(sessionId, session, { gateId, optionId }) {
    return persistTaskChange(sessionId, session, async () => {
      const active = activeQuality(session);
      if (!active) throw new Error('No active implementation task to authorize.');
      const pending = active.state.decisions.filter((d) => d.status === 'pending');
      const matches = active.state.decisions.filter((d) => gateId ? d.id === gateId || d.id.startsWith(gateId) : d.status === 'pending');
      if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous decision gate. Use its full ID.' : 'No matching pending decision gate.');
      if (!gateId && pending.length !== 1) throw new Error('More than one decision is pending; supply the decision gate ID.');
      const binding = await currentDecisionBinding(active.task, session.repoRoot);
      return resolveDecision(active.task, matches[0].id, optionId, binding, { userInitiated: true });
    });
  }

  function resolvePlan(session, validatedIntent) {
    // Deprecated direct helper: callers must supply a typed Task Specification.
    // It is a lookup only; execution always routes and reauthorizes in workflow.
    if (!validatedIntent || typeof validatedIntent !== 'object') return null;
    const intent = validateTaskSpec(validatedIntent);
    if (intent.operation !== 'change' || intent.writeIntent !== 'explicit' || intent.ambiguities.length ||
        !['current_implementation','saved_implementation'].includes(intent.continuation.mode)) return null;
    const tasks = ensureImplementationTasks(session).filter(item => item.plan);
    const chosen = intent.continuation.operationId ? findImplementationTask(session,intent.continuation.operationId)
      : intent.continuation.mode === 'current_implementation' ? activeImplementationTask(session)
      : tasks.length === 1 ? tasks[0] : null;
    if (!chosen?.plan || chosen.plan.repoRoot !== session.repoRoot ||
        chosen.plan.planId !== planDigest(normalizeImplementationPlan(chosen.plan.plan) ?? {})) return null;
    return chosen.plan;
  }

  async function execute({
    sessionId, session, invocation, rawText = '', mediaBlocks = [], reporter,
    signal, controls = {}, providerBridge = {}, onProviderStateChange, onBeforeCommit,
    onConfigReady, // optional host presentation hook, never part of execution state
  }) {
    if (!session || !invocation || typeof invocation.task !== 'string') throw new TypeError('Session and invocation.task are required');
    let attachmentTxn = null;
    let beforeHistory = session.history;
    let beforeTranscript = session.transcript;
    let committed = false;
    try {
      // Reserve blobs before the turn; attachment references become durable
      // only together with the transcript. Keep the existing GC transaction.
      attachmentTxn = await attachments.persistTurnAttachments(sessionId, mediaBlocks);
      const historical = await attachments.buildHistoricalAttachmentBlocks(sessionId, session.transcript);
      beforeHistory = session.history;
      beforeTranscript = session.transcript;
      const baseConfig = await getConfig(session.repoRoot);
      ensureSessionConfigState(session, baseConfig);
      const config = applySessionProfileOverrides(baseConfig, session);
      const trustedDependencyClosures = configuredVerificationInputClosures();
      await onConfigReady?.(baseConfig, config);
      // Every workflow caller uses the same Router -> typed plan-selection API.
      // No injected workflow is permitted to preselect a Plan from prompt text.
      const plan = null;
      let selectedTaskId = null;
      let qualityProcessed = false;
      const semanticPlanSelection = true;
      const registry = await createRegistry(config, providerBridge);
      let result;
      try {
        result = await workflow({
          task: invocation.task,
          config,
          registry,
          repoStart: session.cwd,
          modeOverride: invocation.modeOverride,
          planOnly: controls.planOnly === true,
          providerOptionsForRole: typeof controls.providerOptionsForRole === 'function'
            ? controls.providerOptionsForRole : undefined,
          onProviderStateChange,
          skillName: invocation.skillName,
          skillInvocation: invocation.skillInvocation ?? null,
          reviewTarget: invocation.reviewTarget,
          authoritativePlan: plan,
          savedOperationMetadata: semanticPlanSelection ? implementationTaskSummaries(session)
            .filter(t => t.planId && t.status !== 'orphaned_checkpoint')
            .map(({taskId,planId,status,active})=>({operationId:taskId,planId,status,active,
              pendingReconciliation:ensureImplementationTasks(session).some(t=>t.taskId===taskId &&
                t.reconciliation && t.quality?.decisions?.some(d=>d.kind==='checkout_reconciliation' && d.status==='pending' &&
                  d.proposalToken===t.reconciliation.token && d.proposalRepoKey===t.reconciliation.repoKey))})) : [],
          onSelectSavedImplementation: semanticPlanSelection ? async ({mode,operationId}) => {
            // Model claims can SELECT a persisted Plan but cannot create one,
            // bypass its digest, or adopt a checkpoint from a different Plan.
            const tasks=ensureImplementationTasks(session).filter(t=>t.plan);
            let chosen;
            try {
              chosen=operationId ? findImplementationTask(session,operationId)
                : mode==='current_implementation' ? activeImplementationTask(session)
                  : tasks.length===1 ? tasks[0] : null;
            } catch { return null; }
            if (!chosen?.plan) return null;
            const stored=normalizeImplementationPlan(chosen.plan.plan);
            if (!stored || chosen.plan.version!==1 || chosen.plan.repoRoot!==session.repoRoot ||
                chosen.plan.planId!==planDigest(stored) ||
                (chosen.checkpoint && chosen.checkpoint.planId!==chosen.plan.planId)) return null;
            await persistTaskChange(sessionId,session,()=>selectImplementationTask(session,chosen.taskId));
            selectedTaskId=chosen.taskId;
            return {plan:chosen.plan,checkpoint:chosen.checkpoint,reconciliation:chosen.reconciliation};
          } : null,
          // Never allow a checkpoint from an unrelated task to influence this
          // workflow, even while the new task's planner is running.
          implementationCheckpoint: plan ? activeImplementationTask(session)?.checkpoint ?? null : null,
          implementationReconciliation: plan ? activeImplementationTask(session)?.reconciliation ?? null : null,
          onImplementationPlan: async (artifact) => {
            if (selectedTaskId) throw new Error('Cannot replace a saved Plan during continuation.');
            const entry = await persistTaskChange(sessionId, session,
              () => registerImplementationPlan(session, artifact));
            selectedTaskId = entry.taskId;
          },
          onImplementationReconciliation: (state) => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) {
              throw new Error('Reconciliation has no matching selected task; nothing was replaced.');
            }
            return saveReconciliation(sessionId, session, state);
          },
          onVerificationAttempt: async (attempt) => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) return;
            return persistTaskChange(sessionId, session, () =>
              beginVerificationAttempt(activeImplementationTask(session), attempt));
          },
          onRevalidationResult: async (observation) => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) {
              throw new Error('Targeted verification belongs to a different task.');
            }
            return persistTaskChange(sessionId, session, () => ingestWorkflowResult(
              activeImplementationTask(session), observation, session.repoRoot, { trustedDependencyClosures }));
          },
          onRecoveryAssessment: async () => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) return null;
            return assessRecovery(activeImplementationTask(session), session.repoRoot);
          },
          onResolveReconciliationIntent: async (selection) => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) {
              return {status:'unavailable'};
            }
            // A semantic decision cannot create a gate or address another Plan.
            // All authorization remains bound to the current repository snapshot.
            return persistTaskChange(sessionId, session, async () => {
              const active = activeQuality(session);
              const proposal = active?.task?.reconciliation;
              if (!proposal) return {status:'unavailable'};
              const gates = active.state.decisions.filter(d =>
                d.kind === 'checkout_reconciliation' && d.proposalToken === proposal.token &&
                d.proposalRepoKey === proposal.repoKey && ['pending','resolved'].includes(d.status));
              if (gates.length !== 1) return {status:'unavailable'};
              const binding = await currentDecisionBinding(active.task, session.repoRoot);
              const gate = resolveDecision(active.task, gates[0].id, selection, binding, {userInitiated:true});
              return {status:gate.status,selection:gate.selection ?? null,gateId:gate.id};
            });
          },
          onReconciliationDecision: async () => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) return null;
            return reconciliationDecision(activeImplementationTask(session), session.repoRoot);
          },
          onApprovedFindings: async () => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) return [];
            return applicableApproval(activeImplementationTask(session), session.repoRoot);
          },
          onQualityAssessment: async (assessment) => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) {
              throw new Error('Cannot attach quality assessment to an unrelated task.');
            }
            return persistTaskChange(sessionId, session, async () => {
              const task = activeImplementationTask(session);
              await ingestWorkflowResult(task, assessment, session.repoRoot, { trustedDependencyClosures });
              const rows = await evidenceMatrix(task, session.repoRoot, { currentAttemptId: assessment.verificationAttempt?.id });
              qualityProcessed = true;
              return { complete: rows.length > 0 && rows.every((r) => ['verified', 'verified_current_run'].includes(r.state)),
                results: rows.map(({ id, state, nextAction }) => ({ id, state, nextAction })) };
            });
          },
          onImplementationCheckpoint: (checkpoint) => {
            if (!selectedTaskId || activeImplementationTask(session)?.taskId !== selectedTaskId) {
              throw new Error('Cannot save an orphan implementation checkpoint; the Plan must be persisted first.');
            }
            return saveField(sessionId, session, 'implementationCheckpoint', checkpoint);
          },
          reviewCheckpoint: session.reviewCheckpoint ?? null,
          onReviewCheckpoint: (checkpoint) => saveField(sessionId, session, 'reviewCheckpoint', checkpoint),
          sessionContextText: buildSessionContextText(session),
          roleSessionContext: process.env.AGENT_P3_CONTEXT === '1'
            ? (role) => compileRoleHistory(session, role, { mode: 'conservative', savedPlan: Boolean(plan) }).text
            : null,
          efficiency: { handoff: process.env.AGENT_P3_HANDOFF === '1', continuationFastPath: process.env.AGENT_P3_CONTINUATION_FAST_PATH === '1', routerContextMode: resolveRouterContextMode(config) },
          reporter,
          signal,
          promptBlocks: [...historical.blocks, ...mediaBlocks],
          mcpServers: session.mcpServers ?? [],
          additionalDirectories: session.additionalDirectories ?? [],
          streamFinalResponse: controls.streamFinalResponse === true,
        });
      } finally {
        await registry.close?.();
      }
      if (result.status === 'planned' && result.planArtifact) {
        const registered = await persistTaskChange(sessionId, session,
          () => registerImplementationPlan(session, result.planArtifact, { origin: 'plan' }));
        selectedTaskId = registered?.taskId ?? null;
      }
      if (selectedTaskId && activeImplementationTask(session)?.taskId === selectedTaskId) {
        await persistTaskChange(sessionId, session, async () => {
          const task = activeImplementationTask(session);
          if (!qualityProcessed) await ingestWorkflowResult(task, result, session.repoRoot, { trustedDependencyClosures });
          const gate = await proposeWorkflowDecision(task, result, session.repoRoot);
          if (gate) result.decisionGateId = gate.id;
        });
      }
      const assistantText = String(result.responseText ?? '').trim() || formatResultMarkdown(result);
      session.history = [
        ...(beforeHistory ?? []),
        { user: rawText || '[non-text prompt context]', result: historySummary(result) },
      ].slice(-100);
      session.transcript = [
        ...(beforeTranscript ?? []),
        { user: rawText || '[non-text prompt context]', attachments: attachmentTxn.attachments, assistant: assistantText },
      ].slice(-100);
      try {
        try { await onBeforeCommit?.(session, result, selectedTaskId); }
        catch (error) { console.error(`[efficiency] optional aggregation failed: ${error?.message ?? error}`); }
        await persist(sessionId, session);
        committed = true;
        await attachmentTxn.commitSucceeded();
      } catch (error) {
        session.history = beforeHistory;
        session.transcript = beforeTranscript;
        throw error;
      }
      return { result, assistantText };
    } catch (error) {
      if (attachmentTxn && !committed) {
        await attachmentTxn.commitFailed().catch(() => {});
        await attachments.cleanupSessionAttachments(sessionId, beforeTranscript ?? session.transcript).catch(() => {});
      }
      throw error;
    }
  }

  return { execute, resolvePlan, saveReconciliation, saveField, decide };
}
