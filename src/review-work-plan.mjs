// Immutable, reproducible review assignments. Criteria and file coverage are
// independently necessary; a reviewer report cannot rewrite the work plan.
import { createHash } from 'node:crypto';

export const MAX_UNITS_PER_BATCH = 2;
export const MAX_BATCHES_PER_RUN = 8;
export const MAX_PLAN_UNITS = 1024;
export const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// Stable subsystem grouping prioritizes changed modules/components and keeps
// adjacent implementations/tests close. Static import hints may add ordering
// constraints, but cannot establish that behavior has been verified.
function subsystem(path) {
  const parts = path.split('/');
  if (['packages', 'apps', 'services'].includes(parts[0]) && parts.length > 2) return parts.slice(0, 2).join('/');
  if (parts[0] === 'src' && ['modules', 'features', 'components', 'domains'].includes(parts[1]) && parts.length > 3) {
    return parts.slice(0, 3).join('/');
  }
  if (parts[0] === 'src') return parts.length > 2 ? parts.slice(0, 2).join('/') : 'src';
  if (parts[0] === 'test' || parts[0] === 'tests' || parts[0] === '__tests__') return parts[0];
  return parts.length > 1 ? parts[0] : '(root)';
}
function relatedName(path) {
  return path.split('/').at(-1).replace(/\.(?:test|spec)\b/i, '').replace(/\.[^.]+$/, '').toLowerCase();
}
const GENERIC_WORDS = new Set(['inspect', 'check', 'verify', 'review', 'files', 'changed', 'changes', 'behavior', 'behaviour',
  'regressions', 'regression', 'tests', 'test', 'ensure', 'correctness', 'functional', 'source', 'integration',
  'проверить', 'проверка', 'файлов', 'изменения', 'работы', 'системы']);
function matchCriteria(criterion, units) {
  const words = (String(criterion.description).toLowerCase().match(/[\p{L}\d]{4,}/gu) ?? [])
    .filter((word) => !GENERIC_WORDS.has(word));
  const matched = words.length ? units.filter((unit) => unit.paths.some((path) =>
    words.some((word) => path.toLowerCase().includes(word)))) : [];
  // No reliable lexical link => broad criterion: it depends on the whole
  // known changed scope, not merely the first group the model happened to see.
  return matched.length ? matched : units;
}

