import { terminateAcpChild } from './acp/child-lifecycle.mjs';
import { safeNormalizeAcpToolObservation, acpObservationVersion } from './acp/tool-events.mjs';
import { profileProviderPrompt } from '../efficiency/profiling.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { projectName } from '../project.mjs';
import { parseStructuredStateOrText } from '../structured-output.mjs';
import { safeUpstreamErrorData, upstreamErrorDiagnostic } from '../errors.mjs';
import { passthroughPromptBlocks } from '../acp-content.mjs';
import { buildTaskPlanProgressContract } from '../task-plan-progress.mjs';
import { codexAcpCapabilities } from './capabilities.mjs';
import { assertSupportedSandboxMode } from './provider.mjs';
import { minimalChildEnv } from './process-env.mjs';
import { resolveTurnTiming, TurnTimingGuard } from './turn-timing.mjs';
import { AgentProviderError, providerCancelledError } from './errors.mjs';
import { cancellationDetails, cancellationErrorFromSignal, throwIfAborted } from '../cancellation.mjs';
import { AcpTurnDiagnostics } from './acp/turn-diagnostics.mjs';
import { AcpInvocationGuard, acpInvocationLimits } from './acp/invocation-guard.mjs';
import { captureAcpSessionUpdate, acpToolEventCaptureStatus, assertCompleteAcpAnswer, captureDeferredAcpUpdate, assertCompleteDeferredAcpPresentation } from './acp/notification-state.mjs';
import { reserveAcpPresentationSlot, releaseAcpPresentationSlot } from './acp/notification-state.mjs';

const require = createRequire(import.meta.url);
const MAX_RECONCILIATION_TURNS = 3;

const INNER_AIR_META = {
    jetbrains: {
        air: {
            version: 1,
            capabilities: ['sessionFailure'],
        },
    },
};

function normalizeSessionFailure(failure) {
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return null;
    const title = typeof failure.title === 'string' ? failure.title.trim() : '';
    if (!title) return null;
    return {
        ...(typeof failure.id === 'string' ? { id: failure.id } : {}),
        ...(Number.isInteger(failure.revision) ? { revision: failure.revision } : {}),
        ...(typeof failure.category === 'string' ? { category: failure.category } : {}),
        ...(typeof failure.severity === 'string' ? { severity: failure.severity } : {}),
        title,
        ...(typeof failure.details === 'string' && failure.details.trim() ? { details: failure.details.trim() } : {}),
        ...(Array.isArray(failure.actions) ? { actions: failure.actions.filter((action) => typeof action === 'string') } : {}),
    };
}

function promptSessionFailure(response) {
    return normalizeSessionFailure(response?._meta?.jetbrains?.air?.sessionFailure);
}

function sessionFailureMessage(failure) {
    const title = String(failure?.title ?? 'Provider session failed').trim();
    const details = typeof failure?.details === 'string' ? failure.details.trim() : '';
    return details && details !== title ? `${title} — ${details}` : title;
}

function typedSessionFailureError(acpModule, failure) {
    return new acpModule.RequestError(-32603, sessionFailureMessage(failure), { sessionFailure: failure });
}

function providerRequestError(acpModule, error, { provider, profileName, role, state, stderr = '', authHint = '' }) {
    const prefix = `${provider}/${profileName}/${role}: `;
    const sessionFailure = normalizeSessionFailure(error?.data?.sessionFailure);
    const diagnostic = sessionFailure
        ? sessionFailureMessage(sessionFailure)
        : upstreamErrorDiagnostic(error, state?.unphasedText || stderr);
    const message = `${diagnostic.startsWith(prefix) ? '' : prefix}${diagnostic}${authHint}`;
    if (Number.isInteger(error?.code)) {
        return new acpModule.RequestError(error.code, message, {
            provider,
            profileName,
            role,
            ...(sessionFailure ? { sessionFailure } : {}),
            upstream: {
                code: error.code,
                message: String(error?.message ?? ''),
                data: safeUpstreamErrorData(error?.data),
            },
        });
    }
    return new Error(message);
}

