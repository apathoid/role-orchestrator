import { cancellationErrorFromSignal } from '../../cancellation.mjs';

// ACP's RPC request API does not accept AbortSignal uniformly. Keep local
// invocation promises bounded and notify the provider to cancel/tear down.
// Individual RPC timeouts are distinct from model-turn idle/deadline timing.
export class AcpInvocationGuard {
  constructor({ signal, label, deadlineMs, preflightTimeoutMs = 120_000, onInterrupt = null }) {
    this.signal = signal;
    this.label = label;
    this.preflightTimeoutMs = preflightTimeoutMs;
    this.onInterrupt = onInterrupt;
    this.phase = 'start';
    this.disposed = false;
    this.failed = false;
    this.interruption = new Promise((_, reject) => { this.rejectInterruption = reject; });
    // An interruption may occur before the first RPC is awaited.
    this.interruption.catch(() => {});
    this.onAbort = () => this.interrupt(cancellationErrorFromSignal(signal));
    signal?.addEventListener('abort', this.onAbort, { once: true });
    this.deadlineTimer = setTimeout(() => {
      this.interrupt(this.timeout('invocation_deadline'));
    }, deadlineMs);
    if (signal?.aborted) this.onAbort();
  }

  timeout(kind) {
    const error = new Error(`${this.label}: ${kind} during ${this.phase}.`);
    error.code = 'ACP_INVOCATION_TIMEOUT';
    error.timeoutKind = kind;
    error.phase = this.phase;
    error.diagnostics = { source: 'orchestrator_timing', phase: this.phase, timeoutKind: kind };
    return error;
  }

  interrupt(error) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    try { this.onInterrupt?.(this.phase, error); } catch { /* preserve primary failure */ }
    this.rejectInterruption(error);
  }

  async run(operation, phase, timeoutMs = this.preflightTimeoutMs) {
    this.phase = phase;
    if (this.signal?.aborted) this.onAbort();
    let timer;
    try {
      return await Promise.race([
        this.interruption,
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = this.timeout('preflight');
            this.interrupt(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async boundedClose(operation, timeoutMs = 3_000) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(this.timeout('session_close')), timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.deadlineTimer);
    this.signal?.removeEventListener('abort', this.onAbort);
  }
}

export function acpInvocationLimits(profile = {}, config = {}) {
  const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  const preflightTimeoutMs = positive(profile.preflightTimeoutMs ?? config.preflightTimeoutMs, 120_000);
  const cleanupTimeoutMs = positive(profile.cleanupTimeoutMs ?? config.cleanupTimeoutMs, 3_000);
  const turnDeadlineMs = positive(profile.turnDeadlineMs ?? config.turnDeadlineMs ?? profile.timeoutMs ?? config.timeoutMs, 2_700_000);
  const deadlineMs = positive(profile.invocationDeadlineMs ?? config.invocationDeadlineMs, turnDeadlineMs + 4 * preflightTimeoutMs + cleanupTimeoutMs);
  return { preflightTimeoutMs, cleanupTimeoutMs, deadlineMs };
}
