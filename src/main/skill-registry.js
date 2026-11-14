import { arrayOf, decode, id, optional, record } from '../core/decode.js';
import { duplicateExtensionIds } from './plugin-api.js';

/** @import {Configuration} from '../application/configuration/decode-config.js' */
/** @import {Catalog, SkillMetadata, SkillInstructions} from '../core/ports.js' */
/** @import {Plugin} from './plugin-api.js' */

const metadataShape = record({ id, version: id, description: id, resources: optional(arrayOf(id)) });
const maxMetadataBytes = 4096;

/** @param {unknown} raw @param {string} skillId @returns {SkillMetadata | undefined} */
function metadata(raw, skillId) {
  const result = decode(metadataShape, raw);
  if (result.kind !== 'accepted' || result.value.id !== skillId ||
      Buffer.byteLength(JSON.stringify(result.value)) > maxMetadataBytes) return undefined;
  const { resources, ...fields } = result.value;
  return Object.freeze({ ...fields, ...(resources ? { resources: Object.freeze(resources) } : {}) });
}

/** @param {readonly NonNullable<Configuration['skills']>[number][]} entries
 *  @param {ReadonlyMap<string, Plugin>} plugins */
export async function createSkillRegistry(entries, plugins) {
  const duplicates = duplicateExtensionIds(entries);
  /** @type {Map<string, SkillMetadata>} */
  const records = new Map();
  /** @type {Map<string, string>} */
  const sources = new Map();
  for (const { id, source } of entries) {
    if (records.has(id)) continue;
    const loader = plugins.get(source)?.loadSkill;
    if (!duplicates.has(id) && loader) {
      try {
        const value = metadata(await loader({ id, content: 'metadata' }), id);
        if (value) {
          records.set(id, value);
          sources.set(id, source);
          continue;
        }
      } catch { /* A source failure is confined to the configured skill. */ }
    }
    records.set(id, Object.freeze({ id, unavailable: duplicates.has(id) ? 'duplicate_id' : 'source_unavailable' }));
  }
  /** @type {NonNullable<Catalog['loadSkill']>} */
  async function loadSkill(id, maxBytes, signal) {
    /** @param {string} reason @returns {SkillInstructions} */
    const unavailable = reason => ({ id, status: 'unavailable', reason });
    if (signal.aborted) return unavailable('closed');
    const entry = records.get(id);
    const source = sources.get(id);
    const loader = source === undefined ? undefined : plugins.get(source)?.loadSkill;
    if (!loader || !entry?.version) return unavailable(entry?.unavailable ?? 'missing');
    if (maxBytes < 1) return unavailable('budget');
    let raw;
    try { raw = await loader({ id, content: 'instructions', signal }); }
    catch { return unavailable('source_unavailable'); }
    if (signal.aborted) return unavailable('closed');
    if (!raw || typeof raw !== 'object' || !('version' in raw) || !('instructions' in raw) ||
        typeof raw.instructions !== 'string' || raw.instructions.length === 0) return unavailable('resource_unavailable');
    if (raw.version !== entry.version) return unavailable('version_changed');
    let bytes = 0;
    let end = 0;
    for (const character of raw.instructions) {
      const size = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (bytes + size > maxBytes) break;
      bytes += size;
      end += character.length;
    }
    return { id, version: entry.version, status: end === raw.instructions.length ? 'complete' : 'truncated',
      instructions: raw.instructions.slice(0, end) };
  }
  return { records: [...records.values()], loadSkill };
}
