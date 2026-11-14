import { decode, jsonValue } from '../core/decode.js';

/** @import {ProviderActivity, ActivityEvent, ActivityNotice, ActivityScope, ActivityListener, ActivityCallback} from '../core/ports.js' */
/** @typedef {{event: ActivityEvent, bytes: number}} Entry */
/** @typedef {{scope: ActivityScope, listener: ActivityListener, queue: Entry[], bytes: number,
 *   draining: boolean, active: boolean, gap?: Extract<ActivityNotice, {kind: 'gap'}>}} Subscriber */

const maxEvents = 128;
const maxBytes = 1024 * 1024;
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
    sub.active = false;
    sub.queue.length = 0;
    sub.bytes = 0;
    sub.gap = undefined;
    subscribers.delete(sub);
  }

  /** @param {Subscriber} sub @param {ActivityEvent} event */
  function drop(sub, event) {
    const prior = sub.gap;
    if (!prior) {
      sub.gap = { kind: 'gap', operationId: event.operationId, attemptId: event.attemptId,
        droppedCount: 1, reason: 'overflow', sequenceRange: { first: event.sequence, last: event.sequence } };
    } else {
      prior.droppedCount++;
      if (prior.attemptId !== event.attemptId || !prior.sequenceRange ||
          prior.sequenceRange.last + 1 !== event.sequence) {
        delete prior.attemptId;
        delete prior.sequenceRange;
      } else prior.sequenceRange.last = event.sequence;
    }
  }

  /** @param {Subscriber} sub */
  function wake(sub) {
    if (sub.draining || !sub.active) return;
    sub.draining = true;
    queueMicrotask(() => { void drain(sub); });
  }

  /** @param {Subscriber} sub */
  async function drain(sub) {
    try {
      while (sub.active) {
        const entry = sub.queue.shift();
        const notice = entry?.event ?? sub.gap;
        if (!notice) break;
        if (!entry) sub.gap = undefined;
        try { await sub.listener(notice); } catch { /* Delivery cannot fail execution. */ }
        if (entry && sub.active) sub.bytes -= entry.bytes;
      }
    } finally {
      sub.draining = false;
      if (sub.active && (sub.queue.length || sub.gap)) wake(sub);
    }
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
        listener, queue: [], bytes: 0, draining: false, active: true };
      subscribers.add(sub);
      return () => detach(sub);
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
          for (const sub of matching) {
            if (!sub.active) continue;
            // Keep the pending gap after the already queued prefix; do not
            // insert newer events ahead of the gap. No replay is promised.
            if (sub.gap || sub.queue.length >= maxEvents - 1 || bytes > maxBytes - sub.bytes) drop(sub, event);
            else { sub.queue.push({ event, bytes }); sub.bytes += bytes; }
            wake(sub);
          }
        } catch { /* Malformed/oversized activity is never a provider failure. */ }
      };
    },
    close() {
      closed = true;
      for (const sub of subscribers) detach(sub);
    },
  };
}