export function buildReviewWorkPlan(contract, scope, { maxFilesPerUnit = 4 } = {}) {
  if (!Number.isInteger(maxFilesPerUnit) || maxFilesPerUnit < 1 || maxFilesPerUnit > 16) throw new Error('Invalid review file-unit size');
  const fileUnits = [];
  if (scope?.available) {
    const domains = new Map();
    for (const entry of scope.paths) {
      const domain = subsystem(entry.path);
      if (!domains.has(domain)) domains.set(domain, []);
      domains.get(domain).push(entry);
    }
    for (const [domain, entries] of [...domains].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      entries.sort((a, b) => relatedName(a.path).localeCompare(relatedName(b.path), 'en') || a.path.localeCompare(b.path, 'en'));
      for (let i = 0; i < entries.length; i += maxFilesPerUnit) {
        const changes = entries.slice(i, i + maxFilesPerUnit);
        const paths = changes.map((entry) => entry.path);
        fileUnits.push({ id: `F${String(fileUnits.length + 1).padStart(5, '0')}`,
          kind: 'file-group', subsystem: domain, criterionIds: [], paths, changes, dependencies: [], relatedUnits: [],
          description: `Inspect changed ${domain} files ${i + 1}–${i + paths.length} and their integrations.`,
          estimatedWeight: paths.length });
      }
    }
    const byPath = new Map(fileUnits.flatMap((unit) => unit.paths.map((path) => [path, unit])));
    const links = new Map(fileUnits.map((unit) => [unit.id, new Set()]));
    const relatives = new Map(fileUnits.map((unit) => [unit.id, new Set()]));
    for (const edge of scope.relationships ?? []) {
      const from = byPath.get(edge.from), to = byPath.get(edge.to);
      if (!from || !to || from === to || edge.relation !== 'import') continue;
      relatives.get(from.id).add(to.id);
      relatives.get(to.id).add(from.id);
      links.get(from.id).add(to.id); // importer requires provider first
    }
    const hasPath = (from, target, visited = new Set()) => {
      if (from === target) return true;
      if (visited.has(from)) return false;
      visited.add(from);
      return [...(links.get(from) ?? [])].some((next) => hasPath(next, target, visited));
    };
    // Eliminate cyclic ordering constraints deterministically; keep relation
    // metadata for the reviewer so no contradictory prerequisite deadlock arises.
    links.clear();
    for (const unit of fileUnits) links.set(unit.id, new Set());
    const connected = new Set();
    for (const edge of scope.relationships ?? []) {
      const from = byPath.get(edge.from), to = byPath.get(edge.to);
      if (!from || !to || from === to || edge.relation !== 'import') continue;
      const key = `${from.id}:${to.id}`;
      if (connected.has(key)) continue;
      connected.add(key);
      if (hasPath(to.id, from.id)) continue;
      links.get(from.id).add(to.id);
    }
    for (const unit of fileUnits) {
      unit.dependencies = [...links.get(unit.id)].sort();
      unit.relatedUnits = [...relatives.get(unit.id)].sort();
    }
  }
  const criterionUnits = contract.checks.map((criterion) => {
    const targets = matchCriteria(criterion, fileUnits);
    for (const target of targets) target.criterionIds.push(criterion.id);
    return { id: `C${criterion.id}`, kind: 'criterion', subsystem: '(criteria)', criterionIds: [criterion.id],
      description: criterion.description, paths: [], dependencies: targets.map((unit) => unit.id), estimatedWeight: 1 };
  });
  const units = [...fileUnits, ...criterionUnits];
  const omittedUnits = units.slice(MAX_PLAN_UNITS);
  const scheduledUnits = units.slice(0, MAX_PLAN_UNITS);
  const planKey = digest({ checks: contract.checks, omitted: contract.omitted,
    source: scope?.available ? [scope.selector, scope.revisionKey, scope.manifestKey, scope.status] : [scope?.reason, scope?.required, scope?.status, scope?.revisionKey],
    units: scheduledUnits, omittedIds: omittedUnits.map((unit) => unit.id) });
  return { version: 1, planKey, units: scheduledUnits, omittedUnits: omittedUnits.map((u) => u.id),
    totalUnits: units.length, scope: { deniedFiles: scope?.deniedCount ?? 0, available: !!scope?.available, required: !!scope?.required,
      reason: scope?.reason ?? null, selector: scope?.selector ?? null, revisionKey: scope?.revisionKey ?? null,
      manifestKey: scope?.manifestKey ?? null, status: scope?.status ?? (scope?.available ? 'resolved' : 'unresolved'),
      complete: scope?.complete ?? !!scope?.available, resolvedChanges: scope?.resolvedChanges ?? null,
      unresolvedChanges: scope?.unresolvedChanges ?? null,
      knownFiles: scope?.available ? scope.total : null,
      totalFiles: scope?.available && scope?.status !== 'partial' && scope?.totalKnown !== false ? scope.total : null } };
}

export function nextReviewBatch(plan, verifiedIds, attemptedIds = [], { maxUnitsPerBatch = MAX_UNITS_PER_BATCH, coScheduleDependents = false } = {}) {
  if (!Number.isInteger(maxUnitsPerBatch) || maxUnitsPerBatch < 1 || maxUnitsPerBatch > 8) throw new Error('Invalid review batch limits');
  const complete = new Set(verifiedIds), attempted = new Set(attemptedIds);
  const ready = plan.units.filter((unit) => !complete.has(unit.id) && !attempted.has(unit.id) &&
    unit.dependencies.every((id) => complete.has(id)));
  if (!ready.length) return [];
  const domain = ready[0].subsystem;
  const selected = ready.filter((unit) => unit.subsystem === domain).slice(0, maxUnitsPerBatch);
  if (selected.length < maxUnitsPerBatch) selected.push(...ready.filter((unit) => unit.subsystem !== domain)
    .slice(0, maxUnitsPerBatch - selected.length));
  if (coScheduleDependents && selected.length < maxUnitsPerBatch) {
    // A criterion can be evaluated alongside its source files, but still needs
    // its OWN evidence. It is never silently marked checked by association.
    const included = new Set([...complete, ...selected.map(u => u.id)]);
    for (const unit of plan.units) {
      if (selected.length >= maxUnitsPerBatch) break;
      if (unit.kind !== 'criterion' || included.has(unit.id) || attempted.has(unit.id)) continue;
      if (unit.dependencies.every(id => included.has(id))) {
        selected.push(unit); included.add(unit.id);
      }
    }
  }
  return selected;
}

