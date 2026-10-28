export function agentMessageChunk(text) {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  };
}

export function agentThoughtChunk(text) {
  return {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text },
  };
}

// Commentary is execution progress, not part of the user-facing answer.
// ACP has no separate commentary chunk type: forwarding it as an
// agent_message_chunk concatenates it with the final answer in Zed.
// Keep commentary in workflow events/CLI diagnostics, but never promote it to
// answer text (including if a provider accidentally emits a native update).
export function userFacingRoleUpdate(event) {
  if (event?.type === 'role_commentary_chunk') return null;
  if (event?.type === 'role_thought_chunk') {
    return typeof event.text === 'string' && event.text ? agentThoughtChunk(event.text) : null;
  }
  if (event?.type === 'role_native_update') {
    const update = event.update;
    return update ?? null;
  }
  return null;
}


// These are presentation limits, NOT execution/verification limits. Never
// modify provider results, ACP permission decisions, exit codes or status.
// Native tool payloads may contain large stdout/stderr, binary media or diffs.
const TOOL_PRESENTATION_TEXT_LIMIT = 12_000;
const TOOL_PRESENTATION_TOTAL_LIMIT = 32_000;
const TOOL_PRESENTATION_ITEM_LIMIT = 64;
const truncation = (omitted) => `[ACP presentation truncated: ${omitted} characters omitted; original tool output is not fully displayed]`;
function boundedText(value, limit = TOOL_PRESENTATION_TEXT_LIMIT) {
  if (typeof value !== 'string' || value.length <= limit) return value;
  const keep = Math.max(1, Math.floor((limit - 160) / 2));
  return `${value.slice(0, keep)}\n${truncation(value.length - 2 * keep)}\n${value.slice(-keep)}`;
}
function presentationSize(value) {
  try { return JSON.stringify(value)?.length ?? 0; }
  catch { return Infinity; }
}
function boundedPayload(value, limit) {
  if (typeof value === 'string') return boundedText(value, limit);
  if (presentationSize(value) <= limit) return value;
  return truncation(presentationSize(value));
}
function boundedContent(value) {
  if (!Array.isArray(value)) return boundedPayload(value, TOOL_PRESENTATION_TOTAL_LIMIT);
  const output = [];
  let remaining = TOOL_PRESENTATION_TOTAL_LIMIT;
  const marker = (message) => ({ type: 'content', content: { type: 'text', text: message } });
  for (const item of value.slice(0, TOOL_PRESENTATION_ITEM_LIMIT)) {
    if (remaining <= 0) { output.push(marker('[ACP presentation truncated: additional tool content omitted]')); break; }
    let bounded = item;
    if (item?.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string') {
      const text = boundedText(item.content.text, Math.min(remaining, TOOL_PRESENTATION_TEXT_LIMIT));
      bounded = { ...item, content: { ...item.content, text } };
    } else if (item?.type === 'diff' && presentationSize(item) > Math.min(remaining, TOOL_PRESENTATION_TEXT_LIMIT)) {
      // A partial diff would misleadingly look applicable; omit it instead.
      bounded = marker('[ACP presentation truncated: oversized native diff omitted; inspect the repository for the full change]');
    } else if (presentationSize(item) > remaining) {
      bounded = marker('[ACP presentation truncated: oversized non-text tool block omitted]');
    }
    output.push(bounded);
    remaining -= presentationSize(bounded);
  }
  if (value.length > TOOL_PRESENTATION_ITEM_LIMIT) output.push(marker(`[ACP presentation truncated: ${value.length - TOOL_PRESENTATION_ITEM_LIMIT} additional content items omitted]`));
  return output;
}
/** Bound the outward ACP card only; never use this object as tool evidence. */
export function boundToolUpdateForUi(update) {
  if (!update || typeof update !== 'object') return update;
  const bounded = { ...update };
  if (typeof bounded.title === 'string') bounded.title = boundedText(bounded.title, 2048);
  if (Object.prototype.hasOwnProperty.call(bounded, 'content')) bounded.content = boundedContent(bounded.content);
  if (Object.prototype.hasOwnProperty.call(bounded, 'rawInput')) bounded.rawInput = boundedPayload(bounded.rawInput, 4096);
  if (Object.prototype.hasOwnProperty.call(bounded, 'rawOutput')) {
    const raw = bounded.rawOutput;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      bounded.rawOutput = Object.fromEntries(Object.entries(raw).map(([key, value]) =>
        [key, boundedPayload(value, 8192)]));
    } else bounded.rawOutput = boundedPayload(raw, 8192);
  }
  return bounded;
}

