import assert from 'node:assert/strict';
import { initialReviewRisks, newReviewQualityState, applyReviewRiskReport, risksForReviewBatch,
  assessReviewQuality, validateReviewQualityState } from '../src/review-quality.mjs';
import { makeReviewCheckpoint, validateReviewCheckpoint } from '../src/review-checkpoint.mjs';
import { reviewOperationCompatible } from '../src/review-continuity.mjs';
import { schemas, assertShape } from '../src/schemas.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';

const unit=(id,p)=>({id,kind:'file-group',paths:[p],changes:[{path:p}],subsystem:'src',dependencies:[],relatedUnits:[]});
const units=[unit('F00001','src/socket.ts'),unit('F00002','src/popup.ts')];
const plan={version:1,planKey:'plan',units,totalUnits:2,omittedUnits:[],scope:{deniedFiles:0,required:true,status:'resolved',totalFiles:2,knownFiles:2,selector:'uncommitted'}};
const workload={riskFlags:{concurrency:true,crossSubsystem:true,security:false}};
const state=newReviewQualityState(plan,workload,{});
assert.equal(state.risks.length,2);
assert.equal(state.risks[0].category,'async_consistency');
assert.equal(initialReviewRisks(plan,{riskFlags:{}},{}).length,0);
assert.equal(assessReviewQuality(state,{mode:'observe'}).status,'not_enforced');
assert.equal(assessReviewQuality(state,{mode:'enforce'}).status,'incomplete');
assert.equal(assessReviewQuality(state,{mode:'enforce'}).open,2);
assert.equal(risksForReviewBatch(state,[units[1]]).length,2,'material risks survive batch assignment boundaries');
assert.deepEqual(state.risks.map(r=>r.status),['open','open']);

const first={riskAssessments:[{riskId:state.risks[0].id,status:'investigated',outcome:'no_issue_supported',
  evidence:'Inspected dispatch sequencing; the socket callback is installed before the state update and cannot overwrite it.',
  sourceRefs:['src/socket.ts']}],issues:[]};
const premature=applyReviewRiskReport(state,first,{plan,assignedRisks:state.risks,unitIds:['F00001'],completedUnitIds:[]});
assert.equal(premature.state.risks[0].status,'open','file coverage required');
assert(premature.problems.length>0);
const resolvedFirst=applyReviewRiskReport(state,first,{plan,assignedRisks:state.risks,unitIds:['F00001'],completedUnitIds:['F00001']});
assert.equal(resolvedFirst.state.risks[0].status,'resolved');
assert.equal(resolvedFirst.state.risks[0].evidenceLevel,'model_reported');
assert.equal(assessReviewQuality(resolvedFirst.state,{mode:'enforce'}).open,1);
const second={riskAssessments:[{riskId:state.risks[1].id,status:'investigated',outcome:'issue_found',
  evidence:'Popup subscribes to state on mount, while the separate view never mounts without a selection.',
  sourceRefs:['src/popup.ts']}],issues:[]};
const missingIssue=applyReviewRiskReport(resolvedFirst.state,second,{plan,assignedRisks:resolvedFirst.state.risks,
  unitIds:['F00002'],completedUnitIds:['F00001','F00002']});
assert.equal(missingIssue.state.risks[1].status,'open','a claim of a defect requires a structured finding');
const supported=applyReviewRiskReport(resolvedFirst.state,{...second,issues:[{path:'src/popup.ts',message:'Popup cannot mount when no model is selected, leaving an empty window.'}]},{
  plan,assignedRisks:resolvedFirst.state.risks,unitIds:['F00002'],completedUnitIds:['F00001','F00002']});
assert.equal(supported.state.risks[1].status,'resolved');
assert.equal(assessReviewQuality(supported.state,{mode:'enforce'}).status,'satisfied');
const contradicted=applyReviewRiskReport(supported.state,{issues:[{path:'src/socket.ts',message:'A stale response can replace a newer socket connection after reconnect.'}],riskAssessments:[{
  riskId:supported.state.risks[0].id,status:'investigated',outcome:'issue_found',
  evidence:'A second reading found a stale completion event that could overwrite the active socket state.',
  sourceRefs:['src/socket.ts']}]},{plan,assignedRisks:[],unitIds:['F00002'],completedUnitIds:['F00001','F00002']});
assert.equal(contradicted.state.risks[0].status,'disputed');
assert.equal(assessReviewQuality(contradicted.state,{mode:'enforce'}).contradictions,1);
const unverifiedResolution=applyReviewRiskReport(contradicted.state,first,{plan,
  assignedRisks:contradicted.state.risks,unitIds:[],completedUnitIds:['F00001','F00002']});
assert.equal(unverifiedResolution.state.risks[0].status,'disputed','second opinion alone cannot overwrite an evidence conflict');

assert.equal(validateReviewQualityState({...supported.state,risks:[{...supported.state.risks[0],sourceRefs:['../secret']}]},plan),null);
assert.equal(validateReviewQualityState({...supported.state,risks:[{...supported.state.risks[0],evidenceLevel:'independently_verified'}]},plan),null);

