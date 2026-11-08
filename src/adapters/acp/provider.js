import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { startCliProcess } from '../cli/owned-process.js';
import { launchEnvironment } from '../launch-environment.js';
import { parseDecisionText, renderInvocationPrompt } from '../invocation-prompt.js';
import { attachmentBlocks, configureSession } from './input.js';

/** @import {ClientConnection, ClientRequestParamsByMethod, ClientRequestResponsesByMethod, InitializeResponse, SessionUpdate} from '@agentclientprotocol/sdk' */
/** @import {Invocation, Profile, ProviderPort, ProviderResult, ProviderSession} from '../../core/ports.js' */
/** @import {Outcome, ReasonCode} from '../../core/contracts.js' */
/** @import {ResolveAttachment} from './input.js' */
/** @import {ProviderConfig} from '../../application/configuration/decode-config.js' */
/** @typedef {{attemptId: string, operationId: string, authorityRef: string, signal: AbortSignal}} ToolScope */
/** @typedef {Partial<{[M in keyof ClientRequestParamsByMethod]: (params: ClientRequestParamsByMethod[M], scope: ToolScope) => Promise<ClientRequestResponsesByMethod[M]>}>} Bridge */
/** @typedef {{attemptId: string, stop: AbortController, result: Promise<ProviderResult>}} Call */
/** @typedef {{profile: Profile, call?: Call, closing?: Promise<void>}} Session */

const maxOutputBytes = 1024 * 1024;
const closeGraceMs = 300;

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
 *   resolveAttachment?: ResolveAttachment, bridge?: Bridge}} options
 * @returns {ProviderPort}
 */