function diffContentOnly(content) {
  if (!Array.isArray(content)) return null;
  return content.filter((item) => item?.type === 'diff');
}

export function sanitizeToolUpdateForUi(update, {
  toolKinds = new Map(),
  showCommandToolCalls = false,
  showSuccessfulCommandOutput = false,
} = {}) {
  const toolCallId = update?.toolCallId;
  if (toolCallId && update?.kind) toolKinds.set(toolCallId, update.kind);
  const kind = update?.kind ?? (toolCallId ? toolKinds.get(toolCallId) : null);

  // Shell commands are useful provider telemetry, but forwarding the execute
  // tool call itself makes Zed render a large `Run Command` card containing the
  // full command line. Keep those events in provider metadata by default and do
  // not surface them in the outer ACP session. File/edit tool calls remain
  // visible, so native ACP diff rendering is preserved.
  //
  // If command cards are explicitly enabled, still hide stdout/stderr from
  // successful commands unless requested. Failed output remains visible in that
  // opt-in mode because it is diagnostic.
  if (kind === 'execute' && !showCommandToolCalls) return null;

  if (kind !== 'execute' || showSuccessfulCommandOutput || update?.status === 'failed') {
    return boundToolUpdateForUi(update);
  }

  const sanitized = { ...update };
  if (Object.prototype.hasOwnProperty.call(update, 'content')) {
    sanitized.content = diffContentOnly(update.content) ?? [];
  }
  if (Object.prototype.hasOwnProperty.call(update, 'rawOutput')) {
    delete sanitized.rawOutput;
  }
  return boundToolUpdateForUi(sanitized);
}

// Host-neutral implementation stage data -> compact ACP transcript labels.
// The original descriptions remain intact in the native ACP Plan entries and
// can also be rendered independently when a client has no Plan widget.
export function implementationStagePresentation(event) {
  const steps = Array.isArray(event?.steps) ? event.steps : [];
  const ids = steps.map((item) => String(item.id ?? '')).filter(Boolean);
  const numeric = ids.map((id) => /^S(\d+)$/u.exec(id)?.[1]).map(Number);
  const sequential = ids.length > 1 && numeric.every((n, index) => Number.isInteger(n) && (index === 0 || n === numeric[index - 1] + 1));
  const range = sequential ? `${ids[0]}–${ids.at(-1)}` : ids.join(', ');
  return {
    summary: `▶ **Implementation ${event.index}/${event.total}**${range ? ` — ${range}` : ''}`,
    details: `Implementation ${event.index}/${event.total}\n\n${steps.map((step) => `${step.id} — ${String(step.description ?? '').trim()}`).join('\n')}`,
    ids,
  };
}

