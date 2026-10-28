import assert from 'node:assert/strict';
import { buildReviewContract, assessReviewBatch, assessReviewInventory, reviewCoverageSummary, groupReviewChecks, priorReviewHandoff } from '../src/review-coverage.mjs';

const originalPlan = `/review-code
### Steps
1. 1. Review aggregate develop...part31; commit 5b731f8d14 is only historical context.
2. 2. Inspect all 337 changed files.
3. 3. Check lifecycle and collisions.
### Acceptance criteria
- Full change inventory accounted for.
- No untested critical scenario may be called production-ready.
### Relevant files
- src/modeling/part.ts`;
const contract = buildReviewContract(originalPlan, { steps: ['Review one commit'], acceptanceCriteria: ['One commit reviewed'] },
  {requirements:{reviewChecks:[
    ...['Review aggregate develop...part31; commit 5b731f8d14 is only historical context.','Inspect all 337 changed files.','Check lifecycle and collisions.'].map(description=>({kind:'step',description})),
    ...['Full change inventory accounted for.','No untested critical scenario may be called production-ready.'].map(description=>({kind:'acceptance',description})),
  ],expectedFileCount:337}});
assert.equal(contract.source, 'user');
assert.deepEqual(contract.checks.map((item) => item.id), ['S1', 'S2', 'S3', 'A1', 'A2']);
assert.match(contract.checks[0].description, /aggregate/);
assert.equal(contract.expectedFileCount, 337);
assert.equal(buildReviewContract('Для part31 подтверждены 337 измененных файлов; охватить весь diff.', null).expectedFileCount, null);
assert.equal(buildReviewContract('Объём подтвержденного diff — 337 файлов, 7888 добавлений.', null, {requirements:{expectedFileCount:337}}).expectedFileCount, 337);
assert.equal(contract.batches.length, 1);

const filled = {
  outputFormat: 'structured',
  output: { coverage: contract.checks.map(({ id }) => ({ id, status: 'checked', evidence: 'Inspected the current git diff and src/modeling/part.ts:25.' })), inventory: { changedFiles: 337, reviewedFiles: 11, source: 'git diff' } },
};
const assessed = assessReviewBatch(contract.checks, filled);
assert.deepEqual(assessed.issues, []);
assert.match(assessReviewInventory(337, [filled])[0], /337 requested/);
const incomplete = reviewCoverageSummary(contract, assessed.records, assessReviewInventory(337, [filled]));
assert.equal(incomplete.complete, false);
assert.equal(incomplete.checked, 5);

const invalid = assessReviewBatch(contract.checks, { outputFormat: 'structured', output: { coverage: [
  { id: 'S1', status: 'checked', evidence: 'too short' },
  { id: 'S1', status: 'checked', evidence: 'duplicated evidence ignored' },
  { id: 'S100', status: 'checked', evidence: 'not in contract' },
] } });
assert.ok(invalid.issues.some((s) => s.includes('Duplicate coverage ID')));
assert.ok(invalid.issues.some((s) => s.includes('Unexpected coverage ID')));
assert.ok(invalid.issues.some((s) => s.includes('missing from reviewer report')));
assert.equal(invalid.records.find((row) => row.id === 'S1').status, 'not_checked');

const longTask = `### Steps\n${Array.from({ length: 45 }, (_, i) => `${i + 1}. Check scenario ${i + 1}`).join('\n')}`;
const large = buildReviewContract(longTask, null, {requirements:{reviewChecks:Array.from({length:45},(_,i)=>({kind:'step',description:`Check scenario ${i+1}`}))}});
assert.equal(large.batches.length, 4);
assert.deepEqual(large.batches.map((items) => items.length), [8, 8, 8, 8]);
assert.equal(large.omitted.length, 13);
const summarized = reviewCoverageSummary(large, large.checks.map(({ id }) => ({ id, status: 'checked', evidence: 'Validated using git show and code reading.' })), []);
assert.equal(summarized.complete, false);
assert.equal(summarized.total, 45);
assert.equal(summarized.truncated, true);

// Historical prose cannot silently become authoritative review obligations.
const referenced = buildReviewContract('Проведи ревью по предыдущему плану', {
  steps:['Only inspect greeting'],acceptanceCriteria:['Greeting is good'],
}, {referencedPlanText:originalPlan});
assert.equal(referenced.source,'planner');
assert.deepEqual(referenced.checks.map(item=>item.id),['S1','A1']);
assert.equal(referenced.expectedFileCount,null);
const unrelated = buildReviewContract('Review the current greeting', { steps: ['Inspect greeting'], acceptanceCriteria: ['Reviewed'] }, { referencedPlanText: originalPlan });
assert.equal(unrelated.source, 'planner', 'old session plans must not leak into unrelated tasks');

const fallback = buildReviewContract('Review current changes', { steps: ['Inspect changed code'], acceptanceCriteria: ['Report actual issues'] });
assert.equal(fallback.source, 'planner');
assert.deepEqual(fallback.checks.map((item) => item.id), ['S1', 'A1']);
assert.equal(fallback.expectedFileCount, null);
assert.deepEqual(assessReviewInventory(null, []), []);
const related = groupReviewChecks([
  ...Array.from({ length: 8 }, (_, i) => ({ id: `S${i + 1}`, description: i === 0 ? 'Inspect visual effects cleanup after model switch' : `Inspect independent subsystem ${i}` })),
  { id: 'A1', description: 'Verify visual effects cleanup after model switch' },
]);
assert.ok(related[0].some((item) => item.id === 'A1'), 'related acceptance criterion must travel with its associated step');
assert.equal(related.flat().length, 9, 'grouping must not drop or collapse acceptance criteria');
const handoff = priorReviewHandoff([{ id: 'S1', status: 'checked', evidence: 'Inspected src/modeling.ts:14 and compared git diff output.' }],
  [{ outputFormat: 'structured', output: { verdict: 'fix', summary: 'Found a race', issues: [
    { severity: 'major', path: 'src/modeling.ts', message: 'Async race', suggestedFix: 'Cancel stale dispatch' },
  ], inventory: { changedFiles: 9, reviewedFiles: 2, source: 'git diff' } } }]);
assert.match(handoff, /Async race/);
assert.match(handoff, /S1/);
console.log('review-coverage: passed');
