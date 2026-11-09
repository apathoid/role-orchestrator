import { methods, RequestError } from '@agentclientprotocol/sdk';

/** @import {ClientRequestMethod, ClientRequestParamsByMethod, ClientRequestResponsesByMethod, RequestPermissionResponse} from '@agentclientprotocol/sdk' */
/** @import {PermissionHandler} from '../application/configuration/permissions.js' */
/** @typedef {ReturnType<typeof import('./acp.js').serveAcp>['route']} Route */
/** @typedef {{operationId: string, attemptId: string, signal: AbortSignal, lifecycleSignal: AbortSignal}} Scope */

const c = methods.client;

/** @param {Route} route */
export function createAcpRelay(route) {
  /** @type {PermissionHandler} */
  async function handleRequest(request, signal) {
    const destination = route(request.operationId);
    if (!destination) return { kind: 'unavailable' };
    const { client, sessionId } = destination;
    const stop = AbortSignal.any([signal, destination.signal]);
    try {
      const response = /** @type {RequestPermissionResponse} */ (await client.request(c.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: request.requestId,
          title: request.action?.title ?? request.resource,
          status: 'pending',
          locations: request.action?.locations?.map(({ path, line }) => ({ path, line })),
          rawInput: { resource: request.resource, details: request.action?.details },
        },
        options: request.options.map(option => ({
          optionId: option.id, name: option.label ?? option.id,
          kind: option.kind === 'allow' ? option.scope === 'always' ? 'allow_always' : 'allow_once'
            : option.scope === 'always' ? 'reject_always' : 'reject_once',
        })),
      }, { cancellationSignal: stop, stopWaitingOnCancel: true }));
      if (stop.aborted || route(request.operationId)?.sessionId !== sessionId) return { kind: 'cancelled' };
      if (response.outcome.outcome === 'cancelled') return { kind: 'cancelled' };
      const { optionId } = response.outcome;
      return request.options.some(option => option.id === optionId)
        ? { kind: 'selected', option: optionId } : { kind: 'invalid' };
    } catch {
      return stop.aborted ? { kind: 'cancelled' } : { kind: 'unavailable' };
    }
  }

  /** @type {Map<string, Map<string, () => void>>} */
  const terminals = new Map();

  /** @param {string} attemptId @param {string} terminalId */
  function forgetTerminal(attemptId, terminalId) {
    const owned = terminals.get(attemptId);
    const detach = owned?.get(terminalId);
    if (!owned || !detach) return false;
    owned.delete(terminalId);
    if (!owned.size) terminals.delete(attemptId);
    detach();
    return true;
  }

  /** @template {ClientRequestMethod} M @param {M} method */
  function relay(method) {
    /** @param {ClientRequestParamsByMethod[M]} params @param {Scope} scope */
    return async (params, scope) => {
      const destination = route(scope.operationId);
      if (!destination) throw RequestError.requestCancelled();
      const { client, sessionId, capabilities } = destination;
      const terminal = method.startsWith('terminal/');
      if (terminal ? !capabilities.terminal : method === c.fs.readTextFile
        ? !capabilities.fs?.readTextFile : !capabilities.fs?.writeTextFile) throw RequestError.methodNotFound(method);
      const input = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (params));
      const terminalId = typeof input.terminalId === 'string' ? input.terminalId : undefined;
      if (terminalId && !terminals.get(scope.attemptId)?.has(terminalId)) {
        throw new RequestError(-32602, 'Unknown terminal for this attempt');
      }
      const signal = AbortSignal.any([scope.signal, destination.signal]);
      signal.throwIfAborted();
      const result = await client.request(method, { ...input, sessionId }, {
        cancellationSignal: signal, stopWaitingOnCancel: method !== c.terminal.create,
      });
      if (method === c.terminal.create && result && typeof result === 'object' && 'terminalId' in result && typeof result.terminalId === 'string') {
        const id = result.terminalId;
        const release = () => {
          if (forgetTerminal(scope.attemptId, id)) {
            if (!destination.signal.aborted) void client.request(c.terminal.release, { sessionId, terminalId: id },
              { cancellationSignal: AbortSignal.timeout(1000), stopWaitingOnCancel: true }).catch(() => {});
          }
        };
        let owned = terminals.get(scope.attemptId);
        if (!owned) terminals.set(scope.attemptId, owned = new Map());
        owned.get(id)?.();
        owned.set(id, () => scope.lifecycleSignal.removeEventListener('abort', release));
        if (signal.aborted) release();
        else scope.lifecycleSignal.addEventListener('abort', release, { once: true });
      }
      if (method === c.terminal.release && terminalId) forgetTerminal(scope.attemptId, terminalId);
      signal.throwIfAborted();
      return /** @type {ClientRequestResponsesByMethod[M]} */ (result);
    };
  }

  return {
    handleRequest,
    /** @param {string} operationId */
    bridgeCapabilities(operationId) { return route(operationId)?.capabilities ?? {}; },
    bridge: {
      [c.fs.readTextFile]: relay(c.fs.readTextFile),
      [c.fs.writeTextFile]: relay(c.fs.writeTextFile),
      [c.terminal.create]: relay(c.terminal.create),
      [c.terminal.output]: relay(c.terminal.output),
      [c.terminal.waitForExit]: relay(c.terminal.waitForExit),
      [c.terminal.release]: relay(c.terminal.release),
      [c.terminal.kill]: relay(c.terminal.kill),
    },
  };
}
