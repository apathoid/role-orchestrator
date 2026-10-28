// Review execution strategy is distinct from the immutable coverage contract.
// Selection is deterministic, host/provider-neutral, and never authorizes writes.
import { createHash } from 'node:crypto';
import { reconcileReviewFindings } from './review-findings.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isPath = path => typeof path === 'string' && path.length <= 240 &&
  !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..') &&
  /^[\p{L}\d_.+@/-]+$/u.test(path);

// Only validated task requirements can exclude files; prose and skill content
// are never a second authority on review scope.
export function reviewExcludedPaths(requirements) {
  return [...new Set((requirements?.excludedPaths ?? []).filter(isPath))].sort();
}

export function applyUserReviewExclusions(scope, excluded) {
  if (!scope?.available || !excluded?.length) return scope;
  const match = path => excluded.some(value => value.includes('/') ? path === value : path.split('/').at(-1) === value);
  const omitted = scope.paths.filter(entry => [entry.path, entry.oldPath, ...(entry.oldPaths ?? [])].filter(Boolean).some(match));
  if (!omitted.length) return scope;
  const paths = scope.paths.filter(entry => !omitted.includes(entry));
  return { ...scope, paths, total: paths.length, excludedFiles: omitted.length,
    // The user's authorized review scope, not the raw repository inventory,
    // defines the checkpoint and completion identity.
    manifestKey: digest({ source: scope.manifestKey, excluded, paths }),
    changesets: scope.changesets?.map(change => ({ ...change,
      entries: change.entries.filter(entry => ![entry.path, entry.oldPath].filter(Boolean).some(match)) })) ?? scope.changesets };
}

export function chooseReviewStrategy({ scope, classification, requirements = {}, contract, workload, policy = {}, resume = false } = {}) {
  const available = scope?.available === true;
  const fileCount = available ? scope.paths.length : null;
  const risk = classification?.risk;
  const explicitDeep = policy.forceDeep === true || requirements.reviewDepth === 'deep' ||
    requirements.resourcePreference === 'thorough' || workload?.highRisk === true || risk === 'security_or_data';
  const strategy = resume && policy.persistedStrategy ? policy.persistedStrategy
    : explicitDeep || workload?.uncertain === true || !available || scope.status !== 'resolved' || fileCount > 36 ? 'deep'
      : requirements.reviewDepth === 'standard' ? 'standard'
      : fileCount <= 16 && risk !== 'architecture' && workload?.mediumRisk !== true ? 'focused' : 'standard';
  const maxUnitsPerBatch = policy.maxUnitsPerBatch ?? (strategy === 'focused' ? 8 : strategy === 'standard' ? 6 : 2);
  const maxFilesPerUnit = policy.maxFilesPerUnit ?? (strategy === 'focused' ? 8 : strategy === 'standard' ? 6 : 4);
  return { name: strategy, maxUnitsPerBatch, maxFilesPerUnit, coScheduleDependents: strategy !== 'deep',
    skipRedundantResponder: true, skipPlanning: strategy !== 'deep', skipExploration: strategy === 'focused',
    isBudgetEstimate: true };
}

// An advisory lower bound, not an authorization to mark units checked. Dependency
// ordering, provider failure and quality follow-ups may require more attempts.
export function reviewPlanFeasibility(plan, strategy, verifiedIds = [], budgetState = null) {
  const completed = new Set(verifiedIds);
  const pending = plan.units.filter(u => !completed.has(u.id)).length;
  const size = strategy.maxUnitsPerBatch;
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid review batch size');
  const lowerBound = Math.ceil(pending/size);
  const segmentMax = strategy.maxInvocations ?? null;
  const remainingSegment = segmentMax === null ? null : Math.max(0,segmentMax-(budgetState?.invocations??0));
  const hardMax = strategy.maxOperationInvocations ?? null;
  const remainingHard = hardMax === null ? null : Math.max(0,hardMax-(budgetState?.operationInvocations??0));
  return {obligations:pending,minInvocations:lowerBound,
    maxUnitsPerBatch:size,segmentRemainingInvocations:remainingSegment,
    operationRemainingInvocations:remainingHard,
    fitsCurrentSegment:remainingSegment === null ? null : lowerBound <= remainingSegment,
    hardLimitPotentiallyInsufficient:remainingHard !== null && lowerBound > remainingHard,
    exceedsOneRun:lowerBound > (remainingSegment ?? strategy.batchLimit ?? 8),
    continuationRequired:remainingSegment!==null && lowerBound>remainingSegment,
    estimate:true};
}

