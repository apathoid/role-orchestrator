/** @import {ContextItem} from '../core/observation.js' */

export const defaultContextMaxBytes = 64 * 1024;
const maxExcerptBytes = 512;

/** @param {unknown} value */
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** @param {ContextItem} item @param {number} bytes @returns {ContextItem | undefined} */
function excerptItem(item, bytes) {
  if (item.value === undefined || item.completeness === 'unavailable') return undefined;
  const { value, ...metadata } = item;
  /** @type {ContextItem} */
  const itemExcerpt = { ...metadata, completeness: 'truncated', excerpt: '' };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let remaining = Math.min(maxExcerptBytes, bytes - jsonBytes(itemExcerpt));
  let excerpt = '';
  for (const character of text) {
    const size = jsonBytes(character) - 2;
    if (size > remaining) break;
    excerpt += character;
    remaining -= size;
  }
  return excerpt ? { ...itemExcerpt, excerpt } : undefined;
}

/** @param {ContextItem} item */
const isUserMessage = item => item.provenance?.kind === 'user' && !item.attemptId;

/** @param {string} ref @param {'missing' | 'budget'} unavailableReason @returns {ContextItem} */
export function unavailableContext(ref, unavailableReason) {
  return { ref, source: 'host_observed', completeness: 'unavailable', unavailableReason };
}

/**
 * Items are supplied in priority order. The byte limit applies to the optional
 * JSON records, including metadata and separators. Literal user messages and
 * explicit missing references have to remain visible even at a tiny limit.
 * @param {readonly ContextItem[]} items @param {number} maxBytes @param {boolean} keepRefs
 */
export function compactContext(items, maxBytes, keepRefs) {
  /** @type {ContextItem[]} */
  const context = [];
  let remaining = Math.max(0, maxBytes - 2);
  let omitted = 0;
  let excerpted = 0;
  for (const item of items) {
    if (isUserMessage(item) || (keepRefs && item.completeness === 'unavailable')) {
      context.push(item);
      continue;
    }
    const size = remaining > 1 && !(typeof item.value === 'string' && item.value.length >= remaining)
      ? jsonBytes(item) + 1 : Infinity;
    if (size <= remaining) {
      context.push(item);
      remaining -= size;
      continue;
    }
    const excerpt = remaining > 1 ? excerptItem(item, remaining - 1) : undefined;
    if (excerpt) {
      context.push(excerpt);
      remaining -= jsonBytes(excerpt) + 1;
      excerpted++;
    } else {
      omitted++;
      if (keepRefs) context.push(unavailableContext(item.ref, 'budget'));
    }
  }
  return { context, omitted, excerpted };
}
