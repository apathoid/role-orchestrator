import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { reviewBatchEvidenceHandoff, reusableReviewVerification,
  validatedReviewObservations } from '../src/review-evidence-runtime.mjs';
import { executeVerificationDecision } from '../src/verification/executor.mjs';
import { persistEvidenceSnapshot, loadEvidenceSnapshot } from '../src/evidence/store.mjs';
import { ExecutionBudget } from '../src/execution/budget.mjs';
import { boundedReviewHistory } from '../src/review-context.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const units=[{id:'F2',paths:['src/a.ts'],dependencies:['F1'],relatedUnits:[]}];
const plan={units:[{id:'F1',paths:['src/a.ts']},{id:'F2',paths:['src/a.ts']} ]};
const checked=[{id:'F1',status:'checked',reviewedPaths:['src/a.ts'],evidence:'Inspected a',fileEvidence:[]},
  {id:'OTHER',status:'checked',reviewedPaths:['src/z.ts'],evidence:'Inspected z',fileEvidence:[]}];
const reports=[{batchId:'F1_1',unitIds:['F1'],output:{issues:[
  {path:'src/a.ts',severity:'major',message:'Issue at a'},
  {path:'src/z.ts',severity:'minor',message:'Other issue'},
]}}];
const handoff = reviewBatchEvidenceHandoff(units,plan,checked,reports);
const compact=JSON.parse(handoff.text);
assert.deepEqual(compact.completedUnitIds,['F1','OTHER']);
assert.deepEqual(compact.relevantEvidence.map(x=>x.id),['F1']);
assert.equal(handoff.unrelatedEvidenceOmitted,1);
assert.equal(handoff.uniqueFindings,2);
assert(handoff.text.length < 3500);
assert.throws(()=>reviewBatchEvidenceHandoff(units,plan,checked,reports,{maxChars:30}),/limit/);

const longHistory='Older dialogue with optional explanations.\n'.repeat(500);
const trimmed=boundedReviewHistory(longHistory,{task:'Review uncommitted changes in src/a.ts',
  mode:'bounded_history',maxCharacters:3200});
assert.equal(trimmed.reduced,true);
assert(trimmed.savedCharacters>1000);
assert.match(trimmed.text,/HISTORICAL CONTEXT PARTIAL/);
assert.equal(boundedReviewHistory(longHistory,{task:'Review as discussed earlier',
  mode:'bounded_history',maxCharacters:3200}).reduced,false);
assert.equal(boundedReviewHistory(longHistory,{task:'Review',mode:'legacy'}).reduced,false);
assert.throws(()=>boundedReviewHistory('short',{mode:'discard_all'}),/Invalid/);
const command='npm run test:review';
const binding={kind:'paths',completeness:'complete',entries:[{path:'src/a.ts',fingerprint:'abc'}]};
const currentDigest=sha(JSON.stringify(binding));
const result=await executeVerificationDecision({decision:{strategy:'targeted_test',required:true},
  configuredCommands:[['npm','run','test:review']], approvedCommands:[command],
  sourceKey:'review-source',invocationId:'review-1',allowed:true,
  run:async only=>({results:[{command:only[0],exitCode:0,status:'PASS',inputsStable:true,inputBinding:binding}]})});
assert.equal(result.disposition,'executed');
const recorded=validatedReviewObservations(result.observations,'review-source');
assert.equal(recorded.length,1);
assert.equal(recorded[0].inputDigest,currentDigest);
assert(reusableReviewVerification(recorded,{sourceKey:'review-source',command,
  approvedCommands:[command],inputDigest:currentDigest}));
assert.equal(reusableReviewVerification(recorded,{sourceKey:'review-source',command,
  approvedCommands:[command],inputDigest:sha('changed-dependency')}),null);
assert.equal(reusableReviewVerification(recorded,{sourceKey:'changed-source',command,
  approvedCommands:[command],inputDigest:currentDigest}),null);
assert.equal(reusableReviewVerification(recorded,{sourceKey:'review-source',command,
  approvedCommands:[],inputDigest:currentDigest}),null);
assert.equal(validatedReviewObservations([{...result.observations[0],inputDigest:null}],'review-source').length,0,
  'Unknown dependency closure must not be persistently reusable');
const root=await mkdtemp(path.join(tmpdir(),'ro-review-finish-'));
try {
  const first={version:2,sourceKey:'review-source',evidence:[{id:'E1',recordRef:'F1',level:'model_reported'}],
    obligations:[{id:'F1',status:'satisfied',evidenceIds:['E1'],dependencies:[]}],verificationObservations:recorded};
  await persistEvidenceSnapshot({operationId:'op-1',scopeKey:'scope-a',graph:first,root});
  let restored=await loadEvidenceSnapshot({operationId:'op-1',scopeKey:'scope-a',sourceKey:'review-source',root});
  assert.deepEqual(restored.verificationObservations,recorded);
  const second={...first,evidence:[{id:'E2',recordRef:'F2',level:'model_reported'}]};
  await persistEvidenceSnapshot({operationId:'op-1',scopeKey:'scope-a',graph:second,root});
  const objects=await readdir(path.join(root,'op-1','objects'));
  assert.equal(objects.length,1,'Superseded evidence objects should be reclaimed after new manifest commits');
  assert.equal((await loadEvidenceSnapshot({operationId:'op-1',scopeKey:'scope-a',sourceKey:'review-source',root})).evidence[0].id,'E2');
  await writeFile(path.join(root,'op-1','manifest.json'),'corrupt');
  await assert.rejects(()=>loadEvidenceSnapshot({operationId:'op-1',scopeKey:'scope-a',sourceKey:'review-source',root}));
  // Refuse symlink substitution of the *objects directory*, not just files.
  await persistEvidenceSnapshot({operationId:'op-2',scopeKey:'scope-a',graph:first,root});
  await rename(path.join(root,'op-2','objects'),path.join(root,'real-objects'));
  await symlink(path.join(root,'real-objects'),path.join(root,'op-2','objects'));
  await assert.rejects(()=>loadEvidenceSnapshot({operationId:'op-2',scopeKey:'scope-a',sourceKey:'review-source',root}),/Unsafe/);
} finally { await rm(root,{recursive:true,force:true}); }
const budget=new ExecutionBudget({maxInvocations:2});
budget.observe(); budget.observeUsage({inputTokens:100,outputTokens:40});
const checkpoint=budget.snapshot();
const resumed=new ExecutionBudget({maxInvocations:2});
assert.equal(resumed.restore(checkpoint),true);
assert.equal(resumed.disposition().exhausted,false);
resumed.observe();
assert.equal(resumed.disposition().exhausted,true);
assert.equal(resumed.disposition().reasons[0],'invocations');
assert.equal(new ExecutionBudget().restore({invocations:-1}),false);
const telemetry=createEfficiencyRun('run');
telemetry.onEvent({type:'review_evidence_handoff',omittedUnrelated:2});
telemetry.onEvent({type:'review_targeted_verification',disposition:'reused_verified',observations:1});
const normalized=normalizeEfficiencyRuns([telemetry.finish({status:'review_incomplete'})])[0];
assert.equal(normalized.reviewEvidenceUnrelatedOmitted,2);
assert.equal(normalized.targetedVerificationReused,1);
console.log('review-completion: PASS');
