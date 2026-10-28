// Host/provider-neutral adjudication. Scope limits remediation, never discovery.
// Model-provided origins are evidence claims, not authority to expand permissions.
import { findingIdentity } from './quality-state.mjs';

const issueEvidence = issue => typeof issue?.evidence === 'string' && issue.evidence.trim().length >= 24;
const outside = issue => issue && ['pre_existing','preexisting'].includes(issue.origin) &&
  issue.remediationScope === 'outside_scope' &&
  ['dependency','independent'].includes(issue.taskRelation) && issueEvidence(issue);
const inside = issue => issue && (issue.remediationScope === 'in_scope' ||
  issue.origin === 'introduced' || issue.taskRelation === 'requirement') && issueEvidence(issue);

export function classifyFixFinding(issue, { verificationDisposition = 'UNVERIFIED' } = {}) {
  const classification = issue?.remediationScope === 'outside_scope' && (issue.origin === 'introduced' || issue.taskRelation === 'requirement')
    ? 'insufficient_evidence' : outside(issue) ? 'pre_existing_out_of_scope' :
    inside(issue) ? (issue?.origin === 'introduced' ? 'introduced_by_current_change' :
      issue?.taskRelation === 'requirement' ? 'test_coverage_gap' : 'pre_existing_in_scope') :
    'insufficient_evidence';
  const reason = classification === 'pre_existing_out_of_scope' ? 'independent_out_of_scope_defect' :
    classification === 'insufficient_evidence' ? 'unproven_scope_or_origin' : 'within_authorized_task';
  const actionable = !['pre_existing_out_of_scope','insufficient_evidence'].includes(classification);
  return { issue, findingId: findingIdentity(issue), classification, reason,
    fixAuthorized: actionable, actionable,
    blocksTask: actionable || (verificationDisposition === 'CODE_FAILURE' &&
      classification !== 'pre_existing_out_of_scope'),
    needsTests: classification === 'test_coverage_gap' || classification === 'introduced_by_current_change' };
}

// A validator's verdict is reusable only for a truly unchanged checkout;
// the caller must additionally guarantee that review and verification inputs
// remain unchanged (the no-op path has no new verification attempt).
export function shouldReuseNoopValidation({ previousValidation, beforeRepoKey, afterRepoKey }) {
  return Boolean(previousValidation && typeof beforeRepoKey === 'string' && beforeRepoKey.length > 0 &&
    beforeRepoKey === afterRepoKey);
}

export function assessFixDecision({ review, finalValidation, verificationDisposition }) {
  const codeFailure = verificationDisposition === 'CODE_FAILURE';
  const reviewIssues = Array.isArray(review?.issues) ? review.issues : [];
  const validatorIssues = Array.isArray(finalValidation?.issues) ? finalValidation.issues : [];
  const requested = review?.verdict === 'fix' || finalValidation?.verdict === 'fix' || codeFailure;
  if (!requested) return { action: 'none', reason: 'no_fix_requested', findings: [] };

  // Identical cross-role evidence must not create extra corrective work.
  // Never collapse different reproduction keys even when wording is similar.
  const unique = new Map(), conflicts = new Set();
  for (const issue of [...reviewIssues, ...validatorIssues]) {
    const id = findingIdentity(issue);
    const previous = unique.get(id);
    if (previous) {
      if (classifyFixFinding(previous).classification !== classifyFixFinding(issue).classification)
        conflicts.add(id); // do not accept conflicting origin claims as proof of a fix permission
      if (!issueEvidence(previous) && issueEvidence(issue)) unique.set(id, issue);
    } else unique.set(id, issue);
  }
  const findings = [...unique.values()];
  const classifications = findings.map(issue => conflicts.has(findingIdentity(issue))
    ? { ...classifyFixFinding(issue, { verificationDisposition }),
      classification:'insufficient_evidence',reason:'conflicting_origin_or_scope',actionable:false,
      fixAuthorized:false,blocksTask:codeFailure,needsTests:false }
    : classifyFixFinding(issue, { verificationDisposition }));
  const actionable = classifications.filter(row => row.actionable);
  const uncertain = classifications.filter(row => row.classification === 'insufficient_evidence');
  const outOfScope = classifications.filter(row => row.classification === 'pre_existing_out_of_scope');
  const shared = { findings, classifiedFindings: classifications,
    actionableFindings: actionable.map(row => row.issue), outOfScopeFindings: outOfScope.map(row => row.issue) };

  // An independent PASS does not erase evidenced reviewer observations;
  // disagreement still needs an explicit disposition, not an unbounded loop.
  if (finalValidation?.verdict === 'pass' && review?.verdict === 'fix' && !codeFailure) {
    if (!findings.length || !findings.some(issueEvidence)) return {
      action: 'none', reason: 'review_disagreement_resolved', findings: [] };
    if (!actionable.length && !uncertain.length) return { ...shared, action: 'report_only', reason: 'confirmed_out_of_scope_defect' };
    if (!actionable.length) return { ...shared, action: 'approval_required', reason: 'unresolved_evidenced_review_disagreement' };
  }
  if (actionable.length) return { ...shared, action: 'fix',
    reason: codeFailure ? 'verification_code_failure' : 'actionable_review_or_validation',
    // The fixer must never be instructed to repair independent external findings.
    findings: actionable.map(row => row.issue) };

  // A failing test can prove the task incomplete even if all visible findings
  // concern other behavior. Do not claim PASS; preserve the evidence and ask.
  if (codeFailure) return { ...shared, action: 'approval_required', reason: 'unresolved_failing_verification' };
  if (uncertain.length || !findings.length || finalValidation?.assessment?.taskCompliance === 'unknown')
    return { ...shared, action: 'approval_required', reason: 'scope_or_origin_unconfirmed' };
  return { ...shared, action: 'report_only', reason: 'confirmed_out_of_scope_defect' };
}

