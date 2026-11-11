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
    unavailableReason: item.unavailableReason,
    providerRef: item.providerRef?.slice(0, 96).toWellFormed(),
    reportedLocation: item.reportedContext?.location?.slice(0, 96).toWellFormed() };
  if (Buffer.byteLength(JSON.stringify(entry)) <= 1024 || !receivedSequence) return structuredClone(entry);
  return { ref: { ...receivedSequence }, source, completeness, unavailableReason: item.unavailableReason, receivedSequence: { ...receivedSequence } };
}

/**
 * A hash names bytes in the store. Only a typed receipt in the source
 * operation identifies which bytes this invocation can actually retrieve.
 * @param {{
 *   state: Operation, store: StateStore, maxBytes: number, captureMaxBytes?: number, profileId: string, attemptId: string,
 *   selected?: ReadonlySet<string>, allowShare?: ContextShare, isActive: () => boolean,
 *   newId: () => string, now: () => number, receive: (item: Observation) => void
 * }} scope
 * @returns {ContextPort}
 */
export function bindContextAccess(scope) {
  const { state, store, maxBytes, captureMaxBytes = maxBytes, profileId, attemptId, selected, isActive } = scope;
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

    async fetch(ref, sourceOperationId = state.operationId, range) {
      if (!isActive()) return unavailable('closed');
      if (typeof sourceOperationId !== 'string') return unavailable('denied');
      if (range !== undefined && (!range || typeof range !== 'object' ||
          !Number.isSafeInteger(range.offset) || range.offset < 0 ||
          (range.maxBytes !== undefined && (!Number.isSafeInteger(range.maxBytes) ||
            range.maxBytes < 0)) ||
          Object.keys(range).some(key => key !== 'offset' && key !== 'maxBytes'))) {
        return unavailable('invalid_offset');
      }
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
      if (range) {
        if (item.completeness === 'unavailable') {
          return unavailable(item.unavailableReason === 'duplicate_inline' ? 'payload' :
            item.unavailableReason ?? 'payload');
        }
        /** @type {'utf8' | 'json' | 'binary'} */
        const format = item.artifact ? 'binary' :
          typeof item.value === 'string' && item.value.isWellFormed() ? 'utf8' : 'json';
        /** @type {Buffer | undefined} */
        const inline = item.artifact || item.value === undefined ? undefined :
          Buffer.from(format === 'utf8' ? /** @type {string} */ (item.value) :
            JSON.stringify(item.value), 'utf8');
        if (!item.artifact && !inline) return unavailable('payload');
        const totalBytes = item.artifact?.size ?? inline?.length ?? 0;
        if (range.offset > totalBytes) return unavailable('invalid_offset');
        const responseLimit = Math.min(maxBytes, range.maxBytes ?? maxBytes);
        const itemMetadata = { ...directoryEntry(item), provenance: item.provenance, artifact: item.artifact };
        const envelope = { kind: /** @type {const} */ ('chunk'), item: itemMetadata, format,
          offset: range.offset, totalBytes, base64: '', nextOffset: totalBytes };
        // Base64 survives arbitrary UTF-8 boundaries. Account for the entire
        // technical response, not merely its raw byte payload.
        const overhead = Buffer.byteLength(JSON.stringify(envelope)) + 8;
        const allowance = 3 * Math.floor(Math.max(0, responseLimit - overhead) / 4);
        if (!allowance && range.offset < totalBytes) return unavailable('budget');
        const wanted = Math.min(totalBytes - range.offset, allowance);
        /** @type {Uint8Array} */
        let chunk;
        if (item.artifact) {
          try {
            const read = store.readArtifactSlice
              ? await store.readArtifactSlice(item.artifact, range.offset, wanted)
              : await store.readArtifact?.(item.artifact, item.artifact.size);
            if (!isActive()) return unavailable('closed');
            if (!allowed()) return unavailable('denied');
            if (read?.kind !== 'available') {
              return unavailable(read?.kind === 'integrity_error' ? 'integrity_error' :
                read?.reason ?? 'payload');
            }
            if (store.readArtifactSlice) {
              if (read.bytes.byteLength !== wanted) return unavailable('integrity_error');
              chunk = read.bytes;
            } else {
              if (read.bytes.byteLength !== item.artifact.size) return unavailable('integrity_error');
              chunk = read.bytes.subarray(range.offset, range.offset + wanted);
            }
          } catch {
            return unavailable(isActive() ? 'payload' : 'closed');
          }
        } else {
          chunk = /** @type {Buffer} */ (inline).subarray(range.offset, range.offset + wanted);
        }
        const end = range.offset + chunk.byteLength;
        const result = { ...envelope, base64: Buffer.from(chunk).toString('base64'),
          nextOffset: end < totalBytes ? end : undefined };
        if (Buffer.byteLength(JSON.stringify(result)) > responseLimit) return unavailable('budget');
        return result;
      }
      if (item.artifact) {
        try {
          if (item.artifact.size > maxBytes) {
            const presence = await store.artifactPresence?.(item.artifact);
            if (!isActive()) return unavailable('closed');
            if (!allowed()) return unavailable('denied');
            return unavailable(presence === 'retention' ? 'retention' : presence === 'missing' ? 'payload' : 'budget');
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
      if (item.completeness === 'unavailable') return unavailable(item.unavailableReason === 'duplicate_inline' ? 'payload' : item.unavailableReason ?? 'payload');
      // A positional lookup can address an opaque reference too long to echo
      // within fetchMaxBytes. Its receivedSequence remains the original identity.
      const view = typeof ref !== 'string' && Buffer.byteLength(JSON.stringify(item)) > maxBytes
        ? { ...item, ref: 'host:history-position:' + ref.revision + ':' + ref.index } : item;
      const bounded = boundContextItem(view, maxBytes, maxBytes);
      return bounded ? { kind: 'available', item: structuredClone(bounded) } : unavailable('budget');
    },

    async captureArtifact(bytes) {
      if (!isActive() || !(bytes instanceof Uint8Array) || !store.writeArtifact) return undefined;
      try {
        const artifact = await store.writeArtifact(bytes, Math.min(captureMaxBytes, bytes.byteLength));
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

/**
 * Optional model-requested next-turn retrieval. Reads only the existing
 * operation's ContextPort under its active authority; no MCP requirement,
 * extra store, automatic Worker dispatch, or semantic selection.
 * @param {ContextPort} port
 * @param {{refs?: readonly (string | import('../core/ports.js').ContextPosition |
 *     {ref: string | import('../core/ports.js').ContextPosition, offset: number})[], cursor?: number}} request
 * @param {number} maxBytes
 * @returns {Promise<ContextItem[]>}
 */
export async function materializeControllerHistory(port, request, maxBytes) {
  /** @type {ContextItem[]} */
  const delivered = [];
  let bytes = 0;
  // An explicitly named raw result wins over a directory preview.
  // The latter is still addressable by the original numeric cursor.
  const refs = request.refs ?? [];
  let represented = 0;
  for (const ref of refs) {
    if (bytes >= maxBytes) break;
    const selection = typeof ref === 'object' && 'ref' in ref ? ref.ref : ref;
    const offset = typeof ref === 'object' && 'ref' in ref ? ref.offset : undefined;
    const result = await port.fetch(selection, undefined, offset === undefined ? undefined :
      {offset, maxBytes: Math.max(0, maxBytes - bytes)});
    const positionRef = typeof selection === 'string' ? selection :
      'host:history-position:' + selection.revision + ':' + selection.index;
    /** @type {ContextItem} */
    let item;
    if (result.kind === 'chunk') {
      // Fresh model-selected output: the evidence itself remains in the same
      // journal, and chunk metadata preserves original source/provenance.
      item = {
        ref: 'host:history-chunk:' + represented, source: result.item.source,
        completeness: result.offset === 0 && result.nextOffset === undefined
          ? result.item.completeness : 'truncated',
        provenance: result.item.provenance, attemptId: result.item.attemptId,
        receivedSequence: result.item.receivedSequence,
        value: { requestedRef: result.item.ref, format: result.format,
          offset: result.offset, totalBytes: result.totalBytes,
          nextOffset: result.nextOffset, base64: result.base64,
          sourceCompleteness: result.item.completeness,
          artifact: result.item.artifact },
      };
    } else if (result.kind === 'available') {
      const source = result.bytes ? { ...result.item, artifact: undefined,
        value: { encoding: 'base64', bytes: Buffer.from(result.bytes).toString('base64'),
          originalArtifact: result.item.artifact },
      } : result.item;
      // Directory positions remain useful when a source ref is too large
      // to fit in the prompt. Preserve provenance and received sequence.
      item = typeof selection !== 'string' && Buffer.byteLength(source.ref) > 128
        ? { ...source, ref: positionRef } : source;
    } else {
      item = { ref: positionRef, source: 'host_observed', completeness: 'unavailable',
        unavailableReason: result.reason };
    }
    // The ContextPort bounds its own reply; the Controller adds another
    // attributed envelope and may have a still smaller optional budget.
    // Reduce just the range payload and expose an exact nextOffset.
    if (bytes + Buffer.byteLength(JSON.stringify(item)) > maxBytes) {
      item = boundContextItem(item, Math.max(0, maxBytes - bytes)) ??
        { ref: positionRef, source: 'host_observed', completeness: 'unavailable',
          unavailableReason: 'budget' };
    }
    const sizeAfter = Buffer.byteLength(JSON.stringify(item));
    if (bytes + sizeAfter > maxBytes) break;
    bytes += sizeAfter;
    delivered.push(item);
    represented++;
  }
  if (request.cursor !== undefined) {
    const page = port.list(request.cursor);
    const base = { ref: 'host:history-page:' + request.cursor,
      source: /** @type {const} */ ('host_observed') };
    if (page.kind === 'available') {
      /** @type {typeof page.items} */
      const items = [];
      for (const next of page.items) {
        const count = items.length + 1;
        const cursor = count === page.items.length ? page.nextCursor : request.cursor + count;
        const draft = { ...base, completeness: /** @type {const} */ ('complete'),
          value: { kind: 'available', items: [...items, next],
            ...(cursor === undefined ? {} : {nextCursor:cursor}) } };
        if (bytes + Buffer.byteLength(JSON.stringify(draft)) > maxBytes) break;
        items.push(next);
      }
      const nextCursor = items.length === page.items.length ? page.nextCursor : request.cursor + items.length;
      const item = { ...base, completeness: /** @type {const} */ ('complete'),
        value: { kind: 'available', items,
          ...(nextCursor === undefined ? {} : { nextCursor }) } };
      if ((items.length > 0 || page.items.length === 0) &&
          bytes + Buffer.byteLength(JSON.stringify(item)) <= maxBytes) {
        bytes += Buffer.byteLength(JSON.stringify(item));
        delivered.push(item);
      } else {
        const unavailable = { ...base, completeness: /** @type {const} */ ('unavailable'),
          unavailableReason: /** @type {const} */ ('budget') };
        if (bytes + Buffer.byteLength(JSON.stringify(unavailable)) <= maxBytes) delivered.push(unavailable);
      }
    } else {
      const item = { ...base, completeness: /** @type {const} */ ('complete'), value: page };
      if (bytes + Buffer.byteLength(JSON.stringify(item)) <= maxBytes) delivered.push(item);
    }
  }
  if (represented < refs.length) {
    delivered.push({ ref: 'host:history-request-budget', source: 'host_observed',
      completeness: 'complete', value: { requested: refs.length, represented,
        omitted: refs.length - represented, maxBytes } });
  }
  return delivered;
}
