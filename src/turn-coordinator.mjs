// Host-neutral outer-turn scheduling. A new turn supersedes an older turn in
// the same session, without cancelling turns in unrelated sessions.
import { CANCELLATION_REASONS, abortWithReason } from './cancellation.mjs';

export function createTurnCoordinator() {
  const active = new Map();
  const pending = new Map();
  const tails = new Map();

  function reserve(sessionId, controller) {
    if (controller.signal.aborted) return { wait: Promise.resolve(), activate() {}, release() {} };
    const reason = { source: 'outer_session', diagnostics: { sessionId } };
    abortWithReason(active.get(sessionId), CANCELLATION_REASONS.SUPERSEDED_BY_NEW_TURN, reason);
    abortWithReason(pending.get(sessionId), CANCELLATION_REASONS.SUPERSEDED_BY_NEW_TURN, reason);
    pending.set(sessionId, controller);
    const previous = tails.get(sessionId) ?? Promise.resolve();
    let finish;
    const completed = new Promise((resolve) => { finish = resolve; });
    const tail = previous.catch(() => {}).then(() => completed);
    tails.set(sessionId, tail);
    let released = false;
    return {
      wait: previous.catch(() => {}),
      activate() {
        if (pending.get(sessionId) === controller) pending.delete(sessionId);
        if (!controller.signal.aborted) active.set(sessionId, controller);
      },
      release() {
        if (released) return;
        released = true;
        if (active.get(sessionId) === controller) active.delete(sessionId);
        if (pending.get(sessionId) === controller) pending.delete(sessionId);
        finish();
        void tail.finally(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
      },
    };
  }

  function cancel(sessionId, reason = CANCELLATION_REASONS.SESSION_CANCELLED, source = 'session_cancel') {
    const options = { source, diagnostics: { sessionId } };
    abortWithReason(active.get(sessionId), reason, options);
    abortWithReason(pending.get(sessionId), reason, options);
  }
  return { reserve, cancel, isBusy: (sessionId) => active.has(sessionId) || pending.has(sessionId) };
}
