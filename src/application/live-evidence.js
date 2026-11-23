/** Invocation-local, read-only view of accepted observations; no second journal. */
/** @import {Observation} from '../core/observation.js' */
/** @import {LiveEvidencePort, LiveEvidenceUnavailableReason} from '../core/ports.js' */
const pageRecords = 12;
const pageBytes = 24 * 1024;
const chunkBytes = 16 * 1024;

/** @param {Observation} item */
function directoryItem(item) {
  return {
    ref: item.ref, source: item.source, completeness: item.completeness,
    ...(item.providerRef && {providerRef: item.providerRef}),
    ...(item.provenance && {provenance: item.provenance}),
    ...(item.reportedContext && {reportedContext: item.reportedContext}),
    ...(item.artifact && {artifact: item.artifact}),
    ...(item.summary && {summary: item.summary}),
  };
}

/**
 * @param {{observations: readonly Observation[], isActive: () => boolean}} scope
 * @returns {LiveEvidencePort}
 */
export function bindLiveEvidenceAccess({observations, isActive}) {
  /** @param {LiveEvidenceUnavailableReason} reason */
  const unavailable = reason => ({kind: /** @type {const} */ ('unavailable'), reason});
  return {
    list(cursor = 0) {
      if (!isActive()) return unavailable('closed');
      // This is an append-only accepted-record index, not a history cursor.
      const length = observations.length;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > length) return unavailable('invalid_cursor');
      const items = [];
      let next = cursor;
      const end = Math.min(length, cursor + pageRecords);
      while (next < end) {
        const entry = directoryItem(observations[next]);
        const candidate = {kind:'available',cursor,items:[...items,entry],nextCursor:next + 1};
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > pageBytes) break;
        items.push(entry);
        next++;
      }
      if (next === cursor && next < length) return unavailable('budget');
      return {kind:'available',cursor,items,...(next < length && {nextCursor:next})};
    },
    fetch(ref, range) {
      if (!isActive()) return unavailable('closed');
      if (typeof ref !== 'string' || !ref) return unavailable('invalid_ref');
      if (range !== undefined && (!range || !Number.isSafeInteger(range.offset) || range.offset < 0 ||
          (range.maxBytes !== undefined && (!Number.isSafeInteger(range.maxBytes) || range.maxBytes < 0)))) {
        return unavailable('invalid_offset');
      }
      const item = observations.find(item => item.ref === ref);
      if (!item) return unavailable('missing');
      if (item.value === undefined) return unavailable('payload');
      const format = typeof item.value === 'string' ? 'utf8' : 'json';
      const bytes = Buffer.from(format === 'utf8' ? /** @type {string} */ (item.value) : JSON.stringify(item.value), 'utf8');
      const offset = range?.offset ?? 0;
      if (offset > bytes.byteLength) return unavailable('invalid_offset');
      const limit = Math.min(chunkBytes, range?.maxBytes ?? chunkBytes);
      if (limit === 0 && offset < bytes.byteLength) return unavailable('budget');
      const end = Math.min(bytes.byteLength, offset + limit);
      return {
        kind:'chunk', item:directoryItem(item),format,offset,totalBytes:bytes.byteLength,
        base64:bytes.subarray(offset,end).toString('base64'),
        ...(end < bytes.byteLength && {nextOffset:end}),
      };
    },
  };
}
