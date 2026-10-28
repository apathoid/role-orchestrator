import assert from 'node:assert/strict';
import { reconcileReviewFindings, renderReviewFindings } from '../src/review-findings.mjs';
import { reviewOperationCompatible, isReviewContinuationRequest, reviewScopeReconciliationRequest, reconcileReviewUnits } from '../src/review-continuity.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';
import { executionGroupId } from '../src/efficiency/outcome.mjs';

assert.equal(isReviewContinuationRequest({operation:'review',continuation:{mode:'current_review'}}),true);
assert.equal(isReviewContinuationRequest({operation:'review',continuation:{mode:'saved_review'}}),true);
assert.equal(isReviewContinuationRequest({operation:'change',continuation:{mode:'current_review'}}),false);
assert.equal(isReviewContinuationRequest('Продолжи ревью'),false);
assert.equal(reviewScopeReconciliationRequest('/review-reconcile merge-parent=2'), 2);
assert.equal(reviewScopeReconciliationRequest('/review-reconcile merge-parent=99'), null);

const baseIssue = { severity: 'major', path: 'src/a.ts', message: 'The checkout loses a directory update.',
  contractId: 'directory-switch', reproductionKey: 'stale-request', failureMode: 'stale-state',
  affectedBehavior: 'loadDirectories', evidence: 'A stale state is published into the reducer.' };
const observations = [
  { ...baseIssue, batchId: 'B1', unitIds: ['U1'] },
  { ...baseIssue, message: 'Late results replace the latest tree.', evidence: 'Second independent code read.', batchId: 'B2', unitIds: ['U2'] },
  { ...baseIssue, reproductionKey: 'trailing-slash', message: 'Trailing slash aborts the directory load.', batchId: 'B2' },
  { ...baseIssue, path: 'src/b.ts', batchId: 'B3' },
];
const ledger = reconcileReviewFindings(observations);
assert.equal(ledger.raw, 4);
assert.equal(ledger.unique, 3);
assert.equal(ledger.reconciledDuplicates, 1);
const repeated = ledger.ledger.find(row=>row.issue.path==='src/a.ts' && row.issue.reproductionKey==='stale-request');
assert.equal(repeated.occurrences.length,2);
assert.equal(repeated.evidence.length,2);
const report = renderReviewFindings(ledger.ledger);
assert.equal((report.match(/^- \*\*RF-[a-f\d]{16}/gm) ?? []).length, 3, 'each canonical record is displayed once');
assert.equal(reconcileReviewFindings([...observations].reverse()).ledger.find(i => i.issue.contractId === 'directory-switch' && i.issue.reproductionKey === 'stale-request' && i.issue.path === 'src/a.ts').findingId,
  repeated.findingId, 'stable IDs independent of batch order');
const unsafe = reconcileReviewFindings([
  { severity:'major', path:'src/a.ts', message:'one unrelated failure' },
  { severity:'major', path:'src/a.ts', message:'another unrelated failure' },
]);
assert.equal(unsafe.unique, 2, 'do not automatically merge by file name');
assert.equal(unsafe.potentialDuplicates,0,'same path alone must not imply duplication');

const unit = (id, path, change = 'A', deps = []) => ({ id, kind:'file-group', subsystem:'src', paths:[path], changes:[{status:change}], dependencies:deps });
const oldPlan = { units: [unit('F00001','src/a.ts'), unit('F00002','src/b.ts','A',['F00001']), {id:'CS1',kind:'criterion',paths:[],dependencies:['F00001','F00002']}] };
const nextPlan = { units: [unit('F00002','src/a.ts'), unit('F00003','src/b.ts','M',['F00002']), unit('F00004','src/c.ts'), {id:'CS1',kind:'criterion',paths:[],dependencies:['F00002','F00003','F00004']}] };
const old = { records: [
  {id:'F00001',status:'checked',evidence:'Inspected the concrete update to a.'},
  {id:'F00002',status:'checked',evidence:'Inspected the concrete update to b.'},
  {id:'CS1',status:'checked',evidence:'Verified the overall criterion.'},
],reports:[{batchId:'B1',unitIds:['F00001'], output:{issues:[]}},
  {batchId:'B2',unitIds:['F00002'],output:{issues:[]}},
  {batchId:'B3',unitIds:['CS1'],output:{issues:[]}}]};
const reuse = reconcileReviewUnits(oldPlan,nextPlan,old);
assert.deepEqual(reuse.records.map(r=>r.id), ['F00002']);
assert.equal(reuse.invalidated,2);
assert.equal(reuse.reports.length,1);

const emptyRisk = { ...old, reports: [...old.reports,
  { batchId: 'risk', kind: 'risk_follow_up', unitIds: [], output: { verdict: 'pass', issues: [], riskAssessments: [{ riskId: 'R1', outcome: 'resolved' }] } }] };
const riskAfterDrift = reconcileReviewUnits(oldPlan, nextPlan, emptyRisk);
assert.equal(riskAfterDrift.reports.some(r => r.batchId === 'risk'), false,
  'scope-wide risk follow-up cannot be reused without revision provenance');
const opId='11111111-2222-4333-8444-555555555555';
const cp={version:3,status:'in_progress',planKey:'digest',operation:{id:opId,repoRoot:'/repo',task:'Review NWOF-123',contract:{checks:[]},workPlan:{version:1,planKey:'digest',units:[{}]}}};
assert.equal(reviewOperationCompatible(cp,{repoRoot:'/repo'}),true);
assert.equal(reviewOperationCompatible(cp,{repoRoot:'/another'}),false);
assert.equal(reviewOperationCompatible({...cp,status:'finished'},{repoRoot:'/repo'}),false);
assert.equal(executionGroupId({runId:'run1',reviewOperationId:opId}),`review:${opId}`);
const metrics=createEfficiencyRun('run1');
metrics.onEvent({type:'review_operation_resumed',operationId:opId,reusedUnits:16});
metrics.onEvent({type:'review_report_validated',operationId:opId,reported:3,required:3});
metrics.onEvent({type:'review_progress',rawFindings:4,uniqueFindings:3,reconciledFindings:1,potentialDuplicates:1});
const finished=metrics.finish({status:'review_incomplete',result:{status:'review_incomplete',reviewOperationId:opId,
  reviewFindingsReport:{raw:4,unique:3,reconciledDuplicates:1,reported:3}}});
const persisted=normalizeEfficiencyRuns([finished])[0];
assert.equal(persisted.executionGroupId,`review:${opId}`);
assert.equal(persisted.reviewFindingsReported,3);
assert.equal(persisted.reviewFindingsReconciled,1);
assert.equal(persisted.outcome.reviewFindingsReported,3);
console.log('review-operation-continuity: PASS');
