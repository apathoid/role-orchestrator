/** @import {ContextItem} from '../core/observation.js' */

export const defaultContextMaxBytes = 64 * 1024;
const maxExcerptBytes = 512;
const maxOptionalRecords = 128;

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

/** @param {ContextItem} item @param {number} maxBytes @param {number} [excerptLimit] */
export function boundContextItem(item, maxBytes, excerptLimit = maxExcerptBytes) {
  if (maxBytes <= 0) return undefined;
  if (!(typeof item.value === 'string' && item.value.length > maxBytes) && jsonBytes(item) <= maxBytes) return item;
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
  let omitted = 0, excerpted = 0, unrepresented = 0, optionalIncluded = 0;
  for (const item of items) {
    // Literal user instructions are not optional, even under a tiny budget.
    if (isUserMessage(item)) {
      context.push(item);
      continue;
    }
    if (optionalIncluded >= maxOptionalRecords) {
      omitted++;
      unrepresented++;
      continue;
    }
    const bounded = boundContextItem(item, remaining - 1);
    if (bounded) {
      context.push(bounded);
      remaining -= jsonBytes(bounded) + 1;
      optionalIncluded++;
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
      optionalIncluded++;
    } else {
      unrepresented++;
    }
  }
  return { context, omitted, excerpted, unrepresented };
}
