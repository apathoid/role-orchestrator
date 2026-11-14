/**
 * @typedef {{now: () => number, monotonicNow: () => number}} Clock
 * @typedef {{newId: () => string}} IdFactory
 * @typedef {'debug' | 'info' | 'warn' | 'error'} DiagnosticLevel
 * @typedef {Readonly<{
 *   schemaVersion: 1, eventId: string, receivedAt: number, sequence: number,
 *   level: DiagnosticLevel, component: string, eventName: string,
 *   operationId?: string, attemptId?: string, actionId?: string, decisionId?: string,
 *   reasonCode: string, details?: Readonly<Record<string, string | number | boolean | null>>
 * }>} DiagnosticEvent
 * @typedef {{emit: (event: DiagnosticEvent) => void | Promise<void>, flush: () => void | Promise<void>}} DiagnosticPort
 */

/** @type {Readonly<DiagnosticPort>} */
export const noopDiagnostics = Object.freeze({
  emit() {},
  flush() {},
});

/**
 * Diagnostics have no bearing on the caller's outcome. Async sinks own their
 * buffers and backpressure; the caller never waits for an individual event.
 * @param {DiagnosticPort} sink
 * @param {DiagnosticEvent} event
 */
export function emitDiagnostic(sink, event) {
  try {
    const pending = sink.emit(event);
    if (pending !== undefined) void pending.catch(() => {});
  } catch {
    // An unavailable sink cannot reject a domain operation.
  }
}
