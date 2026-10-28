#!/usr/bin/env node
import { efficiencyReadiness } from './efficiency/readiness.mjs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { loadConfig } from './config.mjs';
import { discoverSkills, parseSlashInvocation } from './context.mjs';
import { cleanPlanStep } from './implementation-stages.mjs';
import { implementationTaskSummaries } from './implementation-tasks.mjs';
import { qualityView } from './quality-view.mjs';
import { resolveRepoRoot } from './repo.mjs';
import { createOrchestratorRuntime } from './orchestrator-runtime.mjs';
import {
  reconcileAttachmentStore,
  startAttachmentGc,
} from './attachment-store.mjs';
import { projectName } from './project.mjs';
import { userFacingRoleUpdate, implementationStagePresentation, sanitizeToolUpdateForUi, executionOverviewMarkdown, executionTraceMarkdown, executionRunsMarkdown } from './acp-presentation.mjs';
import { createOuterToolCallBridge } from './acp-tool-bridge.mjs';
import { reconcileTaskPlanProgress, taskPlanProgressDiagnostic } from './task-plan-progress.mjs';
import { compactSessionTitle } from './conversation-context.mjs';
import {
  applySessionProfileOverrides,
  buildSessionConfigOptions,
  ensureSessionConfigState,
  setSessionConfigOption,
} from './session-config.mjs';
import {
  buildCodexNativeConfigOptions,
  CODEX_AGENT_MODE_CONFIG_ID,
  CODEX_COLLABORATION_MODE_CONFIG_ID,
  codexAgentModeState,
  ensureCodexNativeControlState,
  setCodexAgentMode,
  setCodexNativeConfigOption,
  snapshotCodexTurnControls,
} from './codex-native-controls.mjs';
import {
  cancellationUserMessage,
  diagnosticCode,
  diagnosticErrorMessage,
  isExpectedCancellation,
} from './cancellation.mjs';

const runtime = createOrchestratorRuntime({ getConfig: getBaseConfig });
const sessions = runtime.sessions;
const configUpdateTails = new Map();

function serializeConfigUpdate(sessionId, operation) {
  const previous = configUpdateTails.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  configUpdateTails.set(sessionId, next);
  return next.finally(() => {
    if (configUpdateTails.get(sessionId) === next) configUpdateTails.delete(sessionId);
  });
}

const configPromises = new Map();
let outerClientCapabilities = null;

function getBaseConfig(repoRoot) {
  // Project configuration belongs to the repository, never to the process cwd
  // or to the previous ACP session. Each session materializes assignments once.
  if (!repoRoot) throw new Error('A repository root is required to load configuration.');
  if (!configPromises.has(repoRoot)) {
    const pending = loadConfig({ repoRoot }).catch((error) => {
      configPromises.delete(repoRoot);
      throw error;
    });
    configPromises.set(repoRoot, pending);
  }
  return configPromises.get(repoRoot);
}

function allSessionConfigOptions(config, session) {
  ensureCodexNativeControlState(session);
  return [...buildCodexNativeConfigOptions(session), ...buildSessionConfigOptions(config, session)];
}

function extractPromptText(prompt = []) {
  return prompt
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function supplementalPromptBlocks(prompt = []) {
  return prompt.filter((block) => block && typeof block === 'object' && block.type !== 'text');
}

function taskTextForPrompt(prompt = []) {
  const text = extractPromptText(prompt);
  if (text) return text;
  const kinds = [...new Set(prompt.map((block) => block?.type).filter(Boolean))];
  if (kinds.length) return `Analyze the supplied ${kinds.join(', ')} context and answer the user's request without modifying the repository unless write intent is explicitly stated.`;
  return '';
}

async function sendText(client, sessionId, text) {
  if (!text) return;
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: text.endsWith('\n') ? text : `${text}\n` },
    },
  });
}

async function sendUsage(client, sessionId, used, size) {
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return;
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'usage_update', used: Math.max(0, Math.round(used)), size: Math.round(size) },
  });
}

function outerRequestError(error) {
  if (error instanceof acp.RequestError) return error;
  const message = diagnosticErrorMessage(error);
  if (Number.isInteger(error?.code)) return new acp.RequestError(error.code, message, error?.data);
  // Throw a typed JSON-RPC error with the real message at the protocol boundary.
  // Otherwise the ACP SDK intentionally replaces arbitrary Error.message with
  // the generic "Internal error" label and places the detail only in data,
  // which some clients do not surface.
  const internalCode = diagnosticCode(error);
  return new acp.RequestError(-32603, message, {
    details: message,
    ...(internalCode ? { orchestrationCode: internalCode } : {}),
    ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    ...(error?.diagnostics && typeof error.diagnostics === 'object' ? { diagnostics: error.diagnostics } : {}),
  });
}


async function persistSession(sessionId, session) {
  await runtime.persistSession(sessionId, session);
}

async function replayTranscript(client, sessionId, transcript = []) {
  for (const turn of transcript) {
    if (typeof turn?.user === 'string' && turn.user) {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: turn.user },
        },
      });
    }
    if (typeof turn?.assistant === 'string' && turn.assistant) {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: turn.assistant.endsWith('\n') ? turn.assistant : `${turn.assistant}\n` },
        },
      });
    }
  }
}

async function restoreSession(params, options) {
  const session = await runtime.restoreSession(params, options);
  ensureCodexNativeControlState(session);
  return session;
}

