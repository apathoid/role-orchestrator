import { safeNormalizeAcpToolObservation, acpObservationVersion } from './tool-events.mjs';
import { profileProviderPrompt } from '../../efficiency/profiling.mjs';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { AgentProvider } from '../provider.mjs';
import { genericAcpCapabilities } from '../capabilities.mjs';
import { minimalChildEnv } from '../process-env.mjs';
import { parseStructuredStateOrText } from '../../structured-output.mjs';
import { buildTaskPlanProgressContract } from '../../task-plan-progress.mjs';
import { resolveTurnTiming, TurnTimingGuard } from '../turn-timing.mjs';
import { providerCancelledError } from '../errors.mjs';
import { cancellationDetails, cancellationErrorFromSignal, throwIfAborted } from '../../cancellation.mjs';
import { AcpTurnDiagnostics } from './turn-diagnostics.mjs';
import { AcpInvocationGuard, acpInvocationLimits } from './invocation-guard.mjs';
import { terminateAcpChild } from './child-lifecycle.mjs';
import { normalizeFinalMarkdown } from '../../response-normalization.mjs';

function textOf(content) { return content?.type === 'text' && typeof content.text === 'string' ? content.text : ''; }
function promptCaps(init) { return init?.agentCapabilities?.promptCapabilities ?? {}; }
function contentCapabilities(init) {
  const p = promptCaps(init);
  return { images: p.image === true, embeddedResources: p.embeddedContext === true, resourceLinks: true, audio: p.audio === true };
}
function normalizeUsage(update) {
  const used = Number(update?.used), size = Number(update?.size);
  if (!Number.isFinite(used) && !Number.isFinite(size)) return null;
  return { inputTokens: null, outputTokens: null, totalTokens: null, contextUsedTokens: Number.isFinite(used) && used >= 0 ? used : null, contextWindow: Number.isFinite(size) ? size : null };
}

export class GenericAcpProvider extends AgentProvider {
  constructor(name, config, runtime = {}) {
    super(name, config);
    this.runtime = runtime;
    this.child = null;
    this.connection = null;
    this.initializeResponse = null;
    this.startPromise = null;
    this.stderr = '';
    this.activeSessions = new Map();
  }

  async prepare() {
    await this.ensureStarted();
  }

  capabilities() { return genericAcpCapabilities(this.config, this.runtime, this.initializeResponse); }

  resolveCommand() {
    if (!this.config.command && !this.config.binary) throw new Error(`${this.name}: acp-agent provider requires command.`);
    return { command: this.config.command ?? this.config.binary, args: Array.isArray(this.config.args) ? this.config.args.map(String) : [] };
  }

  async ensureStarted() {
    if (this.startPromise) return this.startPromise;
    if (this.connection && this.initializeResponse) return;
    const pending = this.start();
    this.startPromise = pending;
    try { return await pending; }
    finally { if (this.startPromise === pending) this.startPromise = null; }
  }

