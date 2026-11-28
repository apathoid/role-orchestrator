import { defaultUserContentMaxBytes, userContentFrameBytes } from '../../application/user-content.js';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { capturePrefix } from '../capture-prefix.js';
import { startCliProcess } from '../cli/owned-process.js';
import { launchEnvironment } from '../launch-environment.js';
import { bridgeName, retrievalDetail, startMcpBridge } from '../mcp-bridge.js';
import { reportPrompt } from '../prompt-diagnostics.js';
import { parseDecisionText, renderInvocationPrompt } from '../invocation-prompt.js';
import { attachmentBlocks, configureReasoning, configureSession, modelOption, supportsBinding, boundOption, configureBoundOption, thoughtOption } from './input.js';

/** @import {ClientConnection, ClientRequestParamsByMethod, ClientRequestResponsesByMethod, InitializeResponse, NewSessionResponse, SessionUpdate, ToolCallUpdate} from '@agentclientprotocol/sdk' */
/** @import {Invocation, Profile, ProviderPort, ProviderResult, ProviderSession} from '../../core/ports.js' */
/** @import {Outcome, ReasonCode} from '../../core/contracts.js' */
/** @import {ResolveAttachment} from './input.js' */
/** @import {ProviderConfig} from '../../application/configuration/decode-config.js' */
/** @typedef {{attemptId: string, operationId: string, authorityRef: string, signal: AbortSignal, lifecycleSignal: AbortSignal}} ToolScope */
/** @typedef {Partial<{[M in keyof ClientRequestParamsByMethod]: (params: ClientRequestParamsByMethod[M], scope: ToolScope) => Promise<ClientRequestResponsesByMethod[M]>}>} Bridge */
/** @typedef {{capabilities: (operationId: string) => {requests: string[], notifications: string[]},
 * request: (method: string, params: Record<string, unknown>, scope: ToolScope) => Promise<unknown>,
 * notify: (method: string, params: Record<string, unknown>, scope: ToolScope) => Promise<void>}} ExtensionRelay */
/** @typedef {{attemptId: string, stop: AbortController, result: Promise<ProviderResult>}} Call */
/** @typedef {{profile: Profile, call?: Call, closing?: Promise<void>}} Session */

const maxOutputBytes = 1024 * 1024;

const closeGraceMs = 300;
const maxStderrBytes = 64 * 1024;
const maxErrorBytes = 4 * 1024;

/** @param {Invocation} invocation @param {ReasonCode} [code] @param {Outcome['terminal']} [terminal] @param {ProviderResult['dispatchCertainty']} [certainty] */
function resultFor(invocation, code, terminal = 'failed', certainty = 'not_sent') {
  /** @type {ProviderResult} */
  const result = { dispatchCertainty: certainty, outcome: {
    schemaVersion: 1, attemptId: invocation.attemptId, terminal, effect: certainty === 'not_sent' ? 'none' : 'unknown',
    diagnostics: code ? [{ code, ref: undefined }] : [], outputRefs: [], usage: { inputTokens: null, outputTokens: null, cost: null },
  } };
  return result;
}

/**
 * One process and one native session per invocation. The local handle is allocated
 * before dispatch, but the agent is started only when invocation cwd is available.
 * @param {{providerId: string, configuration: ProviderConfig, defaultCwd?: string, environment?: NodeJS.ProcessEnv,
 *   resolveAttachment?: ResolveAttachment, orderedContent?:true, bridge?: Bridge, extensionRelay?: ExtensionRelay,
 *   promptReporter?: import('../prompt-diagnostics.js').PromptReporter,
 *   bridgeCapabilities?: (operationId: string) => {terminal?: boolean, fs?: {readTextFile?: boolean, writeTextFile?: boolean}}}} options
 * @returns {ProviderPort}
 */
