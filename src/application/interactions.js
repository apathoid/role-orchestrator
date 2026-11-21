import { sameRecord } from '../core/operation.js';
import { decode, jsonValue } from '../core/decode.js';

/** @import {InteractionPort, InteractionRequest, PendingInteraction, InteractionResult, InteractionReply} from '../core/ports.js' */
/** @import {IdFactory} from '../core/diagnostics.js' */
/** @typedef {{request: PendingInteraction, manual: boolean, active: () => boolean,
 *   settle: (result: InteractionResult) => void, answer?: unknown}} Entry */

/**
 * Ephemeral request/reply correlation. Not a permission broker or an execution
 * lifecycle. A configured handler OR manual owner answers, not observers.
 * @param {{ids: IdFactory, timeoutMs?: number,
 *   available?: (operationId: string, kind: InteractionRequest['kind']) => boolean,
 *   onRequest?: (request: PendingInteraction) => void | Promise<void>,
 *   handleRequest?: (request: PendingInteraction, signal: AbortSignal) => Promise<InteractionResult>}} options
 */
export function createInteractionBroker({ ids, timeoutMs, available = () => true, onRequest, handleRequest }) {
  if (onRequest && handleRequest) throw new TypeError('Choose one interaction answer owner');
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)) {
    throw new RangeError('Invalid interaction timeout');
  }
  /** @type {Map<string, Entry>} */
  const pending = new Map();
  /** @type {Map<string, Entry>} */
  const receipts = new Map();

  /** @param {InteractionReply} reply */
  function respond(reply) {
    const entry = pending.get(reply.requestId) ?? receipts.get(reply.requestId);
    if (!entry || !entry.manual || entry.request.operationId !== reply.operationId ||
        entry.request.attemptId !== reply.attemptId || entry.request.providerRequestId !== reply.providerRequestId) {
      return { kind: 'rejected', code: 'UNKNOWN_INTERACTION_REQUEST' };
    }
    if (!entry.active()) return { kind: 'rejected', code: 'INTERACTION_CLOSED' };
    const parsed = decode(jsonValue, reply.payload);
    if (parsed.kind === 'rejected') return { kind: 'rejected', code: 'INVALID_INTERACTION_REPLY' };
    if (receipts.has(reply.requestId)) {
      return sameRecord(entry.answer, parsed.value) ? { kind: 'accepted' }
        : { kind: 'rejected', code: 'INTERACTION_REPLY_CONFLICT' };
    }
    entry.answer = parsed.value;
    entry.settle({ kind: 'answered', payload: parsed.value });
    return { kind: 'accepted' };
  }

  /** @type {InteractionPort['bind']} */
  function bind(scope) {
    let closed = scope.signal.aborted;
    /** @type {Map<string, {input: InteractionRequest, result: Promise<InteractionResult>}>} */
    const deliveries = new Map();
    /** @type {Set<string>} */
    const owned = new Set();
    /** @param {string} event @param {string} reason */
    function report(event, reason) {
      try { scope.report?.(event, reason); } catch { /* Best effort. */ }
    }
    const active = () => !closed && !scope.signal.aborted && scope.isActive();
    /** @returns {InteractionResult} */
    const stopped = () => scope.signal.reason === 'deadline' ? { kind: 'timed_out' } : { kind: 'cancelled' };
    function close() {
      closed = true;
      scope.signal.removeEventListener('abort', close);
      for (const id of owned) {
        pending.get(id)?.settle(stopped());
        receipts.delete(id);
      }
      owned.clear();
      deliveries.clear();
    }
    if (!closed) scope.signal.addEventListener('abort', close, { once: true });
    /** @param {InteractionRequest['kind']} kind */
    function supports(kind) {
      try { return active() && !!(onRequest || handleRequest) && available(scope.operationId, kind); }
      catch { return false; }
    }
    return {
      close, supports,
      async request(input, requestSignal) {
        if (!active() || requestSignal?.aborted) return stopped();
        if (!supports(input.kind)) return { kind: 'unavailable' };
        if (!input.providerRequestId || !input.nativeKind) return { kind: 'invalid' };
        const parsed = decode(jsonValue, input.payload);
        if (parsed.kind === 'rejected') return { kind: 'invalid' };
        const data = { ...input, payload: parsed.value };
        const prior = deliveries.get(input.providerRequestId);
        if (prior) return sameRecord(prior.input, data) ? prior.result : { kind: 'invalid' };
        const remaining = Math.min(scope.deadline - scope.clock.monotonicNow(), timeoutMs ?? Infinity);
        if (remaining <= 0) return { kind: 'timed_out' };
        const requestId = ids.newId();
        if (pending.has(requestId) || receipts.has(requestId)) return { kind: 'invalid' };
        const request = { ...data, requestId, operationId: scope.operationId, attemptId: scope.attemptId,
          profileId: scope.profileId, deadlineAt: scope.clock.now() + remaining };
        /** @type {PromiseWithResolvers<InteractionResult>} */
        const { promise, resolve } = Promise.withResolvers();
        deliveries.set(input.providerRequestId, { input: data, result: promise });
        owned.add(requestId);
        const delivery = new AbortController();
        let clear = () => {};
        const expires = scope.clock.monotonicNow() + remaining;
        const alive = () => active() && !requestSignal?.aborted && scope.clock.monotonicNow() < expires;
        /** @type {Entry} */
        const entry = { request, manual: !!onRequest, active: () => receipts.has(requestId) ? active() : alive(), settle(result) {
          if (!pending.delete(requestId)) return;
          clear();
          requestSignal?.removeEventListener('abort', interrupt);
          delivery.abort();
          if (result.kind === 'answered' && entry.manual) receipts.set(requestId, entry);
          report('interaction.resolved', 'INTERACTION_' + result.kind.toUpperCase());
          resolve(result);
        } };
        function interrupt() { entry.settle(stopped()); }
        pending.set(requestId, entry);
        requestSignal?.addEventListener('abort', interrupt, { once: true });
        clear = scope.schedule(Math.ceil(remaining), () => entry.settle({ kind: 'timed_out' }));
        if (!pending.has(requestId)) clear();
        if (!alive()) entry.settle(active() && !requestSignal?.aborted ? { kind: 'timed_out' } : stopped());
        else {
          report('interaction.requested', 'AWAITING_TRUSTED_REPLY');
          void Promise.resolve().then(async () => {
            if (!pending.has(requestId)) return;
            if (handleRequest) {
              const result = await handleRequest(structuredClone(request), delivery.signal);
              if (!pending.has(requestId)) return;
              if (!alive()) entry.settle(active() && !requestSignal?.aborted ? { kind: 'timed_out' } : stopped());
              else if (result.kind === 'answered') {
                const reply = decode(jsonValue, result.payload);
                entry.settle(reply.kind === 'accepted' ? { kind: 'answered', payload: reply.value } : { kind: 'invalid' });
              } else if (['unavailable', 'cancelled', 'timed_out', 'invalid', 'error'].includes(result.kind)) entry.settle(result);
              else entry.settle({ kind: 'invalid' });
            } else await onRequest?.(structuredClone(request));
          }).catch(() => entry.settle({ kind: 'unavailable' }));
        }
        return promise;
      },
    };
  }

  return Object.freeze({
    bind, respond,
    /** Trusted host inspection, not authority to reply. @param {string} operationId */
    pending(operationId) {
      return [...pending.values()].filter(x => x.request.operationId === operationId).map(x => structuredClone(x.request));
    },
  });
}
