const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_TURN_DEADLINE_MS = 2_700_000;

function finitePositiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Resolve activity-aware ACP turn timing.
 *
 * `timeoutMs` is retained as a legacy compatibility alias. When it is the only
 * timing option present it keeps the old fixed-timeout behaviour by supplying
 * both the idle timeout and the absolute deadline. New configurations should
 * use `idleTimeoutMs` + `turnDeadlineMs` explicitly.
 */
export function resolveTurnTiming(profile = {}, providerConfig = {}) {
  const legacyTimeout = profile.timeoutMs ?? providerConfig.timeoutMs;
  const idleTimeoutMs = finitePositiveMs(
    profile.idleTimeoutMs ?? providerConfig.idleTimeoutMs ?? legacyTimeout,
    DEFAULT_IDLE_TIMEOUT_MS,
  );
  const turnDeadlineMs = finitePositiveMs(
    profile.turnDeadlineMs ?? providerConfig.turnDeadlineMs ?? legacyTimeout,
    DEFAULT_TURN_DEADLINE_MS,
  );
  return { idleTimeoutMs, turnDeadlineMs };
}

function timingError(label, kind, idleTimeoutMs, turnDeadlineMs) {
  const message = kind === 'idle'
    ? `${label} idle timeout after ${idleTimeoutMs} ms without ACP activity (absolute turn deadline ${turnDeadlineMs} ms).`
    : `${label} exceeded absolute turn deadline of ${turnDeadlineMs} ms.`;
  const error = new Error(message);
  error.timeoutKind = kind;
  error.idleTimeoutMs = idleTimeoutMs;
  error.turnDeadlineMs = turnDeadlineMs;
  return error;
}

/**
 * A two-level timeout guard for one ACP prompt turn.
 *
 * - idle timeout: reset by `touch()` whenever the agent emits useful ACP
 *   activity (reasoning, commentary, tool/progress updates, etc.);
 * - absolute deadline: never reset, so a continuously-chatty runaway turn is
 *   still bounded;
 * - idle timing can be paused while the agent is legitimately blocked on an
 *   outer user interaction such as permission/elicitation.
 */
export class TurnTimingGuard {
  constructor({ label = 'ACP turn', idleTimeoutMs, turnDeadlineMs, onTimeout = null } = {}) {
    this.label = label;
    this.idleTimeoutMs = finitePositiveMs(idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    this.turnDeadlineMs = finitePositiveMs(turnDeadlineMs, DEFAULT_TURN_DEADLINE_MS);
    this.onTimeout = typeof onTimeout === 'function' ? onTimeout : null;
    this.idleTimer = null;
    this.deadlineTimer = null;
    this.reject = null;
    this.promise = null;
    this.started = false;
    this.finished = false;
    this.pauseDepth = 0;
  }

  start() {
    if (this.started) return this.promise;
    this.started = true;
    this.promise = new Promise((_, reject) => { this.reject = reject; });
    this.deadlineTimer = setTimeout(() => this.#expire('deadline'), this.turnDeadlineMs);
    this.#scheduleIdle();
    return this.promise;
  }

  touch() {
    if (!this.started || this.finished || this.pauseDepth > 0) return;
    this.#scheduleIdle();
  }

  pauseIdle() {
    if (!this.started || this.finished) return;
    this.pauseDepth += 1;
    if (this.pauseDepth === 1) this.#clearIdle();
  }

  resumeIdle() {
    if (!this.started || this.finished || this.pauseDepth === 0) return;
    this.pauseDepth -= 1;
    if (this.pauseDepth === 0) this.#scheduleIdle();
  }

  dispose() {
    if (this.finished) return;
    this.finished = true;
    this.#clearIdle();
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    this.reject = null;
  }

  #scheduleIdle() {
    this.#clearIdle();
    this.idleTimer = setTimeout(() => this.#expire('idle'), this.idleTimeoutMs);
  }

  #clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  #expire(kind) {
    if (this.finished) return;
    this.finished = true;
    this.#clearIdle();
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    const error = timingError(this.label, kind, this.idleTimeoutMs, this.turnDeadlineMs);
    try { this.onTimeout?.(error); } catch { }
    this.reject?.(error);
    this.reject = null;
  }
}
