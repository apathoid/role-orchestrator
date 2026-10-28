// Host/provider-neutral, explicitly audited instruction projection. An operator
// must identify each deferrable document by exact digest and role. No content
// is inferred to be optional from names, file size, or model judgments.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readScopedText } from '../instruction-files.mjs';
import { formatInstructionContext } from '../context.mjs';

const MODES = new Set(['legacy', 'observe', 'optimized']);
const REVIEW_ROLES = new Set(['explorer', 'reviewerLow', 'reviewerMedium', 'reviewerHigh', 'finalValidator']);
const sha = text => createHash('sha256').update(text).digest('hex');
const excludedScope = scope => typeof scope === 'string' && /^(project|nested)(?:-reference)+$/.test(scope);
export const reviewContextModes = Object.freeze([...MODES]);

function validatedManifest(value) {
  if (value?.version !== 1 || value.reviewed !== true || !Array.isArray(value.defer) || value.defer.length > 64) return null;
  if (!value.defer.every(row => row && excludedScope(row.scope) && typeof row.path === 'string' &&
    row.path.length > 0 && row.path.length <= 1024 && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256) &&
    Array.isArray(row.roles) && row.roles.length > 0 && row.roles.every(role => REVIEW_ROLES.has(role)))) return null;
  return value;
}

/** Compute one role's safely deferrable instruction projection. */
export async function projectRoleInstructions({repoRoot, invocationContext, role, mode = 'legacy'} = {}) {
  if (!MODES.has(mode)) throw new Error('Invalid review project-context mode');
  const original = formatInstructionContext(invocationContext);
  const base = {mode, selected:'legacy', reason:'legacy', originalCharacters:original.length,
    projectedCharacters:original.length, deferredDocuments:0};
  if (mode === 'legacy' || !REVIEW_ROLES.has(role)) return {text:original,manifest:base};
  let raw;
  try { raw = await readScopedText(join(repoRoot,'.agents','role-orchestrator','review-context.json'),repoRoot,{maxChars:24000}); }
  catch { return {text:original,manifest:{...base,reason:'manifest_unavailable'}}; }
  let parsed;
  try { parsed = validatedManifest(JSON.parse(raw)); }
  catch { parsed = null; }
  if (!parsed) return {text:original,manifest:{...base,reason:'manifest_missing_or_invalid'}};
  const documents=invocationContext?.instructions ?? [];
  const deferred=[];
  for (const entry of parsed.defer.filter(row=>row.roles.includes(role))) {
    const matches=documents.filter(doc=>doc.scope===entry.scope && doc.path===entry.path && sha(doc.body)===entry.sha256);
    // Fail closed on stale/missing/ambiguous source identities.
    if (matches.length !== 1 || deferred.includes(matches[0])) return {text:original,manifest:{...base,reason:'digest_mismatch'}};
    deferred.push(matches[0]);
  }
  if (!deferred.length) return {text:original,manifest:{...base,reason:'no_applicable_documents'}};
  const filtered={...invocationContext,instructions:documents.filter(doc=>!deferred.includes(doc))};
  // The role can resolve any deferred project instruction by reading the
  // original path. No globally scoped or active-skill document is deferrable.
  const discovery=`DEFERRED PROJECT REFERENCES (operator-reviewed; read the original document before using or changing its governed code):\n${deferred.map(doc=>`- ${doc.path}`).join('\n')}`;
  const projected=`${formatInstructionContext(filtered)}\n\n${discovery}`;
  const manifest={...base,projectedCharacters:projected.length,deferredDocuments:deferred.length};
  if (projected.length >= original.length) return {text:original,manifest:{...manifest,reason:'no_reduction'}};
  return {text:mode==='optimized'?projected:original,manifest:{...manifest,
    reason:mode==='observe'?'observe_only':'digest_verified',selected:mode==='optimized'?'optimized':'legacy'}};
}
