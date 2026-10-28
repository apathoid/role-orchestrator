import assert from 'node:assert/strict';
import { assessFixDecision, fixInterruptionReport, shouldReuseNoopValidation } from '../src/fix-decision.mjs';

assert.equal(shouldReuseNoopValidation({previousValidation:{verdict:'fix'},beforeRepoKey:'a',afterRepoKey:'a'}),true);
assert.equal(shouldReuseNoopValidation({previousValidation:{verdict:'fix'},beforeRepoKey:'a',afterRepoKey:'b'}),false);
assert.equal(shouldReuseNoopValidation({previousValidation:null,beforeRepoKey:'a',afterRepoKey:'a'}),false);
const issue = {
  severity: 'major', path: 'component.tsx', message: 'The existing selection callback is stale.',
  origin: 'preexisting', taskRelation: 'dependency', remediationScope: 'outside_scope',
  evidence: 'Existing committed handler reproduces a stale selection callback after reset.',
};
const validator = { verdict: 'fix', summary: 'Regression found', issues: [issue],
  assessment: { correctness: 'defect_confirmed', taskCompliance: 'verified', fixAuthorization: 'requires_approval' } };
const review = { verdict: 'pass', issues: [], summary: 'The new regression tests satisfy the task.' };
const assess = (finalValidation = validator, verificationDisposition = 'PASS', reviewer = review) =>
  assessFixDecision({ review: reviewer, finalValidation, verificationDisposition });
assert.equal(assess().action, 'report_only');
assert.equal(assess(validator, 'CODE_FAILURE').action, 'approval_required');
assert.equal(assess({ ...validator, issues: [{ ...issue, severity: 'blocking' }] }).action, 'report_only'); // severity alone cannot expand authorized scope
assert.equal(assess({ ...validator, issues: [{ ...issue, origin: 'unknown' }] }).action, 'approval_required');
assert.equal(assess({ ...validator, issues: [{ ...issue, evidence: 'guess' }] }).action, 'approval_required');
assert.equal(assess({ ...validator, issues: [{ ...issue, remediationScope: 'unknown' }] }).action, 'approval_required');
assert.equal(assess({ ...validator, issues: [issue, { ...issue, origin: 'introduced' }] }).action, 'approval_required'); // contradictory origin for same defect
assert.equal(assess({ ...validator, assessment: undefined }).action, 'report_only');
assert.equal(assess({ ...validator, assessment: { ...validator.assessment, taskCompliance: 'unknown' } }).action, 'approval_required');
assert.equal(assess(validator, 'PASS', { verdict: 'fix', issues: [issue] }).action, 'report_only');
assert.equal(assess({ verdict: 'pass', issues: [] }, 'CODE_FAILURE').action, 'approval_required'); // no evidence attributes a failure to authorized changes
assert.equal(assess({ verdict: 'pass', issues: [] }, 'PASS', { verdict: 'fix', issues: [issue] }).action, 'report_only');
assert.equal(assess({ verdict: 'pass', issues: [] }, 'PASS', { verdict: 'fix', issues: [{ severity:'major', message:'Unsubstantiated', path:null, suggestedFix:null }] }).action, 'none');
assert.equal(assess({ verdict: 'pass', issues: [] }).action, 'none');
const output = fixInterruptionReport({ status: 'needs_user_decision', decision: assess(validator, 'CODE_FAILURE'), review,
  finalValidation: validator, verificationDisposition: 'CODE_FAILURE', changedPaths: ['data-grid.test.tsx'],
  verification: [{ command: 'vitest data-grid', status: 'TEST_FAILED' }] });
assert.match(output, /selection callback is stale/);
assert.match(output, /TEST_FAILED/);
assert.match(output, /not a claim that all tests pass/i);
assert.doesNotMatch(output, /"verdict":/);
console.log('fix-decision: passed');
