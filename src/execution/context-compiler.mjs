// Strict role context compiler. Mandatory policy, skill and task blocks never
// disappear or get silently shortened. Optional exact duplicates are eliminated
// only within the same precedence scope; semantic equality is NOT assumed.
import { createHash } from 'node:crypto';
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
const validKinds = new Set(['core_policy','role_contract','task_contract','skill','project_rule',
  'source_evidence','history','handoff','engineering_policy','checkpoint']);
export function compileRoleContext({blocks = [], mode = 'observe', optionalMaxCharacters = null} = {}) {
  if (!['observe','deduplicate'].includes(mode)) throw new Error('Invalid context compilation mode');
  if (!Array.isArray(blocks) || blocks.length > 256) throw new Error('Invalid context blocks');
  if (optionalMaxCharacters !== null && (!Number.isSafeInteger(optionalMaxCharacters) || optionalMaxCharacters < 0))
    throw new Error('Invalid optional context character budget');
  const seen = new Set(), selected = [], omitted = [];
  let optionalCharacters = 0;
  for (let i=0; i<blocks.length; i++) {
    const block = blocks[i];
    if (!validKinds.has(block?.kind) || typeof block?.text !== 'string' ||
        !['global','project','task','invocation'].includes(block?.scope ?? 'invocation'))
      throw new Error('Invalid context block');
    const scope = block.scope ?? 'invocation';
    const key = `${scope}:${digest(block.text)}`;
    const required = block.required !== false;
    const previous = seen.has(key);
    const tooLarge = optionalMaxCharacters !== null && optionalCharacters + block.text.length > optionalMaxCharacters;
    if (!required && mode === 'deduplicate' && (previous || tooLarge)) {
      // If optional content is omitted, the role MUST have an explicit means
      // of retrieving it. Otherwise keep it inline despite the requested cap.
      if (previous || (typeof block.resolverRef === 'string' && block.resolverRef)) {
        omitted.push({index:i,reason:previous?'exact_duplicate':'retrievable_optional',
          digest:digest(block.text),resolverRef:block.resolverRef ?? null});
        continue;
      }
    }
    selected.push(block.text);
    seen.add(key);
    if (!required) optionalCharacters += block.text.length;
  }
  return {text:selected.filter(Boolean).join('\n\n'),omitted,
    requiredPreserved:blocks.filter(b=>b.required!==false).length,
    totalCharacters:selected.reduce((n,s)=>n+s.length,0),
    savedCharacters:omitted.reduce((n,o)=>n+blocks[o.index].text.length,0),
    completeness:omitted.some(o=>o.reason==='retrievable_optional')?'resolvable_optional_omitted':'complete'};
}