const uncovered=applyReviewRiskReport(state,{issues:[],openQuestions:[{
  statement:'Does an alternate entry point skip the required auth check when the job resumes?',
  sourceRefs:['src/popup.ts','../../secrets'],relatedUnitIds:['F00002'],materiality:'high'
}]},{plan,assignedRisks:[],unitIds:['F00002'],completedUnitIds:['F00002']});
assert.equal(uncovered.state.risks.length,3);
assert.deepEqual(uncovered.state.risks[2].sourceRefs,['src/popup.ts'],'never persist forbidden anchors');
assert.equal(assessReviewQuality(uncovered.state,{mode:'enforce'}).open,3);
const noDuplicates=applyReviewRiskReport(uncovered.state,{issues:[],openQuestions:[{
  statement:'Does an alternate entry point skip the required auth check when the job resumes?',
  sourceRefs:['src/popup.ts'],relatedUnitIds:['F00002'],materiality:'high'
}]},{plan,assignedRisks:[],unitIds:['F00002']});
assert.equal(noDuplicates.state.risks.length,3);
const bad=applyReviewRiskReport(state,{riskAssessments:[{riskId:state.risks[0].id,status:'investigated',
  outcome:'no_issue_supported',evidence:'short',sourceRefs:['src/socket.ts']}]},{plan,assignedRisks:state.risks,unitIds:['F00001'],completedUnitIds:['F00001']});
assert.equal(bad.state.risks[0].status,'open');

assert.equal(schemas.scopedReview.properties.openQuestions.type,'array');
const reviewResult={verdict:'pass',summary:'No issues found',issues:[],coverage:[],inventory:{changedFiles:2,reviewedFiles:2,source:'git'},
  riskAssessments:first.riskAssessments,openQuestions:[]};
assert.equal(assertShape('scopedReview',reviewResult),reviewResult);
assert.throws(()=>assertShape('scopedReview',{...reviewResult,openQuestions:[{statement:'bad',sourceRefs:'array',materiality:'high',relatedUnitIds:[]}]}));

const sourceKey='git/source';
const operation={id:'11111111-2222-4333-8444-555555555555',repoRoot:'/repo',task:'Review source',
  workPlan:plan,contract:{checks:[]},reviewBudget:{invocations:1},qualityPolicy:{mode:'enforce',followUpPolicy:'material_only',maxAdditionalInvocations:1}};
const evidence='Inspected call graph and the exact contract behavior.';
const records=units.map(u=>({id:u.id,status:'checked',evidence,reviewedPaths:u.paths,
  fileEvidence:[{path:u.paths[0],evidence}]}));
const reports=[{batchId:'F00001_F00002_1',unitIds:units.map(u=>u.id),outputFormat:'structured',
  output:{verdict:'pass',summary:'Reviewed paths and lifecycle.',issues:[],coverage:[],inventory:{changedFiles:2,reviewedFiles:2,source:'git'}}}];
const cp=makeReviewCheckpoint({scopeKey:'scope',repoKey:sourceKey,plan,records,reports,operation,
  qualityState:uncovered.state,status:'in_progress'});
assert.equal(cp.version,4);
assert.equal(reviewOperationCompatible(cp,{repoRoot:'/repo'}),true);
const restored=validateReviewCheckpoint(cp,{scopeKey:'scope',repoKey:sourceKey,plan});
assert(restored?.qualityState);
assert.equal(restored.qualityState.risks.length,3);
assert.equal(validateReviewCheckpoint({...cp,qualityState:{...cp.qualityState,risks:cp.qualityState.risks.slice(1)}},
  {scopeKey:'scope',repoKey:sourceKey,plan}),null,'cannot delete a source-anchored structural risk');
assert.equal(validateReviewCheckpoint({...cp,qualityState:{...cp.qualityState,risks:cp.qualityState.risks.map(r=>({
  ...r,status:'resolved',outcome:'no_issue_supported',evidence:'I claim the risk was resolved without reviewer report.',evidenceLevel:'model_reported'}))}},
  {scopeKey:'scope',repoKey:sourceKey,plan}),null,'unwitnessed completion must be rejected');
assert.equal(validateReviewCheckpoint({...cp,qualityState:{...cp.qualityState,followUps:-1}},
  {scopeKey:'scope',repoKey:sourceKey,plan}),null);
assert.equal(validateReviewCheckpoint(cp,{scopeKey:'scope',repoKey:'changed',plan}),null);
const followUp=makeReviewCheckpoint({scopeKey:'scope',repoKey:sourceKey,plan,records,reports:[...reports,
  {batchId:'risk_follow_up_2',kind:'risk_follow_up',unitIds:[],outputFormat:'structured',
    output:{verdict:'pass',summary:'Investigated open risk',issues:[],riskAssessments:[],openQuestions:[]}}],
  operation,qualityState:{...uncovered.state,followUps:1},status:'in_progress'});
assert.equal(validateReviewCheckpoint(followUp,{scopeKey:'scope',repoKey:sourceKey,plan})?.reports.length,2);
const metrics=createEfficiencyRun('run-quality');
metrics.onEvent({type:'review_quality_assessed',total:3,assessed:1,open:2,contradictions:0,preserved:1,followUps:1,status:'incomplete'});
metrics.onEvent({type:'review_quality_evidence_rejected',count:2});
const out=normalizeEfficiencyRuns([metrics.finish({status:'review_incomplete'})])[0];
assert.equal(out.reviewMaterialRisksOpen,2);
assert.equal(out.reviewQualityGateDisposition,'incomplete');
assert.equal(out.reviewRiskEvidenceRejected,2);
// Oversized Review Plans must not silently claim that truncated risk coverage is complete.
const huge={...plan,units:Array.from({length:66},(_,i)=>unit(`F${i}`,'src/p'+i+'.ts'))};
const large=newReviewQualityState(huge,{riskFlags:{crossSubsystem:true}},{});
assert(large.coverageOverflow>0);
assert.equal(assessReviewQuality(large,{mode:'enforce'}).status,'incomplete');
console.log('review-quality-depth: PASS');