const summarizeIssue = (issue) => `- **${issue.severity ?? 'unknown'}**${issue.path ? ` — \`${issue.path}\`` : ''}: ${issue.message ?? 'Undescribed issue'}${issue.evidence ? ` Evidence: ${issue.evidence}` : ''}${issue.suggestedFix ? ` Proposed remediation: ${issue.suggestedFix}` : ''}`;

export function fixInterruptionReport({ status, decision, review, finalValidation, implementation, verificationDisposition, changedPaths, verification, implementationCoverage, acceptanceCoverage }) {
  const reason = {
    approval_required: 'A defect or uncertain finding needs a decision before changing the authorized scope.',
    report_only: 'Confirmed findings outside the authorized change scope were preserved without editing unrelated code.',
    no_change_conflict: 'The coder made no further changes, and the independent validator still requires an in-scope fix.',
    fix_round_limit: 'The configured limit of corrective rounds was reached.',
  }[decision.action] ?? 'The change cannot be marked as successfully verified.';
  const lines = [
    `## ${status === 'completed_with_findings' ? 'Changes preserved with findings' : 'Implementation requires attention'}`,
    '', reason,
    '', `**Verification:** ${verificationDisposition}.`,
    `**Reviewer:** ${review?.verdict ?? 'unknown'}. **Final validator:** ${finalValidation?.verdict ?? 'not run'}.`,
    ...(implementationCoverage ? [`**Implementation stages:** ${implementationCoverage.completedStages?.length ?? 0}/${implementationCoverage.totalStages ?? '?'} recorded.`] : []),
    ...(acceptanceCoverage ? [`**Acceptance criteria:** ${acceptanceCoverage.results?.filter((item) => item.status === 'verified').length ?? 0}/${acceptanceCoverage.results?.length ?? '?'} independently verified.`] : []),
    ...(decision.action === 'no_change_conflict' && implementation?.summary ? [`**Coder:** ${implementation.summary}`] : []),
    '', '### Reported defects or unresolved findings',
    ...(decision.findings?.length ? decision.findings.map(summarizeIssue) : ['- The fix requirement remains unresolved; no issue was discarded.']),
    ...(decision.outOfScopeFindings?.length && decision.action !== 'report_only' ?
      ['', '### Non-blocking out-of-scope findings (not authorized for repair)',
        ...decision.outOfScopeFindings.map(summarizeIssue)] : []),
  ];
  if (verification?.length) {
    lines.push('', '### Checks', ...verification.map((entry) => `- ${entry.command}: ${entry.status ?? 'UNVERIFIED'}`));
  }
  lines.push('', '### Changed files', ...(changedPaths.length ? changedPaths.map((path) => `- \`${path}\``) : ['- None observed']),
    '', 'Existing workspace changes were preserved. No additional fix will be attempted automatically. This is not a claim that all tests pass or that the code is ready to merge.');
  return lines.join('\n');
}
