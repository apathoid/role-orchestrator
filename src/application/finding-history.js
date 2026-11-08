import { operationHistory } from './controller-context.js';

/** @import {Finding} from '../core/finding.js' */
/** @import {Attempt, Operation} from '../core/operation.js' */
/** @import {Outcome} from '../core/contracts.js' */
/** @import {ContextItem} from '../core/observation.js' */
/** @import {ArtifactPresence, StateStore} from '../core/ports.js' */

/** @typedef {{ref: string, item?: ContextItem, attempt?: Attempt, recordedOutcome?: Outcome,
 *   artifactPresence?: ArtifactPresence}} HistoryEntry
 */

/**
 * Resolve references against the immutable operation journal. Keep the outcome
 * of the original receipt separate from the latest outcome on its attempt.
 * @param {Operation} operation @param {string} findingRef @param {StateStore} store
 * @returns {Promise<HistoryEntry[] | undefined>}
 */
export async function findingHistory(operation, findingRef, store) {
  const items = new Map();
  for (const item of operationHistory(operation)) {
    if (!items.has(item.ref)) items.set(item.ref, item);
  }
  if (items.get(findingRef)?.kind !== 'finding') return undefined;
  const attempts = new Map(operation.attempts.map(attempt => [attempt.attemptId, attempt]));
  const refs = new Set([findingRef]);
  /** @type {HistoryEntry[]} */
  const entries = [];
  for (const ref of refs) {
    const item = items.get(ref);
    if (item?.kind === 'finding') {
      const finding = /** @type {Finding} */ (item.value);
      for (const support of finding.supports) refs.add(support);
      if (finding.supersedes) refs.add(finding.supersedes);
    }
    for (const support of item?.summary?.coveredObservationRefs ?? []) refs.add(support);
    const event = operation.events[(item?.receivedSequence?.revision ?? 0) - 1];
    entries.push({
      ref, item,
      attempt: item?.attemptId ? attempts.get(item.attemptId) : undefined,
      recordedOutcome: event?.kind === 'attempt.outcome' ? event.outcome : undefined,
      artifactPresence: item?.artifact ? await store.artifactPresence?.(item.artifact).catch(() => undefined) : undefined,
    });
  }
  return entries;
}
