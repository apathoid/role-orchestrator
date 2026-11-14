import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { redactDiagnostic } from './redact-diagnostic.js';
import { createBoundedDelivery } from './delivery.js';

/** @import {DiagnosticEvent, DiagnosticPort} from '../core/diagnostics.js' */
/** @import {ActivityScope} from '../core/ports.js' */
/** @typedef {(event: DiagnosticEvent) => void | Promise<void>} EventListener */

/** @param {DiagnosticEvent | undefined} prior @param {DiagnosticEvent} dropped @returns {DiagnosticEvent} */
function gapFor(prior, dropped) {
  return Object.freeze({
    schemaVersion: 1, eventId: prior?.eventId ?? 'delivery-gap:' + dropped.eventId,
    receivedAt: dropped.receivedAt, sequence: dropped.sequence,
    level: 'warn', component: 'delivery', eventName: 'delivery.gap', reasonCode: 'DELIVERY_OVERFLOW',
    operationId: !prior || prior.operationId === dropped.operationId ? dropped.operationId : undefined,
    attemptId: !prior || prior.attemptId === dropped.attemptId ? dropped.attemptId : undefined,
    details: Object.freeze({ droppedCount: Number(prior?.details?.droppedCount ?? 0) + 1, reason: 'overflow' }),
  });
}

/** @param {DiagnosticPort} sink @param {{secrets?: readonly string[], captureBodies?: boolean}} [redaction] */
export function createEventStream(sink = noopDiagnostics, redaction = {}) {
  /** @type {Set<{scope?: ActivityScope, delivery: ReturnType<typeof createBoundedDelivery<DiagnosticEvent, DiagnosticEvent>>}>} */
  const subscribers = new Set();
  let closed = false;
  return {
    /** @param {DiagnosticEvent} event */
    emit(event) {
      if (closed) return;
      const safe = /** @type {DiagnosticEvent} */ (redactDiagnostic(event, redaction));
      const snapshot = Object.freeze({ ...safe, details: safe.details && Object.freeze({ ...safe.details }) });
      emitDiagnostic(sink, snapshot);
      if (!subscribers.size) return;
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      for (const { scope, delivery } of subscribers) {
        if (scope && (scope.operationId !== snapshot.operationId ||
            (scope.attemptId !== undefined && scope.attemptId !== snapshot.attemptId))) continue;
        delivery.enqueue(snapshot, bytes);
      }
    },
    flush: () => sink.flush(),
    /** @param {EventListener} listener @param {ActivityScope} [scope] */
    subscribe(listener, scope) {
      if (closed) throw new Error('Event stream is closed');
      if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
      const subscription = { scope: scope && { ...scope }, delivery: createBoundedDelivery(listener, gapFor) };
      subscribers.add(subscription);
      return () => { subscription.delivery.close(); subscribers.delete(subscription); };
    },
    close() {
      closed = true;
      for (const subscriber of subscribers) subscriber.delivery.close();
      subscribers.clear();
    },
  };
}