  async start() {
    const { command, args } = this.resolveCommand();
    const child = spawn(command, args, {
      env: minimalChildEnv({ allow: this.config.envAllowlist ?? [], extra: this.config.env ?? {} }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;
    // ChildProcess 'error' is fatal if unhandled (e.g. missing executable).
    // Race startup RPC against process failure, including a clean early exit.
    const childFailure = new Promise((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`${this.name}: ACP process exited during initialization (${code ?? signal}).`)));
    });
    childFailure.catch(() => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-32_000); });
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const clientApp = acp.client({ name: 'role-orchestrator' })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const sessionId = ctx.params?.sessionId;
        const state = sessionId ? this.activeSessions.get(sessionId) : null;
        if (!state || state.sandboxMode === 'read-only' || typeof this.runtime.requestPermission !== 'function') {
          return { outcome: { outcome: 'cancelled' } };
        }
        state.turnTiming?.pauseIdle();
        try {
          return await this.runtime.requestPermission(ctx.params, {
            provider: this.name,
            role: state.role,
            profileName: state.profileName,
            innerSessionId: sessionId,
          });
        } finally {
          state.turnTiming?.resumeIdle();
        }
      })
      .onNotification(acp.methods.client.session.update, async (ctx) => this.onSessionUpdate(ctx.params));
    const connection = clientApp.connect(stream);
    this.connection = connection;
    connection.closed.finally(() => {
      if (this.connection === connection) { this.connection = null; this.initializeResponse = null; }
    }).catch(() => {});
    try {
      const initialized = await Promise.race([childFailure, connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'role-orchestrator', version: '1' },
        clientCapabilities: { plan: {}, session: { configOptions: { boolean: {} } } },
      })]);
      if (!initialized || initialized.protocolVersion !== acp.PROTOCOL_VERSION ||
        !initialized.agentCapabilities || typeof initialized.agentCapabilities !== 'object') {
        throw new Error(`${this.name}: ACP initialize returned invalid negotiated protocol/capabilities.`);
      }
      this.initializeResponse = initialized;
    } catch (error) {
      await this.close();
      throw new Error(`${this.name}: ACP initialize failed: ${error.message}`, { cause: error });
    }
  }

  async onSessionUpdate(params) {
    const state = this.activeSessions.get(params?.sessionId);
    const update = params?.update;
    if (!state || !update) return;
    // Any session update is observable provider activity and therefore refreshes
    // the idle watchdog, even when the update is not surfaced to the outer UI.
    state.turnTiming?.touch();
    state.turnDiagnostics?.recordUpdate(update.sessionUpdate);
    const text = textOf(update.content);
    if (update.sessionUpdate === 'agent_thought_chunk' && text) return state.onProgress?.({ type: 'reasoning', text });
    if (update.sessionUpdate === 'agent_message_chunk') {
      // ACP message chunks are ordinarily final messages. Preserve optional
      // provider phase markers instead of blending commentary with a later
      // explicitly marked final answer (same contract as Codex ACP).
      const phase = update?._meta?.codex?.phase ?? null;
      if (text) {
        if (phase === 'commentary') await state.onProgress?.({type:'commentary',text});
        else {
          if (phase === 'final_answer') state.finalText += text;
          else state.unphasedText += text;
          await state.onProgress?.({type:'activity',activity:'answer'});
        }
      }
      // Final answer belongs to the OUTER ACP presentation layer. Do not
      // publish unnormalized inner chunks and then repeat the final answer.
      // Reasoning, tool events and plans still stream normally.
      // Non-text media cannot be reconstructed from accumulated finalText.
      if (state.presentToUser && update.content && update.content.type !== 'text')
        await state.onProgress?.({ type: 'content_block', update });
      return;
    }
    if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
      return state.onProgress?.({ type: 'plan_update', items: update.entries.map((e) => ({ text: String(e.content ?? ''), status: e.status, completed: e.status === 'completed' })) });
    }
    if (update.sessionUpdate === 'usage_update') {
      const usage = normalizeUsage(update); if (usage) return state.onProgress?.({ type: 'usage', usage,
        usageObservation:{semantics:'occupancy',scope:'turn',contextUsedTokens:usage.contextUsedTokens,contextWindow:usage.contextWindow},
        contextWindow: usage.contextWindow });
    }
    if (['tool_call','tool_call_update','tool_call_content_chunk'].includes(update.sessionUpdate)) return state.onProgress?.({ type: 'tool_call', update, observation:safeNormalizeAcpToolObservation(update,{version:acpObservationVersion(this.initializeResponse?.protocolVersion ?? acp.PROTOCOL_VERSION,update)}), innerSessionId: params.sessionId });
    if (!['user_message_chunk','session_info_update','available_commands_update','config_option_update','current_mode_update'].includes(update.sessionUpdate)) {
      return state.onProgress?.({ type: 'content_block', update });
    }
  }

  async setConfig(sessionId, id, value) {
    if (!id) return;
    await this.connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: id, value });
  }

  async invoke({ profileName, profile, role, prompt, schemaKind, schema, cwd, sandboxMode='read-only', signal, onProgress, taskPlan=null, promptBlocks=[], mcpServers=[], additionalDirectories=[], presentToUser=false, providerOptions={} }) {
    const started = Date.now();
    const turnDiagnostics = new AcpTurnDiagnostics();
    let sessionId = null;
    const limits = acpInvocationLimits(profile, this.config);
    const guard = new AcpInvocationGuard({ signal, label: `${this.name}: ACP invocation`, ...limits,
      onInterrupt: (phase, error) => {
        if (sessionId) turnDiagnostics.sendCancel(this.connection, acp.methods.agent.session.cancel, sessionId,
          phase, cancellationDetails(signal?.reason)?.reason ?? error?.code ?? null);
        else if (this.activeSessions.size === 0) void this.close();
      },
    });
    try {
    await guard.run(() => this.ensureStarted(), 'initialize');
    const modeId = sandboxMode === 'workspace-write' ? this.config.workspaceModes?.write : this.config.workspaceModes?.readOnly;
    if (!modeId) throw Object.assign(new Error(`${this.name}: no enforceable ACP mode configured for ${sandboxMode}.`), { code: 'CAPABILITY_UNSUPPORTED' });
    const created = await guard.run(() => this.connection.agent.request(acp.methods.agent.session.new,
      { cwd, mcpServers, ...(additionalDirectories.length ? { additionalDirectories } : {}) }), 'session.new');
    sessionId = created.sessionId;
    const state = { role, profileName, sandboxMode, onProgress, finalText: '', unphasedText: '', presentToUser, turnTiming: null, turnDiagnostics };
    this.activeSessions.set(sessionId, state);
    try {
      await guard.run(() => this.connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId }), 'session.setMode');
      await guard.run(() => this.setConfig(sessionId, this.config.modelConfigId ?? 'model', profile.model), 'session.setConfig');
      if (profile.reasoningEffort && this.config.reasoningConfigId) await guard.run(() => this.setConfig(sessionId, this.config.reasoningConfigId, profile.reasoningEffort), 'session.setConfig');
      // Generic ACP agents may expose a provider-specific boolean control for
      // fast service tier. Its ID must be configured explicitly, not guessed.
      if (profile.fastMode !== undefined && this.config.supportsFastMode === true &&
          this.config.fastModeConfigId && profile.supportsFastMode !== false) {
        await guard.run(() => this.setConfig(sessionId, this.config.fastModeConfigId, Boolean(profile.fastMode)), 'session.setConfig');
      }
      for (const [id, value] of Object.entries(providerOptions?.configOptions ?? {})) await guard.run(() => this.setConfig(sessionId, id, value), 'session.setConfig');
      const planContract = buildTaskPlanProgressContract(taskPlan, { mechanism: 'provider native plan/progress mechanism when available' });
      const outputContract = schemaKind && schema
        ? `\n\nOUTPUT CONTRACT:\nReturn one JSON object matching this JSON Schema.\n${JSON.stringify(schema)}`
        : '\n\nUSER-FACING RESPONSE:\nReturn a natural Markdown document, not a code-fenced Markdown source block. Fence only genuine code/data examples.';
      const blocks = [{ type: 'text', text: `${prompt}${planContract}${outputContract}` }];
      const pc = promptCaps(this.initializeResponse);
      for (const block of promptBlocks) {
        if (block?.type === 'text' || block?.type === 'resource_link' || (block?.type === 'image' && pc.image) || (block?.type === 'resource' && pc.embeddedContext) || (block?.type === 'audio' && pc.audio)) blocks.push(block);
      }
      try { await onProgress?.({ type:'prompt_profile', profile: profileProviderPrompt(blocks[0].text,blocks.length-1) }); } catch { /* telemetry must not affect provider execution */ }
      const turnTiming = resolveTurnTiming(profile, this.config);
      turnDiagnostics.beginTurn(turnTiming);
      const timing = new TurnTimingGuard({
        label: `${this.name}/${profileName}/${role}: ACP turn`,
        ...turnTiming,
        onTimeout: (error) => {
          turnDiagnostics.recordTimeout(error);
          turnDiagnostics.sendCancel(
            this.connection, acp.methods.agent.session.cancel, sessionId,
            error.timeoutKind === 'idle' ? 'idle_timeout' : 'turn_deadline',
          );
          error.diagnostics = { source: 'orchestrator_timing', innerAcp: turnDiagnostics.snapshot() };
        },
      });
      state.turnTiming = timing;
      let response;
      try {
        guard.phase = 'session.prompt';
        response = await Promise.race([
          this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks }),
          timing.start(), guard.interruption,
        ]);
      } finally {
        if (state.turnTiming === timing) state.turnTiming = null;
        timing.dispose();
      }
      throwIfAborted(signal);
      if (response?.stopReason === 'cancelled' && turnDiagnostics.timeoutError) throw turnDiagnostics.timeoutError;
      if (response?.stopReason === 'cancelled') throw providerCancelledError({
        provider: this.name,
        profileName,
        role,
        innerSessionId: sessionId,
        elapsedMs: Date.now() - started,
        diagnostics: turnDiagnostics.snapshot(),
      });
      const finalText = schemaKind ? state.finalText : normalizeFinalMarkdown(state.finalText || state.unphasedText, {
        preserveLiteral: /(?:show|display|return|выведи|покажи|верни).{0,45}(?:raw|literal|исходн|сыр(?:ой|ым))\s*markdown/i.test(prompt),
      });
      const interpreted = schemaKind ? parseStructuredStateOrText({ finalText, unphasedText: state.unphasedText }, schemaKind) : { format:'text', text:finalText, rawText:finalText, source:'native-final-answer', parseError:null };
      return { output: interpreted.format === 'structured' ? interpreted.data : interpreted.text, meta: { innerSessionId: sessionId, elapsedMs: Date.now() - started, timing: turnTiming, structuredOutput: { format: interpreted.format, source: interpreted.source, parseError: interpreted.parseError, rawText: interpreted.rawText,
        diagnostics: interpreted.diagnostics ?? null, providerCompletionStatus: response?.stopReason ?? null } } };
    } finally {
      this.activeSessions.delete(sessionId);
      try { await guard.boundedClose(() => this.connection?.agent.request(acp.methods.agent.session.close, { sessionId }), limits.cleanupTimeoutMs); }
      catch { if (this.activeSessions.size === 0) await this.close(); }
    }
    } finally { guard.dispose(); }
  }

  async close() {
    try { this.connection?.close(); } catch {}
    this.connection = null;
    this.initializeResponse = null;
    const child = this.child; this.child = null;
    await terminateAcpChild(child);
  }
}
