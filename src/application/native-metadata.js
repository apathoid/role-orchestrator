/** @import {NativeMetadata} from '../core/observation.js' */

/**
 * Add optional native fields only after the existing representation fits.
 * The accepted native record is bounded at ingress; only serialize the base
 * record once and each small candidate extension, not the full body again.
 * @template T
 * @param {T & {native?: NativeMetadata, omittedMetadataFields?: string[]}} entry
 * @param {NativeMetadata | undefined} native
 * @param {number} maxBytes
 * @returns {T & {native?: NativeMetadata, omittedMetadataFields?: string[]}}
 */
export function projectNativeMetadata(entry, native, maxBytes) {
  if (!native) return entry;
  const {native: _previous, omittedMetadataFields: previous = [], ...base} = entry;
  const baseBytes = Buffer.byteLength(JSON.stringify(base));
  const fields = Object.entries(native).filter(([,value]) => value !== undefined);
  if (!fields.length) return entry;
  /** @param {NativeMetadata | undefined} selected @param {string[]} omitted */
  function extension(selected, omitted) {
    return {...(selected && {native:selected}), ...(omitted.length && {omittedMetadataFields:omitted})};
  }
  /** @param {ReturnType<typeof extension>} extra */
  function fits(extra) {
    const bytes = Buffer.byteLength(JSON.stringify(extra));
    return baseBytes + bytes - 2 + (baseBytes > 2 && bytes > 2 ? 1 : 0) <= maxBytes;
  }
  // Test the entire snapshot first: temporary per-field omission labels can
  // cost more than the missing fields themselves at a tight byte boundary.
  const full = extension(native, previous);
  if (fits(full)) return {...entry, ...full};
  // Prefer exact field omissions. If the omission list itself will not fit,
  // a whole-record marker is enough; never remove existing metadata/ref/body.
  // At an exact byte boundary even that marker may not fit: preserve access.
  const whole = extension(undefined, [...previous, 'native']);
  let result = fits(whole) ? {...entry, ...whole} : entry;
  /** @type {NativeMetadata} */
  let selected = {};
  for (const [key,value] of fields) {
    const next = {...selected,[key]:value};
    const omitted = [...previous, ...fields.filter(([name]) => !Object.hasOwn(next,name)).map(([name]) => 'native.'+name)];
    const extra = extension(next, omitted);
    if (!fits(extra)) continue;
    selected = next;
    result = {...entry, ...extra};
  }
  return result;
}
