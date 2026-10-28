import assert from 'node:assert/strict';
import { fakeReviewCoverage } from './fake-review-coverage.mjs';
import { assessReviewUnits } from '../src/review-work-plan.mjs';

const prompt = `TASK MODE: review (READ ONLY)\nREVIEW WORK BATCH 1 (limit 8 batches per run). Assigned UNITS:\nF00001: Inspect changed files\n  type=file-group\n  subsystem=src\n  criterionIds=S1\n  prerequisites=(none)\n  relatedUnits=(none)\n  requiredPaths=["src/alpha.ts","src/beta.ts"]\n  changes=[]\nC S1: invalid never selected\n\nReturn scopedReview JSON.`;
const valid = prompt.replace('C S1: invalid never selected', 'CS1: Review the behavior\n  type=criterion\n  subsystem=(criteria)\n  criterionIds=S1\n  prerequisites=F00001\n  relatedUnits=(none)\n  requiredPaths=[]\n  changes=[]');
const fixture = fakeReviewCoverage(valid);
assert(fixture);
assert.deepEqual(fixture.coverage.map(row => row.id), ['F00001', 'CS1']);
assert.deepEqual(fixture.coverage[0].reviewedPaths, ['src/alpha.ts','src/beta.ts']);
assert.deepEqual(fixture.coverage[0].fileEvidence.map(entry => entry.path), ['src/alpha.ts','src/beta.ts']);
assert.equal(fixture.inventory.reviewedFiles, 2);
const assignment = [
  { id: 'F00001', kind:'file-group', paths:['src/alpha.ts','src/beta.ts'] },
  { id: 'CS1', kind:'criterion', paths:[] },
];
assert.equal(assessReviewUnits(assignment, {outputFormat:'structured',output:fixture}).records.filter(row => row.status==='checked').length,2);
const missingEvidence=structuredClone(fixture);
missingEvidence.coverage[0].fileEvidence.pop();
assert.equal(assessReviewUnits(assignment, {outputFormat:'structured',output:missingEvidence}).records[0].status,'not_checked');
assert.deepEqual(fakeReviewCoverage('No scoped review assignment'),null);
assert.throws(() => fakeReviewCoverage(valid.replace('  requiredPaths=["src/alpha.ts","src/beta.ts"]\n','')),/missing requiredPaths/);
const quality=valid.replace('Return scopedReview JSON.', 'REVIEW RISK OBLIGATIONS (source-anchored questions, NOT known defects):\n[]\nReturn scopedReview JSON.');
assert.equal(fakeReviewCoverage(quality).coverage.length,2);
const legacy='CHECKLIST BATCH 1/1 (fixed, no implicit retries):\nS1: Inspect greeting\n\nReturn scopedReview JSON.';
assert.deepEqual(fakeReviewCoverage(legacy).coverage.map(row=>row.id),['S1']);
console.log('fake-review-coverage: PASS');
