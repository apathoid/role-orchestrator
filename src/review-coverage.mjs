// A bounded, deterministic completion contract for read-only reviews. The
// user's explicit checklist outranks any planner-generated paraphrase.
export const REVIEW_BATCH_SIZE = 8;
export const MAX_REVIEW_BATCHES = 4;
const MAX_CHECKS = REVIEW_BATCH_SIZE * MAX_REVIEW_BATCHES;

// Group related acceptance criteria with the work that can prove them. This
// changes scheduling only: every criterion keeps its own ID and must receive
// independent evidence. Unknown relationships are never treated as proof.
const GENERIC_TERMS = new Set(['review', 'check', 'checks', 'inspect', 'verify', 'verified', 'validation', 'test', 'tests', 'code', 'files', 'file', 'changes', 'changed', 'scope', 'scenario', 'scenarios', 'ensure', 'confirm', 'acceptance', 'criterion', 'criteria', 'behavior', 'behaviour', 'проверить', 'проверка', 'проверки', 'файлов', 'файлы', 'изменения', 'изменений', 'критерий', 'сценарий', 'сценарии', 'должен', 'должны']);
function subjectWords(description) {
  return new Set(String(description).toLowerCase().match(/[\p{L}\d_]{4,}/gu)?.filter((word) => !GENERIC_TERMS.has(word)) ?? []);
}
function topicScore(left, right) {
  const a = subjectWords(left), b = subjectWords(right);
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return common >= 2 ? common / Math.max(a.size, b.size, 1) : 0;
}
export function groupReviewChecks(checks) {
  const steps = checks.filter((item) => item.id.startsWith('S'));
  const criteria = checks.filter((item) => !item.id.startsWith('S'));
  const units = steps.map((step) => [step]);
  for (const criterion of criteria) {
    let bestUnit = -1, bestScore = 0;
    for (const [i, unit] of units.entries()) {
      const score = Math.max(0, ...unit.map((item) => topicScore(item.description, criterion.description)));
      if (score > bestScore) { bestUnit = i; bestScore = score; }
    }
    if (bestUnit >= 0) units[bestUnit].push(criterion);
    else units.push([criterion]);
  }
  const groups = [];
  for (const unit of units) {
    for (const item of unit) {
      if (!groups.length || groups.at(-1).length === REVIEW_BATCH_SIZE) groups.push([]);
      groups.at(-1).push(item);
    }
  }
  return groups;
}

// Bounded, evidence-only handoff. This is context, not independently verified
// proof: reviewers may challenge an earlier finding, but must state why.
export function priorReviewHandoff(records, reports, { maxChars = 14000 } = {}) {
  if (!reports.length) return '(first batch; no prior review results)';
  const compact = {
    completedBatches: reports.length,
    coverage: records.map((row) => ({ id: row.id, status: row.status, evidence: String(row.evidence ?? '').slice(0, 320) })),
    findings: reports.flatMap((report, i) => (report?.outputFormat === 'structured' ? report.output?.issues ?? [] : [])
      .map((issue) => ({ batch: i + 1, severity: issue.severity, path: issue.path, message: issue.message, suggestedFix: issue.suggestedFix }))),
    summaries: reports.map((report, i) => ({ batch: i + 1, verdict: report?.output?.verdict ?? 'unknown', summary: String(report?.output?.summary ?? '').slice(0, 450) })),
    inventories: reports.map((report, i) => ({ batch: i + 1, ...(report?.output?.inventory ?? {}) })),
  };
  const serialized = JSON.stringify(compact);
  if (serialized.length <= maxChars) return serialized;
  // Never represent truncated evidence as complete; the full records remain in
  // the orchestration ledger and are used for the final coverage decision.
  const fallback = {
    completedBatches: reports.length,
    summaries: compact.summaries.slice(-4),
    priorIds: records.map((row) => ({ id: row.id, status: row.status })),
    findings: compact.findings.slice(-12).map((entry) => ({ batch: entry.batch,
      severity: entry.severity, path: String(entry.path ?? '').slice(0, 160),
      message: String(entry.message ?? '').slice(0, 320) })),
    evidenceTruncated: true,
  };
  while (JSON.stringify(fallback).length > maxChars && fallback.findings.length) fallback.findings.shift();
  while (JSON.stringify(fallback).length > maxChars && fallback.summaries.length) fallback.summaries.shift();
  return JSON.stringify(fallback);
}