// Read-only execution cockpit: deliberately protocol-agnostic data, rendered
// as ordinary ACP text so existing clients do not need custom UI extensions.
export function executionOverviewMarkdown(view, session = null) {
  if (!view) {
    const checkpoint = session?.implementationCheckpoint;
    return checkpoint
      ? `### Execution status\nNo retained execution trace. Saved implementation checkpoint: **${checkpoint.status ?? 'unknown'}**, ${checkpoint.completedStages?.length ?? 0} stage(s) completed.\n`
      : 'No execution trace exists for this session yet.';
  }
  const lines = [
    '### Execution overview',
    `**Run:** \`${view.runId}\``,
    `**Lifecycle:** ${view.status}${view.resultStatus ? ` · **Outcome:** ${view.resultStatus}` : ''}`,
    `**Phase:** ${view.phase ?? 'not determined'}`,
  ];
  if (view.activeInvocations?.length) {
    lines.push('**Active roles:** ' + view.activeInvocations.map((x) => `${x.role} (${x.provider ?? 'unknown'} / ${x.model ?? 'unknown'})`).join(', '));
  }
  if (view.checkpoint) {
    const checkpoint = view.checkpoint;
    lines.push(`**Saved checkpoint:** ${checkpoint.status ?? 'unknown'} · ${checkpoint.completedStages.length} completed stage(s)${checkpoint.nextStage ? ` · next ${checkpoint.nextStage}` : ''}`);
  } else if (view.stages?.length) {
    const completed = view.stages.filter((x) => x.status === 'completed').length;
    lines.push(`**Stages observed:** ${completed}/${view.stages.length} durably completed`);
  }
  if (view.stages?.length) {
    const total = Math.max(0, ...view.stages.map((stage) => stage.total ?? 0));
    const current = view.stages.find((stage) => stage.status === 'running' || stage.status === 'unconfirmed' || stage.status === 'awaiting_checkpoint_confirmation');
    if (total) lines.push(`**Implementation progress:** ${view.stages.filter((s) => s.status === 'completed').length}/${total} saved stage(s)`);
    if (current) lines.push(`**Current stage:** ${current.id} · ${current.status}`);
  }
  if (view.activity) lines.push(`**Activity:** ${view.activity.roleInvocations} role invocation(s) · ${view.activity.reconciliationChecks} workspace reconciliation(s) · ${view.activity.fixRounds} fix round(s)`);
  if (view.historicalSnapshot) lines.push('**Historical run:** current session checkpoints are not applied to this snapshot.');
  if (view.verification?.status !== 'not_started') lines.push(`**Verification:** ${view.verification.status}`);
  if (view.workspace?.driftCount) lines.push(`**Workspace:** ${view.workspace.status} · ${view.workspace.driftCount} drift observation(s)`);
  if (view.lastDecision) lines.push(`**Last decision:** ${view.lastDecision.decision} (${view.lastDecision.reason ?? 'not specified'})`);
  if (view.quality) lines.push(`**P2 quality:** ${view.quality.evidenceCount} evidence · ${view.quality.openFindings} open finding(s) · ${view.quality.pendingDecisions} pending gate(s) · ${view.quality.recovery?.requiredActions?.join(', ') || 'no recovery actions'}. Use /evidence, /findings, /recovery, /decisions.`);
  if (view.diagnostics?.length) {
    const last = view.diagnostics.at(-1);
    lines.push(`**Diagnostics:** ${view.diagnostics.slice(-3).map((x) => x.code).join(', ')}`);
    if (last.summary) lines.push(`**Reason:** ${last.summary}`);
    if (last.nextAction) lines.push(`**Next step:** ${last.nextAction}`);
  }
  if (view.trace?.degraded || view.trace?.truncated) lines.push('⚠ Diagnostic trace is incomplete; saved checkpoints remain authoritative.');
  if (view.trace?.droppedTelemetry) lines.push(`**Telemetry not retained:** ${view.trace.droppedTelemetry} low-level update(s); native ACP streaming is unaffected.`);
  if (view.status === 'interrupted') lines.push('This run has no confirmed terminal event. Resume only through the existing checkpoint/reconciliation mechanism.');
  return lines.join('\n') + '\n';
}

export function executionTraceMarkdown(events) {
  if (!events?.length) return 'No retained trace events for this session.';
  const rows = ['### Execution trace (most recent events)'];
  for (const event of events) {
    const d = event.data ?? {};
    const c = event.correlation ?? {};
    const target = d.role ?? d.stage ?? '';
    const reason = d.code ?? c.reasonCode ?? d.reason ?? d.decision ?? d.gitFields?.join(', ') ?? '';
    const context = [
      c.invocationId ? `inv ${c.invocationId.slice(0, 8)}` : null,
      c.stageId ? `stage ${c.stageId}` : null,
      c.attempt || d.attempt ? `attempt ${c.attempt ?? d.attempt}` : null,
      d.operationId ? `op ${d.operationId.slice(0, 8)}` : null,
    ].filter(Boolean).join(' · ');
    rows.push(`- \`${event.sequence}\` **${event.kind}**${target ? ` · ${target}` : ''}${reason ? ` · ${reason}` : ''}${context ? ` (${context})` : ''}`);
    if (d.acp) rows.push(`  - ACP: updates=${d.acp.acpUpdateCount ?? '?'}, last=${d.acp.lastAcpUpdateType ?? '?'}, idle=${d.acp.msSinceLastAcpUpdate ?? '?'}ms, outgoingCancel=${d.acp.outgoingCancelCount ?? '?'}, timeout=${d.acp.localTimeoutKind ?? '-'}${d.acp.outgoingCancels?.length ? `; cancel notifications=${d.acp.outgoingCancels.map(x => `${x.reason ?? 'unknown'}:${x.notificationStatus ?? 'unknown'}`).join(',')}` : ''}`);
  }
  return rows.join('\n') + '\n';
}

// Pure presentation for the history of a session; does not invoke models or
// reinterpret checkpoints from older runs as today's saved progress.
export function executionRunsMarkdown(runs) {
  if (!runs?.length) return 'No retained execution runs for this session.';
  return ['### Recent executions', ...runs.map((run) =>
    `- \`${run.runId}\` · **${run.status}**${run.resultStatus ? ` / ${run.resultStatus}` : ''} · ${run.startedAt}${run.diagnosticCode ? ` · ${run.diagnosticCode}` : ''}`,
  ), '', 'Use `/status <run-id>` or `/trace <count> <run-id>` to inspect a historical execution.'].join('\n');
}
