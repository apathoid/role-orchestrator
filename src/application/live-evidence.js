/** Invocation-local read-only view of accepted observations; no second journal. */
/** @import {Observation} from '../core/observation.js' */
/** @import {LiveEvidencePort, LiveEvidenceUnavailableReason, LiveEvidenceItem} from '../core/ports.js' */
const pageRecords = 12;
const pageBytes = 24 * 1024;
const chunkBytes = 16 * 1024;
const itemBytes = 1536;

// Bound optional metadata *before* serializing it into the model-facing
// directory. All fields are technically reported; nothing is inferred or
// summarized from their contents. An omitted field is named explicitly.
/** @param {string} field @param {unknown} value */
function boundedMetadata(field, value) {
  if (field === 'providerRef') return typeof value === 'string' && value.length <= 1024;
  if (field === 'provenance') {
    const v = /** @type {NonNullable<Observation['provenance']>} */ (value);
    return v.sourceId.length <= 1024;
  }
  if (field === 'reportedContext') {
    const v = /** @type {NonNullable<Observation['reportedContext']>} */ (value);
    return (v?.location?.length ?? 0) <= 1024 && (v?.version?.length ?? 0) <= 1024;
  }
  if (field === 'summary') {
    const v = /** @type {NonNullable<Observation['summary']>} */ (value);
    return v.author.length <= 256 && v.coveredObservationRefs.length <= 16 &&
      v.coveredObservationRefs.every(ref => ref.length <= 256);
  }
  return true;
}

/** @param {Observation} item @returns {LiveEvidenceItem | undefined} */
function directoryItem(item) {
  /** @type {LiveEvidenceItem} */
  const entry = {ref:item.ref,source:item.source,completeness:item.completeness};
  // An extreme canonical ref itself might not fit. Caller returns an
  // explicit positional gap and still advances, never a fabricated ref.
  if (item.ref.length > itemBytes - 160 ||
      Buffer.byteLength(JSON.stringify(entry)) > itemBytes - 160) return undefined;
  /** @type {string[]} */
  const omittedMetadataFields = [];
  for (const field of /** @type {const} */ (['providerRef','provenance','reportedContext','artifact','summary'])) {
    const value = item[field];
    if (value === undefined) continue;
    if (!boundedMetadata(field,value)) {
      omittedMetadataFields.push(field);
      continue;
    }
    // Keep room for the omission marker and the surrounding page envelope.
    const proposed = {...entry,[field]:value};
    if (Buffer.byteLength(JSON.stringify(proposed)) > itemBytes - 160) omittedMetadataFields.push(field);
    else Object.assign(entry, {[field]:value});
  }
  if (omittedMetadataFields.length) entry.omittedMetadataFields = omittedMetadataFields;
  return entry;
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
      // Append-only accepted-record index, independent from history cursors.
      const length = observations.length;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > length) return unavailable('invalid_cursor');
      /** @type {import('../core/ports.js').LiveEvidenceListItem[]} */
      const items = [];
      let next = cursor;
      const end = Math.min(length, cursor + pageRecords);
      while (next < end) {
        const entry = directoryItem(observations[next]) ??
          {kind:/** @type {const} */ ('unavailable'),index:next,reason:/** @type {const} */ ('budget')};
        const candidate = {kind:'available',cursor,items:[...items,entry],
          resumeCursor:next+1,nextCursor:next+1};
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > pageBytes) break;
        items.push(entry);
        next++;
      }
      // Always allow a later read from this position, including an initially
      // empty directory or a page whose snapshot is exhausted.
      if (next === cursor && next < length) return unavailable('budget');
      return {kind:'available',cursor,items,resumeCursor:next,...(next < length && {nextCursor:next})};
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
      const metadata = directoryItem(item);
      if (!metadata) return unavailable('budget');
      const format = typeof item.value === 'string' ? 'utf8' : 'json';
      const bytes = Buffer.from(format === 'utf8' ? /** @type {string} */ (item.value) : JSON.stringify(item.value), 'utf8');
      const offset = range?.offset ?? 0;
      if (offset > bytes.byteLength) return unavailable('invalid_offset');
      const limit = Math.min(chunkBytes, range?.maxBytes ?? chunkBytes);
      if (limit === 0 && offset < bytes.byteLength) return unavailable('budget');
      const end = Math.min(bytes.byteLength, offset + limit);
      return {
        kind:'chunk', item:metadata,format,offset,totalBytes:bytes.byteLength,
        base64:bytes.subarray(offset,end).toString('base64'),
        ...(end < bytes.byteLength && {nextOffset:end}),
      };
    },
  };
}