function contentText(content) {
    return content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

function codexPhase(update) {
    return update?._meta?.codex?.phase ?? null;
}

function normalizeUsage(update) {
    const used = Number(update?.used);
    const size = Number(update?.size);
    if (!Number.isFinite(used) && !Number.isFinite(size)) return null;
    return {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        reasoningOutputTokens: null,
        totalTokens: null,
        contextUsedTokens: Number.isFinite(used) && used >= 0 ? used : null,
        contextWindow: Number.isFinite(size) ? size : null,
    };
}

function rolePrompt(role, prompt, schemaKind, schema, taskPlan) {
    const taskPlanContract = buildTaskPlanProgressContract(taskPlan, {
        mechanism: 'Codex native plan/progress mechanism',
    });
    if (!schemaKind || !schema) {
        return `ORCHESTRATOR ROLE: ${role}\n\n${prompt}${taskPlanContract}\n\nUSER-FACING RESPONSE:\nYour final answer is shown directly to the user through ACP. Choose the clearest native presentation yourself. Use normal Markdown, fenced code blocks, tables, or a fenced unified diff when they improve readability. If the user asked for proposed code without repository edits, show the proposal in chat rather than editing files. Do not serialize the final answer as orchestration JSON unless the user explicitly asked for JSON.`;
    }
    const decisionOutput = ['routing', 'review', 'scopedReview', 'implementationReview', 'implementationReconciliation', 'stagedImplementation', 'finalValidation'].includes(schemaKind);
    const contract = decisionOutput
        ? `Your final-answer message should be exactly one JSON object matching this JSON Schema because the orchestrator uses these fields for a control-flow decision. Do not wrap it in Markdown fences or add prose around it. If you nevertheless return plain text, the orchestrator will preserve it but treat the machine decision as indeterminate.`
        : `Prefer exactly one JSON object matching this JSON Schema so downstream roles can consume the result reliably. If a useful final answer cannot be represented cleanly as that object, a concise plain-text final answer is still acceptable and will be preserved by the orchestrator.`;
    return `ORCHESTRATOR ROLE: ${role}\n\n${prompt}${taskPlanContract}\n\nOUTPUT CONTRACT:\n${contract} Intermediate commentary/tool activity is allowed before the final answer.\n${JSON.stringify(schema)}`;
}


function configJson(providerConfig) {
    const cfg = { ...(providerConfig.codexConfig ?? {}) };
    if (providerConfig.auth === 'chatgpt') cfg.forced_login_method = 'chatgpt';
    const mp = providerConfig.modelProvider;
    if (mp) {
        cfg.model_provider = mp.id;
        cfg.model_providers = {
            ...(cfg.model_providers ?? {}),
            [mp.id]: {
                name: mp.name ?? mp.id,
                base_url: mp.baseURL,
                wire_api: 'responses',
                requires_openai_auth: false,
                ...(mp.extra ?? {}),
            },
        };
    }
    return cfg;
}

function safeChildEnv(providerConfig) {
    const cfg = configJson(providerConfig);
    return minimalChildEnv({
        allow: providerConfig.envAllowlist ?? [],
        extra: {
            NO_BROWSER: providerConfig.noBrowser === false ? '0' : '1',
            INITIAL_AGENT_MODE: 'agent',
            ...(Object.keys(cfg).length ? { CODEX_CONFIG: JSON.stringify(cfg) } : {}),
            ...(providerConfig.modelProvider?.id ? { MODEL_PROVIDER: providerConfig.modelProvider.id } : {}),
            ...(providerConfig.codexPath ? { CODEX_PATH: providerConfig.codexPath } : {}),
        },
    });
}

function cancelledPermission() {
    return { outcome: { outcome: 'cancelled' } };
}

function cancelledElicitation() {
    return { action: 'cancel' };
}

function proxiedElicitationCapabilities(runtime) {
    const elicitation = runtime?.clientCapabilities?.elicitation;
    const capabilities = {};
    if (elicitation?.form) capabilities.form = {};
    if (elicitation?.url) capabilities.url = {};
    return Object.keys(capabilities).length ? capabilities : null;
}

function collaborationModeFromConfigUpdate(update) {
    const options = update?.configOptions ?? update?.config_options;
    if (!Array.isArray(options)) return null;
    const option = options.find((item) => item?.id === 'collaboration_mode');
    const value = option?.currentValue ?? option?.current_value ?? option?.value ?? null;
    return value === 'default' || value === 'plan' ? value : null;
}


const INNER_CONTROL_UPDATES = new Set([
    // These belong to the ephemeral inner role session and must never be
    // projected onto an outer host conversation. In particular, forwarding
    // session_info_update can rename the outer chat from an internal role
    // prompt, while user_message_chunk can expose that private prompt verbatim.
    'user_message_chunk',
    'session_info_update',
    'available_commands_update',
    'config_option_update',
    'current_mode_update',
]);

export class CodexAcpProvider {
    constructor(name, config, runtime = {}) {
        this.name = name;
        this.config = config;
        this.runtime = runtime;
        this.child = null;
        this.connection = null;
        this.initializeResponse = null;
        this.sessionStates = new Map();
        this.startPromise = null;
        this.stderr = '';
    }

    capabilities() { return codexAcpCapabilities(); }

    resolveCommand() {
        if (this.config.binary) return { command: this.config.binary, args: [] };
        const entry = require.resolve('@agentclientprotocol/codex-acp');
        return { command: process.execPath, args: [entry] };
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
            env: safeChildEnv(this.config),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });
        this.child = child;
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            this.stderr = `${this.stderr}${chunk}`.slice(-32_000);
            if (this.config.forwardStderr) process.stderr.write(`[${this.name}/codex-acp] ${chunk}`);
        });

        const exited = new Promise((_, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => {
                reject(new Error(`${this.name}: codex-acp exited during initialization (${code ?? signal}).\n${this.stderr}`));
            });
        });
        // Prevent an unobserved rejection if the adapter exits while idle. Active
        // requests are also rejected by the ACP connection itself.
        exited.catch(() => { });

        const stream = acp.ndJsonStream(
            Writable.toWeb(child.stdin),
            Readable.toWeb(child.stdout),
        );

        const clientApp = acp
            .client({ name: `${projectName}-codex-provider` })
            .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
                const state = this.sessionStates.get(ctx.params.sessionId);
                if (!state) return cancelledPermission();
                if (state.sandboxMode === 'read-only') return cancelledPermission();
                const handler = this.runtime.requestPermission;
                if (!handler) return cancelledPermission();
                // A permission prompt can legitimately wait on the outer user for much
                // longer than the model's normal activity cadence. Pause only the idle
                // watchdog while the user interaction is outstanding; the absolute turn
                // deadline remains active and still bounds the entire ACP turn.
                state.turnTiming?.pauseIdle();
                try {
                    return await handler(ctx.params, {
                        provider: this.name,
                        role: state.role,
                        profileName: state.profileName,
                        innerSessionId: ctx.params.sessionId,
                    });
                } finally {
                    state.turnTiming?.resumeIdle();
                }
            })
            .onRequest(acp.methods.client.elicitation.create, async (ctx) => {
                const innerSessionId = typeof ctx.params?.sessionId === 'string' ? ctx.params.sessionId : null;
                const state = innerSessionId ? this.sessionStates.get(innerSessionId) : null;
                const handler = state?.requestElicitation ?? this.runtime.requestElicitation;
                if (!handler || !state) return cancelledElicitation();
                state.turnTiming?.pauseIdle();
                try {
                    return await handler(ctx.params, {
                        provider: this.name,
                        role: state.role,
                        profileName: state.profileName,
                        innerSessionId,
                    });
                } finally {
                    state.turnTiming?.resumeIdle();
                }
            })
            .onNotification(acp.methods.client.elicitation.complete, async (ctx) => {
                await this.runtime.completeElicitation?.(ctx.params);
            })
            .onNotification(acp.methods.client.session.update, (ctx) =>
                this.enqueueSessionUpdate(ctx.params));

        const connection = clientApp.connect(stream);
        this.connection = connection;
        connection.closed.finally(() => {
            if (this.connection === connection) { this.connection = null; this.initializeResponse = null; }
        }).catch(() => { });

        try {
            const initialized = await Promise.race([exited, connection.agent.request(acp.methods.agent.initialize, {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientInfo: { name: projectName, version: '1' },
                clientCapabilities: {
                    plan: {},
                    session: { configOptions: { boolean: {} } },
                    ...(proxiedElicitationCapabilities(this.runtime) ? { elicitation: proxiedElicitationCapabilities(this.runtime) } : {}),
                    _meta: INNER_AIR_META,
                },
            })]);
            if (!initialized || initialized.protocolVersion !== acp.PROTOCOL_VERSION ||
                !initialized.agentCapabilities || typeof initialized.agentCapabilities !== 'object') {
                throw new Error('Codex ACP initialize returned invalid negotiated protocol/capabilities.');
            }
            this.initializeResponse = initialized;
        } catch (error) {
            const stderr = this.stderr;
            await this.close();
            const diagnostic = upstreamErrorDiagnostic(error, stderr);
            if (Number.isInteger(error?.code)) {
                throw new acp.RequestError(error.code, `${this.name}: failed to initialize codex-acp. ${diagnostic}`, {
                    provider: this.name,
                    phase: 'initialize',
                    upstream: { code: error.code, message: String(error?.message ?? ''), data: safeUpstreamErrorData(error?.data) },
                });
            }
            throw new Error(`${this.name}: failed to initialize codex-acp. ${diagnostic}`);
        }
    }

    // Capture protocol state synchronously, before any host-side progress awaits.
    // ACP notifications carry the actual final response, whereas onProgress is an
    // optional presentation/telemetry callback that may be arbitrarily slow.
    // Queue only presentation; never let UI scheduling determine the data-plane
    // result returned from session/prompt.
    enqueueSessionUpdate(params) {
        const state = this.sessionStates.get(params?.sessionId);
        if (!state) return;
        state.turnTiming?.touch();
        const update = params.update ?? {};
        state.turnDiagnostics?.recordUpdate(update.sessionUpdate);
        captureAcpSessionUpdate(state, update, { phaseOf: codexPhase, usageOf: normalizeUsage });

        // Use a non-rejecting tail so an optional host callback cannot suppress
        // subsequent ACP updates. Preserve delivery order for plans and UI events.
        // Bound the number of raw notifications retained behind slow host callbacks.
        if (!reserveAcpPresentationSlot(state)) return state.updateQueue;
        const delivered = state.updateQueue.then(() => this.deliverSessionUpdate(params, state))
            .finally(() => { releaseAcpPresentationSlot(state); });
        state.updateQueue = delivered.catch((error) => {
            state.progressErrors += 1;
            // Progress errors are diagnostic, not permission to discard model text.
            state.lastProgressError = String(error?.message ?? error).slice(0, 200);
        });
        return state.updateQueue;
    }

    async deliverSessionUpdate(params, state) {
        const update = params.update ?? {};
        const text = contentText(update.content);

        if (update.sessionUpdate === 'config_option_update') {
            const collaborationMode = collaborationModeFromConfigUpdate(update);
            if (collaborationMode && collaborationMode !== state.codexCollaborationMode) {
                state.codexCollaborationMode = collaborationMode;
                await state.onProgress?.({ type: 'provider_state', key: 'collaboration_mode', value: collaborationMode });
            }
            return;
        }

        if (update.sessionUpdate === 'agent_thought_chunk' && text) {
            await state.onProgress?.({ type: 'reasoning', text: text.slice(0, 65_536) });
            return;
        }

        if (update.sessionUpdate === 'agent_message_chunk') {
            const phase = codexPhase(update);
            // The synchronous capture has already marked an oversized answer.
            // Never retain the offending raw chunk in deferred presentation.
            if (state.answerCaptureIncomplete && phase !== 'commentary') {
                state.pendingFinalUpdates = [];
                state.pendingUnphasedUpdates = [];
                return;
            }
            if (text) {
                await state.onProgress?.({ type: 'activity', activity: 'answer' });
                if (phase === 'final_answer') {
                    if (state.presentToUser) {
                        if (state.deferPresentation) captureDeferredAcpUpdate(state, 'pendingFinalUpdates', update);
                        else {
                            await state.onProgress?.({ type: 'content_block', update });
                            state.finalAnswerPresented = true;
                        }
                    }
                } else if (phase === 'commentary') {
                    await state.onProgress?.({ type: 'commentary', text: text.slice(0, 65_536) });
                } else if (state.presentToUser) {
                    // Unphased content is already captured; defer presentation
                    // until we know that no explicitly phased final arrived.
                    captureDeferredAcpUpdate(state, 'pendingUnphasedUpdates', update);
                }
            } else {
                if (state.presentToUser && state.deferPresentation) captureDeferredAcpUpdate(state, 'pendingFinalUpdates', update);
                else {
                    await state.onProgress?.({ type: 'content_block', update });
                    if (state.presentToUser) state.finalAnswerPresented = true;
                }
            }
            return;
        }

        if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
            await state.onProgress?.({
                type: 'plan_update',
                items: update.entries.map((entry) => ({
                    text: String(entry.content ?? ''),
                    completed: entry.status === 'completed',
                    status: entry.status,
                })),
            });
            return;
        }

        if (update.sessionUpdate === 'usage_update') {
            const usage = normalizeUsage(update);
            if (usage) {
                await state.onProgress?.({ type: 'usage', usage, contextWindow: usage.contextWindow ?? state.contextWindow ?? null });
            }
            return;
        }

        if (['tool_call', 'tool_call_update', 'tool_call_content_chunk'].includes(update.sessionUpdate)) {
            await state.onProgress?.({ type: 'tool_call', update, observation: safeNormalizeAcpToolObservation(update, { version: acpObservationVersion(this.initializeResponse?.protocolVersion ?? acp.PROTOCOL_VERSION, update) }), innerSessionId: params.sessionId });
            return;
        }

        if (!INNER_CONTROL_UPDATES.has(update.sessionUpdate)) {
            await state.onProgress?.({ type: 'content_block', update });
        }
    }

    async setConfig(sessionId, configId, value) {
        return await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId,
            value,
        });
    }

    async configureSession(sessionId, profile, sandboxMode, codexAgentMode = 'agent', codexCollaborationMode = 'default') {
        assertSupportedSandboxMode(sandboxMode, this.name);
        // Keep native codex-acp semantics native. The outer orchestrator only
        // carries the selected IDs between its persistent session and each inner
        // role session. A true orchestration read-only role is always constrained
        // to codex-acp's read-only mode; writable coder roles receive the user's
        // selected native AgentMode verbatim.
        const effectiveAgentMode = sandboxMode === 'workspace-write' ? codexAgentMode : 'read-only';
        await this.connection.agent.request(acp.methods.agent.session.setMode, {
            sessionId,
            modeId: effectiveAgentMode,
        });
        await this.setConfig(sessionId, 'model', profile.model);
        if (profile.reasoningEffort) await this.setConfig(sessionId, 'reasoning_effort', profile.reasoningEffort);
        if (profile.fastMode !== undefined && this.config.supportsFastMode !== false && profile.supportsFastMode !== false) {
            await this.setConfig(sessionId, 'fast-mode', Boolean(profile.fastMode));
        }
        // Collaboration mode captures the currently selected model/reasoning
        // settings inside Codex, so apply it after the profile controls.
        await this.setConfig(sessionId, 'collaboration_mode', codexCollaborationMode);
    }

    async invoke({
        profileName, profile, role, prompt, schemaKind, schema, cwd,
        sandboxMode = 'read-only', signal, onProgress, taskPlan = null,
        promptBlocks = [], mcpServers = [], additionalDirectories = [], reconcile = null, presentToUser = false,
        codexAgentMode = 'agent', codexCollaborationMode = 'default', providerOptions = {},
    }) {
        assertSupportedSandboxMode(sandboxMode, this.name);
        codexAgentMode = providerOptions?.agentMode ?? codexAgentMode;
        codexCollaborationMode = providerOptions?.collaborationMode ?? codexCollaborationMode;
        const started = Date.now();
        const turnDiagnostics = new AcpTurnDiagnostics();
        let sessionId = null;
        const limits = acpInvocationLimits(profile, this.config);
        const guard = new AcpInvocationGuard({ signal, label: `${this.name}: codex-acp invocation`, ...limits,
            onInterrupt: (phase, error) => {
                if (sessionId) turnDiagnostics.sendCancel(this.connection, acp.methods.agent.session.cancel, sessionId,
                    phase, cancellationDetails(signal?.reason)?.reason ?? error?.code ?? null);
                else if (this.sessionStates.size === 0) void this.close();
            },
        });
        try {
            await guard.run(() => this.ensureStarted(), 'initialize');
            const session = await guard.run(() => this.connection.agent.request(acp.methods.agent.session.new, {
                cwd,
                mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
                ...(Array.isArray(additionalDirectories) && additionalDirectories.length ? { additionalDirectories } : {}),
            }), 'session.new');
            sessionId = session.sessionId;
            const state = {
                role,
                profileName,
                sandboxMode,
                requestElicitation: this.runtime.requestElicitation,
                onProgress,
                contextWindow: profile.contextWindow ?? null,
                finalText: '',
                unphasedText: '',
                usage: null,
                toolEvents: [],
                codexCollaborationMode,
                presentToUser: presentToUser === true,
                deferPresentation: presentToUser === true && typeof reconcile === 'function',
                pendingFinalUpdates: [],
                pendingUnphasedUpdates: [],
                updateQueue: Promise.resolve(),
                notificationsReceived: 0,
                finalChunksReceived: 0,
                progressErrors: 0,
                lastProgressError: null,
                finalAnswerPresented: false,
                turnTiming: null,
                turnDiagnostics,
            };
            this.sessionStates.set(sessionId, state);
            await guard.run(() => this.configureSession(sessionId, profile, sandboxMode, codexAgentMode, codexCollaborationMode), 'session.configure');

            const finalPrompt = rolePrompt(role, prompt, schemaKind, schema, taskPlan);
            const turnTiming = resolveTurnTiming(profile, this.config);
            const runTurn = async (blocks) => {
                turnDiagnostics.beginTurn(turnTiming);
                const timing = new TurnTimingGuard({
                    label: `${this.name}/${profileName}/${role}: codex-acp turn`,
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
                try {
                    guard.phase = 'session.prompt';
                    const response = await Promise.race([
                        this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks }),
                        timing.start(), guard.interruption,
                    ]);
                    // Do not read finalText or publish the turn while earlier ACP
                    // notifications are still being processed by the host.
                    await Promise.race([state.updateQueue, timing.start(), guard.interruption]);
                    throwIfAborted(signal);
                    if (response?.stopReason === 'cancelled' && turnDiagnostics.timeoutError) throw turnDiagnostics.timeoutError;
                    // Preserve the more informative structured session failure even
                    // when the provider also uses stopReason=cancelled.
                    const sessionFailure = promptSessionFailure(response);
                    if (sessionFailure && sessionFailure.severity !== 'warning') {
                        throw typedSessionFailureError(acp, sessionFailure);
                    }
                    if (response?.stopReason === 'cancelled') throw providerCancelledError({
                        provider: this.name,
                        profileName,
                        role,
                        innerSessionId: sessionId,
                        elapsedMs: Date.now() - started,
                        diagnostics: turnDiagnostics.snapshot(),
                    });
                    return response;
                } finally {
                    if (state.turnTiming === timing) state.turnTiming = null;
                    timing.dispose();
                }
            };

            const supplemental = passthroughPromptBlocks(promptBlocks, this.initializeResponse);
            try { await onProgress?.({type:'prompt_profile',profile:profileProviderPrompt(finalPrompt,supplemental.length)}); } catch { /* optional monitoring */ }
            let lastTurnResponse = await runTurn([{ type: 'text', text: finalPrompt }, ...supplemental]);
            assertCompleteAcpAnswer(state);
                    assertCompleteDeferredAcpPresentation(state);
            if (state.presentationQueueIncomplete) throw new AgentProviderError('PROVIDER_CRASH',
                'ACP presentation queue exceeded 2048 pending notifications; turn output is incomplete.', {
                    diagnostics: { source: 'orchestrator', reason: 'ACP_PRESENTATION_QUEUE_LIMIT', complete: false },
                });

            let reconciliation = null;
            let reconciliationTurns = 0;
            const reconciliationDiagnostics = [];
            if (typeof reconcile === 'function') {
                while (true) {
                    reconciliation = await guard.run(() => reconcile({
                        innerSessionId: sessionId,
                        finalText: state.finalText || state.unphasedText,
                        toolEvents: state.toolEvents,
                        toolEventCapture: acpToolEventCaptureStatus(state),
                        reconciliationTurns,
                    }), 'reconcile');
                    if (!reconciliation?.prompt) break;
                    if (reconciliation?.diagnostic) {
                        reconciliationDiagnostics.push(String(reconciliation.diagnostic));
                        if (reconciliationDiagnostics.length > MAX_RECONCILIATION_TURNS) reconciliationDiagnostics.shift();
                    }
                    if (reconciliationTurns >= MAX_RECONCILIATION_TURNS) {
                        const details = reconciliationDiagnostics.length
                            ? ` Recent semantic drift observations: ${reconciliationDiagnostics.join(' | ')}.`
                            : '';
                        throw new AgentProviderError('WORKSPACE_UNSTABLE', `Live workspace kept changing during ${role} reconciliation after ${MAX_RECONCILIATION_TURNS} revised turn(s). The final answer was withheld rather than presenting stale repository state.${details}`, { retryable: true, diagnostics: { role, attempts: reconciliationTurns, drift: [...reconciliationDiagnostics] } });
                    }
                    reconciliationTurns += 1;
                    // Keep the same inner Codex session so it can reuse prior investigation,
                    // but keep every candidate final answer buffered until a turn observes a
                    // stable workspace. Repeated editor/watcher changes therefore cannot leak
                    // a stale first or intermediate presentation.
                    state.finalText = '';
                    state.unphasedText = '';
                    state.answerCaptureIncomplete = false;
                    state.presentationQueueIncomplete = false;
                    state.deferredPresentationIncomplete = false;
                    state.deferredPresentationBytes = 0;
                    state.answerCaptureOmittedCharacters = 0;
                    state.pendingFinalUpdates = [];
                    state.pendingUnphasedUpdates = [];
                    lastTurnResponse = await runTurn([{ type: 'text', text: String(reconciliation.prompt) }]);
                    assertCompleteAcpAnswer(state);
                    assertCompleteDeferredAcpPresentation(state);
                    if (state.presentationQueueIncomplete) throw new AgentProviderError('PROVIDER_CRASH',
                        'ACP presentation queue exceeded 2048 pending notifications; turn output is incomplete.', {
                            diagnostics: { source: 'orchestrator', reason: 'ACP_PRESENTATION_QUEUE_LIMIT', complete: false },
                        });
                }
                if (state.presentToUser && state.deferPresentation && state.pendingFinalUpdates.length) {
                    state.deferPresentation = false;
                    for (const update of state.pendingFinalUpdates) {
                        await state.onProgress?.({ type: 'content_block', update });
                    }
                    state.pendingFinalUpdates = [];
                    state.finalAnswerPresented = true;
                } else {
                    state.deferPresentation = false;
                }
            }

            // Only expose phase-less message chunks when *no* explicit final-answer
            // text appeared in this (possibly reconciled) turn. This is a compatibility
            // fallback, not commentary streaming. Do not leak stale reconciliation
            // candidates or duplicate a later native final answer.
            if (state.presentToUser && !state.finalText && state.pendingUnphasedUpdates.length) {
                for (const update of state.pendingUnphasedUpdates) {
                    await state.onProgress?.({ type: 'content_block', update });
                }
                state.finalAnswerPresented = true;
            }
            state.pendingUnphasedUpdates = [];

            const interpreted = schemaKind
                ? parseStructuredStateOrText(state, schemaKind)
                : {
                    format: 'text',
                    text: String(state.finalText || state.unphasedText || ''),
                    rawText: String(state.finalText || state.unphasedText || ''),
                    source: 'native-final-answer',
                    parseError: null,
                };
            return {
                output: interpreted.format === 'structured' ? interpreted.data : interpreted.text,
                meta: {
                    elapsedMs: Date.now() - started,
                    timing: turnTiming,
                    usage: state.usage,
                    toolEvents: state.toolEvents,
                    toolEventCapture: acpToolEventCaptureStatus(state),
                    innerSessionId: sessionId,
                    reconciliation: typeof reconcile === 'function' ? { performed: reconciliationTurns > 0, turns: reconciliationTurns } : null,
                    finalAnswerPresented: state.finalAnswerPresented || (state.presentToUser && Boolean(state.finalText || state.unphasedText)),
                    structuredOutput: {
                        format: interpreted.format,
                        source: interpreted.source,
                        parseError: interpreted.parseError,
                        rawText: interpreted.rawText,
                        diagnostics: interpreted.diagnostics ?? null,
                        providerCompletionStatus: lastTurnResponse?.stopReason ?? null,
                    },
                    acpNotificationDiagnostics: {
                        received: state.notificationsReceived,
                        finalChunksReceived: state.finalChunksReceived,
                        unphasedCharacters: state.unphasedText.length,
                        progressErrors: state.progressErrors,
                    },
                },
            };
        } catch (error) {
            const authHint = /auth|required|login/i.test(String(error?.message ?? '')) && this.config.auth === 'chatgpt'
                ? `\nEnsure the bundled Codex account is authenticated with ChatGPT (for example run 'codex login').`
                : '';
            if (error?.name === 'AbortError' || error instanceof AgentProviderError) throw error;
            const state = sessionId ? this.sessionStates.get(sessionId) : null;
            const wrapped = providerRequestError(acp, error, {
                provider: this.name, profileName, role, state, stderr: this.stderr, authHint,
            });
            // Preserve local watchdog provenance through the Codex request-error
            // wrapper and the provider-neutral error normalizer.
            if (error?.diagnostics) wrapped.diagnostics = error.diagnostics;
            if (error?.timeoutKind) wrapped.timeoutKind = error.timeoutKind;
            throw wrapped;
        } finally {
            if (sessionId) {
                this.sessionStates.delete(sessionId);
                try {
                    await guard.boundedClose(() => this.connection?.agent.request(acp.methods.agent.session.close, { sessionId }), limits.cleanupTimeoutMs);
                } catch { if (this.sessionStates.size === 0) await this.close(); }
            }
            guard.dispose();
        }
    }

    async close() {
        const connection = this.connection;
        this.connection = null;
        this.initializeResponse = null;
        if (connection) {
            try { connection.close(); } catch { }
        }
        const child = this.child;
        this.child = null;
        await terminateAcpChild(child, { gracefulMs: 1_500 });
    }
}