export function createAcpProvider({ providerId, configuration, defaultCwd = process.cwd(), environment = process.env,
  resolveAttachment, orderedContent, bridge: suppliedBridge, bridgeCapabilities, extensionRelay, promptReporter }) {
  const bridge = { ...suppliedBridge };
  const configuredFs = { readTextFile: !!bridge['fs/read_text_file'], writeTextFile: !!bridge['fs/write_text_file'] };
  const terminalMethods = /** @type {const} */ (['terminal/create', 'terminal/output', 'terminal/release', 'terminal/wait_for_exit', 'terminal/kill']);
  const configuredTerminal = terminalMethods.every(method => !!bridge[method]);
  const mcpEnabled = configuration.mcpBridge === true;
  const toolBridge = configuredTerminal || configuredFs.readTextFile || configuredFs.writeTextFile;
  /** @type {Map<ProviderSession, Session>} */
  const sessions = new Map();

  return {
    ...(orderedContent&&{supportsOrderedContent: /** @type {const} */ (true)}),
    ...(!configuration.featureBindings?.reasoningEffort || supportsBinding(configuration.featureBindings.reasoningEffort) ? {supportsReasoningSelection: /** @type {const} */ (true)} : {}),
    ...(supportsBinding(configuration.featureBindings?.collaborationMode) ? {supportsCollaborationMode: /** @type {const} */ (true)} : {}),
    ...(supportsBinding(configuration.featureBindings?.approvalMode) ? {supportsApprovalMode: /** @type {const} */ (true)} : {}),
    ...(mcpEnabled || bridgeCapabilities ? {
      negotiatesCapabilities: mcpEnabled ? ['context.retrieval', 'tools.bridge'] : ['tools.bridge'],
    } : {}),
    async describe() {
      return { providerId, maxConcurrency: null, capabilities: {
        'input.text': { support: 'supported', source: 'configured' },
        // Local prerequisites are configured; optional input also needs live negotiation.
        'input.image': { support: resolveAttachment||orderedContent ? 'supported' : 'unsupported', source: 'configured' },
        ...(orderedContent&&{'input.audio':{support:/** @type {const} */('supported'),source:/** @type {const} */('configured')},'input.attachments':{support:/** @type {const} */('supported'),source:/** @type {const} */('configured')}}),
        'output.decision': { support: 'supported', source: 'configured' },
        'tools.bridge': { support: toolBridge && !bridgeCapabilities ? 'supported' : toolBridge || mcpEnabled ? 'unknown' : 'unsupported', source: 'configured' },
        'permissions.interactive': { support: 'supported', source: 'configured', detail: 'Requires a bound Host permission broker.' },
        'context.retrieval': { support: mcpEnabled ? 'unknown' : 'unsupported', source: 'configured',
          detail: mcpEnabled ? 'Requires ACP HTTP MCP negotiation.' : 'No MCP bridge is configured.' },
        'session.resume': { support: 'unsupported', source: 'configured' },
        'attempt.status': { support: 'unsupported', source: 'configured' },
        cancel: { support: 'supported', source: 'configured' },
      } };
    },
    async open(profile, signal) {
      signal.throwIfAborted();
      if (profile.providerId !== providerId) throw new Error('ACP profile belongs to another provider');
      const handle = Object.freeze({ sessionId: randomUUID() });
      sessions.set(handle, { profile: { ...profile } });
      return handle;
    },
    async invoke(handle, invocation, observe, activity) {
      const state = sessions.get(handle);
      const selected = invocation.profile;
      if (!state || state.closing || state.call || selected.providerId !== providerId ||
          state.profile.profileId !== selected.profileId || state.profile.model !== selected.model) {
        return resultFor(invocation, 'PROTOCOL_ERROR');
      }
      const stop = new AbortController();
      const signal = AbortSignal.any([stop.signal, invocation.signal]);
      /** @type {Call} */
      const call = { attemptId: invocation.attemptId, stop, result: Promise.resolve().then(() => run(invocation, signal, observe, activity)) };
      state.call = call;
      return call.result;
    },
    async cancel(handle, attemptId) {
      const call = sessions.get(handle)?.call;
      if (call?.attemptId === attemptId) call.stop.abort();
    },
    async close(handle) {
      const state = sessions.get(handle);
      if (!state) return;
      state.closing ??= (async () => {
        const call = state.call;
        if (call) {
          call.stop.abort();
          await call.result;
        }
        sessions.delete(handle);
      })();
      await state.closing;
    },
  };

  /** @param {Invocation} invocation @param {AbortSignal} signal @param {Parameters<ProviderPort['invoke']>[2]} observe @param {Parameters<ProviderPort['invoke']>[3]} [activity] */
  async function run(invocation, signal, observe, activity) {
    if (signal.aborted) return resultFor(invocation, 'CANCELLED', 'cancelled');
    const required = invocation.requiredCapabilities ?? [];
    const maxInputFrameBytes=userContentFrameBytes(invocation.userContentMaxBytes??defaultUserContentMaxBytes);
    const { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError, CreateElicitationRequest, CreateElicitationResponse } = await import('@agentclientprotocol/sdk');
    if (signal.aborted) return resultFor(invocation, 'CANCELLED', 'cancelled');
    const supported = new Set(['input.text', 'output.decision', 'cancel']);
    if (resolveAttachment||orderedContent) supported.add('input.image');
    if(orderedContent){supported.add('input.audio');supported.add('input.attachments');}
    const clientCapabilities = bridgeCapabilities?.(invocation.operationId);
    const form = invocation.interactions?.supports('input') === true;
    const extensions = extensionRelay?.capabilities(invocation.operationId);
    const extensionMethods = { requests: new Set(extensions?.requests ?? []), notifications: new Set(extensions?.notifications ?? []) };
    const terminal = configuredTerminal && (!bridgeCapabilities || clientCapabilities?.terminal === true);
    const fsCapabilities = {
      readTextFile: configuredFs.readTextFile && (!bridgeCapabilities || clientCapabilities?.fs?.readTextFile === true),
      writeTextFile: configuredFs.writeTextFile && (!bridgeCapabilities || clientCapabilities?.fs?.writeTextFile === true),
    };
    if (terminal || fsCapabilities.readTextFile || fsCapabilities.writeTextFile ||
      (mcpEnabled && invocation.externalTools)) supported.add('tools.bridge');
    if (mcpEnabled && invocation.contextAccess) supported.add('context.retrieval');
    if (invocation.permissions) supported.add('permissions.interactive');
    if (required.some(key => !supported.has(key))) return resultFor(invocation, 'CAPABILITY_UNAVAILABLE');
    const { launch, nativeSettings = {} } = configuration;
    let mode = nativeSettings.mode;
    const bindings=configuration.featureBindings??{};
    const selected=[{kind:'collaborationMode',value:invocation.collaborationMode?.nativeValue,binding:bindings.collaborationMode},
      {kind:'approvalMode',value:invocation.approvalMode?.nativeValue,binding:bindings.approvalMode},
      {kind:'reasoningEffort',value:invocation.reasoning?.mode==='selectable'?invocation.reasoning.nativeValue:undefined,binding:bindings.reasoningEffort}].filter(item=>item.value!==undefined);
    const explicit=selected.filter(item=>item.binding!==undefined||item.kind!=='reasoningEffort');
    /** @param {string} kind @param {string} cause @returns {import('../../core/ports.js').ProviderResult} */
    function settingFailure(kind,cause){
      const option=kind==='collaborationMode'?invocation.collaborationMode?.id:kind==='approvalMode'?invocation.approvalMode?.id:invocation.reasoning?.level;
      const failure=resultFor(invocation,'CAPABILITY_UNAVAILABLE');
      failure.outcome.diagnostics[0].ref=observe({ref:'acp-setting-failure',sourceId:invocation.attemptId,kind:'host_transport',completeness:'complete',
        value:{profileId:invocation.profile.profileId,feature:kind,option,cause}});
      if((kind==='collaborationMode'||kind==='approvalMode')&&option)failure.settingUnavailable={feature:kind,option,cause};
      if(kind==='reasoningEffort')failure.reasoningUnavailable=cause==='native_request_rejected'?'session_option_rejected':'session_option_unavailable';
      return failure;
    }
    const unsupported=explicit.find(item=>!supportsBinding(item.binding));
    if(unsupported)return settingFailure(unsupported.kind,'unsupported_binding');
    const targets=explicit.map(item=>item.binding?.kind==='sessionMode'?'mode':'config:'+item.binding?.id);
    if(new Set(targets).size!==targets.length)return settingFailure(explicit.find((item,index)=>targets.indexOf(targets[index])!==index)?.kind??explicit[0].kind,'conflicting_active_bindings');
    const legacy=explicit.find(item=>item.binding?.kind==='sessionMode');
    if(legacy){if(typeof legacy.value!=='string')return settingFailure(legacy.kind,'native_value_type');mode=legacy.value;}
    if (!launch || !launch.command.trim() || Object.keys(nativeSettings).some(key => key !== 'mode') ||
        (mode !== undefined && (typeof mode !== 'string' || !mode.trim()))) return resultFor(invocation, 'PROVIDER_START_FAILED');
    const cwd = resolve(defaultCwd, invocation.workspaceContext?.cwd ?? '.');
    let env;
    try { env = launchEnvironment(launch.env, environment); }
    catch { return resultFor(invocation, 'PROVIDER_START_FAILED'); }
    const stderr = capturePrefix(maxStderrBytes);
    // SDK close(error) cancels the Node stdout reader with this exact reason.
    // A distinct transport error, even with the same text, remains a failure.
    const intentionalClose = new Error('ACP connection closed');
    const owner = startCliProcess({
      command: launch.command, args: launch.args ?? [], options: { cwd, env, shell: false },
    }, {
      timeoutMs: null,
      signal: new AbortController().signal,
      expectedStdoutCloseError: intentionalClose,
      onOutput(stream, chunk) { if (stream === 'stderr') stderr.append(chunk); },
    });
    /** @type {ClientConnection | undefined} */
    let connection;
    /** @type {'after_exchange' | 'cancellation_deadline' | undefined} */
    let teardown;
    /** @param {'after_exchange' | 'cancellation_deadline'} cause */
    function closeConnection(cause) {
      if (!connection || connection.signal.aborted || teardown !== undefined) return;
      teardown = cause;
      connection.close(intentionalClose);
    }
    /** @type {string | undefined} */
    let sessionId;
    /** @type {NewSessionResponse | undefined} */
    let session;
    /** @type {string|undefined} */ let observedMode;
    /** @type {Awaited<ReturnType<typeof startMcpBridge>> | undefined} */
    let mcp;
    let sent = false;
    let active = false;
    let output = '';
    let pendingText = '';
    /** @type {string | undefined} */
    let finalMessageRef;
    /** @type {string | null | undefined} */
    let messageId;
    // History capture and current native result have independent byte bounds.
    // Both retain the existing 1 MiB ceiling; neither is a duration/count limit.
    let outputBytes = 0;
    let truncated = false;
    let omittedEvents = 0;
    let resultBytes = 0;
    let lastCodeUnit = NaN;
    let resultTruncated = false;
    let historyMissedText = false;
    /** @type {string | undefined} */
    let resultLimitRef;
    let resultLimitReported = false;
    /** @type {string | undefined} */
    let boundaryLimitRef;
    let boundaryLimitReported = false;
    /** @type {string | undefined} */
    let currentResultIssue;
    // Reuse the permission/identity map. After history fills, retain only IDs
    // within a byte bound, not tool payloads or an unbounded duplicate registry.
    let toolIdentityBytes = 0;
    let toolIdentityIncomplete = false;
    let line = 0;
    const updates = new Set();
    /** @type {Map<string, ToolCallUpdate>} */
    const tools = new Map();
    /** @type {Outcome['outputRefs']} */
    const refs = [];
    const permissionStop = new AbortController();
    const toolSignal = AbortSignal.any([signal, permissionStop.signal]);

    /** @param {import('../../core/observation.js').AdapterObservation} item */
    function publish(item) {
      const ref = observe(item);
      if (ref !== undefined) refs.push({ ref, providerRef: undefined,
        kind: item.kind === 'agent_exit' ? 'agent_exit' : 'output',
        source: item.kind === 'model' ? 'model_claim' :
          item.kind === 'host_transport' || item.kind === 'agent_exit' ? 'host_observed' : 'provider_reported' });
      return ref;
    }
    function flushMessage(complete = true) {
      if (!pendingText) return;
      const completedMessage = pendingText === output && complete && !resultTruncated && !historyMissedText;
      const ref = publish({ ref: 'acp-message-' + ++line, sourceId: messageId ?? sessionId ?? invocation.attemptId, kind: 'model',
        completeness: complete ? 'complete' : 'truncated', value: pendingText });
      finalMessageRef = completedMessage ? ref : undefined;
      pendingText = '';
    }
    /** Reset only at a boundary already defined by the native contract. */
    function resetResult() {
      output = '';
      resultBytes = 0;
      lastCodeUnit = NaN;
      resultTruncated = false;
      historyMissedText = false;
      currentResultIssue = undefined;
      finalMessageRef = undefined;
    }
    /** @param {string} text */
    function appendResult(text) {
      if (resultTruncated || !text) return;
      finalMessageRef = undefined;
      // A surrogate pair may straddle two native chunks. Count the UTF-8
      // bytes of the assembled text, without repeatedly encoding the prefix.
      const high = lastCodeUnit;
      const low = text.charCodeAt(0);
      const joinedPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
      const bytes = Buffer.byteLength(text) - (joinedPair ? 2 : 0);
      if (resultBytes + bytes > maxOutputBytes) {
        resultTruncated = true;
        if (!resultLimitReported) {
          resultLimitReported = true;
          resultLimitRef = publish({ref:'acp-result-limit',sourceId:invocation.attemptId,kind:'host_transport',
            completeness:'complete',value:{reason:'current_result_limit',limitBytes:maxOutputBytes,firstAcceptedBytes:resultBytes}});
        }
        currentResultIssue = resultLimitRef;
        return;
      }
      output += text;
      lastCodeUnit = text.charCodeAt(text.length - 1);
      resultBytes += bytes;
    }
    /** @param {boolean} complete */
    function finishMessage(complete) {
      flushMessage(complete && !historyMissedText && !resultTruncated);
      // Only when history lost part of this message, retain its independently
      // captured representation. Ordinary fragmented results keep the existing
      // application declared-value fallback; do not duplicate complete history.
      if (historyMissedText && output && !finalMessageRef) {
        const ref = publish({ref:'acp-current-result',sourceId:messageId ?? sessionId ?? invocation.attemptId,
          kind:'model',completeness:complete && !resultTruncated?'complete':'truncated',value:output});
        if (complete && !resultTruncated) finalMessageRef = ref;
      }
      historyMissedText = false;
    }
    /** @param {SessionUpdate} update */
    function receive(update) {
      // Activity is independent of the accumulated execution output budget.
      // Preserve the original native event, never classify result chunks as public messages.
      if (activity && !signal.aborted) {
        try {
          const nativeKind = update.sessionUpdate;
          if (nativeKind === 'agent_thought_chunk') activity({ kind: 'reasoning', nativeKind,
            nativeId: update.messageId ?? undefined, payload: structuredClone(update) });
          else if (nativeKind === 'plan') activity({ kind: 'plan', nativeKind, payload: structuredClone(update) });
          else if (nativeKind === 'tool_call' || nativeKind === 'tool_call_update') activity({ kind: 'tool', nativeKind,
            nativeId: update.toolCallId, payload: structuredClone(update) });
        } catch { /* Activity delivery is not execution. */ }
      }
      if (update.sessionUpdate !== 'agent_message_chunk' &&
          update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
      // Once history is full, only protocol identity and current text are
      // consumed; do not serialize or retain further tool payloads.
      const encoded = truncated ? undefined : JSON.stringify(update);
      let retained = false;
      if (encoded !== undefined) {
        const bytes = Buffer.byteLength(encoded);
        if (outputBytes + bytes <= maxOutputBytes) {
          outputBytes += bytes;
          retained = true;
        } else {
          truncated = true;
          publish({ref:'acp-output-limit',sourceId:invocation.attemptId,kind:'host_transport',
            completeness:'complete',value:{reason:'accumulated_output_limit',limitBytes:maxOutputBytes,acceptedBytes:outputBytes}});
        }
      }
      if (!retained) omittedEvents++;
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (update.content.type === 'text') {
          const id = update.messageId ?? null;
          if (id !== messageId) {
            flushMessage(!historyMissedText && !resultTruncated);
            messageId = id;
            resetResult();
          }
          appendResult(update.content.text);
          if (retained) pendingText += update.content.text;
          else if (update.content.text) historyMissedText = true;
        }
        return;
      }
      if (encoded !== undefined && updates.has(encoded)) return;
      if (retained && encoded !== undefined) updates.add(encoded);
      flushMessage(!historyMissedText && !resultTruncated);
      const known = tools.has(update.toolCallId);
      // Existing Controller-only anonymous boundary rule. If we cannot prove
      // novelty after exhausting bounded identity retention, do not reset and
      // do not claim the resulting ambiguous text is complete.
      if (invocation.kind === 'controller' && messageId === null &&
          update.sessionUpdate === 'tool_call' && !known) {
        if (!toolIdentityIncomplete) resetResult();
        else if (output || resultTruncated) {
          resultTruncated = true;
          if (!boundaryLimitReported) {
            boundaryLimitReported = true;
            boundaryLimitRef = publish({ref:'acp-result-boundary-limit',sourceId:invocation.attemptId,
              kind:'host_transport',completeness:'complete',
              value:{reason:'anonymous_tool_identity_unavailable',limitBytes:maxOutputBytes}});
          }
          currentResultIssue = boundaryLimitRef;
        }
      }
      if (retained) {
        // Previously accepted metadata remains available for permission requests.
        if (!known) toolIdentityBytes += Buffer.byteLength(JSON.stringify(update.toolCallId)) + 16;
        tools.set(update.toolCallId, mergeToolCall(update.sessionUpdate === 'tool_call_update'
          ? tools.get(update.toolCallId) : undefined, update));
      } else if (!known && !toolIdentityIncomplete) {
        const bytes = Buffer.byteLength(JSON.stringify(update.toolCallId)) + 16;
        if (toolIdentityBytes + bytes <= maxOutputBytes) {
          toolIdentityBytes += bytes;
          tools.set(update.toolCallId, {toolCallId:update.toolCallId});
        } else toolIdentityIncomplete = true;
      }
      if (!retained || encoded === undefined) return;
      // Snapshot only identification from the existing same-call state. A
      // missing update field may inherit; an explicit clear may not. Never
      // inherit status or content, and do not enrich a new call or empty ID.
      const identity = update.sessionUpdate === 'tool_call_update' && update.toolCallId
        ? tools.get(update.toolCallId) : undefined;
      /** @type {import('../../core/observation.js').InheritedNativeField[]} */
      const inheritedFields = [];
      const title = update.title === undefined ? identity?.title : update.title;
      const kind = update.kind === undefined ? identity?.kind : update.kind;
      if (update.title === undefined && typeof title === 'string') inheritedFields.push('title');
      if (update.kind === undefined && typeof kind === 'string') inheritedFields.push('kind');
      // Keep opaque native payload as text to avoid recursive decoding of unbounded shapes.
      publish({ ref: 'acp-update-' + ++line, sourceId: update.toolCallId, kind: 'provider_tool', completeness: 'complete',
        native: { eventKind: update.sessionUpdate, nativeToolCallId: update.toolCallId,
          ...(typeof title === 'string' && {title}),
          ...(typeof kind === 'string' && {kind}),
          ...(typeof update.status === 'string' && {status: update.status}),
          ...(inheritedFields.length && {inheritedFields}) },
        value: { status: update.status, type: update.sessionUpdate, json: encoded } });
    }
    /** @template {keyof ClientRequestParamsByMethod} M @param {M} method @param {boolean} enabled */
    function forward(method, enabled) {
      /** @param {{params: ClientRequestParamsByMethod[M], signal: AbortSignal}} context @returns {Promise<ClientRequestResponsesByMethod[M]>} */
      return async ({ params, signal: requestSignal }) => {
        const handler = /** @type {Bridge[M]} */ (bridge[method]);
        if (!enabled || !handler) throw RequestError.methodNotFound(method);
        if (!active || toolSignal.aborted || (/** @type {{sessionId?: string}} */ (/** @type {unknown} */ (params))).sessionId !== sessionId) throw RequestError.requestCancelled();
        const scopeSignal = AbortSignal.any([toolSignal, requestSignal]);
        scopeSignal.throwIfAborted();
        if (invocation.isActive?.() === false) throw RequestError.requestCancelled();
        const value = await handler(params, { attemptId: invocation.attemptId, operationId: invocation.operationId,
          authorityRef: invocation.authorityRef, signal: scopeSignal, lifecycleSignal: toolSignal });
        scopeSignal.throwIfAborted();
        if (invocation.isActive?.() === false) throw RequestError.requestCancelled();
        return value;
      };
    }

    /** @param {unknown} params @param {AbortSignal} requestSignal */
    function extensionScope(params, requestSignal) {
      if (!active || toolSignal.aborted || !sessionId || !params || typeof params !== 'object' || Array.isArray(params) ||
          !('sessionId' in params) || params.sessionId !== sessionId || invocation.isActive?.() === false) {
        throw RequestError.requestCancelled();
      }
      const scopeSignal = AbortSignal.any([toolSignal, requestSignal]);
      scopeSignal.throwIfAborted();
      return { input: /** @type {Record<string, unknown>} */ (params), scope: {
        attemptId: invocation.attemptId, operationId: invocation.operationId, authorityRef: invocation.authorityRef,
        signal: scopeSignal, lifecycleSignal: toolSignal,
      } };
    }

    const m = methods.client;
    const a = methods.agent;
    /** @type {NodeJS.Timeout | undefined} */
    let cancelDeadline;
    const cancellation = addAbortListener(signal, () => {
      if (!active || !sessionId) {
        // Setup and post-end-turn finalization may have an owned process but
        // no active native prompt. Do not rely on a child execution timer.
        closeConnection('cancellation_deadline');
        owner.cancel();
        return;
      }
      void connection?.agent.notify(a.session.cancel, { sessionId }).catch(() => {});
      cancelDeadline = setTimeout(() => { closeConnection('cancellation_deadline'); owner.cancel(); }, closeGraceMs);
    });
    async function exchange() {
      signal.throwIfAborted();
      if (!owner.pipes) return resultFor(invocation, 'PROVIDER_START_FAILED');
      const app = client()
        .onNotification(m.session.update, ({ params }) => {
          if (params.sessionId !== sessionId) return;
          if (session && params.update.sessionUpdate === 'config_option_update') {
            session.configOptions = params.update.configOptions;
          } else if (session && !active && params.update.sessionUpdate === 'current_mode_update') {
            observedMode=params.update.currentModeId;
          } else if (active) receive(params.update);
        })
        .onRequest(m.session.requestPermission, async ({ params, requestId, signal: requestSignal }) => {
          const cancelled = /** @type {const} */ ({ outcome: { outcome: 'cancelled' } });
          if (!active || params.sessionId !== sessionId || !invocation.permissions || toolSignal.aborted) return cancelled;
          const options = params.options.map(option => ({
            id: option.optionId, label: option.name,
            kind: /** @type {'allow' | 'deny'} */ (option.kind.startsWith('allow_') ? 'allow' : 'deny'),
            scope: /** @type {'once' | 'always'} */ (option.kind.endsWith('_always') ? 'always' : 'once'),
          }));
          const permissionSignal = AbortSignal.any([toolSignal, requestSignal]);
          if (permissionSignal.aborted) return cancelled;
          /** @type {PromiseWithResolvers<import('../../core/ports.js').PermissionResult>} */
          const interrupted = Promise.withResolvers();
          const listener = addAbortListener(permissionSignal, () => interrupted.resolve({ kind: 'cancelled' }));
          try {
            const tool = mergeToolCall(tools.get(params.toolCall.toolCallId), params.toolCall);
            const { title, kind, locations, rawInput, content } = tool;
            const reply = await Promise.race([interrupted.promise, invocation.permissions.request({
              providerRequestId: JSON.stringify([sessionId, requestId]),
              resource: 'acp-tool:' + JSON.stringify([sessionId, tool.toolCallId]), options,
              action: { source: 'provider_reported', title: title ?? undefined, kind: kind ?? undefined, nativeToolCallId: tool.toolCallId,
                locations: locations?.map(({ path, line }) => ({ path, line: line ?? undefined })),
                details: rawInput != null || content != null ? JSON.stringify({ rawInput, content }) : undefined },
            })]);
            if (!permissionSignal.aborted && reply.kind === 'selected' && options.some(option => option.id === reply.option)) {
              return { outcome: { outcome: 'selected', optionId: reply.option } };
            }
            return cancelled;
          } catch {
            return cancelled;
          } finally { listener[Symbol.dispose](); }
        })
        .onRequest(m.elicitation.create, async ({ params, requestId, signal: requestSignal }) => {
          if (!form || !invocation.interactions || !CreateElicitationRequest.isForm(params) || !('sessionId' in params)) {
            throw RequestError.methodNotFound(m.elicitation.create);
          }
          if (!active || params.sessionId !== sessionId || toolSignal.aborted) return { action: 'cancel' };
          const result = await invocation.interactions.request({ kind: 'input', nativeKind: m.elicitation.create,
            providerRequestId: JSON.stringify([sessionId, requestId]), payload: params }, AbortSignal.any([toolSignal, requestSignal]));
          if (result.kind === 'answered') {
            const reply = /** @type {import('@agentclientprotocol/sdk').CreateElicitationResponse} */ (result.payload);
            if (CreateElicitationResponse.isAccept(reply) || CreateElicitationResponse.isDecline(reply) || CreateElicitationResponse.isCancel(reply)) return reply;
            throw new RequestError(-32602, 'Invalid elicitation reply');
          }
          if (result.kind === 'cancelled') return { action: 'cancel' };
          if (result.kind === 'timed_out') throw new RequestError(-32001, 'Interaction deadline exceeded');
          if (result.kind === 'error') throw new RequestError(result.code, result.message, result.data);
          if (result.kind === 'invalid') throw new RequestError(-32602, 'Invalid interaction');
          throw RequestError.methodNotFound(m.elicitation.create);
        })
        .onRequest(m.fs.readTextFile, forward(m.fs.readTextFile, fsCapabilities.readTextFile))
        .onRequest(m.fs.writeTextFile, forward(m.fs.writeTextFile, fsCapabilities.writeTextFile))
        .onRequest(m.terminal.create, forward(m.terminal.create, terminal))
        .onRequest(m.terminal.output, forward(m.terminal.output, terminal))
        .onRequest(m.terminal.release, forward(m.terminal.release, terminal))
        .onRequest(m.terminal.waitForExit, forward(m.terminal.waitForExit, terminal))
        .onRequest(m.terminal.kill, forward(m.terminal.kill, terminal));
      if (extensionRelay) {
        app.onRequest('*', async ({ method, params, signal: requestSignal }) => {
          if (!method.startsWith('_') || !extensionMethods.requests.has(method)) throw RequestError.methodNotFound(method);
          const { input, scope } = extensionScope(params, requestSignal);
          const response = await extensionRelay.request(method, input, scope);
          if (scope.signal.aborted || invocation.isActive?.() === false) throw RequestError.requestCancelled();
          return response;
        });
        app.onNotification('*', async ({ method, params }) => {
          // SDK wildcard notifications can also see known session/update events.
          if (!method.startsWith('_') || !extensionMethods.notifications.has(method)) return;
          try {
            const { input, scope } = extensionScope(params, toolSignal);
            await extensionRelay.notify(method, input, scope);
          } catch { /* Notifications have no response. No retry or false ACK. */ }
        });
      }
      connection = app.connect(ndJsonStream(Writable.toWeb(owner.pipes.stdin), Readable.toWeb(owner.pipes.stdout),
        { maxMessageBytes: maxOutputBytes }));
      const agent = connection.agent;
      /** @type {InitializeResponse} */
      const initialized = await agent.request(a.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: fsCapabilities, terminal,
          ...(form && { elicitation: { form: {} } }),
          ...(extensions && (extensions.requests.length || extensions.notifications.length) && {
            _meta: { roleOrchestratorExtensions: extensions },
          }),
        },
      }, { cancellationSignal: signal, stopWaitingOnCancel: true });
      if (initialized.protocolVersion !== PROTOCOL_VERSION) return resultFor(invocation, 'PROTOCOL_ERROR');
      /** @type {{requestId:string,ref:string,reason:string}[]} */ const omittedContent=[];
      /** @type {{requestId:string,startBlock:number,count:number,literalText:boolean}[]} */ const deliveredTurns=[];
      const blocks = await attachmentBlocks(invocation, initialized.agentCapabilities??{}, resolveAttachment, AbortSignal.any([signal, connection.signal]),(requestId,ref)=>omittedContent.push({requestId,ref,reason:'native_content_unavailable'}),
        (turn,startBlock,count)=>deliveredTurns.push({requestId:turn.requestId,startBlock,count,literalText:turn.content.some(item=>item.kind==='text')}));
      if (!blocks || (required.includes('input.image') && (!initialized.agentCapabilities?.promptCapabilities?.image))) {
        const refused=resultFor(invocation,'CAPABILITY_UNAVAILABLE');
        refused.outcome.diagnostics[0].ref=publish({ref:'acp-user-content',kind:'host_transport',sourceId:invocation.attemptId,completeness:'complete',
          value:{reason:'user_content_not_deliverable',profileId:invocation.profile.profileId,attachments:(invocation.attachments??[]).map(item=>({ref:item.ref,mediaType:item.mediaType}))}});
        return refused;
      }
      signal.throwIfAborted();
      const httpMcp = mcpEnabled && initialized.agentCapabilities?.mcpCapabilities?.http === true;
      if (!httpMcp && (required.includes('context.retrieval') || (!toolBridge && required.includes('tools.bridge')))) {
        const ref = publish({ ref: 'acp-mcp-unavailable', sourceId: invocation.attemptId, kind: 'host_transport',
          completeness: 'complete', value: { reason: 'Agent did not negotiate HTTP MCP.' } });
        const refused = resultFor(invocation, 'CAPABILITY_UNAVAILABLE');
        refused.outcome.diagnostics[0].ref = ref;
        return refused;
      }
      // Transport choice is made from trusted configuration and the actual
      // native HTTP MCP negotiation, before the first Controller prompt.
      // Unsupported optional MCP falls back to the same intent via native text.
      const controllerDelivery = invocation.kind === 'controller' && configuration.controllerIntent
        ? (configuration.controllerIntent === 'prefer_mcp' && httpMcp ? 'intent_mcp' : 'intent_text') : undefined;
      if (httpMcp && (invocation.contextAccess || invocation.evidenceAccess || invocation.externalTools || controllerDelivery === 'intent_mcp')) {
        mcp = await startMcpBridge({ ...invocation, controllerDelivery, signal });
      }
      signal.throwIfAborted();
      session = await agent.request(a.session.new, {
        cwd, mcpServers: mcp ? [{ type: 'http', name: bridgeName, url: mcp.url, headers: [] }] : [],
      }, { cancellationSignal: signal, stopWaitingOnCancel: true });
      if (typeof session.sessionId !== 'string' || !session.sessionId.trim()) return resultFor(invocation, 'PROTOCOL_ERROR');
      sessionId = session.sessionId;
      try {
        const model = invocation.profile.model;
        const initialMode=session.modes?.currentModeId;
        if(legacy&&mode!==initialMode&&!session.modes?.availableModes.some(item=>item.id===mode))return settingFailure(legacy.kind,'native_mode_unavailable');
        const configured = await configureSession(agent, a.session, session, model, typeof mode === 'string' ? mode : undefined, signal);
        if (!configured || modelOption(session.configOptions)?.currentValue !== model) {
          return resultFor(invocation, 'CAPABILITY_UNAVAILABLE');
        }
        for(const item of explicit) {
          if(item.kind==='reasoningEffort'||item.binding?.kind==='sessionMode')continue;
          if(!item.binding||item.value===undefined)return settingFailure(item.kind,'unsupported_binding');
          if(!bindings.reasoningEffort&&invocation.reasoning?.mode==='selectable'&&item.binding.id===thoughtOption(session.configOptions)?.id)return settingFailure(item.kind,'conflicting_active_bindings');
          const advertised=session.configOptions?.find(option=>option.id===item.binding?.id);
          if(!advertised)return settingFailure(item.kind,'native_selector_missing');
          const bound=boundOption(session,item.binding);
          if(!bound)return settingFailure(item.kind,'native_selector_type');
          if(bound.type==='select'&&(typeof item.value!=='string'||!bound.options.flatMap(option=>'options' in option?option.options:[option]).some(option=>option.value===item.value)))return settingFailure(item.kind,'native_option_unavailable');
          if(bound.type==='boolean'&&typeof item.value!=='boolean')return settingFailure(item.kind,'native_value_type');
          try {
            if(!await configureBoundOption(agent,a.session,session,item.binding,item.value,signal))return settingFailure(item.kind,'native_value_not_confirmed');
          } catch(error) {
            if(signal.aborted||!(error instanceof RequestError)||connection.signal.aborted)throw error;
            return settingFailure(item.kind,'native_request_rejected');
          }
        }
        // Selection is session-local; the native agent must explicitly advertise
        // and confirm its effective value before receiving any prompt.
        let configuredEffort = false;
        try {
          configuredEffort = legacy?.kind==='reasoningEffort' || await configureReasoning(agent, a.session, session, invocation.reasoning, signal, bindings.reasoningEffort);
        } catch (error) {
          if (signal.aborted) throw error;
          if (invocation.reasoning?.mode === 'selectable' && error instanceof RequestError && !connection.signal.aborted) {
            return {...resultFor(invocation, 'CAPABILITY_UNAVAILABLE'),
              reasoningUnavailable: /** @type {const} */ ('session_option_rejected')};
          }
          throw error;
        }
        if (!configuredEffort) {
          const failure = resultFor(invocation, 'CAPABILITY_UNAVAILABLE');
          // Distinguish missing/refused reasoning from unrelated model selection
          // failures: only this signal becomes a user-visible effort error.
          if (invocation.reasoning?.mode === 'selectable') {
            failure.reasoningUnavailable = 'session_option_unavailable';
          }
          return failure;
        }
        if (modelOption(session.configOptions)?.currentValue !== model) {
          const failure=resultFor(invocation,'CAPABILITY_UNAVAILABLE');
          failure.outcome.diagnostics[0].ref=publish({ref:'acp-model-selection',sourceId:invocation.attemptId,
            kind:'host_transport',completeness:'complete',value:{reason:'model_selection_not_confirmed',profileId:invocation.profile.profileId}});
          return failure;
        }
        for(const item of explicit) {
          if(item.binding?.kind==='configOption'&&boundOption(session,item.binding)?.currentValue!==item.value)return settingFailure(item.kind,'native_value_changed');
          if(item.binding?.kind==='sessionMode'&&observedMode!==undefined&&observedMode!==item.value)return settingFailure(item.kind,'native_mode_changed');
          if(item.kind!=='reasoningEffort')publish({ref:'acp-setting-'+item.kind,kind:'host_transport',sourceId:invocation.attemptId,completeness:'complete',value:{kind:item.kind,
            option:item.kind==='collaborationMode'?invocation.collaborationMode?.id:invocation.approvalMode?.id,
            status:item.binding?.kind==='sessionMode'?(observedMode===item.value||initialMode===item.value?'mode_confirmed':'mode_submitted'):'config_option_confirmed'}});
        }
        if (invocation.reasoning?.mode === 'selectable') {
          publish({ref:'acp-reasoning-ack',kind:'host_transport',sourceId:invocation.attemptId,
            completeness:'complete',value:{
              status:legacy?.kind==='reasoningEffort'?'mode_submitted':'config_option_confirmed',level:invocation.reasoning.level,profileId:invocation.profile.profileId,
              // The nativeValue stays in the trusted route, never the model context.
            }});
        }
        const preparationStarted=performance.now();
        /** @type {Record<string,number>} */
        let componentSizes={};
        // Native blocks are the sole literal representation of delivered
        // ordered user text. Keep its original identity in orchestration JSON.
        const literal=new Map(deliveredTurns.filter(turn=>turn.literalText).map(turn=>[turn.requestId,turn]));
        const initial=invocation.context.find(item=>item.provenance?.kind==='user'&&item.receivedSequence?.revision===0&&item.receivedSequence.index===0);
        const objective=initial&&literal.has(initial.ref)?'Original user objective is in native ordered turn '+initial.ref:invocation.objective;
        const context=invocation.context.map(item=>{
          const turn=literal.get(item.ref);
          if(!turn)return item;
          const {value:_value,excerpt:_excerpt,...identity}=item;
          return {...identity,value:{nativeOrderedTurn:turn.requestId}};
        });
        if(deliveredTurns.length)context.push({ref:'host:ordered-input',source:'host_observed',completeness:'complete',value:deliveredTurns});
        if(omittedContent.length)context.push({ref:'host:user-content-delivery',source:'host_observed',completeness:'complete',value:omittedContent});
        const prompt = renderInvocationPrompt({...invocation,objective,context,controllerDelivery, controllerDecisionToolName:mcp?.decisionToolName}, retrievalDetail(Boolean(mcp?.contextListToolName), mcp, invocation.kind),
          promptReporter?sizes=>{componentSizes=sizes;}:undefined);
        reportPrompt(promptReporter,invocation,'prepared',{transport:'acp',preparationMs:performance.now()-preparationStarted,attachmentBlocks:blocks.length,...componentSizes},prompt);
        if(blocks.length&&Buffer.byteLength(JSON.stringify([{type:'text',text:prompt},...blocks]))>maxInputFrameBytes-4096){
          const refused=resultFor(invocation,'RESOURCE_LIMIT');
          refused.outcome.diagnostics[0].ref=publish({ref:'acp-user-content-limit',kind:'host_transport',sourceId:invocation.attemptId,completeness:'complete',value:{reason:'native_prompt_frame_limit',limit:maxInputFrameBytes}});
          return refused;
        }
        signal.throwIfAborted();
        active = true;
        sent = true;
        const sendStarted=performance.now();
        reportPrompt(promptReporter,invocation,'send_attempted',{transport:'acp',nativeSessionId:sessionId});
        const reply = await agent.request(a.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }, ...blocks] });
        const stopReason = reply?.stopReason;
        reportPrompt(promptReporter,invocation,'reply',{transport:'acp',nativeSessionId:sessionId,
          elapsedMs:performance.now()-sendStarted,stopReason:stopReason??null,observedToolCount:tools.size});
        clearTimeout(cancelDeadline);
        active = false;
        permissionStop.abort();
        let result;
        if (signal.aborted || stopReason === 'cancelled') result = resultFor(invocation, 'CANCELLED', stopReason === 'cancelled' ? 'cancelled' : 'unknown', 'sent');
        else if (stopReason === 'end_turn' && (!resultTruncated || controllerDelivery === 'intent_mcp')) {
          result = resultFor(invocation, undefined, 'completed', 'sent');
          if (invocation.kind !== 'controller') result.output = output;
          else if (controllerDelivery === 'intent_mcp') {
            // Tool receipt is proposal-only. A trusted native end_turn closes
            // registration and waits for all pre-boundary submissions only.
            const selected = await mcp?.finalizeDecision?.();
            if (!selected || selected.kind === 'unavailable') {
              result = resultFor(invocation, selected?.reason === 'budget' ? 'RESOURCE_LIMIT' : 'PROTOCOL_ERROR', 'failed', 'sent');
            } else {
              // Ordinary capture overflow is not a defect in a separately
              // received, invocation-scoped MCP declaration. An incomplete
              // final text must never be described as complete evidence.
              if (!resultTruncated) result.output = output;
              if (selected.kind === 'intent') {
                const receiptRef = publish({ref:'acp-decision-submission',sourceId:selected.proposalRef,
                  kind:'model',completeness:'complete',value:selected.value});
                result.controllerDeclaration = {kind:'intent',value:selected.value,observationRef:receiptRef};
              } else if (selected.kind === 'invalid') {
                result.controllerDeclaration = {kind:'invalid',reason:selected.reason};
              } else {
                result.controllerDeclaration = {kind:selected.kind};
              }
            }
          } else {
            Object.assign(result, parseDecisionText(output));
            if (controllerDelivery === 'intent_text' && !result.decisionTextError) {
              result.controllerDeclaration = {kind:'intent',value:result.output};
            }
          }
        } else {
          const code = resultTruncated && stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? 'RESOURCE_LIMIT' :
            stopReason === 'refusal' ? 'PROVIDER_REFUSED' : 'PROTOCOL_ERROR';
          result = resultFor(invocation, code, 'failed', 'sent');
          if (resultTruncated) result.outcome.diagnostics[0].ref=currentResultIssue;
        }
        finishMessage(result.outcome.terminal === 'completed');
        if (result.outcome.terminal === 'completed' && !resultTruncated && finalMessageRef) {
          result.outputObservationRef = finalMessageRef;
          if (invocation.kind === 'controller' && controllerDelivery !== 'intent_mcp') result.outputObservationParsed = true;
        }
        const stopRef=publish({ ref: 'acp-stop', sourceId: sessionId, kind: 'provider_report', completeness: 'complete',
          value: { stopReason: stopReason ?? null, truncated, historyTruncated:truncated,
            resultTruncated, historyBytes:outputBytes, historyOmittedEvents:omittedEvents, resultBytes,
            toolIdentityBytes, toolIdentityIncomplete, cancelRequested: signal.aborted } });
        for(const diagnostic of result.outcome.diagnostics) diagnostic.ref ??= stopRef;
        return result;
      } finally {
        active = false;
        permissionStop.abort();
        if (initialized.agentCapabilities?.sessionCapabilities?.close && !connection.signal.aborted) {
          await agent.request(a.session.close, { sessionId }, { cancellationSignal: AbortSignal.timeout(closeGraceMs), stopWaitingOnCancel: true }).catch(() => {});
        }
      }
    }

    let result;
    let errorRef;
    try {
      result = await exchange();
    } catch (error) {
      if (error instanceof Error) {
        const text = Buffer.from(error.message);
        errorRef = publish({ ref: 'acp-error', sourceId: invocation.attemptId,
          kind: error instanceof RequestError && !connection?.signal.aborted ? 'provider_report' : 'host_transport',
          completeness: text.length > maxErrorBytes ? 'truncated' : 'complete',
          value: { message: text.subarray(0, maxErrorBytes).toString('utf8'), code: error instanceof RequestError ? error.code : null } });
      }
      const code = signal.aborted || (sent && error instanceof RequestError && error.code === -32800) ? 'CANCELLED' :
        error instanceof RequestError && !connection?.signal.aborted && sent ? 'PROTOCOL_ERROR' :
          sent ? 'PROVIDER_DISCONNECTED' : 'PROVIDER_START_FAILED';
      result = resultFor(invocation, code, sent ? 'unknown' : signal.aborted ? 'cancelled' : 'failed', sent ? 'unknown' : 'not_sent');
    } finally {
      active = false;
      permissionStop.abort();
      cancellation[Symbol.dispose]();
      clearTimeout(cancelDeadline);
      mcp?.close();
      closeConnection('after_exchange');
      await owner.close();
    }
    const processResult = await owner.finished;
    if (signal.reason === 'deadline' && result.outcome.terminal !== 'completed') {
      result.outcome.diagnostics = [{ code: 'DEADLINE_EXCEEDED', ref: undefined }];
    }
    finishMessage(false);
    const captured = stderr.result();
    const stderrRef = result.outcome.diagnostics.length && captured.bytes.length ? publish({
      ref: 'acp-stderr', sourceId: invocation.attemptId, kind: 'provider_report',
      completeness: captured.truncated || processResult.errors.stderr ? 'truncated' : 'complete',
      value: { text: captured.bytes.toString('utf8'), receivedBytes: captured.receivedBytes },
    }) : undefined;
    const processRef = publish({ ref: 'acp-process', sourceId: invocation.attemptId, completeness: 'complete',
      ...(processResult.exitCode === null ? { kind: 'host_transport' } : { kind: 'agent_exit', exitCode: processResult.exitCode }),
      value: { reason: processResult.reason, exitCode: processResult.exitCode, signal: processResult.signal,
        errors: processResult.errors, cancelRequested: signal.aborted, ...(teardown === undefined ? {} : { teardown }) } });
    for (const diagnostic of result.outcome.diagnostics) diagnostic.ref ??= stderrRef || errorRef || processRef;
    result.outcome.outputRefs = refs;
    return result;
  }
}

/** @param {ToolCallUpdate | undefined} previous @param {ToolCallUpdate} update @returns {ToolCallUpdate} */
function mergeToolCall(previous, update) {
  return {
    toolCallId: update.toolCallId,
    title: update.title === undefined ? previous?.title : update.title,
    kind: update.kind === undefined ? previous?.kind : update.kind,
    locations: update.locations ?? previous?.locations,
    rawInput: update.rawInput ?? previous?.rawInput,
    content: update.content ?? previous?.content,
  };
}
