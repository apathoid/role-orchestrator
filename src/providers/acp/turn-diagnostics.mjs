/**
 * Diagnostic-only record for an invocation of an inner ACP agent. Never stores
 * prompt text, tool payloads, or model output. One record spans all reconciliation
 * prompts within the same inner session; activity is scoped to each prompt turn.
 */
export class AcpTurnDiagnostics {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.startedAt = now();
    this.turnStartedAt = null;
    this.turnNumber = 0;
    this.timing = null;
    this.updateCount = 0;
    this.lastUpdateAt = null;
    this.lastUpdateType = null;
    this.localTimeout = null;
    this.timeoutError = null;
    this.cancelAttempts = [];
    this.cancelAttemptCount = 0;
  }

  beginTurn(timing) {
    this.turnNumber += 1;
    this.turnStartedAt = this.now();
    this.timing = { idleTimeoutMs: timing.idleTimeoutMs, turnDeadlineMs: timing.turnDeadlineMs };
    this.updateCount = 0;
    this.lastUpdateAt = null;
    this.lastUpdateType = null;
    this.localTimeout = null;
    this.timeoutError = null;
  }

  recordUpdate(type) {
    if (this.turnStartedAt === null) return;
    this.updateCount += 1;
    this.lastUpdateAt = this.now();
    this.lastUpdateType = typeof type === 'string' ? type : 'unknown';
  }

  recordTimeout(error) {
    this.timeoutError = error;
    this.localTimeout = {
      kind: error.timeoutKind,
      elapsedMs: this.turnStartedAt === null ? null : Math.max(0, this.now() - this.turnStartedAt),
    };
  }

  /**
   * A successful notify() promise only establishes local transport submission,
   * NOT an acknowledgement that the provider acted on session.cancel.
   */
  sendCancel(connection, method, sessionId, reason, outerReason = null) {
    const entry = {
      reason,
      ...(outerReason ? { outerReason } : {}),
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      turnNumber: this.turnNumber,
      notificationStatus: 'pending',
    };
    this.cancelAttemptCount += 1;
    this.cancelAttempts.push(entry);
    if (this.cancelAttempts.length > 4) this.cancelAttempts.shift();
    if (!connection) {
      entry.notificationStatus = 'connection_unavailable';
      return;
    }
    try {
      Promise.resolve(connection.agent.notify(method, { sessionId })).then(
        () => { entry.notificationStatus = 'submitted'; },
        () => { entry.notificationStatus = 'failed'; },
      );
    } catch {
      entry.notificationStatus = 'failed';
    }
  }

  snapshot() {
    const now = this.now();
    return {
      turnNumber: this.turnNumber,
      ...(this.turnStartedAt === null ? {} : { turnElapsedMs: Math.max(0, now - this.turnStartedAt) }),
      ...(this.timing ? { configuredTiming: { ...this.timing } } : {}),
      acpUpdateCount: this.updateCount,
      lastAcpUpdateType: this.lastUpdateType,
      msSinceLastAcpUpdate: this.lastUpdateAt === null ? null : Math.max(0, now - this.lastUpdateAt),
      ...(this.localTimeout ? { localTimeout: { ...this.localTimeout } } : {}),
      outgoingCancelCount: this.cancelAttemptCount,
      outgoingCancels: this.cancelAttempts.map((entry) => ({ ...entry })),
    };
  }
}