// Do not replay the previous full plan, findings, or free-form exploration
// when only a short scoped follow-up is required. If the source data exceeds
// the bound, label it incomplete and allow the reviewer to inspect the repo.
// This graph is a derived projection of the existing durable checkpoint, not
// another mutable authority. Every record remains MODEL-REPORTED, even if the
// evidence string looks concrete. The next reviewer may challenge and re-read.
export function deriveReviewEvidenceGraph(records, reports) {
  const obligations = (records ?? []).filter(row => row.status === 'checked').map(row => ({
    unitId: row.id, paths: (row.reviewedPaths ?? []).slice(0, 16),
    evidence: String(row.evidence ?? '').slice(0, 220),
    fileEvidence: (row.fileEvidence ?? []).slice(0, 16).map(file => ({
      path: file.path, evidence: String(file.evidence ?? '').slice(0, 140),
    })),
    level: 'model_reported',
  }));
  // Normalize already-identified findings before passing them to a new role.
  // This does not merge merely similar prose or different reproductions.
  const reconciled = reconcileReviewFindings((reports ?? []).flatMap(report => report.output?.issues ?? []));
  const knownFindings = reconciled.issues.map(issue => ({
    findingId:issue.findingId,
    path: issue.path ?? null, contractId: issue.contractId ?? null,
    reproductionKey: issue.reproductionKey ?? null, failureMode: issue.failureMode ?? null,
    affectedBehavior: issue.affectedBehavior ?? null,
    message: String(issue.message ?? '').slice(0, 160), level:'model_reported',
  }));
  return { obligations, knownFindings, completedCount: obligations.length,
    provenance: 'review_checkpoint_reported_not_tool_verified' };
}

// A bounded source-aware handoff. The full ledger remains durable and can be
// consulted by the orchestration engine; limited reviewer context is explicitly
// incomplete and never silently represents all prior evidence.
export function compactReviewEvidence(records, reports, { maxChars = 3200 } = {}) {
  const graph = deriveReviewEvidenceGraph(records, reports);
  const distinct = [...new Map(graph.knownFindings.map(row => [JSON.stringify(row), row])).values()];
  const compact = {
    completedUnitIds: graph.obligations.map(row => row.unitId),
    earlierEvidence: graph.obligations.slice(-8).map(row => ({
      id: row.unitId, evidence: row.evidence.slice(0, 160),
      paths: row.paths.slice(0, 8),
    })),
    knownFindingHypotheses: distinct.slice(-10),
    omittedEvidence: Math.max(0, graph.obligations.length - 8),
    omittedFindings: Math.max(0, distinct.length - 10),
    provenance: graph.provenance,
    note: 'Do not repeat known investigations without a new reason. Inspect source directly for unverified obligations.',
  };
  let text = JSON.stringify(compact);
  while (text.length > maxChars && compact.earlierEvidence.length) {
    compact.earlierEvidence.shift(); compact.omittedEvidence++;
    text = JSON.stringify(compact);
  }
  while (text.length > maxChars && compact.knownFindingHypotheses.length) {
    compact.knownFindingHypotheses.shift(); compact.omittedFindings++;
    text = JSON.stringify(compact);
  }
  if (text.length > maxChars) text = JSON.stringify({ completedCount: graph.completedCount,
    detailOmitted: true, provenance: graph.provenance });
  return text;
}
