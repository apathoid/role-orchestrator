import { decode, jsonValue } from '../core/decode.js';
import { createBoundedDelivery } from './delivery.js';

/** @import {ProviderActivity, ActivityEvent, ActivityNotice, ActivityScope, ActivityListener, ActivityCallback} from '../core/ports.js' */
/** @typedef {Extract<ActivityNotice, {kind: 'gap'}>} Gap */
/** @typedef {{scope: ActivityScope, delivery: ReturnType<typeof createBoundedDelivery<ActivityEvent, Gap>>}} Subscriber */

const kinds = new Set(['reasoning', 'user_message', 'tool', 'plan', 'finding']);

/** @param {unknown} value */
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

/**
 * Ephemeral delivery only: no state writer, model call, evidence or replay.
 * The callback is bound by the coordinator, not by provider-supplied IDs.
 */
export function createActivityStream() {
  /** @type {Set<Subscriber>} */
  const subscribers = new Set();
  let closed = false;

  /** @param {Subscriber} sub */
  function detach(sub) {
    sub.delivery.close();
    subscribers.delete(sub);
  }

  /** @param {Gap | undefined} prior @param {ActivityEvent} event @returns {Gap} */
  function gapFor(prior, event) {
    if (!prior) return { kind: 'gap', operationId: event.operationId, attemptId: event.attemptId,
      droppedCount: 1, reason: 'overflow', sequenceRange: { first: event.sequence, last: event.sequence } };
    prior.droppedCount++;
    if (prior.attemptId !== event.attemptId || !prior.sequenceRange ||
        prior.sequenceRange.last + 1 !== event.sequence) {
      delete prior.attemptId;
      delete prior.sequenceRange;
    } else prior.sequenceRange.last = event.sequence;
    return prior;
  }

  return {
    /** Trusted in-process consumer; transports must scope this using their existing ownership.
     * @param {ActivityScope} scope @param {ActivityListener} listener */
    subscribe(scope, listener) {
      if (closed) throw new Error('Activity stream is closed');
      if (typeof scope.operationId !== 'string' || !scope.operationId ||
          (scope.attemptId !== undefined && (typeof scope.attemptId !== 'string' || !scope.attemptId)) ||
          typeof listener !== 'function') throw new TypeError('Invalid activity subscription');
      /** @type {Subscriber} */
      const sub = { scope: { operationId: scope.operationId, attemptId: scope.attemptId },
        delivery: createBoundedDelivery(listener, gapFor) };
      subscribers.add(sub);
      return Object.assign(() => detach(sub), { finish: () => {
        subscribers.delete(sub);
        return sub.delivery.finish();
      } });
    },
    /**
     * @param {{operationId: string, attemptId: string, profileId: string, providerId: string}} source
     * @param {() => boolean} isActive
     * @returns {ActivityCallback}
     */
    bind(source, isActive) {
      const identity = { operationId: source.operationId, attemptId: source.attemptId,
        profileId: source.profileId, providerId: source.providerId };
      let sequence = 0;
      return item => {
        try {
          if (closed || !item || !kinds.has(item.kind)) return;
          const current = ++sequence;
          const matching = [...subscribers].filter(sub => sub.scope.operationId === identity.operationId &&
            (sub.scope.attemptId === undefined || sub.scope.attemptId === identity.attemptId));
          if (!matching.length) return;
          if (!isActive()) return;
          const parsed = decode(jsonValue, item.payload);
          if (parsed.kind !== 'accepted') return;
          /** @type {ActivityEvent} */
          const event = { ...identity, source: 'provider_activity', sequence: current, kind: item.kind,
            payload: parsed.value,
            ...(typeof item.nativeId === 'string' && { nativeId: item.nativeId }),
            ...(typeof item.nativeKind === 'string' && { nativeKind: item.nativeKind }) };
          const bytes = Buffer.byteLength(JSON.stringify(event));
          freeze(event);
          for (const sub of matching) sub.delivery.enqueue(event, bytes);
        } catch { /* Malformed/oversized activity is never a provider failure. */ }
      };
    },
    close() {
      closed = true;
      for (const sub of subscribers) detach(sub);
    },
  };
}