export function buildReviewContract(_task, plan, { requirements = {} } = {}) {
  // User-provided semantics arrive exclusively from the validated Router task.
  // A planner may fill missing requirements, but cannot erase user checks.
  const explicit = (requirements.reviewChecks ?? []).map((item,index,array)=>({
    id:`${item.kind === 'step' ? 'S' : 'A'}${array.slice(0,index+1).filter(x=>x.kind===item.kind).length}`,
    description:item.description,source:'user',
  }));
  const generated = explicit.length ? [] : [
    ...(Array.isArray(plan?.steps) ? plan.steps : []).map((description,index)=>({id:`S${index+1}`,description,source:'plan'})),
    ...(Array.isArray(plan?.acceptanceCriteria) ? plan.acceptanceCriteria : []).map((description,index)=>({id:`A${index+1}`,description,source:'plan'})),
  ].filter(item=>typeof item.description==='string'&&item.description.trim());
  const all=explicit.length ? explicit : generated;
  return {source:explicit.length ? 'user' : 'planner',checks:all.slice(0,MAX_CHECKS),
    omitted:all.slice(MAX_CHECKS),expectedFileCount:requirements.expectedFileCount??null,
    batches:groupReviewChecks(all.slice(0,MAX_CHECKS))};
}

export function assessReviewBatch(expected, result) {
  const issues = [];
  const records = [];
  const rows = result?.outputFormat === 'structured' && Array.isArray(result.output?.coverage)
    ? result.output.coverage : [];
  if (!rows.length) issues.push('Reviewer did not return a structured coverage ledger.');
  const expectedIds = new Set(expected.map((check) => check.id));
  const seen = new Set();
  for (const row of rows) {
    if (!expectedIds.has(row?.id)) {
      issues.push(`Unexpected coverage ID: ${String(row?.id ?? '(missing)')}`);
      continue;
    }
    if (seen.has(row.id)) {
      issues.push(`Duplicate coverage ID: ${row.id}`);
      continue;
    }
    seen.add(row.id);
    const checked = row.status === 'checked' && typeof row.evidence === 'string' && row.evidence.trim().length >= 16;
    records.push({ id: row.id, status: checked ? 'checked' : row.status === 'blocked' ? 'blocked' : 'not_checked', evidence: row.evidence ?? '' });
    if (!checked) issues.push(`${row.id}: ${row.status === 'checked' ? 'missing concrete evidence' : row.status ?? 'not checked'}`);
  }
  for (const check of expected) if (!seen.has(check.id)) {
    records.push({ id: check.id, status: 'not_checked', evidence: '' });
    issues.push(`${check.id}: missing from reviewer report`);
  }
  return { records, issues };
}

export function assessReviewInventory(expectedFileCount, reports) {
  if (expectedFileCount === null) return [];
  // Final reviewer must reconcile the CUMULATIVE distinct-file inventory.
  // Earlier claims alone cannot certify the combined result, and summing
  // individual counts would double-count files shared between batches.
  const last = reports.at(-1);
  const inv = last?.outputFormat === 'structured' ? last.output?.inventory : null;
  if (inv?.changedFiles === expectedFileCount && inv.reviewedFiles === expectedFileCount && inv.source?.trim()) return [];
  return [`Final inventory not confirmed (${expectedFileCount} requested; changed=${inv?.changedFiles ?? 'unknown'}, reviewed=${inv?.reviewedFiles ?? 'unknown'}).`];
}

export function reviewCoverageSummary(contract, records, issues) {
  const items = new Map(records.map((row) => [row.id, row]));
  const missing = [...contract.checks, ...contract.omitted].filter((item) => items.get(item.id)?.status !== 'checked');
  return {
    complete: missing.length === 0 && issues.length === 0,
    source: contract.source,
    expectedFileCount: contract.expectedFileCount,
    checked: contract.checks.length - contract.checks.filter((item) => items.get(item.id)?.status !== 'checked').length,
    total: contract.checks.length + contract.omitted.length,
    entries: [...contract.checks, ...contract.omitted].map((item) => ({ ...item, ...(items.get(item.id) ?? { status: 'not_checked', evidence: '' }) })),
    gaps: [...missing.map((item) => `${item.id}: ${item.description}`), ...issues],
    truncated: contract.omitted.length > 0,
  };
}
