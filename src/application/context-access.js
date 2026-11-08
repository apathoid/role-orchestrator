import { boundContextItem } from './context-bundle.js';
import { operationHistory } from './controller-context.js';
import { observation } from '../core/observation.js';

/** @import {Operation} from '../core/operation.js' */
/** @import {ContextDirectoryItem, ContextFetch, ContextPort, ContextShare, StateStore} from '../core/ports.js' */
/** @import {ContextItem, Observation} from '../core/observation.js' */

const pageRecords = 32;
const pageBytes = 8192;

/** @param {ContextItem} item @returns {ContextDirectoryItem} */
function directoryEntry(item) {
  const { ref, source, completeness, attemptId, receivedSequence, kind, outputKind } = item;
  const entry = { ref, source, completeness, attemptId, receivedSequence, kind, outputKind,
    providerRef: item.providerRef?.slice(0, 96).toWellFormed(),
    reportedLocation: item.reportedContext?.location?.slice(0, 96).toWellFormed() };
  if (Buffer.byteLength(JSON.stringify(entry)) <= 1024 || !receivedSequence) return structuredClone(entry);
  return { ref: { ...receivedSequence }, source, completeness, receivedSequence: { ...receivedSequence } };
}

/**
 * A hash names bytes in the store. Only a typed receipt in the source
 * operation identifies which bytes this invocation can actually retrieve.
 * @param {{
 *   state: Operation, store: StateStore, maxBytes: number, profileId: string, attemptId: string,
 *   selected?: ReadonlySet<string>, allowShare?: ContextShare, isActive: () => boolean,
 *   newId: () => string, now: () => number, receive: (item: Observation) => void
 * }} scope
 * @returns {ContextPort}
 */
export function bindContextAccess(scope) {
  const { state, store, maxBytes, profileId, attemptId, selected, isActive } = scope;
  /** @param {Extract<ContextFetch, {kind: 'unavailable'}>['reason']} reason @returns {ContextFetch} */
  const unavailable = reason => ({ kind: 'unavailable', reason });
  /** @type {ContextItem[] | undefined} */
  let history;
  const localHistory = () => history ??= operationHistory(state);
  /** @type {ContextItem[] | undefined} */
  let directory;
  return {
    list(cursor = 0) {
      if (!isActive()) return { kind: 'unavailable', reason: 'closed' };
      if (!Number.isSafeInteger(cursor) || cursor < 0) return { kind: 'unavailable', reason: 'invalid_cursor' };
      directory ??= localHistory().filter(item => !selected || selected.has(item.ref)).reverse();
      if (cursor > directory.length) return { kind: 'unavailable', reason: 'invalid_cursor' };
      /** @type {ContextDirectoryItem[]} */
      const items = [];
      let bytes = 128;
      while (cursor < directory.length && items.length < pageRecords) {
        const entry = directoryEntry(directory[cursor]);
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes + size > pageBytes) break;
        bytes += size;
        items.push(entry);
        cursor++;
      }
      return { kind: 'available', items, ...(cursor < directory.length ? { nextCursor: cursor } : {}) };
    },

    async fetch(ref, sourceOperationId = state.operationId) {
      if (!isActive()) return unavailable('closed');
      if (typeof sourceOperationId !== 'string') return unavailable('denied');
      const sharedRequest = sourceOperationId !== state.operationId;
      if (typeof ref === 'string' ? !ref.trim() : sharedRequest || !ref || typeof ref !== 'object' ||
          !Number.isSafeInteger(ref.revision) || !Number.isSafeInteger(ref.index)) return unavailable('denied');
      const historical = typeof ref === 'string' ? undefined : localHistory().find(item =>
        item.receivedSequence?.revision === ref.revision && item.receivedSequence?.index === ref.index);
      if (selected && !selected.has(historical?.ref ?? (typeof ref === 'string' ? ref : ''))) return unavailable('denied');
      const allowed = () => !sharedRequest || (typeof ref === 'string' &&
        scope.allowShare?.({ sourceOperationId, targetOperationId: state.operationId, ref, profileId }) === true);
      let source = state;
      if (sharedRequest) {
        try {
          if (!allowed()) return unavailable('denied');
          const shared = await store.load(sourceOperationId);
          if (!isActive()) return unavailable('closed');
          if (!allowed()) return unavailable('denied');
          if (!shared || shared.operationId !== sourceOperationId) return unavailable('missing');
          source = shared;
        } catch {
          return unavailable(isActive() ? 'missing' : 'closed');
        }
      }
      const items = source === state ? localHistory() : operationHistory(source);
      const item = historical ?? items.find(item => item.ref === ref);
      if (!item) return unavailable('missing');
      if (item.artifact) {
        try {
          if (item.artifact.size > maxBytes) {
            const presence = await store.artifactPresence?.(item.artifact);
            if (!isActive()) return unavailable('closed');
            if (!allowed()) return unavailable('denied');
            return unavailable(presence === 'retention' ? 'retention' : 'budget');
          }
          const result = await store.readArtifact?.(item.artifact, item.artifact.size);
          if (!isActive()) return unavailable('closed');
          if (!allowed()) return unavailable('denied');
          if (result?.kind !== 'available') {
            if (result?.kind === 'integrity_error') return unavailable('integrity_error');
            return unavailable(result?.reason ?? 'payload');
          }
          if (result.bytes.byteLength !== item.artifact.size) return unavailable('integrity_error');
          return { kind: 'available', item: structuredClone(item), bytes: result.bytes };
        } catch {
          return unavailable(isActive() ? 'payload' : 'closed');
        }
      }
      if (item.completeness === 'unavailable') return unavailable(item.unavailableReason === 'ambiguous' ? 'ambiguous' : 'payload');
      const bounded = boundContextItem(item, maxBytes, maxBytes);
      return bounded ? { kind: 'available', item: structuredClone(bounded) } : unavailable('budget');
    },

    async captureArtifact(bytes) {
      if (!isActive() || !(bytes instanceof Uint8Array) || !store.writeArtifact) return undefined;
      try {
        const artifact = await store.writeArtifact(bytes, Math.min(maxBytes, bytes.byteLength));
        if (!isActive()) return undefined;
        const ref = 'artifact:' + scope.newId();
        scope.receive(observation({ ref, artifact, completeness: artifact.truncated ? 'truncated' : 'complete' },
          { kind: 'provider_report', sourceId: attemptId, receivedAt: scope.now() }));
        return ref;
      } catch {
        return undefined;
      }
    },
  };
}