async function availableCommands(cwd) {
  let repoRoot = cwd;
  try { repoRoot = await resolveRepoRoot(cwd); } catch {}
  const skills = await discoverSkills(repoRoot);
  const commands = [
    { name: 'review', description: 'Review code without applying fixes', input: { hint: 'what to review' } },
    { name: 'review-resume', description: 'Resume saved review work without rebuilding its plan', input: { hint: '[operation-id]' } },
    { name: 'review-reconcile', description: 'Explicitly reconcile saved review scope with a merge parent', input: { hint: 'merge-parent=N' } },
    { name: 'review-commit', description: 'Review a specific Git commit from the source repository', input: { hint: '<revision> [review focus]' } },
    { name: 'change', description: 'Implement a repository change', input: { hint: 'change to implement' } },
    { name: 'investigate', description: 'Investigate or explain without modifying files', input: { hint: 'question or problem to investigate' } },
    { name: 'skills', description: 'List skills available to this orchestrator' },
    { name:'routing', description:'Read-only semantic routing telemetry (no model calls)', input:{hint:'report [run-id]'} },
    { name: 'efficiency', description: 'Show P3 efficiency counters and context profiling (no model call)', input: { hint: '[history | runs | run <id> | export [id] | coverage]' } },
    { name: 'status', description: 'Show current or past execution without starting a workflow', input: { hint: '[run-id]' } },
    { name: 'runs', description: 'List recent executions for this session (read-only)' },
    { name: 'plans', description: 'List saved implementation Plans and resumable tasks (read-only)' },
    { name: 'trace', description: 'Show recent structured execution events (no model call)', input: { hint: '[event count, max 50] [run-id]' } },
    { name: 'checkpoint', description: 'Show saved implementation/review checkpoints (read-only)' },
    { name: 'evidence', description: 'Show criterion-to-evidence matrix, provenance and freshness (read-only)' },
    { name: 'findings', description: 'Show task findings and their lifecycle (read-only)' },
    { name: 'recovery', description: 'Assess recovery from durable state and checkout (read-only)' },
    { name: 'decisions', description: 'Show pending and historical decision gates (read-only)' },
    { name: 'decide', description: 'Explicitly choose a decision gate option', input: { hint: '[gate-id] <option>' } },
    { name: 'skill', description: 'Run a discovered skill by name (fallback when a dynamic skill command is not visible)', input: { hint: '<skill-name> [task]' } },
  ];
  const reserved = new Set(commands.map((x) => x.name));
  for (const skill of skills.values()) {
    if (reserved.has(skill.name)) continue;
    commands.push({
      name: skill.name,
      description: skill.description || `Run the ${skill.name} skill`,
      ...(skill.argumentHint ? { input: { hint: skill.argumentHint } } : {}),
    });
  }
  return { commands, skills };
}

async function advertiseCommands(client, sessionId, cwd) {
  const { commands } = await availableCommands(cwd);
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: commands,
    },
  });
}

function roleLine(event, done = false) {
  const profile = event.profile ? ` / ${event.profile}` : '';
  const model = event.model ? ` / ${event.model}` : '';
  if (done) return `✓ **${event.role}**${profile}${model} — ${(event.elapsedMs / 1000).toFixed(1)}s\n`;
  return `▶ **${event.role}**${profile}${model} — ${event.purpose}\n`;
}

