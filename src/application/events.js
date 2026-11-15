import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { redactDiagnostic } from './redact-diagnostic.js';
import { createBoundedDelivery } from './delivery.js';

/** @import {DiagnosticEvent, DiagnosticPort} from '../core/diagnostics.js' */
/** @import {ActivityScope} from '../core/ports.js' */
/** @import {Finding} from '../core/finding.js' */
/** @typedef {{event:DiagnosticEvent,findings?:readonly Finding[]}} ExecutionNotice */
/** @typedef {(event: DiagnosticEvent, findings?:readonly Finding[]) => void | Promise<void>} EventListener */

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
  /** @type {Set<{scope?: ActivityScope, delivery: ReturnType<typeof createBoundedDelivery<ExecutionNotice, ExecutionNotice>>}>} */
  const subscribers = new Set();
  let closed = false;
  /** @param {DiagnosticEvent} event @param {readonly Finding[]} [findings] */
  function emit(event,findings) {
      if (closed) return;
      const safe = /** @type {DiagnosticEvent} */ (redactDiagnostic(event, redaction));
      const snapshot = Object.freeze({ ...safe, details: safe.details && Object.freeze({ ...safe.details }) });
      emitDiagnostic(sink, snapshot);
      if (!subscribers.size) return;
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      // The scoped delivery view may carry the already committed model facts.
      // They never enter the diagnostic sink or an independent store.
      const committed = findings?.length && [...subscribers].some(s=>s.scope?.operationId===snapshot.operationId)
        ? structuredClone(findings) : undefined;
      const factBytes = committed ? Buffer.byteLength(JSON.stringify(committed)) : 0;
      for (const { scope, delivery } of subscribers) {
        if (scope && (scope.operationId !== snapshot.operationId ||
            (scope.attemptId !== undefined && scope.attemptId !== snapshot.attemptId))) continue;
        delivery.enqueue({event:snapshot,...(scope&&committed&&{findings:committed})},bytes+(scope?factBytes:0));
      }
  }
  return {
    emit,
    flush: () => sink.flush(),
    /** @param {EventListener} listener @param {ActivityScope} [scope] */
    subscribe(listener, scope) {
      if (closed) throw new Error('Event stream is closed');
      if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
      const subscription = { scope: scope && { ...scope }, delivery: createBoundedDelivery(/** @param {ExecutionNotice} notice */ notice=>listener(notice.event,notice.findings),
        (prior,dropped)=>({event:gapFor(prior?.event,dropped.event)})) };
      subscribers.add(subscription);
      return Object.assign(() => { subscription.delivery.close(); subscribers.delete(subscription); }, { finish: () => {
        subscribers.delete(subscription);
        return subscription.delivery.finish();
      } });
    },
    close() {
      closed = true;
      for (const subscriber of subscribers) subscriber.delivery.close();
      subscribers.clear();
    },
  };
}
