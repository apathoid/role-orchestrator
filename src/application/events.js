import { emitDiagnostic, noopDiagnostics } from '../core/diagnostics.js';
import { redactDiagnostic } from './redact-diagnostic.js';

/** @import {DiagnosticEvent, DiagnosticPort} from '../core/diagnostics.js' */
/** @typedef {(event: DiagnosticEvent) => void | Promise<void>} EventListener */

/** @param {DiagnosticPort} sink @param {{secrets?: readonly string[], captureBodies?: boolean}} [redaction] */
export function createEventStream(sink = noopDiagnostics, redaction = {}) {
  /** @type {Set<{listener: EventListener}>} */
  const subscribers = new Set();
  let closed = false;
  return {
    /** @param {DiagnosticEvent} event */
    emit(event) {
      if (closed) return;
      const safe = /** @type {DiagnosticEvent} */ (redactDiagnostic(event, redaction));
      const snapshot = Object.freeze({ ...safe, details: safe.details && Object.freeze({ ...safe.details }) });
      emitDiagnostic(sink, snapshot);
      for (const subscriber of subscribers) {
        queueMicrotask(() => {
          if (!subscribers.has(subscriber)) return;
          try { void Promise.resolve(subscriber.listener(snapshot)).catch(() => {}); }
          catch { /* Subscribers cannot reject a task. */ }
        });
      }
    },
    flush: () => sink.flush(),
    /** @param {EventListener} listener */
    subscribe(listener) {
      if (closed) throw new Error('Event stream is closed');
      if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
      const subscription = { listener };
      subscribers.add(subscription);
      return () => { subscribers.delete(subscription); };
    },
    close() {
      closed = true;
      subscribers.clear();
    },
  };
}
