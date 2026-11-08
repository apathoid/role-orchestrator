/** @import {ArtifactRetention} from '../../core/ports.js' */
/** @import {Operation} from '../../core/operation.js' */

export const artifactRef = /^sha256:([a-f0-9]{64})$/u;

/**
 * Plan deletion for published, attributable blobs. A digest shared with any
 * operation that may still need its data cannot be removed by this policy.
 * @param {readonly Operation[]} operations @param {ReadonlySet<string>} files
 * @param {ArtifactRetention} policy @param {number} now
 */
export function expiredArtifacts(operations, files, policy, now) {
  /** @type {Map<string, {usedAt: number, protected: boolean, size?: number}>} */
  const usage = new Map();
  for (const operation of operations) {
    const protectedOperation = (operation.status !== 'finished' && operation.status !== 'cancelled') ||
      operation.attempts.some(attempt => attempt.status !== 'terminal' || attempt.outcome.terminal === 'unknown' ||
        attempt.outcome.effect === 'unknown' || attempt.outcome.effect === 'possible');
    const usedAt = operation.events.reduce((last, event) => Math.max(last, event.receivedAt), 0);

    /** @param {unknown} ref @param {number} [size] */
    function track(ref, size) {
      if (typeof ref !== 'string') return;
      const hash = artifactRef.exec(ref)?.[1];
      if (!hash || !files.has('artifact-' + hash + '.blob')) return;
      const entry = usage.get(hash) ?? { usedAt, protected: false, size: undefined };
      entry.usedAt = Math.max(entry.usedAt, usedAt);
      entry.protected ||= protectedOperation || (size !== undefined && entry.size !== undefined && entry.size !== size);
      entry.size ??= size;
      usage.set(hash, entry);
    }

    for (const event of operation.events) {
      if (event.kind !== 'attempt.outcome') continue;
      for (const output of event.outcome.outputRefs) track(output.ref);
      for (const item of event.observations ?? []) {
        if (item.artifact) track(item.artifact.ref, item.artifact.size);
        else {
          track(item.ref);
          if (item.value && typeof item.value === 'object') track(Object.getOwnPropertyDescriptor(item.value, 'ref')?.value);
        }
      }
    }
  }
  const candidates = [...usage.entries()].flatMap(([hash, entry]) =>
    !entry.protected && entry.size !== undefined ? [{ hash, usedAt: entry.usedAt, size: entry.size }] : []);
  candidates.sort((a, b) => a.usedAt - b.usedAt || a.hash.localeCompare(b.hash));
  let total = candidates.reduce((bytes, candidate) => bytes + BigInt(candidate.size), 0n);
  const cap = policy.maxBytes === undefined ? undefined : BigInt(policy.maxBytes);
  const expired = [];
  for (const { hash, usedAt, size } of candidates) {
    if ((policy.maxAgeMs !== undefined && now - usedAt >= policy.maxAgeMs) || (cap !== undefined && total > cap)) {
      expired.push(hash);
      total -= BigInt(size);
    }
  }
  return expired;
}
