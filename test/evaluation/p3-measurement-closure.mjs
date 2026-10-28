import assert from 'node:assert/strict';
import { summarizeExecutionOutcome, normalizeExecutionOutcome, executionGroupId } from '../../src/efficiency/outcome.mjs';
import { createEfficiencyRun, efficiencyView } from '../../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../../src/session-store.mjs';
import { contextPart,trackedBody,unpackTrackedBody,profileTaskBody } from '../../src/efficiency/profiling.mjs';

const earlyFailedReview = summarizeExecutionOutcome({status:'review_incomplete',
  review:{verdict:'pass'},reviewCoverage:{checked:0,total:4,complete:false}});
assert.equal(earlyFailedReview.reviewVerdict,'unknown');
const outcome=summarizeExecutionOutcome({status:'review_incomplete',review:{verdict:'fix',issues:[{message:'LEAK_SECRET'}]},
  reviewCoverage:{checked:4,total:6,complete:false,gaps:['LEAK_SECRET']},verification:[{status:'PASS'},{status:'TOOL_UNAVAILABLE'}],route:{policy:{mode:'review'}},
  responseText:'LEAK_SECRET',implementationCoverage:{completedStages:['I1'],totalStages:3,complete:false},
  qualityAssessment:{results:[{state:'verified'},{state:'stale'}]}});
assert.equal(outcome.category,'incomplete');assert.equal(outcome.reviewFindings,1);
assert.equal(outcome.reviewChecked,4);assert.equal(outcome.reviewTotal,6);
assert.equal(outcome.verificationChecks,2);assert.equal(outcome.verificationPassed,1);
assert.equal(outcome.verificationUnavailable,1);assert.equal(outcome.completedStages,1);
assert.equal(outcome.qualityVerified,1);assert(!JSON.stringify(outcome).includes('LEAK_SECRET'));
assert.equal(normalizeExecutionOutcome({...outcome,raw:'LEAK_SECRET'}).raw,undefined);
assert.equal(executionGroupId({runId:'run1',taskId:null}),'run:run1');
assert.equal(executionGroupId({runId:'run2',taskId:'task1'}),'task:task1');
const body=trackedBody`Alpha ${contextPart('review','SAME')} Beta ${contextPart('review','SAME')} Gamma ${contextPart('verification','TEST')}`;
const measured=unpackTrackedBody(body);
assert.equal(measured.text,'Alpha SAME Beta SAME Gamma TEST');
const source=profileTaskBody(measured.text,measured.sources);
assert.equal(source.sections.find(p=>p.kind==='review').characters,8);
const r=createEfficiencyRun('test-closure');
r.onEvent({type:'role_start',invocationId:'a',role:'reviewerMedium'});
r.onEvent({type:'role_done',invocationId:'a'});
const result=r.finish({status:'review_incomplete',result:{status:'review_incomplete',review:{verdict:'fix',issues:[{}]},reviewCoverage:{checked:4,total:6,complete:false}},taskId:null});
const persisted=normalizeEfficiencyRuns([result]);
assert.equal(persisted[0].outcome.reviewChecked,4);
assert.equal(persisted[0].executionGroupId,'run:test-closure');
const summary=efficiencyView({efficiencyRuns:persisted});
assert.equal(summary.outcomes[0].category,'incomplete');
assert.equal(summary.executionGroups[0].runs,1);
const result2=createEfficiencyRun('test-closure-2').finish({status:'review_passed',taskId:'saved123'});
const result3=createEfficiencyRun('test-closure-3').finish({status:'applied',taskId:'saved123'});
const grouped=efficiencyView({efficiencyRuns:normalizeEfficiencyRuns([result,result2,result3])});
assert.equal(grouped.executionGroups.find(g=>g.groupId==='task:saved123').runs,2);
assert(!JSON.stringify(persisted).includes('LEAK_SECRET'));
const hostile=normalizeEfficiencyRuns([{...result,taskId:'LEAK_SECRET\n',executionGroupId:'task:LEAK_SECRET\n',outcome:{...outcome,secret:'LEAK_SECRET'}}]);
assert.equal(hostile[0].taskId,null);
assert.equal(hostile[0].executionGroupId,'run:test-closure');
assert(!JSON.stringify(hostile).includes('LEAK_SECRET'));
console.log('evaluation/p3-measurement-closure: PASS');
