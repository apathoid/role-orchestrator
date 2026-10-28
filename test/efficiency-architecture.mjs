import assert from 'node:assert/strict';
import { resolveSkillExecutionPolicy, skillExecutionCompatibility } from '../src/execution/skill-policy.mjs';
import { compactImplementationHandoff } from '../src/execution/stage-context.mjs';
import { normalizeExecutionBudget, ExecutionBudget } from '../src/execution/budget.mjs';
import { assessReviewWorkload } from '../src/execution/workload.mjs';
import { compileRoleContextManifest } from '../src/execution/context.mjs';
import { projectReviewEvidence, reconcileEvidenceGraph, toolObservation } from '../src/evidence/graph.mjs';
import { findingHypothesisGroups } from '../src/evidence/findings.mjs';
import { chooseVerification } from '../src/verification/decision.mjs';
import { evaluateQuality, compareQuality } from '../src/evaluation/efficiency-quality.mjs';
import { makeReviewCheckpoint, validateReviewCheckpoint } from '../src/review-checkpoint.mjs';
import { buildReviewWorkPlan } from '../src/review-work-plan.mjs';
const stageHandoff=compactImplementationHandoff({completedStages:['I1'], records:[{id:'S1',evidence:'private project details must be omitted'}],
  reports:[{stageId:'I1',summary:'Stage completed'}]});
assert.match(stageHandoff, /completedStepIds/);
assert(!stageHandoff.includes('private project details must be omitted'));
assert.equal(resolveSkillExecutionPolicy({orchestratorDelegation:'forbidden'}).delegation,'forbidden');
assert.equal(skillExecutionCompatibility(resolveSkillExecutionPolicy({orchestratorDelegation:'forbidden'}),'review').compatible,false);
assert.equal(skillExecutionCompatibility(resolveSkillExecutionPolicy(null),'review').compatible,true);
assert.throws(()=>normalizeExecutionBudget({maxInputTokens:-1}),/Invalid/);
assert.deepEqual(normalizeExecutionBudget({maxInvocations:2}).maxInvocations,2);
const budget=new ExecutionBudget({maxInvocations:2});
assert.equal(budget.disposition().exhausted,false);
budget.observe();budget.observe();
assert.deepEqual(budget.disposition().reasons,['invocations']);
assert.equal(budget.disposition().inputTokens,null,'unknown usage is not zero');
const risk=assessReviewWorkload({available:true,status:'resolved',paths:[{path:'src/auth/session.ts'}]}, {risk:'normal'});
assert.equal(risk.highRisk,true);
assert.equal(assessReviewWorkload({available:true,status:'resolved',paths:[{path:'src/socket/reconnect.ts'}]},{}).mediumRisk,true);
const context=compileRoleContextManifest({role:'reviewer',sections:['core instructions','core instructions','task']});
assert.equal(context.duplicateCharacters,'core instructions'.length);
assert(!JSON.stringify(context).includes('core instructions'),'metadata must contain no prompt text');
const scope={available:true,status:'resolved',paths:[{path:'src/one.ts'}],total:1,revisionKey:'r1',manifestKey:'m1'};
const contract={checks:[{id:'S1',description:'Inspect code',source:'user'}],omitted:[]};
const plan=buildReviewWorkPlan(contract,scope);
const fileUnit=plan.units.find(x=>x.kind==='file-group');
const record={id:fileUnit.id,status:'checked',evidence:'Inspected the actual source behavior and references.',
 reviewedPaths:['src/one.ts'], fileEvidence:[{path:'src/one.ts',evidence:'Inspected the code for source-level issues.'}]};
const graph=projectReviewEvidence({plan,records:[record],sourceKey:'base1'});
assert.equal(graph.evidence.length,1);
assert.equal(graph.evidence[0].level,'model_reported');
assert.equal(graph.obligations.filter(x=>x.status==='satisfied').length,1);
assert.equal(reconcileEvidenceGraph(graph,'base2').reusable,false);
assert.equal(toolObservation({invocationId:'run1',commandDigest:'hash',exitCode:0,sourceKey:'base1'}).level,'tool_observed');
assert.equal(toolObservation({invocationId:'run1',commandDigest:'hash',exitCode:'PASS',sourceKey:'base1'}),null);
assert.equal(chooseVerification({obligations:graph.obligations,evidence:[],risk:{concurrency:true}}).strategy,'independent_review');
const pendingChecks = [{id:'custom-check',status:'pending'}];
assert.equal(chooseVerification({obligations:pendingChecks,availableCommands:['cargo check'],evidence:[]}).strategy,
  'targeted_test', 'command labels are not tied to a particular toolchain');
assert.equal(chooseVerification({obligations:pendingChecks,availableCommands:['./verify'],evidence:[]}).strategy,'targeted_test');
assert.equal(chooseVerification({obligations:pendingChecks,availableCommands:['  '],evidence:[]}).strategy,'source_inspection');
assert.equal(chooseVerification({obligations:pendingChecks,availableCommands:[],evidence:[]}).strategy,'source_inspection');
assert.equal(chooseVerification({obligations:pendingChecks,availableCommands:['cargo check'],
  evidence:[{kind:'tool_result',level:'tool_observed',passed:true}]}).strategy,'source_inspection');
assert.equal(chooseVerification({obligations:pendingChecks,availableCommands:['./verify'],
  risk:{security:true}}).strategy,'independent_review');
const contradictory=findingHypothesisGroups([{path:'a.ts',failureMode:'race',reproductionKey:'t1'},
  {path:'a.ts',failureMode:'race',reproductionKey:'t2'}]);
assert.equal(contradictory.length,0,'incompatible explicit reproductions are not ambiguous candidates');
const [u]=findingHypothesisGroups([{path:'a.ts',failureMode:'race',reproductionKey:'t1'},
  {path:'a.ts',failureMode:'race',message:'The same failure has another wording'}]);
assert.equal(u.relation,'potential_duplicate');
const report={outputFormat:'structured',batchId:'b1',unitIds:[fileUnit.id],output:{verdict:'pass',summary:'Inspected',issues:[]}};
const checkpoint=makeReviewCheckpoint({scopeKey:'scope',plan,repoKey:'base1',status:'in_progress',records:[record],reports:[report],
  operation:{id:'11111111-2222-4333-8444-555555555555',repoRoot:'/tmp/repo',task:'review',workPlan:plan,classification:{risk:'normal'},contract}});
assert.equal(checkpoint.evidenceProjection.version,2);
assert.equal(checkpoint.evidenceProjection.satisfied.length,1);
assert.equal(validateReviewCheckpoint(checkpoint,{scopeKey:'scope',plan,repoKey:'base1'})?.records.length,1);
const truth=['F1','F2'];
const base=evaluateQuality({expectedFindings:truth,reportedFindings:['F1'],blockerMajorIds:['F1'],mandatoryObligations:['C1'],verifiedObligations:['C1'],measurements:{invocations:8}});
const candidate=evaluateQuality({expectedFindings:truth,reportedFindings:['F1','F2'],blockerMajorIds:['F1'],mandatoryObligations:['C1'],verifiedObligations:['C1'],measurements:{invocations:2}});
assert.equal(compareQuality(base,candidate).acceptedQuality,true);
assert.equal(compareQuality(base,candidate).invocationReduction,.75);
assert.equal(compareQuality(base,candidate).tokenReduction,null);
console.log('efficiency-architecture: PASS');
