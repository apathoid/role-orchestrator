import { sameRecord } from '../../core/operation.js';

/** @import {IdFactory} from '../../core/diagnostics.js' */
/** @import {AuthorityPort, PermissionPort, PermissionRequest, PermissionResult} from '../../core/ports.js' */

/**
 * @typedef {PermissionRequest & {requestId: string, attemptId: string, profileId: string}} PendingPermission
 * @typedef {{request: PendingPermission, settle: (result: PermissionResult) => void,
 *   authorized: () => boolean}} Pending
 * @typedef {{requestId: string, attemptId: string, providerRequestId: string, optionId: string}} PermissionReply
 */

/**
 * The broker belongs to the Host. A provider only receives a request function
 * for its own attempt. A UI or other trusted client calls respond().
 * @param {{
 *   authority: AuthorityPort, ids: IdFactory,
 *   onRequest?: (request: PendingPermission) => void,
 *   standing?: readonly {profileId: string, resource: string, optionId: string, kind: 'allow' | 'deny'}[]
 * }} options
 */
export function createPermissionBroker({ authority, ids, onRequest, standing = [] }) {
  const standingDecisions = standing.map(item => ({ ...item }));
  /** @type {Map<string, Pending>} */
  const pending = new Map();

  /** @param {PermissionReply} reply */
  function respond(reply) {
    const entry = pending.get(reply.requestId);
    if (!entry || entry.request.attemptId !== reply.attemptId || entry.request.providerRequestId !== reply.providerRequestId) {
      return { kind: 'rejected', code: 'UNKNOWN_PERMISSION_REQUEST' };
    }
    const choice = entry.request.options.find(option => option.id === reply.optionId);
    if (!choice) return { kind: 'rejected', code: 'UNKNOWN_PERMISSION_OPTION' };
    if (!entry.authorized()) {
      entry.settle({ kind: 'denied' });
      return { kind: 'rejected', code: 'PERMISSION_DENIED' };
    }
    entry.settle({ kind: 'selected', option: choice.id });
    return { kind: 'accepted' };
  }

  /** @type {PermissionPort['bind']} */
  function bind({ attemptId, authorityRef, profileId, signal, report }) {
    let closed = signal.aborted;
    /** @type {Map<string, {input: PermissionRequest, result: Promise<PermissionResult>}>} */
    const deliveries = new Map();
    /** @type {Set<string>} */
    const owned = new Set();

    /** @type {NonNullable<Parameters<PermissionPort['bind']>[0]['report']>} */
    function trace(event, reason) {
      try { report?.(event, reason); } catch { /* Diagnostics are best effort. */ }
    }

    function close() {
      closed = true;
      signal.removeEventListener('abort', close);
      for (const requestId of owned) pending.get(requestId)?.settle({ kind: 'cancelled' });
      deliveries.clear();
    }
    if (!closed) signal.addEventListener('abort', close, { once: true });

    function authorized() {
      return !closed && authority.authorize(authorityRef, profileId) === 'ALLOWED';
    }

    return {
      close,
      async request(input) {
        if (closed) return { kind: 'cancelled' };
        if (!authorized()) return { kind: 'denied' };
        if (!input.providerRequestId || !input.resource || !input.options.length ||
            new Set(input.options.map(option => option.id)).size !== input.options.length ||
            input.options.some(option => !option.id || !['allow', 'deny'].includes(option.kind))) {
          return { kind: 'invalid' };
        }
        const earlier = deliveries.get(input.providerRequestId);
        if (earlier) return sameRecord(earlier.input, input) ? earlier.result : { kind: 'invalid' };
        const requestData = {
          ...input, options: input.options.map(item => Object.freeze({ ...item })),
          ...(input.action && { action: Object.freeze({
            ...input.action, locations: input.action.locations &&
              Object.freeze(input.action.locations.map(location => Object.freeze({ ...location }))),
          }) }),
        };
        const { promise, resolve } = /** @type {{promise: Promise<PermissionResult>, resolve: (result: PermissionResult) => void}} */ (Promise.withResolvers());
        deliveries.set(input.providerRequestId, { input: requestData, result: promise });

        const rule = standingDecisions.find(item => item.profileId === profileId && item.resource === input.resource);
        const choice = rule && requestData.options.find(option => option.id === rule.optionId && option.kind === rule.kind);
        if (choice || rule?.kind === 'deny') {
          trace('permission.resolved', 'STANDING_' + (choice?.kind ?? 'deny').toUpperCase());
          resolve(choice ? { kind: 'selected', option: choice.id } : { kind: 'denied' });
          return promise;
        }
        if (!onRequest) {
          trace('permission.resolved', 'PERMISSION_UNAVAILABLE');
          resolve({ kind: 'unavailable' });
          return promise;
        }
        const requestId = ids.newId();
        if (pending.has(requestId)) {
          resolve({ kind: 'invalid' });
          return promise;
        }
        const request = Object.freeze({
          ...requestData, options: Object.freeze(requestData.options), requestId, attemptId, profileId,
        });
        owned.add(requestId);
        const settle = /** @param {PermissionResult} result */ result => {
          owned.delete(requestId);
          pending.delete(requestId);
          const selected = result.kind === 'selected' ? request.options.find(option => option.id === result.option) : undefined;
          trace(result.kind === 'cancelled' ? 'permission.expired' : 'permission.resolved',
            selected?.kind.toUpperCase() ?? result.kind.toUpperCase());
          resolve(result);
        };
        pending.set(requestId, { request, settle, authorized });
        trace('permission.requested', 'AWAITING_TRUSTED_REPLY');
        try { onRequest(request); }
        catch { if (owned.has(requestId)) settle({ kind: 'unavailable' }); }
        return promise;
      },
    };
  }

  return Object.freeze({ bind, respond });
}
