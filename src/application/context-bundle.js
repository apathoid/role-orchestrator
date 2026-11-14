/** @import {ContextItem} from '../core/observation.js' */

export const defaultContextBudgets = Object.freeze({
  controllerMaxBytes: 256 * 1024,
  handoffMaxBytes: 64 * 1024,
  fetchMaxBytes: 64 * 1024,
  captureMaxBytes: 64 * 1024,
  skillInstructionsMaxBytes: 64 * 1024,
  toolOutputMaxBytes: 64 * 1024,
});
// Guard against unbounded allocations and serializations, independent of
// native provider transport limits.
export const maximumContextBudgetBytes = 16 * 1024 * 1024;
export const defaultContextMaxBytes = defaultContextBudgets.controllerMaxBytes;
const maxExcerptBytes = 512;

/** @param {unknown} value */
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** @param {ContextItem} item @param {number} bytes @param {number} excerptLimit @returns {ContextItem | undefined} */
function excerptItem(item, bytes, excerptLimit) {
  if (item.value === undefined || item.completeness === 'unavailable') return undefined;
  const { value, ...metadata } = item;
  /** @type {ContextItem} */
  const itemExcerpt = { ...metadata, completeness: 'truncated', excerpt: '' };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let remaining = Math.min(excerptLimit, bytes - jsonBytes(itemExcerpt));
  let excerpt = '';
  for (const character of text) {
    const size = jsonBytes(character) - 2;
    if (size > remaining) break;
    excerpt += character;
    remaining -= size;
  }
  return excerpt ? { ...itemExcerpt, excerpt } : undefined;
}

/**
 * A lossless Host-requested byte chunk may be reduced for a smaller actual
 * presentation budget, while preserving the byte offset required to continue.
 * Do not turn base64 into a string excerpt: that would destroy retrievability.
 * @param {ContextItem} item @param {number} maxBytes
 * @returns {ContextItem | undefined}
 */
function boundRequestedByteChunk(item, maxBytes) {
  if (!item.ref.startsWith('host:history-chunk:') || !item.value ||
      typeof item.value !== 'object' || !('base64' in item.value) ||
      !('offset' in item.value) || !('totalBytes' in item.value)) return undefined;
  const value = /** @type {{base64:string, offset:number, totalBytes:number, nextOffset?:number} & Record<string,unknown>} */ (item.value);
  if (typeof value.base64 !== 'string' || !Number.isSafeInteger(value.offset) ||
      !Number.isSafeInteger(value.totalBytes)) return undefined;
  const data = Buffer.from(value.base64, 'base64');
  /** @param {number} count */
  const candidate = count => {
    const completePart = count === data.length && value.nextOffset === undefined;
    const end = value.offset + count;
    return {
      ...item,
      completeness: completePart && value.offset === 0 ? item.completeness : /** @type {const} */ ('truncated'),
      value: { ...value, base64: data.subarray(0, count).toString('base64'),
        nextOffset: completePart ? undefined : end },
    };
  };
  let low = 0, high = data.length;
  /** @type {ContextItem | undefined} */
  let selected;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const partial = candidate(mid);
    if (jsonBytes(partial) <= maxBytes) {
      if (mid > 0 || data.length === 0) selected = partial;
      low = mid + 1;
    } else high = mid - 1;
  }
  return selected;
}

/**
 * Directory pages are structured technical data, never string excerpts.
 * Advance only by the number of rows actually delivered, at either budget.
 * @param {ContextItem} item @param {number} maxBytes
 * @returns {ContextItem | undefined}
 */
function boundHistoryPage(item, maxBytes) {
  const page = /** @type {import('../core/ports.js').ContextList} */ (item.value);
  // A known error or empty terminal page is technical metadata, not a
  // nonempty page stalled by bytes. Preserve it for the coverage report.
  if (page?.kind !== 'available' || page.items.length === 0) return undefined;
  {
    for (let count = page.items.length; count > 0; count--) {
      const nextCursor = count === page.items.length ? page.nextCursor :
        {revision: page.cursor.revision, index: page.cursor.index + count};
      const candidate = {...item, value: {...page, items: page.items.slice(0, count), nextCursor}};
      if (jsonBytes(candidate) <= maxBytes) return candidate;
    }
  }
  /** @type {ContextItem} */
  const marker = {...item, completeness: 'unavailable', value: {kind:'unavailable', reason:'budget'}};
  return jsonBytes(marker) <= maxBytes ? marker : undefined;
}

/** @param {ContextItem} item @param {number} maxBytes @param {number} [excerptLimit] */
export function boundContextItem(item, maxBytes, excerptLimit = maxExcerptBytes) {
  if (maxBytes <= 0) return undefined;
  if (!(typeof item.value === 'string' && item.value.length > maxBytes) && jsonBytes(item) <= maxBytes) return item;
  if (item.source === 'host_observed' && item.ref.startsWith('host:history-page:')) {
    return boundHistoryPage(item, maxBytes);
  }
  if (item.ref.startsWith('host:history-chunk:')) {
    return boundRequestedByteChunk(item, maxBytes);
  }
  return excerptItem(item, maxBytes, excerptLimit);
}

/** @param {ContextItem} item */
const isUserMessage = item => item.provenance?.kind === 'user' && !item.attemptId;

/** @param {string} ref @param {'missing' | 'budget'} unavailableReason @returns {ContextItem} */
export function unavailableContext(ref, unavailableReason) {
  return { ref, source: 'host_observed', completeness: 'unavailable', unavailableReason };
}

/**
 * Items are supplied in priority order. The byte limit applies to the optional
 * JSON records, including metadata, references and separators. Literal user
 * messages are mandatory; unavailable/missing references are optional and
 * may be represented only by a bounded aggregate when they do not fit.
 * @param {readonly ContextItem[]} items @param {number} maxBytes @param {boolean} keepRefs
 */
export function compactContext(items, maxBytes, keepRefs) {
  /** @type {ContextItem[]} */
  const context = [];
  let remaining = Math.max(0, maxBytes - 2);
  let omitted = 0, excerpted = 0, unrepresented = 0;
  for (const item of items) {
    // Literal user instructions are not optional, even under a tiny budget.
    if (isUserMessage(item)) {
      context.push(item);
      continue;
    }
    const bounded = boundContextItem(item, remaining - 1);
    if (bounded) {
      context.push(bounded);
      remaining -= jsonBytes(bounded) + 1;
      if (bounded !== item) excerpted++;
      continue;
    }
    omitted++;
    // A marker is optional too. Never copy an unbounded model-supplied ref
    // merely because its original item was too large.
    // For an unavailable record, prefer a compact marker with the original
    // technical reason. Drop bulky provenance only in this explicitly
    // incomplete representation; ContextPort can retrieve the source.
    const marker = !keepRefs ? undefined : item.completeness === 'unavailable'
      ? /** @type {ContextItem} */ ({
        ref: item.ref, source: item.source, completeness: 'unavailable',
        unavailableReason: item.unavailableReason,
      }) : unavailableContext(item.ref, 'budget');
    const markerBytes = marker ? jsonBytes(marker) + 1 : Infinity;
    if (marker && markerBytes <= remaining) {
      context.push(marker);
      remaining -= markerBytes;
    } else {
      unrepresented++;
    }
  }
  return { context, omitted, excerpted, unrepresented };
}
