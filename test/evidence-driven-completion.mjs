import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { persistEvidenceSnapshot, loadEvidenceSnapshot, deleteEvidenceSnapshot } from '../src/evidence/store.mjs';
import { reconcileDependentEvidence, assessEvidenceCoverage } from '../src/evidence/graph.mjs';
import { adjudicateReviewFindings,reviewWitnessSubject } from '../src/evidence/adjudication.mjs';
import { compileRoleContext } from '../src/execution/context-compiler.mjs';
import { executeVerificationDecision } from '../src/verification/executor.mjs';

const dir=await mkdtemp(path.join(tmpdir(),'ro-evidence-'));
try {
  const graph={version:2,sourceKey:'revision-v1',obligations:[{id:'U1',status:'satisfied',evidenceIds:['E1'],dependencies:[]}],
    evidence:[{id:'E1',kind:'review_model_report',level:'model_reported',sourceKey:'revision-v1',
      digest:'source-digest',recordRef:'U1',unitId:'U1'}]};
  const snapshot=await persistEvidenceSnapshot({operationId:'operation-1',scopeKey:'scope-1',graph,root:dir});
  assert.equal(snapshot.records,1);
  const recovered=await loadEvidenceSnapshot({operationId:'operation-1',scopeKey:'scope-1',sourceKey:'revision-v1',root:dir});
  assert.deepEqual(recovered.evidence,graph.evidence);
  assert.equal(await loadEvidenceSnapshot({operationId:'operation-1',scopeKey:'scope-2',sourceKey:'revision-v1',root:dir}),null);
  assert.equal(await loadEvidenceSnapshot({operationId:'operation-1',scopeKey:'scope-1',sourceKey:'revision-v2',root:dir}),null);
  const files=await readdir(path.join(dir,'operation-1','objects'));
  const blob=path.join(dir,'operation-1','objects',files[0]);
  await writeFile(blob, 'tampered');
  await assert.rejects(()=>loadEvidenceSnapshot({operationId:'operation-1',scopeKey:'scope-1',sourceKey:'revision-v1',root:dir}),/integrity|Unsafe|identity/i);
  // Correct an orphan/corrupt blob is deliberately refused, never silently replaced.
  await assert.rejects(()=>persistEvidenceSnapshot({operationId:'operation-1',scopeKey:'scope-1',graph,root:dir}),/corrupt/);
  await deleteEvidenceSnapshot('operation-1',{root:dir});
  assert.equal(await loadEvidenceSnapshot({operationId:'operation-1',scopeKey:'scope-1',sourceKey:'revision-v1',root:dir}),null);
  await assert.rejects(()=>persistEvidenceSnapshot({operationId:'../escape',scopeKey:'scope-1',graph,root:dir}),/Invalid evidence operation/);

  const ev=[{id:'E1',sources:[{id:'src/A',digest:'a'}],dependencyIds:[]},
    {id:'E2',sources:[{id:'src/B',digest:'b'}],dependencyIds:['E1']},
    {id:'E3',sources:[{id:'src/C',digest:'c'}],dependencyIds:[]}];
  let reconciled=reconcileDependentEvidence({evidence:ev,sourceDigests:{'src/A':'changed','src/B':'b','src/C':'c'},accessKey:'allow',priorAccessKey:'allow'});
  assert.deepEqual(reconciled.active.map(x=>x.id),['E3']);
  assert.deepEqual(new Set(reconciled.invalidated),new Set(['E1','E2']));
  assert.equal(reconcileDependentEvidence({evidence:ev,sourceDigests:{'src/A':'a'},accessKey:'changed',priorAccessKey:'allow'}).active.length,0);
  const status=assessEvidenceCoverage({obligations:[
    {id:'O1',requiredEvidenceLevel:'tool_observed',dependencies:[],evidenceIds:['E1']},
    {id:'O2',dependencies:['O1'],evidenceIds:['E2']}],
    evidence:[{id:'E1',level:'model_reported'},{id:'E2',level:'model_reported'}]});
  assert.deepEqual(status.satisfied,[]);

  const dup=[{path:'a.ts',contractId:'c1',reproductionKey:'same',failureMode:'race',affectedBehavior:'save',message:'race',evidence:'observed'},
    {path:'a.ts',contractId:'c2',reproductionKey:'same',failureMode:'race',affectedBehavior:'save',message:'second',evidence:'observed'}];
  const {ledger}=adjudicateReviewFindings(dup);
  assert.equal(ledger.length,2);
  const decision={left:ledger[0].findingId,right:ledger[1].findingId,
    authority:'independently_verified',relation:'equivalent',witnessDigest:'a'.repeat(64)};
  const sourceKey='d'.repeat(64),scopeKey='e'.repeat(64);
  const merged=adjudicateReviewFindings(dup,[decision],{sourceKey,scopeKey,verifiedWitnesses:[{
    digest:decision.witnessDigest,subjectDigest:reviewWitnessSubject({left:ledger[0],right:ledger[1],decision,scopeKey,sourceKey}),
    origin:'trusted_host_verifier',verifierId:'test-host',evidenceRefs:['fixture']}]});
  assert.equal(merged.unique,1);
  assert.equal(adjudicateReviewFindings(dup,[{left:ledger[0].findingId,right:ledger[1].findingId,
    authority:'independently_verified',relation:'equivalent',witnessDigest:'a'.repeat(64)}]).unique,2,
    'model-supplied witness hash without host verification is not authority');
  assert.equal(adjudicateReviewFindings(dup,[{left:ledger[0].findingId,right:ledger[1].findingId,relation:'equivalent'}]).unique,2);
  assert.equal(adjudicateReviewFindings([{...dup[0],reproductionKey:'first'}, {...dup[1],reproductionKey:'other'}],[]).unique,2);

  const ctx=compileRoleContext({mode:'deduplicate',optionalMaxCharacters:5,blocks:[
    {kind:'core_policy',text:'SECURITY RULE',required:true},
    {kind:'history',text:'repeated',required:false,scope:'task'},
    {kind:'history',text:'repeated',required:false,scope:'task'},
    {kind:'handoff',text:'some external evidence',required:false,resolverRef:'E:123'},
    {kind:'task_contract',text:'the full user task',required:true},
  ]});
  assert.match(ctx.text,/SECURITY RULE/);
  assert.match(ctx.text,/the full user task/);
  assert.equal(ctx.omitted.length,2);
  assert(!ctx.text.includes('some external evidence'));
  const mustRetain=compileRoleContext({mode:'deduplicate',optionalMaxCharacters:0,blocks:[
    {kind:'skill',text:'must stay',required:true},{kind:'history',text:'not retrievable',required:false}]});
  assert.match(mustRetain.text,/not retrievable/);
  assert.throws(()=>compileRoleContext({blocks:[{kind:'unknown',text:'hi'}]}),/Invalid/);

  let executed=0;
  const command='npm run test:review';
  const execute=(allowed=true,approvedCommands=[command])=>executeVerificationDecision({decision:{strategy:'targeted_test',required:true},
    configuredCommands:[['npm','run','test:review']],approvedCommands,sourceKey:'sha',invocationId:'inv1',allowed,
    run: async names => { executed++; assert.deepEqual(names,[command]); return {results:[{command,status:'PASS',exitCode:0}]}; }});
  assert.equal((await execute(false)).disposition,'disabled');
  assert.equal((await execute(true,[])).disposition,'no_operator_approved_command');
  const verified=await execute();
  assert.equal(verified.disposition,'executed');
  assert.equal(verified.observations[0].level,'tool_observed');
  assert.equal(executed,1);
  // Language/tool/skill names cannot confer authority. The host approves the
  // exact configured command; custom commands are equally eligible.
  for (const approvedCommand of ['cargo check', './verify', 'python -m custom.audit']) {
    const args = approvedCommand.split(' ');
    const observed = await executeVerificationDecision({
      decision:{strategy:'targeted_test',required:true},
      configuredCommands:[args],approvedCommands:[approvedCommand],allowed:true,
      sourceKey:'sha',invocationId:'trusted-host',
      run: async commands => {
        assert.deepEqual(commands,[approvedCommand]);
        return {results:[{command:approvedCommand,status:'PASS',exitCode:0,inputsStable:true}]};
      },
    });
    assert.equal(observed.disposition,'executed');
    assert.equal(observed.observations[0].passed,true);
  }
  let unwantedRuns=0;
  const notAuthorized=await executeVerificationDecision({
    decision:{strategy:'targeted_test',required:true},
    configuredCommands:[['cargo','check']],approvedCommands:['npm run test'],allowed:true,
    sourceKey:'sha',invocationId:'trusted-host',
    run: async()=>{unwantedRuns++;return {results:[]};},
  });
  assert.equal(notAuthorized.disposition,'no_operator_approved_command');
  assert.equal(unwantedRuns,0,'unapproved checks must never run');
  const changedInput=await executeVerificationDecision({
    decision:{strategy:'targeted_test',required:true},
    configuredCommands:[['cargo','check']],approvedCommands:['cargo check'],allowed:true,
    sourceKey:'sha',invocationId:'trusted-host',
    run:async()=>({results:[{command:'cargo check',status:'PASS',exitCode:0,inputsStable:false}]}),
  });
  assert.equal(changedInput.disposition,'executed');
  assert.equal(changedInput.observations[0].status,'PASS','retain raw process classification');
  assert.equal(changedInput.observations[0].passed,false,
    'command success after mutated inputs is not a trusted PASS observation');
  console.log('evidence-driven-completion: PASS');
} finally { await rm(dir,{recursive:true,force:true}); }
