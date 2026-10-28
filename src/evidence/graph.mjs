import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A read-only, reconstructible projection of persisted review records. It is NOT
// an extra mutable completion authority or an assertion that model prose proves a test ran.
export function projectReviewEvidence({ plan, records = [], reports = [], sourceKey } = {}) {
  const units = new Map((plan?.units ?? []).map(unit => [unit.id,unit]));
  const checked = new Map(records.filter(r => r.status === 'checked' && units.has(r.id)).map(r => [r.id,r]));
  const evidence = [...checked].map(([id, record]) => ({ id:hash([sourceKey,id,record.evidence]).slice(0,24),
    unitId:id, kind:'review_model_report', level:'model_reported', sourceKey,
    paths:(record.reviewedPaths ?? []).slice(0,16), digest:hash(record),
    // Evidence remains a reference to durable checkpoint data, not another copy of it.
    recordRef:id }));
  const byUnit = new Map(evidence.map(e => [e.unitId,e.id]));
  const obligations = [...units.values()].map(unit => ({ id:unit.id, kind:unit.kind,
    dependencies:[...unit.dependencies], evidenceIds:byUnit.has(unit.id) ? [byUnit.get(unit.id)] : [],
    status:checked.has(unit.id) && unit.dependencies.every(id => checked.has(id)) ? 'satisfied' : 'pending' }));
  const findings = reports.flatMap(report => (report.output?.issues ?? []).map(issue => ({
    digest:hash([sourceKey,issue]), level:'model_reported', batchId:report.batchId })));
  return { version:2, sourceKey, obligations, evidence, findings, persistentBacking:'review_checkpoint_v3',
    completeness:'model_reported_only' };
}
export function reconcileEvidenceGraph(graph, sourceKey) {
  if (!graph || graph.sourceKey !== sourceKey) return { reusable:false, reason:'source_revision_changed', graph:null };
  return { reusable:true, reason:null, graph };
}
// Only an explicitly witnessed tool exit can produce tool_observed; no string
// in an agent's report is promoted to this level.
export function toolObservation({ invocationId, commandDigest, exitCode, sourceKey } = {}) {
  if (typeof invocationId !== 'string' || typeof commandDigest !== 'string' || !Number.isInteger(exitCode) ||
      typeof sourceKey !== 'string') return null;
  return { id:hash([invocationId,commandDigest,exitCode,sourceKey]).slice(0,24), kind:'tool_result',
    level:'tool_observed', sourceKey, passed:exitCode===0, invocationId, commandDigest };
}

// Fine-grained reuse is separate from global review sourceKey. Legacy records
// with unknown dependencies are never reusable across a changed revision.
export function reconcileDependentEvidence({ evidence = [], sourceDigests = {}, accessKey, priorAccessKey } = {}) {
  if (typeof accessKey !== 'string' || !accessKey || priorAccessKey !== accessKey)
    return { active: [], invalidated: evidence.map(row => row.id), reason: 'security_scope_changed' };
  const known = sourceDigests && typeof sourceDigests === 'object' && !Array.isArray(sourceDigests) ? sourceDigests : {};
  const accepted = new Map();
  const invalid = new Set();
  const entries = Array.isArray(evidence) ? evidence : [];
  for (const item of entries) {
    const sources = item?.sources;
    const valid = typeof item?.id === 'string' && Array.isArray(sources) && sources.length > 0 &&
      sources.every(s => typeof s?.id === 'string' && typeof s?.digest === 'string' &&
        Object.hasOwn(known, s.id) && known[s.id] === s.digest) &&
      Array.isArray(item?.dependencyIds);
    if (valid) accepted.set(item.id, item);
    else if (typeof item?.id === 'string') invalid.add(item.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of accepted.values()) {
      if (item.dependencyIds.some(id => !accepted.has(id))) {
        accepted.delete(item.id); invalid.add(item.id); changed = true;
      }
    }
  }
  return { active: [...accepted.values()], invalidated: [...invalid], reason: invalid.size ? 'source_or_dependency_changed' : null };
}

// Derive coverage from evidence provenance and explicit obligation requirements.
// A model-authored report cannot satisfy a test-observed obligation.
export function assessEvidenceCoverage({ obligations = [], evidence = [] } = {}) {
  const levels = { model_reported: 0, tool_observed: 1, independently_verified: 2 };
  const byId = new Map(evidence.filter(e => e && typeof e.id === 'string').map(e => [e.id,e]));
  const completed = new Set();
  const pending = new Set(obligations.map(o => o.id));
  let change = true;
  while (change) {
    change = false;
    for (const obligation of obligations) {
      if (!pending.has(obligation.id)) continue;
      const required = levels[obligation.requiredEvidenceLevel ?? 'model_reported'];
      if (required === undefined || !Array.isArray(obligation.evidenceIds) || !obligation.evidenceIds.length) continue;
      if (!(obligation.dependencies ?? []).every(id => completed.has(id))) continue;
      if (!obligation.evidenceIds.every(id => {
        const item = byId.get(id);
        return item && item.lifecycle !== 'invalidated' && item.lifecycle !== 'stale' &&
          levels[item.level] !== undefined && levels[item.level] >= required && item.passed !== false;
      })) continue;
      completed.add(obligation.id); pending.delete(obligation.id); change = true;
    }
  }
  return { satisfied: [...completed], pending: [...pending] };
}