function createAcpReporter(client, sessionId, { onSuggestedTitle = null, toolPresentationForProvider = () => ({}) } = {}) {
  let nativePlan = [];
  const toolKindsByInvocation = new Map();

  const pushNativePlan = async () => {
    if (!nativePlan.length) return;
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: nativePlan.map((step) => ({
          content: step.content,
          priority: step.priority,
          status: step.status,
        })),
      },
    });
  };

  const startTaskPlan = async (steps = []) => {
    nativePlan = steps.map((content, index) => ({
      index,
      content: cleanPlanStep(content),
      priority: 'medium',
      status: 'pending',
    }));
    await pushNativePlan();
  };

  const ensureFirstTaskStepInProgress = async () => {
    if (!nativePlan.length || nativePlan.some((step) => step.status === 'in_progress')) return;
    const next = nativePlan.find((step) => step.status === 'pending');
    if (!next) return;
    next.status = 'in_progress';
    await pushNativePlan();
  };

  let lastTaskPlanDiagnostic = null;
  let implementationStageActive = false;

  const applyTaskProgress = async (items = []) => {
    const reconciled = reconcileTaskPlanProgress(nativePlan, items);
    if (!reconciled.ok) {
      const detail = taskPlanProgressDiagnostic(reconciled);
      if (detail && detail !== lastTaskPlanDiagnostic) {
        lastTaskPlanDiagnostic = detail;
        // This is diagnostic only: attribution belongs to neither the model nor
        // the provider with certainty. Keep the last valid user-facing plan.
        console.error(`[acp] ignored incompatible task-plan progress for ${sessionId}: ${detail}`);
      }
      return;
    }
    lastTaskPlanDiagnostic = null;
    if (!reconciled.changed) return;
    nativePlan = reconciled.plan;
    await pushNativePlan();
  };

  const completeTaskPlan = async () => {
    if (!nativePlan.length) return;
    let changed = false;
    for (const step of nativePlan) {
      if (step.status !== 'completed') {
        step.status = 'completed';
        changed = true;
      }
    }
    if (changed) await pushNativePlan();
  };

  let primaryExecutionRole = null;
  let currentWorkflowMode = null;
  const forwardToolCall = createOuterToolCallBridge({
    publish: async (update) => client.notify(acp.methods.client.session.update, { sessionId, update }),
  });

  const handleEvent = async (event) => {
    if (event.type === 'workspace_ready' && event.reviewTarget) {
      await sendText(client, sessionId, `Review target resolved: source commit **${event.reviewTarget.sourceCommit.slice(0, 12)}**. Agents can inspect the real commit, its parents, and reachable Git history read-only.\n`);
    } else if (event.type === 'review_plan_created') {
      await sendText(client, sessionId, `Review work plan: ${event.total} independent units${event.files === null ? '' : ` across ${event.files} changed files`}.\n`);
    } else if (event.type === 'review_operation_resumed') {
      await sendText(client, sessionId, `↪ Review Operation restored: ${event.reusedUnits ?? 0} completed Unit(s) reused.\n`);
    } else if (event.type === 'review_scope_reconciled') {
      await sendText(client, sessionId, `↪ Review scope reconciled: ${event.reusedUnits ?? 0} unchanged Units reused, ${event.invalidatedUnits ?? 0} invalidated.\n`);
    } else if (event.type === 'review_continuation_ready') {
      await sendText(client, sessionId, `↪ Review continuation: ${event.verified} unit(s) verified, ${event.pending} pending${event.durable ? '; checkpoint saved' : '; checkpoint not saved'}.\n`);
    } else if (event.type === 'review_scope_resolution_required') {
      await sendText(client, sessionId, `⚠ Review scope requires resolution: ${event.reason}; ${event.unresolved ?? 'unknown'} ambiguous change sets.\n`);
    } else if (event.type === 'review_batch_start') {
      await sendText(client, sessionId, `\n▶ **Review batch ${event.batch}** — ${event.ids.join(', ')} (maximum ${event.maxBatchesPerRun ?? event.total} batches)${event.previousBatches ? `; ${event.previousBatches} earlier group(s) reused` : ''}\n`);
    } else if (event.type === 'review_batch_done') {
      await sendText(client, sessionId, `✓ **Review batch ${event.batch}** — ${event.checked}/${event.assigned} checks with evidence${event.incomplete ? `; ${event.incomplete} coverage gap(s)` : ''}\n`);
    } else if (event.type === 'review_progress_blocked') {
      await sendText(client, sessionId, `⚠ Review stopped after ${event.consecutiveBatches} consecutive batches with no accepted evidence (${event.reason}). Pending work was preserved.\n`);
    } else if (event.type === 'review_batch_interrupted') {
      await sendText(client, sessionId, `⚠ **Review batch ${event.batch} interrupted** — ${event.code}; remaining scope will be marked incomplete, no automatic retry\n`);
    } else if (event.type === 'review_checkpoint_resumed') {
      await sendText(client, sessionId, `↪ **Review checkpoint** — resuming ${event.completed}/${event.total} completed units\n`);
    } else if (event.type === 'review_checkpoint_rejected') {
      await sendText(client, sessionId, `↪ **Review checkpoint** — previous results not reused because the scope or repository changed\n`);
    } else if (event.type === 'review_checkpoint_error') {
      await sendText(client, sessionId, `⚠ **Review checkpoint** — could not persist: ${event.message}\n`);
    } else if (event.type === 'role_start') {
      if (event.role === primaryExecutionRole) await ensureFirstTaskStepInProgress();
      // Keep the previous completed role's usage visible until the inner ACP
      // provider reports usage for this role.
      await sendText(client, sessionId, `\n\n${roleLine(event)}\n`);
    } else if (event.type === 'role_done') {
      await sendText(client, sessionId, `\n${roleLine(event, true)}\n`);
    } else if (event.type === 'role_thought_chunk' || event.type === 'role_commentary_chunk') {
      // Thought chunks are passed through byte-for-byte. Commentary remains an
      // internal progress event, never an agent_message_chunk: ACP clients such
      // as clients concatenate those chunks into the final answer.
      const update = userFacingRoleUpdate(event);
      if (update) await client.notify(acp.methods.client.session.update, { sessionId, update });
    } else if (event.type === 'task_plan_progress') {
      // Each read-only review batch covers only a subset of the contract. An
      // inner reviewer must not mark the entire outer plan complete early.
      if (event.role === primaryExecutionRole && currentWorkflowMode !== 'review' && !implementationStageActive) await applyTaskProgress(event.items);
    } else if (event.type === 'role_usage') {
      if (event.contextWindow) await sendUsage(client, sessionId, event.usage.totalTokens ?? 0, event.contextWindow);
    } else if (event.type === 'role_tool_event') {
      // ACP v1 tool-call IDs belong to the inner invocation, not this outer
      // session. Namespace them and enforce create-before-update in one place.
      // Only the host presentation layer decides which command cards are visible.
      // Providers and the workflow always emit unmodified semantic telemetry.
      const key = `${event.provider ?? ''}:${event.innerSessionId ?? event.invocationId ?? ''}`;
      if (!toolKindsByInvocation.has(key)) toolKindsByInvocation.set(key, new Map());
      const options = toolPresentationForProvider(event.provider);
      const update = sanitizeToolUpdateForUi(event.update, {
        toolKinds: toolKindsByInvocation.get(key),
        showCommandToolCalls: options?.showCommandToolCalls === true,
        showSuccessfulCommandOutput: options?.showSuccessfulCommandOutput === true,
      });
      if (update) await forwardToolCall({ ...event, update });
    } else if (event.type === 'role_native_update') {
      // Preserve native final-answer chunks, media and other data-plane updates;
      // defensively reject Codex commentary mislabeled as a native update.
      const update = userFacingRoleUpdate(event);
      if (update) await client.notify(acp.methods.client.session.update, { sessionId, update });
    } else if (event.type === 'git_metadata_drift') {
      const fields = event.fields?.join(', ') || 'unknown';
      const interval = event.command ? ` (during: ${event.command.slice(0, 160)})` : '';
      await sendText(client, sessionId, `⚠ **Git metadata drift** — ${event.stage}${interval}: ${fields}. Git state preserved; source not established.\n`);
    } else if (event.type === 'workspace_drift') {
      const details = [];
      if (event.changedPaths?.length) details.push(`paths: ${event.changedPaths.join(', ')}`);
      if (event.gitFields?.length) details.push(`Git: ${event.gitFields.join(', ')}`);
      const suffix = details.length ? ` (${details.join('; ')})` : '';
      await sendText(client, sessionId, `↻ **${event.role}** — workspace changed concurrently; reconciling with current state${suffix}\n`);
    } else if (event.type === 'workspace_drift_reconciled') {
      await sendText(client, sessionId, `✓ **${event.role}** — reconciled against the current workspace\n`);
    } else if (event.type === 'invocation_retry_scheduled') {
      await sendText(client, sessionId, `↻ **${event.role}** — bounded read-only retry ${event.attempt}/${event.attempts} (${event.reason}). Completed workflow stages will not be repeated.\n`);
    } else if (event.type === 'invocation_recovered') {
      await sendText(client, sessionId, `✓ **${event.role}** — invocation recovered after ${event.attempt} attempts.\n`);
    } else if (event.type === 'invocation_retry_skipped' || event.type === 'invocation_recovery_exhausted') {
      await sendText(client, sessionId, `⚠ **${event.role}** — recovery ${event.type === 'invocation_retry_skipped' ? 'not safe' : 'exhausted'} (${event.reason}).\n`);
    } else if (event.type === 'review_provider_retry') {
      await sendText(client, sessionId, `↻ **${event.role}** — inner provider cancelled unexpectedly; retrying this read-only review once (attempt ${event.attempt}/2). Completed implementation stages will not be repeated.\n`);
    } else if (event.type === 'review_interrupted') {
      await sendText(client, sessionId, `⚠ **Independent review interrupted** — ${event.reason}; ${event.attempts} attempt(s). Saved implementation is preserved; acceptance remains pending.\n`);
    } else if (event.type === 'role_cancelled') {
      await sendText(client, sessionId, `⊘ **${event.role}** — ${event.message}\n`);
    } else if (event.type === 'role_error') {
      await sendText(client, sessionId, `✗ **${event.role}** — ${event.message}\n`);
    } else if (event.type === 'route') {
      currentWorkflowMode = event.policy.mode;
      if (typeof onSuggestedTitle === 'function') {
        try {
          await onSuggestedTitle(event.classification?.title);
        } catch (error) {
          // Conversation naming is presentation metadata, not control flow. A
          // client that cannot accept a title update must not fail the task.
          console.error(`[acp] failed to publish session title for ${sessionId}: ${error?.message ?? error}`);
        }
      }
      primaryExecutionRole = event.policy.mode === 'change'
        ? event.policy.coder
        : event.policy.mode === 'review'
          ? event.policy.reviewer
          : event.policy.mode === 'investigate'
            ? 'investigator'
            : event.policy.mode === 'plan'
              ? 'planner'
              : null;

      // The ACP Plan widget represents the user task plan, not the internal
      // model-orchestration route. Keep the route visible in the transcript,
      // then replace/populate the native plan once the planner has produced the
      // grounded task steps. ACP plan updates are full snapshots, so this is a
      // natural fit for Zed's Plan UI.
      const lines = [`\n### Preliminary route: ${event.policy.mode} / ${event.policy.tier}`];
      for (const [i, step] of event.preview.entries()) {
        const profile = step.profile ? ` (${step.profile}${step.model ? ` / ${step.model}` : ''})` : '';
        const conditional = step.conditional ? ` — conditional${step.note ? `: ${step.note}` : ''}` : '';
        lines.push(`${i + 1}. **${step.role}**${profile}: ${step.purpose}${conditional}`);
      }
      lines.push('');
      await sendText(client, sessionId, `${lines.join('\n')}\n`);
    } else if (event.type === 'plan') {
      await startTaskPlan(event.plan?.steps ?? []);
    } else if (event.type === 'implementation_reconciliation_proposed') {
      await sendText(client, sessionId, `↻ **Implementation reconciliation** — checkout requires review; confirmation needed for this state\n`);
    } else if (event.type === 'implementation_reconciliation_approved') {
      await sendText(client, sessionId, `✓ **Implementation reconciliation** — ${event.automatic ? 'safely accepted automatically' : 'confirmed'}; prior stages retained and integration checks required\n`);
    } else if (event.type === 'implementation_plan_reused') {
      await sendText(client, sessionId, '↪ **Implementation** — using the saved Plan (no silent replanning)\n');
    } else if (event.type === 'implementation_stage_start') {
      implementationStageActive = true;
      const presentation = implementationStagePresentation(event);
      await sendText(client, sessionId, `${presentation.summary}\n`);
      // The native Plan contains original, untruncated descriptions.
      if (!nativePlan.length) await sendText(client, sessionId, `${presentation.details}\n`);
    } else if (event.type === 'implementation_stage_done') {
      implementationStageActive = false;
      // Map stable S-identifiers instead of assuming the current Zed plan
      // starts at S1 (it may be a restored checkpoint).
      for (const id of event.completedStepIds ?? []) {
        const index = Number(id.slice(1)) - 1;
        if (/^S\d+$/.test(id) && index >= 0 && index < nativePlan.length) nativePlan[index].status = 'completed';
      }
      const next = nativePlan.find((step) => step.status === 'pending');
      if (next && !nativePlan.some((step) => step.status === 'in_progress')) next.status = 'in_progress';
      if (nativePlan.length) await pushNativePlan();
      await sendText(client, sessionId, `✓ **Implementation ${event.index}/${event.total}** — ${event.completedSteps} step(s) implemented; checkpoint saved (acceptance pending)\n`);
    } else if (event.type === 'implementation_stage_interrupted') {
      implementationStageActive = false;
      await sendText(client, sessionId, `⚠ **Implementation ${event.stage}** — incomplete (${event.reason}); no automatic retry${event.problems?.length ? `\n${event.problems.slice(0, 5).map((p) => `- ${String(p).slice(0, 240)}`).join('\n')}` : ''}\n`);
    } else if (event.type === 'implementation_checkpoint_resumed') {
      for (const id of event.completedStepIds ?? []) {
        const index = Number(id.slice(1)) - 1;
        if (/^S\d+$/.test(id) && index >= 0 && index < nativePlan.length) nativePlan[index].status = 'completed';
      }
      const next = nativePlan.find((step) => step.status === 'pending');
      if (next) next.status = 'in_progress';
      if (nativePlan.length) await pushNativePlan();
      await sendText(client, sessionId, `↪ **Implementation** — restored ${event.completed}/${event.total} completed stage(s)\n`);
    } else if (event.type === 'implementation_checkpoint_rejected') {
      await sendText(client, sessionId, `⚠ **Implementation checkpoint** — not reusable (${event.reason})\n`);
    } else if (event.type === 'coding_workspace_ready') {
      await sendText(client, sessionId, '✓ **workspaceWrite** — ready\n');
    } else if (event.type === 'verification_start') {
      await sendText(client, sessionId, '▶ **verification** — running configured checks\n');
    } else if (event.type === 'verification_done') {
      await sendText(client, sessionId, `${event.ok ? '✓' : '✗'} **verification** — ${event.ok ? 'passed' : 'failed'}${event.changedPaths?.length ? `; updated ${event.changedPaths.length} project artifact(s)` : ''}\n`);
    } else if (event.type === 'workspace_mutations' && event.unreportedFiles?.length) {
      const origin = event.stage === 'verification' ? 'verification command side effects' : 'additional workspace mutations';
      await sendText(client, sessionId, `↳ **${event.stage}** — detected ${event.unreportedFiles.length} ${origin}: ${event.unreportedFiles.join(', ')}\n`);
    } else if (event.type === 'fix_round') {
      await sendText(client, sessionId, `↻ **fix round ${event.round}/${event.maxRounds}**\n`);
    } else if (event.type === 'fix_resolution') {
      await sendText(client, sessionId, `↳ **Fix decision:** ${event.decision ?? 'unresolved'}${event.reason ? ` · ${String(event.reason).slice(0, 120)}` : ''}\n`);
    } else if (event.type === 'complete') {
      if (event.result?.planCompleted !== false) await completeTaskPlan();
      if (['needs_user_decision', 'implementation_blocked', 'completed_with_findings', 'review_interrupted'].includes(event.result?.status)) {
        await sendText(client, sessionId, `\n**Execution outcome:** ${event.result.status}. Saved work and remaining verification limits are retained; use \`/status\` for details.\n`);
      }
    }
  };
  handleEvent.permission = forwardToolCall.permission;
  return handleEvent;
}
async function publishSessionTitle(client, sessionId, session, suggestedTitle, fallbackTask = '') {
  if (session.title) return session.title;
  const title = compactSessionTitle(suggestedTitle, fallbackTask);
  if (!title) return '';
  session.title = title;
  await client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'session_info_update', title },
  });
  return title;
}

