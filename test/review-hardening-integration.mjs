import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { runWorkflow } from '../src/workflow.mjs';

const root=await mkdtemp(join(tmpdir(),'role-hardening-e2e-'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
try {
  git('init','-q');git('config','user.name','Hardening fixture');git('config','user.email','fixture@example.invalid');
  for(let i=0;i<8;i++){
    const dir=join(root,'src',`module-${i}`);
    await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'index.ts'),`export const value = ${i};\n`);
  }
  git('add','.');git('commit','-qm','baseline');
  for(let i=0;i<8;i++)await writeFile(join(root,'src',`module-${i}`,'index.ts'),`export const value = ${i+1};\n`);
  const before=git('status','--porcelain=v1','-uall');
  const config=await loadConfig();
  config.policy.reviewEfficiency.qualityDepth={mode:'off'};
  config.policy.reviewEfficiency.executionBudget={maxInvocations:16};
  config.policy.reviewWork={maxFilesPerUnit:1,maxUnitsPerBatch:2,maxBatchesPerRun:2};
  config.policy.evidence.persistentStore=false;
  const invoked=[],events=[],seenUnits=[];
  let failOnce=true;
  const registry={
    resolveRole(role){return {role,providerName:'fake',profileName:'fake',profile:{model:'deterministic-fake',contextWindow:100000}};},
    async invokeRole(role,req){
      invoked.push(role);
      if(role==='router') return {output:{mode:'review',complexity:'medium',risk:'normal',writeIntent:'not_requested',reason:'explicit request',task:req.prompt.includes('USER TASK:\nПродолжи ревью') ? {...emptyTaskSpec('review'),continuation:{mode:'current_review'}} : {...emptyTaskSpec('review'),target:{kind:'git',selector:{type:'worktree'}}}},
        meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
      if(role==='explorer') return {output:'Review 8 changed source modules.',meta:{structuredOutput:{format:'text'}},resolved:this.resolveRole(role)};
      if(!role.startsWith('reviewer'))throw new Error(`Unexpected role: ${role}`);
      if(failOnce && invoked.filter(x=>x.startsWith('reviewer')).length===2){failOnce=false;throw new Error('simulated provider disconnect');}
      const part=req.prompt.match(/Assigned UNITS:\n([\s\S]*?)\n\nReturn scopedReview/);
      assert(part,'review must include explicit assigned units');
      const ids=[...part[1].matchAll(/^(F\d+|C[SA]\d+): /gm)].map(row=>row[1]);
      seenUnits.push(...ids);
      const rows=ids.map(id=>{
        const item=part[1].slice(part[1].indexOf(`${id}: `));
        const paths=JSON.parse(item.match(/  requiredPaths=(\[[^\n]*\])/)[1]);
        return {id,status:'checked',evidence:'Inspected source and confirmed assigned behavior against changes.',
          reviewedPaths:paths,fileEvidence:paths.map(path=>({path,evidence:`Inspected ${path} and cross-checked source behavior.`}))};
      });
      const src=rows.flatMap(row=>row.reviewedPaths);
      const issues=src.length?[{path:src[0],severity:'minor',message:`Observed report for ${src[0]}`,
        contractId:'integration',reproductionKey:src[0],failureMode:'example',affectedBehavior:'example',evidence:'Fake role claim only',reportedBatchId:'spoofed-provenance',reportedUnitIds:['FAKE']}]:[];
      return {output:{verdict:issues.length?'fix':'pass',summary:'Fake review executed the assigned scope.',coverage:rows,issues,
        inventory:{changedFiles:8,reviewedFiles:src.length,source:'git'}},
        meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
    },
  };
  let checkpoint=null;
  const options={repoStart:root,config,registry,reporter:async e=>events.push(e),onReviewCheckpoint:async cp=>{checkpoint=structuredClone(cp);}};
  const task='/review-code Review uncommitted changes in all modules.';
  let result=await runWorkflow({...options,task});
  assert.equal(result.status,'review_incomplete','failed reviewer must not be passed off as complete');
  assert(events.some(e=>e.type==='review_batch_interrupted'));
  assert(checkpoint?.records.length>0,'first successful batch must survive provider failure');
  const restored=checkpoint.records.map(row=>row.id);
  let iterations=0;
  while(result.status==='review_incomplete' && iterations++<8){
    result=await runWorkflow({...options,task:'/review-resume',reviewCheckpoint:checkpoint});
  }
  assert.equal(result.status,'review_findings',JSON.stringify(result.reviewCoverage?.gaps));
  assert.equal(result.reviewCoverage.units.pending,0);
  assert.equal(checkpoint.status,'finished');
  const fileUnits=checkpoint.operation.workPlan.units.filter(unit=>unit.kind==='file-group');
  assert.equal(fileUnits.length,8,'all independent file units must be preserved');
  assert.equal(new Set(seenUnits).size,checkpoint.operation.workPlan.totalUnits);
  assert.equal(seenUnits.length,new Set(seenUnits).size,'no completed unit should be invoked twice after restart');
  assert(restored.every(id=>checkpoint.records.some(r=>r.id===id)));
  assert.equal(result.reviewFindingsReport.raw,result.reviewFindingsReport.ledger.reduce((n,row)=>n+row.observations.length,0));
  assert.equal((result.responseText.match(/^- \*\*RF-/gm)??[]).length,result.reviewFindingsReport.unique);
  assert.equal(result.reviewFindingsReport.semanticMerges,0,'unwitnessed semantic duplicates are never merged');
  assert(checkpoint.reports.every(r=>r.output.issues.every(issue=>!issue.reportedBatchId)),
    'model-controlled provenance must be stripped on the first attempt');
  assert(result.reviewFindingsReport.ledger.every(row=>row.observations.every(obs=>
    obs.batchId!=='spoofed-provenance' && !obs.unitIds.includes('FAKE'))));
  assert.equal(git('status','--porcelain=v1','-uall'),before,'read-only workflow must leave worktree intact');
  assert.equal(invoked.filter(x=>x==='router').length,1,'continuations never reroute the review');
  console.log(`review-hardening-integration: PASS; file units=${fileUnits.length}; attempts=${invoked.filter(x=>x.startsWith('reviewer')).length}; resumes=${iterations}`);
} finally {await rm(root,{recursive:true,force:true});}