export function createAcpProvider({ providerId, configuration, defaultCwd = process.cwd(), environment = process.env,
  resolveAttachment, bridge: suppliedBridge }) {
  const bridge = { ...suppliedBridge };
  const fsCapabilities = { readTextFile: !!bridge['fs/read_text_file'], writeTextFile: !!bridge['fs/write_text_file'] };
  const terminalMethods = /** @type {const} */ (['terminal/create', 'terminal/output', 'terminal/release', 'terminal/wait_for_exit', 'terminal/kill']);
  const terminal = terminalMethods.every(method => !!bridge[method]);
  const toolBridge = terminal || fsCapabilities.readTextFile || fsCapabilities.writeTextFile;
  /** @type {Map<ProviderSession, Session>} */
  const sessions = new Map();

  return {
    async describe() {
      return { providerId, maxConcurrency: null, capabilities: {
        'input.text': { support: 'supported', source: 'configured' },
        // Local prerequisites are configured; optional input also needs live negotiation.
        'input.image': { support: resolveAttachment ? 'supported' : 'unsupported', source: 'configured' },
        'output.decision': { support: 'supported', source: 'configured' },
        'tools.bridge': { support: toolBridge ? 'supported' : 'unsupported', source: 'configured' },
        'permissions.interactive': { support: 'supported', source: 'configured', detail: 'Requires a bound Host permission broker.' },
        'context.retrieval': { support: 'unsupported', source: 'configured' },
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
    async invoke(handle, invocation, observe) {
      const state = sessions.get(handle);
      const selected = invocation.profile;
      if (!state || state.closing || state.call || selected.providerId !== providerId ||
          state.profile.profileId !== selected.profileId || state.profile.model !== selected.model) {
        return resultFor(invocation, 'PROTOCOL_ERROR');
      }
      const stop = new AbortController();
      const signal = AbortSignal.any([stop.signal, invocation.signal]);
      /** @type {Call} */
      const call = { attemptId: invocation.attemptId, stop, result: Promise.resolve().then(() => run(invocation, signal, observe)) };
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

  /** @param {Invocation} invocation @param {AbortSignal} signal @param {Parameters<ProviderPort['invoke']>[2]} observe */
  async function run(invocation, signal, observe) {
    if (signal.aborted) return resultFor(invocation, 'CANCELLED', 'cancelled');
    const required = invocation.requiredCapabilities ?? [];
    const { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } = await import('@agentclientprotocol/sdk');
    if (signal.aborted) return resultFor(invocation, 'CANCELLED', 'cancelled');
    const supported = new Set(['input.text', 'output.decision', 'cancel']);
    if (resolveAttachment) supported.add('input.image');
    if (toolBridge) supported.add('tools.bridge');
    if (invocation.permissions) supported.add('permissions.interactive');
    if (required.some(key => !supported.has(key))) return resultFor(invocation, 'CAPABILITY_UNAVAILABLE');
    const { launch, nativeSettings = {} } = configuration;
    const mode = nativeSettings.mode;
    if (!launch || !launch.command.trim() || Object.keys(nativeSettings).some(key => key !== 'mode') ||
        (mode !== undefined && (typeof mode !== 'string' || !mode.trim()))) return resultFor(invocation, 'PROVIDER_START_FAILED');
    const cwd = resolve(defaultCwd, invocation.workspaceContext?.cwd ?? '.');
    let env;
    try { env = launchEnvironment(launch.env, environment); }
    catch { return resultFor(invocation, 'PROVIDER_START_FAILED'); }
    const owner = startCliProcess({
      command: launch.command, args: launch.args ?? [], options: { cwd, env, shell: false },
    }, { timeoutMs: invocation.timeoutMs, signal: new AbortController().signal, onOutput() {} });
    /** @type {ClientConnection | undefined} */
    let connection;
    /** @type {string | undefined} */
    let sessionId;
    let sent = false;
    let active = false;
    let output = '';
    let pendingText = '';
    /** @type {string | null | undefined} */
    let messageId;
    let outputBytes = 0;
    let truncated = false;
    let line = 0;
    const updates = new Set();
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
    }
    function flushMessage(complete = true) {
      if (!pendingText) return;
      publish({ ref: 'acp-message-' + ++line, sourceId: messageId ?? sessionId ?? invocation.attemptId, kind: 'model',
        completeness: complete ? 'complete' : 'truncated', value: pendingText });
      pendingText = '';
    }
    /** @param {SessionUpdate} update */
    function receive(update) {
      if (update.sessionUpdate !== 'agent_message_chunk' &&
          update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
      const encoded = JSON.stringify(update);
      if (truncated || outputBytes + Buffer.byteLength(encoded) > maxOutputBytes) {
        truncated = true;
        return;
      }
      outputBytes += Buffer.byteLength(encoded);
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (update.content.type === 'text') {
          const id = update.messageId ?? null;
          if (id !== messageId) {
            flushMessage();
            messageId = id;
            output = '';
          }
          output += update.content.text;
          pendingText += update.content.text;
        }
        return;
      }
      flushMessage();
      if (updates.has(encoded)) return;
      updates.add(encoded);
      // Keep opaque native payload as text to avoid recursive decoding of unbounded shapes.
      publish({ ref: 'acp-update-' + ++line, sourceId: update.toolCallId, kind: 'provider_tool', completeness: 'complete',
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
        const value = await handler(params, { attemptId: invocation.attemptId, operationId: invocation.operationId,
          authorityRef: invocation.authorityRef, signal: scopeSignal });
        scopeSignal.throwIfAborted();
        return value;
      };
    }

    const m = methods.client;
    const a = methods.agent;
    /** @type {NodeJS.Timeout | undefined} */
    let cancelDeadline;
    const cancellation = addAbortListener(signal, () => {
      if (!active || !sessionId) return;
      void connection?.agent.notify(a.session.cancel, { sessionId }).catch(() => {});
      cancelDeadline = setTimeout(() => { connection?.close(); owner.cancel(); }, closeGraceMs);
    });
    /** @type {ProviderResult | undefined} */
    let result;
    try {
      if (!owner.pipes) return resultFor(invocation, 'PROVIDER_START_FAILED');
      const app = client()
        .onNotification(m.session.update, ({ params }) => {
          if (active && params.sessionId === sessionId) receive(params.update);
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
            const reply = await Promise.race([interrupted.promise, invocation.permissions.request({
              providerRequestId: JSON.stringify([sessionId, requestId]),
              resource: 'acp-tool:' + JSON.stringify([sessionId, params.toolCall.toolCallId]), options,
            })]);
            if (!permissionSignal.aborted && reply.kind === 'selected' && options.some(option => option.id === reply.option)) {
              return { outcome: { outcome: 'selected', optionId: reply.option } };
            }
            return cancelled;
          } catch {
            return cancelled;
          } finally { listener[Symbol.dispose](); }
        })
        .onRequest(m.fs.readTextFile, forward(m.fs.readTextFile, fsCapabilities.readTextFile))
        .onRequest(m.fs.writeTextFile, forward(m.fs.writeTextFile, fsCapabilities.writeTextFile))
        .onRequest(m.terminal.create, forward(m.terminal.create, terminal))
        .onRequest(m.terminal.output, forward(m.terminal.output, terminal))
        .onRequest(m.terminal.release, forward(m.terminal.release, terminal))
        .onRequest(m.terminal.waitForExit, forward(m.terminal.waitForExit, terminal))
        .onRequest(m.terminal.kill, forward(m.terminal.kill, terminal));
      connection = app.connect(ndJsonStream(Writable.toWeb(owner.pipes.stdin), Readable.toWeb(owner.pipes.stdout),
        { maxMessageBytes: maxOutputBytes }));
      const agent = connection.agent;
      /** @type {InitializeResponse} */
      const initialized = await agent.request(a.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: fsCapabilities, terminal },
      }, { cancellationSignal: signal, stopWaitingOnCancel: true });
      if (initialized.protocolVersion !== PROTOCOL_VERSION) return resultFor(invocation, 'PROTOCOL_ERROR');
      const blocks = await attachmentBlocks(invocation, initialized.agentCapabilities, resolveAttachment, AbortSignal.any([signal, connection.signal]));
      if (!blocks || (required.includes('input.image') && (!resolveAttachment || !initialized.agentCapabilities?.promptCapabilities?.image))) {
        return resultFor(invocation, 'CAPABILITY_UNAVAILABLE');
      }
      signal.throwIfAborted();
      const session = await agent.request(a.session.new, { cwd, mcpServers: [] }, { cancellationSignal: signal, stopWaitingOnCancel: true });
      if (typeof session.sessionId !== 'string' || !session.sessionId.trim()) return resultFor(invocation, 'PROTOCOL_ERROR');
      sessionId = session.sessionId;
      try {
        if (!await configureSession(agent, a.session, session, invocation.profile.model, mode, signal)) {
          return resultFor(invocation, 'CAPABILITY_UNAVAILABLE');
        }
        const prompt = renderInvocationPrompt(invocation, 'Context retrieval is unavailable. Use the supplied context and report missing evidence.');
        signal.throwIfAborted();
        active = true;
        sent = true;
        const reply = await agent.request(a.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }, ...blocks] });
        const stopReason = reply?.stopReason;
        clearTimeout(cancelDeadline);
        active = false;
        permissionStop.abort();
        if (signal.aborted || stopReason === 'cancelled') result = resultFor(invocation, 'CANCELLED', stopReason === 'cancelled' ? 'cancelled' : 'unknown', 'sent');
        else if (stopReason === 'end_turn' && !truncated) {
          result = resultFor(invocation, undefined, 'completed', 'sent');
          result.output = invocation.kind === 'controller' ? parseDecisionText(output) : output;
        } else {
          const code = stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? 'RESOURCE_LIMIT' :
            stopReason === 'refusal' ? 'PROVIDER_REFUSED' : 'PROTOCOL_ERROR';
          result = resultFor(invocation, code, 'failed', 'sent');
        }
        flushMessage(!truncated && result.outcome.terminal === 'completed');
        publish({ ref: 'acp-stop', sourceId: sessionId, kind: 'provider_report', completeness: 'complete',
          value: { stopReason: stopReason ?? null, truncated, cancelRequested: signal.aborted } });
      } finally {
        active = false;
        permissionStop.abort();
        if (initialized.agentCapabilities?.sessionCapabilities?.close && !connection.signal.aborted) {
          await agent.request(a.session.close, { sessionId }, { cancellationSignal: AbortSignal.timeout(closeGraceMs), stopWaitingOnCancel: true }).catch(() => {});
        }
      }
    } catch (error) {
      const code = signal.aborted || (sent && error instanceof RequestError && error.code === -32800) ? 'CANCELLED' :
        error instanceof RequestError && !connection?.signal.aborted && sent ? 'PROTOCOL_ERROR' :
          sent ? 'PROVIDER_DISCONNECTED' : 'PROVIDER_START_FAILED';
      result = resultFor(invocation, code, sent ? 'unknown' : signal.aborted ? 'cancelled' : 'failed', sent ? 'unknown' : 'not_sent');
    } finally {
      active = false;
      permissionStop.abort();
      cancellation[Symbol.dispose]();
      clearTimeout(cancelDeadline);
      connection?.close();
      await owner.close();
    }
    const processResult = await owner.finished;
    if (processResult.reason === 'timed_out' && result.outcome.terminal !== 'completed' && !signal.aborted) {
      result.outcome.diagnostics = [{ code: 'DEADLINE_EXCEEDED', ref: undefined }];
    }
    flushMessage(false);
    publish({ ref: 'acp-process', sourceId: invocation.attemptId, completeness: 'complete',
      ...(processResult.exitCode === null ? { kind: 'host_transport' } : { kind: 'agent_exit', exitCode: processResult.exitCode }),
      value: { reason: processResult.reason, signal: processResult.signal, errors: processResult.errors, cancelRequested: signal.aborted } });
    result.outcome.outputRefs = refs;
    return result;
  }
}
