// Review-only, deterministic evidence selection. The authoritative record is the
// validated v3 review checkpoint. A compact handoff is a navigation hint, never
// an authorization or completion signal.
import { createHash } from 'node:crypto';
import { reconcileReviewFindings } from './review-findings.mjs';
import { findingHypothesisGroups } from './evidence/findings.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const safeText = (v, limit) => typeof v === 'string' ? v.slice(0, limit) : '';

export function reviewBatchEvidenceHandoff(units, plan, records = [], reports = [], { maxChars = 3500 } = {}) {
  if (!Array.isArray(units) || !Array.isArray(plan?.units) || !Array.isArray(records) || !Array.isArray(reports))
    throw new Error('Invalid review evidence handoff');
  if (!Number.isSafeInteger(maxChars) || maxChars < 400 || maxChars > 20000) throw new Error('Invalid handoff limit');
  const targetIds = new Set(units.map(unit => unit.id));
  const targetPaths = new Set(units.flatMap(unit => unit.paths ?? []));
  const required = new Set(units.flatMap(unit => [...(unit.dependencies ?? []), ...(unit.relatedUnits ?? [])]));
  const relevant = records.filter(row => row.status === 'checked' && (required.has(row.id) ||
    (row.reviewedPaths ?? []).some(path => targetPaths.has(path))));
  const unrelated = records.filter(row => row.status === 'checked' && !relevant.includes(row));
  const observations = reports.flatMap(report => (report.output?.issues ?? [])
    .map(issue => ({ ...issue, batchId: report.batchId, unitIds: report.unitIds })));
  const all = reconcileReviewFindings(observations);
  const hypotheses = findingHypothesisGroups(observations);
  const findings = all.ledger.map(row => ({
    id:row.findingId, path:row.issue.path ?? null,
    contractId:row.issue.contractId ?? null, reproductionKey:row.issue.reproductionKey ?? null,
    failureMode:safeText(row.issue.failureMode,120),
    message:safeText(row.issue.message,170), evidenceLevel:'model_reported',
  }));
  const nearFindings = findings.filter(row => targetPaths.has(row.path));
  const elsewhereFindings = findings.filter(row => !targetPaths.has(row.path));
  const payload = {
    completedUnitIds: records.filter(row => row.status === 'checked').map(row => row.id),
    relevantEvidence: relevant.slice(-12).map(row => ({ id:row.id,
      paths:(row.reviewedPaths ?? []).slice(0,12),
      evidence:safeText(row.evidence,240), provenance:'model_reported' })),
    relatedFindings:nearFindings.slice(-12),
    otherKnownFindings:elsewhereFindings.slice(-6),
    relatedFindingHypotheses:hypotheses.slice(0,5).map(group=>({ids:group.findingIds.slice(0,8),
      status:'potential_duplicate_unverified',reasons:group.reasons.slice(0,3)})),
    omittedRelatedEvidence:Math.max(0,relevant.length - 12),
    omittedFindings:Math.max(0,nearFindings.length-12)+Math.max(0,elsewhereFindings.length-6),
    omittedUnrelatedEvidence:unrelated.length,
    note:'These are unverified previous role reports, not proof. Re-open source when independence or new evidence is required. Do not redo completed Units.',
  };
  let serialized = JSON.stringify(payload);
  // Large metadata is not permission to silently truncate required scope.
  while (serialized.length > maxChars && payload.relatedFindingHypotheses.length) {
    payload.relatedFindingHypotheses.pop(); serialized=JSON.stringify(payload);
  }
  while (serialized.length > maxChars && payload.otherKnownFindings.length) {
    payload.otherKnownFindings.shift(); payload.omittedFindings++;
    serialized = JSON.stringify(payload);
  }
  while (serialized.length > maxChars && payload.relatedFindings.length) {
    payload.relatedFindings.shift(); payload.omittedFindings++;
    serialized = JSON.stringify(payload);
  }
  while (serialized.length > maxChars && payload.relevantEvidence.length) {
    payload.relevantEvidence.shift(); payload.omittedRelatedEvidence++;
    serialized = JSON.stringify(payload);
  }
  if (serialized.length > maxChars) serialized = JSON.stringify({
    completedUnitCount: payload.completedUnitIds.length, detailsOmitted:true,
    provenance:'model_reported', note:'See authoritative checkpoint and inspect source; no conclusion was silently marked checked.' });
  return { text:serialized, relevantEvidence: relevant.length,
    unrelatedEvidenceOmitted:unrelated.length, uniqueFindings:all.unique,
    savedCharacters:Math.max(0,JSON.stringify({records,reports}).length - serialized.length) };
}

// A successful configured test can be reused only within the exact review
// source/scope and operator-approved command. A provider/model claim cannot
// populate this cache; only the execution adapter returns an observation.
export function reusableReviewVerification(observations, { sourceKey, command, approvedCommands = [], inputDigest = null } = {}) {
  if (typeof sourceKey !== 'string' || !sourceKey || typeof command !== 'string' ||
      !approvedCommands.includes(command) || !Array.isArray(observations) ||
      typeof inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(inputDigest)) return null;
  const commandDigest = sha(command);
  return observations.find(item => item?.kind === 'tool_result' && item.level === 'tool_observed' &&
    item.sourceKey === sourceKey && item.commandDigest === commandDigest && item.status === 'PASS' &&
    item.passed === true && item.exitCode === 0 && item.origin === 'review_verification_executor' &&
    item.inputDigest === inputDigest) ?? null;
}

export function validatedReviewObservations(observations, sourceKey) {
  if (!Array.isArray(observations)) return [];
  return observations.filter(item => item?.kind === 'tool_result' && item.level === 'tool_observed' &&
    item.sourceKey === sourceKey && typeof item.commandDigest === 'string' && /^[a-f0-9]{64}$/.test(item.commandDigest) &&
    item.origin === 'review_verification_executor' && item.status === 'PASS' && item.exitCode === 0 && item.passed === true &&
    typeof item.inputDigest === 'string' && /^[a-f0-9]{64}$/.test(item.inputDigest))
    .slice(-32).map(item => ({kind:item.kind,level:item.level,sourceKey:item.sourceKey,
      commandDigest:item.commandDigest,origin:item.origin, status:item.status,exitCode:item.exitCode,
      passed:item.passed,inputDigest:item.inputDigest}));
}