// Projection for reporting/testing; real execution must check prerequisites
// again after each batch, since an assigned Unit can return not_checked.
export function batchesForRemaining(plan, verifiedIds, { batchLimit = MAX_BATCHES_PER_RUN, maxUnitsPerBatch = MAX_UNITS_PER_BATCH, coScheduleDependents = false } = {}) {
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 16) throw new Error('Invalid review batch limits');
  const complete = new Set(verifiedIds), batches = [];
  for (let i = 0; i < batchLimit; i++) {
    const batch = nextReviewBatch(plan, complete, [], { maxUnitsPerBatch, coScheduleDependents });
    if (!batch.length) break;
    batches.push(batch);
    for (const unit of batch) complete.add(unit.id);
  }
  return batches;
}

export function assessReviewUnits(batch, result) {
  const records = [], problems = [];
  const rows = result?.outputFormat === 'structured' && Array.isArray(result.output?.coverage) ? result.output.coverage : [];
  const expected = new Map(batch.map((u) => [u.id, u]));
  const seen = new Set();
  for (const row of rows) {
    const unit = expected.get(row?.id);
    if (!unit || seen.has(row.id)) { problems.push('unexpected_or_duplicate_unit'); continue; }
    seen.add(row.id);
    const observed = Array.isArray(row.reviewedPaths) ? row.reviewedPaths : [];
    const fileEvidence = Array.isArray(row.fileEvidence) ? row.fileEvidence : [];
    const pathEvidenceValid = unit.kind !== 'file-group' || (fileEvidence.length === unit.paths.length &&
      fileEvidence.every((entry) => typeof entry?.path === 'string' && unit.paths.includes(entry.path) &&
        typeof entry.evidence === 'string' && entry.evidence.trim().length >= 16) &&
      new Set(fileEvidence.map((entry) => entry.path)).size === unit.paths.length);
    const pathsValid = unit.kind !== 'file-group' || (observed.length === unit.paths.length &&
      observed.every((path) => unit.paths.includes(path)) && new Set(observed).size === unit.paths.length && pathEvidenceValid);
    const checked = row.status === 'checked' && typeof row.evidence === 'string' && row.evidence.trim().length >= 16 && pathsValid;
    if (!checked) problems.push(`${unit.id}: ${pathsValid ? 'missing_evidence_or_unchecked' : 'reviewed_paths_not_verified'}`);
    records.push({ id: unit.id, status: checked ? 'checked' : row.status === 'blocked' ? 'blocked' : 'not_checked',
      evidence: typeof row.evidence === 'string' ? row.evidence.slice(0, 1800) : '',
      reviewedPaths: checked ? [...observed] : [],
      fileEvidence: checked && unit.kind === 'file-group' ? fileEvidence.map((entry) =>
        ({ path: entry.path, evidence: entry.evidence.slice(0, 420) })) : [] });
  }
  for (const unit of batch) if (!seen.has(unit.id)) {
    records.push({ id: unit.id, status: 'not_checked', evidence: '', reviewedPaths: [] });
    problems.push(`${unit.id}: missing_unit_result`);
  }
  return { records, problems };
}

