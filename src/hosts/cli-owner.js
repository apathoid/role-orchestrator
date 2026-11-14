import { permissionResult, interactionResult, supportedForm } from './cli-input.js';

/** @import {PendingInput, InputResult} from './cli-input.js' */
/** @import {InteractionReply, PendingInteraction} from '../core/ports.js' */
/** @import {PermissionHandler} from '../application/configuration/permissions.js' */
/** @typedef {{requestId:string, remote:boolean, interactive:boolean}} Owner */

/** Existing work-request ownership only; pending delivery does not create execution state.
 * @param {ReturnType<typeof import('./cli-input.js').createCliInput>} terminal */
export function cliOwner(terminal) {
  /** @type {Map<string,Owner>} */
  const owners = new Map();
  /** @type {Map<string,{entry:PendingInput, finish:(result:InputResult)=>void}>} */
  const pending = new Map();
  /** @param {string} operationId @param {string} requestId @param {boolean} remote @param {boolean} interactive */
  function accept(operationId,requestId,remote,interactive) {
    const current = owners.get(operationId);
    if (current) return current.requestId === requestId && current.remote === remote;
    owners.set(operationId,{requestId,remote,interactive});
    return true;
  }
  /** @param {string} operationId @param {string} requestId */
  function detach(operationId, requestId) {
    if (owners.get(operationId)?.requestId !== requestId) return;
    owners.delete(operationId);
    for (const value of [...pending.values()]) if (value.entry.request.operationId === operationId) value.finish({kind:'unavailable'});
  }
  /** @param {PendingInput} entry @param {AbortSignal} signal @returns {Promise<InputResult>} */
  async function ask(entry, signal) {
    const owner = entry.request.operationId && owners.get(entry.request.operationId);
    if (!owner?.interactive || (entry.kind === 'input' && !supportedForm(entry.request))) return {kind:'unavailable'};
    if (!owner.remote) return terminal.ask(entry,signal);
    if (signal.aborted) return {kind:'cancelled'};
    const id = entry.request.requestId;
    return new Promise(resolve => {
      /** @param {InputResult} result */
      const finish = result => { if (pending.delete(id)) { signal.removeEventListener('abort',abort); resolve(result); } };
      const abort = () => finish({kind:'cancelled'});
      pending.set(id,{entry,finish});
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) abort();
    });
  }
  return {
    accept, detach,
    /** @param {string} operationId */
    available: operationId => owners.get(operationId)?.interactive === true,
    /** @type {PermissionHandler} */
    handlePermission: async (request,signal) => {
      const result = await ask({kind:'permission',request},signal);
      return permissionResult(result);
    },
    /** @param {PendingInteraction} request @param {AbortSignal} signal */
    handleInteraction: async (request,signal) => interactionResult(await ask({kind:'input',request},signal)),
    /** @param {string} operationId */
    pending: operationId => [...pending.values()].filter(x => x.entry.request.operationId === operationId).map(x => x.entry),
    /** @param {InteractionReply} reply */
    respond(reply) {
      const found = pending.get(reply.requestId), request = found?.entry.request;
      if (!found || !request || request.operationId !== reply.operationId || request.attemptId !== reply.attemptId ||
          request.providerRequestId !== reply.providerRequestId) return {kind:'rejected',code:'UNKNOWN_INTERACTION_REQUEST'};
      const payload = reply.payload;
      if (!payload || typeof payload !== 'object' || !('kind' in payload)) return {kind:'rejected',code:'INVALID_INTERACTION_REPLY'};
      if (payload.kind === 'unavailable' || payload.kind === 'cancelled') found.finish({kind:payload.kind});
      else if (payload.kind === 'answered' && 'payload' in payload) {
        if (found.entry.kind === 'permission' && permissionResult({kind:'answered',payload:payload.payload}).kind !== 'selected') return {kind:'rejected',code:'INVALID_INTERACTION_REPLY'};
        if (found.entry.kind === 'permission') {
          const result = permissionResult({kind:'answered',payload:payload.payload});
          if (result.kind !== 'selected' || !found.entry.request.options.some(option=>option.id===result.option)) return {kind:'rejected',code:'UNKNOWN_PERMISSION_OPTION'};
        }
        found.finish({kind:'answered',payload:payload.payload});
      } else return {kind:'rejected',code:'INVALID_INTERACTION_REPLY'};
      return {kind:'accepted'};
    },
  };
}