const app = acp
  .agent({ name: projectName })
  .onRequest(acp.methods.agent.initialize, (ctx) => {
    outerClientCapabilities = ctx.params.clientCapabilities ?? null;
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { resume: {}, additionalDirectories: {} },
        mcpCapabilities: { acp: false, http: true, sse: false },
      },
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    const { sessionId, session, config: baseConfig } = await runtime.createSession(ctx.params);
    ensureCodexNativeControlState(session);
    // ACP clients such as Zed install the session on their side only after the
    // session/new response arrives. Advertising commands before returning can
    // race that installation and the notification may be ignored. Defer one
    // event-loop turn so /review-commit and project skills populate the slash UI.
    setImmediate(() => {
      advertiseCommands(ctx.client, sessionId, ctx.params.cwd).catch((error) => {
        console.error(`[acp] failed to advertise commands for ${sessionId}: ${error.message}`);
      });
    });
    return { sessionId, modes: codexAgentModeState(session), configOptions: allSessionConfigOptions(baseConfig, session) };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    const session = await restoreSession(ctx.params);
    const latestExecution = await runtime.getExecutionView(ctx.params.sessionId);
    if (latestExecution?.status === 'interrupted') {
      await sendText(ctx.client, ctx.params.sessionId,
        `↪ Previous execution was interrupted. Saved checkpoints remain authoritative. Use \`/status\` or \`/checkpoint\` to inspect before resuming.\n`);
    }
    await replayTranscript(ctx.client, ctx.params.sessionId, session.transcript);
    if (session.title) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'session_info_update', title: session.title },
      });
    }
    if (session.legacyRecovered) {
      await sendText(ctx.client, ctx.params.sessionId,
        'This thread predates durable orchestrator sessions. It has been reopened, but prior agent-side coordination context could not be reconstructed; future turns will persist normally.');
      session.legacyRecovered = false;
      await persistSession(ctx.params.sessionId, session);
    }
    setImmediate(() => {
      advertiseCommands(ctx.client, ctx.params.sessionId, session.cwd).catch((error) => {
        console.error(`[acp] failed to advertise commands for loaded session ${ctx.params.sessionId}: ${error.message}`);
      });
    });
    const baseConfig = await getBaseConfig(session.repoRoot);
    return { modes: codexAgentModeState(session), configOptions: allSessionConfigOptions(baseConfig, session) };
  })
  .onRequest(acp.methods.agent.session.resume, async (ctx) => {
    const session = await restoreSession(ctx.params);
    const latestExecution = await runtime.getExecutionView(ctx.params.sessionId);
    if (latestExecution?.status === 'interrupted') {
      await sendText(ctx.client, ctx.params.sessionId,
        `↪ Previous execution was interrupted. Saved checkpoints remain authoritative. Use \`/status\` or \`/checkpoint\` to inspect before resuming.\n`);
    }
    if (session.title) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'session_info_update', title: session.title },
      });
    }
    // ACP resume restores context without replaying old conversation history.
    if (session.legacyRecovered) {
      session.legacyRecovered = false;
      await persistSession(ctx.params.sessionId, session);
    }
    setImmediate(() => {
      advertiseCommands(ctx.client, ctx.params.sessionId, session.cwd).catch((error) => {
        console.error(`[acp] failed to advertise commands for resumed session ${ctx.params.sessionId}: ${error.message}`);
      });
    });
    const baseConfig = await getBaseConfig(session.repoRoot);
    return { modes: codexAgentModeState(session), configOptions: allSessionConfigOptions(baseConfig, session) };
  })
  .onRequest(acp.methods.agent.session.setMode, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId) ?? await restoreSession(ctx.params, { allowLegacyAdoption: false });
    setCodexAgentMode(session, ctx.params.modeId);
    await persistSession(ctx.params.sessionId, session);
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: session.codexAgentMode },
    });
    const baseConfig = await getBaseConfig(session.repoRoot);
    const configOptions = allSessionConfigOptions(baseConfig, session);
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    });
    return {};
  })
  .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => serializeConfigUpdate(ctx.params.sessionId, async () => {
    const session = sessions.get(ctx.params.sessionId) ?? await restoreSession(ctx.params, { allowLegacyAdoption: false });
    const baseConfig = await getBaseConfig(session.repoRoot);
    ensureSessionConfigState(session, baseConfig);
    ensureCodexNativeControlState(session);
    // Preserve the pre-update session on an invalid option or failed save.
    // Preset application replaces a complete assignment map synchronously.
    const before = {
      roleAssignments: session.roleAssignments,
      fastModeOverride: session.fastModeOverride,
      profileOverrides: session.profileOverrides,
      selectedProfile: session.selectedProfile,
      roleEditor: session.roleEditor,
      codexAgentMode: session.codexAgentMode,
      codexCollaborationMode: session.codexCollaborationMode,
    };
    let handledNatively;
    try {
      handledNatively = setCodexNativeConfigOption(session, ctx.params.configId, ctx.params.value);
      if (!handledNatively) setSessionConfigOption(baseConfig, session, ctx.params.configId, ctx.params.value);
      await persistSession(ctx.params.sessionId, session);
    } catch (error) {
      Object.assign(session, before);
      throw error;
    }
    if (handledNatively && ctx.params.configId === CODEX_AGENT_MODE_CONFIG_ID) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: session.codexAgentMode },
      });
    }
    const configOptions = allSessionConfigOptions(baseConfig, session);
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    });
    return { configOptions };
  }))
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw new Error(`Unknown session: ${ctx.params.sessionId}`);
    const turnControls = snapshotCodexTurnControls(session);
    const rawText = extractPromptText(ctx.params.prompt);
    const mediaBlocks = supplementalPromptBlocks(ctx.params.prompt);
    const taskText = taskTextForPrompt(ctx.params.prompt);
    if (!taskText) {
      await sendText(ctx.client, ctx.params.sessionId, 'No usable prompt content was provided.');
      return { stopReason: 'end_turn' };
    }

    const { skills } = await availableCommands(session.cwd);
    // Refresh the full command snapshot on every accepted turn as well, so
    // newly-added project skills become visible without restarting the thread.
    advertiseCommands(ctx.client, ctx.params.sessionId, session.cwd).catch((error) => {
      console.error(`[acp] failed to refresh commands for ${ctx.params.sessionId}: ${error.message}`);
    });
    // These commands are observation-only. Never route them through a model:
    // the presence of an unfinished saved Plan must not start Change.
    const decideCommand = rawText.match(/^\/decide(?:\s+(.+))?$/i);
    if (decideCommand) {
      const args = (decideCommand[1] ?? '').trim().split(/\s+/).filter(Boolean);
      if (args.length < 1 || args.length > 2) {
        await sendText(ctx.client, ctx.params.sessionId, 'Usage: `/decide [gate-id] <option>`. Inspect `/decisions` first.');
      } else {
        try {
          const decision = await runtime.resolveQualityDecision(ctx.params.sessionId, session, {
            gateId: args.length === 2 ? args[0] : null, optionId: args.at(-1),
          });
          await sendText(ctx.client, ctx.params.sessionId, decision.status === 'invalidated'
            ? `Gate \`${decision.id}\` invalidated by changed state. No authorization was granted; reassess the task.`
            : `Explicit decision recorded for gate \`${decision.id}\`: \`${decision.selection}\`. This does not run a coder or bypass tool permissions.`);
        } catch (error) { await sendText(ctx.client, ctx.params.sessionId, `Decision not applied: ${error.message}`); }
      }
      return { stopReason: 'end_turn' };
    }
    const routingCommand=rawText.match(/^\/routing\s+report(?:\s+([a-zA-Z0-9._-]{1,160}))?\s*$/i);
    if(routingCommand){
      try {const report=await runtime.getRoutingReport(ctx.params.sessionId,
        routingCommand[1]?{runId:routingCommand[1]}:{});
        await sendText(ctx.client,ctx.params.sessionId,`### Routing report (telemetry only)\n\n${JSON.stringify({status:report.status,counters:report.counters,rates:report.rates,distributions:report.distributions,usage:report.usage,coverage:report.coverage},null,2)}\n\nSemantic accuracy: NOT_VERIFIED (no independent ground truth in execution traces). No model calls.`);
      }catch {await sendText(ctx.client,ctx.params.sessionId,'Routing report unavailable (trace read error).');}
      return {stopReason:'end_turn'};
    }
    const efficiencyCommand = rawText.match(/^\/efficiency(?:\s+(.*?))?\s*$/i);
    if (efficiencyCommand) {
      const args = (efficiencyCommand[1] ?? '').trim();
      if (args === 'history' || args === '') {
        const metrics = args === 'history'
          ? await runtime.getEfficiencyHistory(ctx.params.sessionId)
          : runtime.getEfficiencyView(ctx.params.sessionId);
        const lines = metrics.roles?.map(r => `- ${r.role ?? 'unknown'} / ${r.model ?? 'unknown'}: ${r.calls} calls, ${r.failed} incomplete/failed; observed input ${r.knownInputTokens ?? 'unknown'} (${r.inputCoverage}/${r.calls} covered), output ${r.knownOutputTokens ?? 'unknown'} (${r.outputCoverage}/${r.calls} covered)${r.contextProfileCoverage !== undefined ? `; prepared chars ${r.preparedCharacters ?? 'unknown'} (${r.contextProfileCoverage}/${r.calls}), peak ctx ${r.peakContextTokens ?? 'unknown'} (${r.contextCoverage}/${r.calls}), tool calls ${r.toolCalls ?? 'unknown'}` : ''}${r.numericOverflow ? ' [numeric overflow: totals unavailable]' : ''}`) ?? [];
        await sendText(ctx.client, ctx.params.sessionId, [`### Efficiency ${args === 'history' ? 'history' : 'session'}`, ...(metrics.enabled === false ? [metrics.reason] : lines.length ? lines : ['No efficiency records available.']), '', ...(metrics.truncated ? ['Warning: bounded telemetry window reached; some invocations are omitted and older runs may be missing.'] : []), 'Usage totals are only known observations, not context occupancy. Prepared characters are not tokens. Missing usage is not zero. Use /efficiency runs, /efficiency run <id>, or /efficiency export. No model calls were made.'].join('\n'));
        return { stopReason: 'end_turn' };
      }
      if (args === 'coverage') {
        const report = runtime.getEfficiencyReport(ctx.params.sessionId);
        const readiness = efficiencyReadiness(report.runs);
        const c = readiness.coverage;
        await sendText(ctx.client,ctx.params.sessionId,[
          '### Efficiency coverage', `Invocations: ${readiness.invocations}`,
          `Prepared context: ${c.composition}/${readiness.invocations}`,
          `Provider boundary: ${c.boundary}/${readiness.invocations}`,
          `Context occupancy: ${c.occupancy}/${readiness.invocations}`,
          `Exact input/output: ${c.exactInput}/${c.exactOutput} of ${readiness.invocations}`,
          `Consistent timing: ${c.timing}/${readiness.invocations}`,
          `Task body categorized: ${c.categorized}/${readiness.invocations}; large unclassified: ${c.largeUnclassified}`, 
          `Tool observations v2: ${c.toolsObserved}/${readiness.invocations}; unknown kinds=${c.toolUnknownKinds}; unknown content=${c.toolUnknownContent}; truncated invocations=${c.toolTruncated}`,
          `Provider token reporting: ${readiness.providerTokenUsage}`,
          ...(readiness.problems.length ? [`Gaps: ${readiness.problems.join(', ')}`] : []),
          '',readiness.note,
        ].join('\n'));
        return {stopReason:'end_turn'};
      }
      if (args === 'runs') {
        const summary = runtime.getEfficiencyView(ctx.params.sessionId);
        const ids = summary.retainedRuns;
        const all = runtime.getEfficiencyRunIndex(ctx.params.sessionId);
        await sendText(ctx.client, ctx.params.sessionId, [`### Efficiency runs (${ids} retained)`,
          ...all.map(r => `- ${r.runId}: ${r.status}; outcome=${r.outcome}; group=${r.executionGroupId}; ${r.invocations} invocations; ${r.completedAt ?? 'unknown time'}`),
          '', 'Use /efficiency run <id> or /efficiency export [id].'].join('\n'));
        return { stopReason: 'end_turn' };
      }
      const detail = args.match(/^(run|export)(?:\s+([A-Za-z0-9._/-]{1,128}))?$/);
      if (detail && (detail[1] === 'export' || detail[2])) {
        const report = runtime.getEfficiencyReport(ctx.params.sessionId, detail[2] ?? null);
        if (!report.runs.length) {
          await sendText(ctx.client, ctx.params.sessionId, 'No matching efficiency run is available.');
          return { stopReason: 'end_turn' };
        }
        if (detail[1] === 'export') {
          await sendText(ctx.client, ctx.params.sessionId, `### Efficiency JSON export\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n\nOnly allowlisted counters and identifiers are included. No prompts, paths or tool contents.`);
        } else {
          const run = report.runs[0];
          const items = run.invocations.map(inv => {
            const c = inv.contextOccupancy;
            const p = inv.contextProfile;
            const sections = p?.sections?.filter(s => s.included).map(s => `${s.kind}=${s.characters ?? '?'}ch`).join(', ') ?? 'unknown';
            const sub = p?.contextSubsections?.filter(s => s.characters).map(s => `${s.kind}=${s.characters}ch`).join(', ') ?? 'unknown';
            const body = p?.taskBody?.sections?.filter(s=>s.characters).map(s=>`${s.kind}=${s.characters}ch`).join(', ') ?? 'unknown';
            const timeline = inv.contextTimeline;
            const router = inv.routerContext ? `; router mode=${inv.routerContext.mode},selected=${inv.routerContext.selected},reason=${inv.routerContext.reason},projected=${inv.routerContext.projectedCharacters}ch` : '';
            const sources = p?.instructionSources?.filter(s=>s.characters).map(s=>`${s.scope}:${s.characters}ch`).join(', ') ?? 'unknown';
            return `- ${inv.role ?? 'unknown'} / ${inv.model ?? 'unknown'} (${inv.invocationId}): ${inv.status}, ${inv.elapsedMs ?? '?'}ms, stage=${inv.stageId ?? '-'}, batch=${inv.reviewBatch ?? '-'}, fix=${inv.fixRound ?? '-'}\n  prepared ${p?.promptCharacters ?? '?'} chars; blocks: ${sections}; context breakdown: ${sub}; instruction sources: ${sources}; task body: ${body}${router}; provider boundary ${inv.providerPromptProfile?.characters ?? '?'}ch; attachments ${p?.supplementalBlocks ?? '?'}\n  context first/peak/last ${c.first ?? '?'}/${c.peak ?? '?'}/${c.last ?? '?'} of ${c.window ?? '?'}; updates=${c.updates}; tools=${inv.toolCalls}${inv.toolMetrics ? ` (v2 completed=${inv.toolMetrics.completed}, failed=${inv.toolMetrics.failed}, cancelled=${inv.toolMetrics.cancelled}, incomplete=${inv.toolMetrics.incomplete}; kinds=${Object.entries(inv.toolMetrics.kinds).map(([k,v])=>`${k}:${v}`).join(',')||'-'}; content=${inv.toolMetrics.contentCharacters ?? '?'}ch/${inv.toolMetrics.contentUtf8Bytes ?? '?'}B; content-unknown=${inv.toolMetrics.contentCoverage?.unknown ?? '?'})` : ''}; input=${inv.usage?.inputTokens ?? '?'}, output=${inv.usage?.outputTokens ?? '?'}`;
          });
          await sendText(ctx.client, ctx.params.sessionId, [`### Efficiency run ${run.runId}`, `Status: ${run.status}; group=${run.executionGroupId ?? 'unknown'}; invocations: ${run.invocations.length}`,
          `Outcome: ${run.outcome?.category ?? 'unknown'}; review=${run.outcome?.reviewVerdict ?? '?'}; checked=${run.outcome?.reviewChecked ?? '?'}/${run.outcome?.reviewTotal ?? '?'}; findings=${run.outcome?.reviewFindings ?? '?'}; verification=${run.outcome?.verificationDisposition ?? '?'}; stages=${run.outcome?.completedStages ?? '?'}/${run.outcome?.totalStages ?? '?'}`, ...items.slice(0, 40), ...(items.length > 40 ? [`... ${items.length - 40} more invocations omitted from display; use /efficiency export ${run.runId}`] : []), '', 'Characters are not tokens; ACP occupancy is not cumulative usage; unknown values are marked ?.'].join('\n'));
        }
        return { stopReason: 'end_turn' };
      }
      await sendText(ctx.client, ctx.params.sessionId, 'Usage: /efficiency [history | runs | run <id> | export [id] | coverage]');
      return { stopReason: 'end_turn' };
    }
    const qualityCommand = rawText.match(/^\/(evidence|findings|recovery|decisions)\s*$/i);
    if (qualityCommand) {
      await sendText(ctx.client, ctx.params.sessionId, await qualityView(session, qualityCommand[1].toLowerCase()));
      return { stopReason: 'end_turn' };
    }
    const diagnosticCommand = rawText.match(/^\/(status|trace|checkpoint|runs|plans)(?:\s+(.*))?$/i);
    if (diagnosticCommand) {
      const kind = diagnosticCommand[1].toLowerCase();
      if (kind === 'plans') {
        const tasks = implementationTaskSummaries(session);
        await sendText(ctx.client, ctx.params.sessionId, tasks.length
          ? ['### Saved implementation tasks', ...tasks.map((task) =>
            `- ${task.active ? '**Active**' : 'Archived'} · ${task.status} · task \`${task.taskId}\` · plan \`${task.planId ?? 'unavailable'}\` · ${task.completedStages.length} completed · ${String(task.goal ?? 'Plan missing (legacy checkpoint)').slice(0, 180)}`),
            '', 'To resume an archived Plan: `Продолжи реализацию плана <plan-id>` or provide its full task ID. This is an explicit Change request.'].join('\n')
          : 'No saved implementation tasks.');
      } else if (kind === 'checkpoint') {
        const impl = session.implementationCheckpoint;
        const review = session.reviewCheckpoint;
        await sendText(ctx.client, ctx.params.sessionId, [
          '### Persisted checkpoints',
          impl ? `Implementation: **${impl.status ?? 'unknown'}** · ${impl.completedStages?.length ?? 0} completed stage(s) · Plan \`${impl.planId ?? 'unknown'}\`` : 'Implementation: none',
          ...(impl?.interruption ? [
            `Last interruption: **${String(impl.interruption.reason ?? 'unknown').slice(0, 100)}**${impl.interruption.stage ? ` · ${String(impl.interruption.stage).slice(0, 32)}` : ''}`,
            ...(impl.interruption.problems ?? []).slice(0, 8).map((problem) => `- ${String(problem).slice(0, 240)}`),
          ] : []),
          review ? ([2,3,4].includes(review.version) ? `Review: ${review.records?.length ?? 0}/${review.unitsTotal ?? "?"} verified unit(s) · ${review.status}${review.version >= 3 ? ` · Operation \`${review.operation?.id ?? 'unknown'}\`` : ''}` : `Review: ${review.completedBatches?.length ?? 0} completed batch(es)`) : 'Review: none',
        ].join('\n'));
      } else if (kind === 'runs') {
        const runs = await runtime.listExecutionRuns(ctx.params.sessionId, { limit: 10 });
        await sendText(ctx.client, ctx.params.sessionId, executionRunsMarkdown(runs));
      } else if (kind === 'trace') {
        const args = (diagnosticCommand[2] ?? '').trim().split(/\s+/).filter(Boolean);
        const count = /^\d+$/.test(args[0] ?? '') ? Number(args.shift()) : 20;
        const runId = args[0] ?? null;
        if (args.length > 1 || (runId && !/^[a-zA-Z0-9._-]{1,160}$/.test(runId))) {
          await sendText(ctx.client, ctx.params.sessionId, 'Usage: `/trace [count] [run-id]`');
        } else {
          const events = await runtime.getExecutionTrace(ctx.params.sessionId, { limit: Math.min(50, Math.max(1, count)), runId });
          await sendText(ctx.client, ctx.params.sessionId, executionTraceMarkdown(events));
        }
      } else {
        const runId = (diagnosticCommand[2] ?? '').trim() || null;
        if (runId && !/^[a-zA-Z0-9._-]{1,160}$/.test(runId)) {
          await sendText(ctx.client, ctx.params.sessionId, 'Usage: `/status [run-id]`');
        } else {
          const view = await runtime.getExecutionView(ctx.params.sessionId, runId);
          await sendText(ctx.client, ctx.params.sessionId, executionOverviewMarkdown(view, runId ? null : session));
        }
      }
      return { stopReason: 'end_turn' };
    }

    if (/^\/skills(?:\s|$)/i.test(rawText)) {
      const rows = [...skills.values()].map((skill) => `- \`/${skill.name}\` — ${skill.description || 'no description'} (${skill.scope})`);
      await sendText(ctx.client, ctx.params.sessionId, rows.length ? `### Available skills\n${rows.join('\n')}\n\nIf your ACP client has not refreshed a dynamic skill slash command yet, use \`/skill <name> [task]\` as a stable fallback.` : 'No skills found in ~/.agents/skills or <project>/.agents/skills.');
      return { stopReason: 'end_turn' };
    }

    const invocation = parseSlashInvocation(rawText || taskText, skills);
    if (invocation.error) {
      await sendText(ctx.client, ctx.params.sessionId, invocation.error);
      return { stopReason: 'end_turn' };
    }
    // Host-specific interfaces are supplied as bridges; runtime owns turns,
    // supersession, implementation checkpoints and transcript persistence.
    let baseConfig = null;
    const reporter = createAcpReporter(ctx.client, ctx.params.sessionId, {
      toolPresentationForProvider: (name) => baseConfig?.providers?.[name] ?? {},
      onSuggestedTitle: async (suggestedTitle) => {
        if (session.title) return;
        const title = await publishSessionTitle(ctx.client, ctx.params.sessionId, session, suggestedTitle, invocation.task);
        if (title) await persistSession(ctx.params.sessionId, session);
      },
    });
    try {
      const { result, assistantText } = await runtime.runTurn({
        sessionId: ctx.params.sessionId,
        session,
        signal: ctx.signal,
        onStarted: () => sendText(ctx.client, ctx.params.sessionId, 'Starting orchestrated task…'),
        invocation,
        rawText,
        mediaBlocks,
        reporter,
        onConfigReady: (loadedConfig) => { baseConfig = loadedConfig; },
        controls: {
          planOnly: turnControls.planOnly,
          streamFinalResponse: true,
          providerOptionsForRole: (role) => ({
            agentMode: turnControls.agentMode,
            collaborationMode: turnControls.collaborationModeForRole(role),
          }),
        },
        providerBridge: {
          clientCapabilities: outerClientCapabilities,
          requestPermission: async (innerParams, metadata) => {
            const mapped = await reporter.permission(innerParams, metadata);
            if (!mapped) return { outcome: { outcome: 'cancelled' } };
            return ctx.client.request(acp.methods.client.session.requestPermission, {
              ...mapped, sessionId: ctx.params.sessionId,
            });
          },
          requestElicitation: async (innerParams) => ctx.client.request(acp.methods.client.elicitation.create, {
            ...innerParams,
            ...(typeof innerParams?.sessionId === 'string' ? { sessionId: ctx.params.sessionId } : {}),
          }),
          completeElicitation: async (innerParams) => ctx.client.notify(acp.methods.client.elicitation.complete, innerParams),
        },
        onProviderStateChange: async ({ key, value }) => {
          if (turnControls.planOnly) return;
          if (key !== 'collaboration_mode' || session.codexCollaborationMode === value) return;
          setCodexNativeConfigOption(session, CODEX_COLLABORATION_MODE_CONFIG_ID, value);
          await persistSession(ctx.params.sessionId, session);
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions: allSessionConfigOptions(baseConfig, session) },
          });
        },
      });
      if (!result.responseStreamed) await sendText(ctx.client, ctx.params.sessionId, assistantText);
      return { stopReason: 'end_turn' };
    } catch (error) {
      if (isExpectedCancellation(error)) {
        await sendText(ctx.client, ctx.params.sessionId, cancellationUserMessage(error));
        return { stopReason: 'cancelled' };
      }
      const requestError = outerRequestError(error);
      const failureCode = requestError?.code ?? error?.code;
      await sendText(ctx.client, ctx.params.sessionId, failureCode === 'WORKSPACE_UNSTABLE'
        ? 'Workspace reconciliation stopped because the repository changed during repeated checks. No stale result was published. Inspect `/status` or `/trace` and retry when Git state is stable.'
        : `Task failed: ${requestError.message}`);
      throw requestError;
    }
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    runtime.cancelSession(ctx.params.sessionId);
  });

await reconcileAttachmentStore({ reason: 'startup' }).catch((error) => {
  console.error(`[attachments] startup reconciliation failed: ${error?.message ?? error}`);
});
startAttachmentGc();

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

const connection = app.connect(stream);
await connection.closed;