export function reviewWorkCoverage(contract, plan, completedRecords, problems = []) {
  const reported = new Map(completedRecords.filter((r) => r?.status === 'checked').map((r) => [r.id, r]));
  const rows = new Map();
  // A dependent result cannot make the work complete on its own, including
  // when an invalid/migrated checkpoint was supplied by a caller.
  for (let pass = 0; pass < plan.units.length; pass++) {
    let added = false;
    for (const unit of plan.units) {
      if (!rows.has(unit.id) && reported.has(unit.id) &&
          unit.dependencies.every((id) => rows.has(id))) { rows.set(unit.id, reported.get(unit.id)); added = true; }
    }
    if (!added) break;
  }
  const verified = plan.units.filter((unit) => rows.has(unit.id));
  const pending = plan.units.filter((unit) => !rows.has(unit.id));
  const criteria = [...contract.checks, ...contract.omitted].map((item) => ({
    ...item, status: rows.has(`C${item.id}`) ? 'checked' : 'not_checked',
    evidence: rows.get(`C${item.id}`)?.evidence ?? '',
  }));
  const gapCodes = [];
  if (pending.length) gapCodes.push('UNIT_PENDING');
  if (pending.some((unit) => unit.dependencies.some((id) => !rows.has(id)))) gapCodes.push('DEPENDENCY_BLOCKED');
  if (contract.omitted.length || plan.omittedUnits.length) gapCodes.push('REVIEW_BUDGET_EXHAUSTED');
  if (plan.scope.deniedFiles > 0) gapCodes.push('SECURITY_RESTRICTED');
  if (plan.scope.required && plan.scope.status !== 'resolved')
    gapCodes.push(plan.scope.status === 'partial' ? 'SCOPE_PARTIAL' : 'SCOPE_UNRESOLVED');
  if (problems.length) gapCodes.push('EVIDENCE_INSUFFICIENT');
  if (problems.some((item) => /(?:source changed|git review base|git source changed|repository changed)/i.test(String(item)))) gapCodes.push('SOURCE_CHANGED');
  const gaps = [...pending.map((unit) => `${unit.id}: ${unit.description}`),
    ...contract.omitted.map((item) => `${item.id}: not included in bounded plan`),
    ...plan.omittedUnits.map((id) => `${id}: unit budget exceeded`), ...problems];
  if (plan.scope.deniedFiles > 0) gaps.push(`${plan.scope.deniedFiles} changed file(s) are inaccessible under the active security policy.`);
  if (plan.scope.required && plan.scope.status !== 'resolved')
    gaps.push(`Git scope not established or partial: ${plan.scope.status} (${plan.scope.reason ?? 'unknown'}; unresolved change sets=${plan.scope.unresolvedChanges ?? 'unknown'})`);
  const complete = gaps.length === 0 && criteria.every((c) => c.status === 'checked') &&
    verified.length === plan.totalUnits;
  const verifiedFiles = verified.filter((u) => u.kind === 'file-group')
    .reduce((sum, unit) => sum + unit.paths.length, 0);
  return { complete, source: contract.source, checked: criteria.filter((c) => c.status === 'checked').length,
    total: criteria.length, entries: criteria, gaps, gapCodes: [...new Set(gapCodes)],
    truncated: contract.omitted.length > 0 || plan.omittedUnits.length > 0,
    scope: { status: plan.scope.status, reason: plan.scope.reason, resolvedChanges: plan.scope.resolvedChanges,
      unresolvedChanges: plan.scope.unresolvedChanges, complete: plan.scope.status === 'resolved',
      blocked: plan.scope.required && plan.scope.status !== 'resolved' },
    criteria: { total: criteria.length, evidenceCollected: criteria.filter((c) => c.status === 'checked').length,
      fullyCovered: plan.scope.required && plan.scope.status !== 'resolved' ? 0 : criteria.filter((c) => c.status === 'checked').length },
    units: { total: plan.totalUnits, verified: verified.length, pending: plan.totalUnits - verified.length },
    files: { total: plan.scope.totalFiles, known: plan.scope.knownFiles, verified: verifiedFiles,
      totalKnown: plan.scope.totalFiles !== null, source: plan.scope.selector } };
}

// A single derived view for UI, trace, and analytics: never a mutable registry.
export function reviewProgressSnapshot(coverage, { batches = 0, maxBatches = MAX_BATCHES_PER_RUN } = {}) {
  return { batches, maxBatches, units: coverage.units, criteria: coverage.criteria,
    files: coverage.files, scope: coverage.scope, complete: coverage.complete,
    gapCodes: coverage.gapCodes };
}
