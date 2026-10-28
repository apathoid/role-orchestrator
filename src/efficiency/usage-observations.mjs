// Provider-neutral semantics for optional usage data. Never infer billed tokens
// from ACP context occupancy. A missing value is not a zero.
const FIELDS = ['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'];
const SEMANTICS = new Set(['cumulative','delta','final','occupancy']);
const SCOPES = new Set(['request','generation','turn','session']);
const quantity = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const safeId = x => typeof x === 'string' && x.length <= 90 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(x) ? x : null;
export function normalizeUsageObservation(value) {
  if (!value || typeof value !== 'object') return null;
  const semantics = SEMANTICS.has(value.semantics) ? value.semantics : 'cumulative';
  const scope = SCOPES.has(value.scope) ? value.scope : 'turn';
  return {
    semantics, scope,
    scopeId: safeId(value.scopeId), observationId: safeId(value.observationId),
    source: value.source === 'runtime' ? 'runtime' : 'provider',
    ...Object.fromEntries(FIELDS.map(k => [k,quantity(value[k])])),
    contextUsedTokens: quantity(value.contextUsedTokens), contextWindow: quantity(value.contextWindow),
  };
}
const empty = () => Object.fromEntries(FIELDS.map(k=>[k,null]));
function validated(v) {
  const o={...v};
  if(o.inputTokens!==null && o.cachedInputTokens!==null && o.cachedInputTokens>o.inputTokens) o.cachedInputTokens=null;
  if(o.outputTokens!==null && o.reasoningOutputTokens!==null && o.reasoningOutputTokens>o.outputTokens) o.reasoningOutputTokens=null;
  if(o.totalTokens!==null && o.inputTokens!==null && o.outputTokens!==null && o.totalTokens!==o.inputTokens+o.outputTokens) o.totalTokens=null;
  return o;
}
/** Streaming cumulative observations are snapshots, per-request final observations are distinct.
 * Never add final/cumulative snapshots within a scope. Delta requires an event ID.
 */
export function createUsageAccumulator() {
  const scopes = new Map();
  const seenDelta = new Set();
  let rejected = 0, observations = 0, ambiguous = false;
  function observe(raw) {
    const u = normalizeUsageObservation(raw);
    if(!u) return;
    observations++;
    if(u.semantics === 'occupancy') return;
    // A request/generation needs an explicit identity so distinct generations
    // cannot be silently merged. Legacy ACP turn usage stays in its own scope.
    if ((u.scope==='request'||u.scope==='generation') && !u.scopeId) { ambiguous=true; rejected++; return; }
    if(u.semantics==='delta' && !u.observationId) { ambiguous=true; rejected++; return; }
    if(u.semantics==='delta') {
      const deltaId=`${u.scope}/${u.scopeId ?? 'default'}/${u.observationId}`;
      if(seenDelta.has(deltaId)) return;
      if(seenDelta.size>=4096) { ambiguous=true; rejected++; return; }
      seenDelta.add(deltaId);
    }
    const key = `${u.scope}/${u.scopeId ?? 'default'}`;
    if (!scopes.has(key) && scopes.size>=128) { ambiguous=true; rejected++; return; }
    const current = scopes.get(key) ?? { values:empty(), mode:u.semantics, counts:Object.fromEntries(FIELDS.map(k=>[k,0])) };
    if (current.mode==='final' && u.semantics==='cumulative') return; // delayed snapshot after authoritative final
    if(current.mode !== u.semantics && !(current.mode==='cumulative' && u.semantics==='final')) {
      ambiguous=true; rejected++; return;
    }
    for(const k of FIELDS) {
      if(u[k]===null) continue;
      const old=current.values[k];
      let next;
      if(u.semantics==='delta') next=(old ?? 0)+u[k];
      else if(u.semantics==='final') next=u[k];
      else next=Math.max(old ?? 0,u[k]);
      if(!Number.isSafeInteger(next)) { ambiguous=true; rejected++; current.values[k]=null; continue; }
      current.values[k]=next; current.counts[k]++;
    }
    if (u.semantics==='final') current.mode='final';
    scopes.set(key,current);
  }
  function summary() {
    const totals=empty();
    const knownFields={};
    for(const k of FIELDS) {
      let sum=0, known=0;
      for(const s of scopes.values()) if(s.values[k]!==null) {
        sum+=s.values[k]; known++;
      }
      const complete = !ambiguous && known===scopes.size && known>0 && Number.isSafeInteger(sum);
      totals[k]=complete ? sum : null;
      knownFields[k]={coveredScopes:known,totalScopes:scopes.size,complete};
    }
    const scopeKinds = new Set([...scopes.keys()].map(k=>k.split('/')[0]));
    // A session/turn aggregate cannot be added to its constituent request
    // generations. Without a declared reconciliation rule, expose no total.
    if ((scopeKinds.has('turn')||scopeKinds.has('session')) && (scopeKinds.has('request')||scopeKinds.has('generation')) ||
        (scopeKinds.has('turn') && scopeKinds.has('session'))) {
      ambiguous=true;
      for(const k of FIELDS){ totals[k]=null; knownFields[k].complete=false; }
    }
    return { usage:validated(totals), completeness: !ambiguous && scopes.size>0 && FIELDS.slice(0,2).every(k=>knownFields[k].complete) ? 'complete' : scopes.size ? 'partial' : 'unknown',
      knownFields, observations, rejected, ambiguous, scopeCount:scopes.size };
  }
  return {observe,summary};
}
