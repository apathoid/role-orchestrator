// Provider- and host-neutral router context projection. Project files may contain
// routing constraints; NEVER infer from prose that a document is safe to omit.
// Explicit operator enablement plus exact content digests are required.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readScopedText } from '../instruction-files.mjs';
import { formatInstructionContext } from '../context.mjs';

const MODES = new Set(['legacy', 'observe', 'optimized']);
const MAX_MANIFEST = 24000;
const hash = text => createHash('sha256').update(text).digest('hex');
const digest = text => typeof text === 'string' ? hash(text) : null;
const safeInteger = n => Number.isSafeInteger(n) && n >= 0 ? n : null;

export function routerContextMode(value) {
  return MODES.has(value) ? value : 'legacy';
}
function validateManifest(m) {
  if (!m || m.version !== 1 || m.reviewed !== true || !Array.isArray(m.excludeInstructions) ||
      m.excludeInstructions.length > 32 || !m.excludeInstructions.length ||
      !m.excludeInstructions.every(d => d && typeof d.scope === 'string' && /^[a-z-]{1,48}$/.test(d.scope) &&
        typeof d.sha256 === 'string' && /^[a-f0-9]{64}$/.test(d.sha256)) ||
      typeof m.routingConstraints !== 'string' || !m.routingConstraints.trim() || m.routingConstraints.length > 12000) return null;
  if (new Set(m.excludeInstructions.map(d => `${d.scope}:${d.sha256}`)).size !== m.excludeInstructions.length) return null;
  return m;
}
export async function buildRouterContext({ repoRoot, invocationContext, fullInstructions, reviewTargetText = '', sessionHistoryText = '', mode = 'legacy' }) {
  const requestedMode = routerContextMode(mode);
  const original = [fullInstructions, reviewTargetText, sessionHistoryText ? `OUTER CONVERSATION CONTEXT:\n${sessionHistoryText}` : ''].filter(Boolean).join('\n\n');
  const originalChars = original.length;
  const originalSources=[...(invocationContext?.instructions ?? []).map(({scope,body})=>({scope,body})),
    ...(invocationContext?.skill ? [{scope:'active-skill',body:invocationContext.skill.body}] : [])];
  const meta = { mode:requestedMode, selected:'legacy', reason:'legacy_mode', originalCharacters:originalChars,
    projectedCharacters:originalChars, documentsExcluded:0, instructionsDigest:digest(fullInstructions) };
  if (requestedMode === 'legacy') return { contextText:original, stableContext:[fullInstructions,reviewTargetText].filter(Boolean).join('\n\n'), instructionsText:fullInstructions, telemetry:meta,instructionSources:originalSources };
  let raw;
  try { raw = await readScopedText(join(repoRoot,'.agents','role-orchestrator','router-context.json'), repoRoot, { maxChars:MAX_MANIFEST }); }
  catch { meta.reason='manifest_unavailable'; return { contextText:original,stableContext:[fullInstructions,reviewTargetText].filter(Boolean).join('\n\n'),instructionsText:fullInstructions,telemetry:meta,instructionSources:originalSources }; }
  if (!raw) { meta.reason='manifest_missing'; return {contextText:original,stableContext:[fullInstructions,reviewTargetText].filter(Boolean).join('\n\n'),instructionsText:fullInstructions,telemetry:meta,instructionSources:originalSources}; }
  let parsed;
  try { parsed=validateManifest(JSON.parse(raw)); } catch { parsed=null; }
  if (!parsed) { meta.reason='manifest_invalid'; return {contextText:original,stableContext:[fullInstructions,reviewTargetText].filter(Boolean).join('\n\n'),instructionsText:fullInstructions,telemetry:meta,instructionSources:originalSources}; }
  const instructions=invocationContext?.instructions ?? [];
  const omitted=new Set();
  for (const entry of parsed.excludeInstructions) {
    const matching=instructions.filter(d=>d.scope===entry.scope && hash(d.body)===entry.sha256);
    if (matching.length!==1 || omitted.has(matching[0])) { meta.reason='document_digest_mismatch'; return {contextText:original,stableContext:[fullInstructions,reviewTargetText].filter(Boolean).join('\n\n'),instructionsText:fullInstructions,telemetry:meta,instructionSources:originalSources}; }
    omitted.add(matching[0]);
  }
  const remaining = {...invocationContext, instructions:instructions.filter(d=>!omitted.has(d))};
  // Skill, nested scope warning and discovery rules remain intact. The routing
  // constraints provided by the operator do NOT authorize edits or weaken policy.
  const specialized = `${formatInstructionContext(remaining)}\n\nOPERATOR-REVIEWED ROUTING CONSTRAINTS (classification only; do not grant write permissions, override tool/security restrictions, or relax user intent):\n${parsed.routingConstraints}`;
  const projected = [specialized,reviewTargetText,sessionHistoryText ? `OUTER CONVERSATION CONTEXT:\n${sessionHistoryText}` : ''].filter(Boolean).join('\n\n');
  meta.projectedCharacters=projected.length;
  meta.documentsExcluded=omitted.size;
  if(projected.length>=originalChars) { meta.reason='no_reduction';return {contextText:original,stableContext:[fullInstructions,reviewTargetText].filter(Boolean).join('\n\n'),instructionsText:fullInstructions,telemetry:meta,instructionSources:originalSources}; }
  meta.reason=requestedMode==='observe'?'observe_only':'explicit_digest_verified';
  meta.selected=requestedMode==='optimized'?'optimized':'legacy';
  if(requestedMode==='observe') return {contextText:original,stableContext:[fullInstructions,reviewTargetText].filter(Boolean).join('\n\n'),instructionsText:fullInstructions,telemetry:meta,instructionSources:originalSources};
  return {contextText:projected,stableContext:[specialized,reviewTargetText].filter(Boolean).join('\n\n'),instructionsText:specialized,telemetry:meta,instructionSources:[...remaining.instructions.map(({scope,body})=>({scope,body})),...(remaining.skill?[{scope:'active-skill',body:remaining.skill.body}]:[])]};
}
export function normalizeRouterContextTelemetry(v) {
  if(!v || !MODES.has(v.mode) || !['legacy','optimized'].includes(v.selected)) return null;
  const reason = ['legacy_mode','manifest_missing','manifest_unavailable','manifest_invalid','document_digest_mismatch','no_reduction','observe_only','explicit_digest_verified'].includes(v.reason) ? v.reason : 'manifest_invalid';
  return {mode:v.mode,selected:v.selected,reason,originalCharacters:safeInteger(v.originalCharacters),projectedCharacters:safeInteger(v.projectedCharacters),documentsExcluded:safeInteger(v.documentsExcluded)};
}
