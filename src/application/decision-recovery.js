/** @import {Operation} from '../core/operation.js' */

export const decisionRecoveryLimits = Object.freeze({
  consecutiveIdentical: 5,
  totalRejected: 10,
});

/**
 * Derived solely from the authoritative Operation journal. A user continuation
 * starts a new counting period; technical recovery does not. No rejected
 * model payloads, mutable counters or speculative interpretation are stored.
 * @param {Operation} state
 */
export function decisionRecovery(state) {
  const boundary = state.events.findLastIndex(event => event.kind === 'operation.continued');
  const current = state.events.slice(boundary + 1);
  /** @type {Set<string>} */
  const countedAttempts = new Set();
  let totalRejected = 0;
  let consecutiveIdentical = 0;
  /** @type {string | undefined} */
  let previousSignature;
  /** @type {Extract<Operation['events'][number], {kind: 'controller.invalid_proposal'}> | undefined} */
  let lastRejection;
  /** @type {typeof lastRejection} */
  let thresholdRejection;
  for (const event of current) {
    if (event.kind === 'controller.responded') {
      consecutiveIdentical = 0;
      previousSignature = undefined;
      continue;
    }
    if (event.kind !== 'controller.invalid_proposal' || countedAttempts.has(event.attemptId)) continue;
    countedAttempts.add(event.attemptId);
    const signature = JSON.stringify([
      event.category ?? 'unknown', event.reason.code, event.reason.path, event.reason.expected,
    ]);
    consecutiveIdentical = signature === previousSignature ? consecutiveIdentical + 1 : 1;
    previousSignature = signature;
    totalRejected++;
    lastRejection = event;
    if (!thresholdRejection && (consecutiveIdentical >= decisionRecoveryLimits.consecutiveIdentical ||
        totalRejected >= decisionRecoveryLimits.totalRejected)) thresholdRejection = event;
  }
  const historical = state.events.findLast(event => event.kind === 'controller.invalid_proposal');
  const lastDurableRejection = lastRejection ?? historical;
  return {
    totalRejected, consecutiveIdentical, limits: decisionRecoveryLimits,
    thresholdRejection,
    lastRejection: lastDurableRejection && {
      attemptId: lastDurableRejection.attemptId,
      category: lastDurableRejection.category ?? 'unknown',
      stage: lastDurableRejection.category === 'invalid_json' ||
        lastDurableRejection.category === 'non_object' || lastDurableRejection.category === 'depth'
        ? 'parser' : lastDurableRejection.category === 'schema_invalid' ? 'decoder' :
          lastDurableRejection.category === 'admission_invalid' ? 'admission' : 'unknown',
      code: lastDurableRejection.reason.code,
      path: lastDurableRejection.reason.path,
      expected: lastDurableRejection.reason.expected,
      scope: lastRejection ? 'current_user_turn' : 'prior_user_turn',
    },
  };
}
