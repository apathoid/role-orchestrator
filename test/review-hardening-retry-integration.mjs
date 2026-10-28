import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {loadConfig} from '../src/config.mjs';
import {runWorkflow} from '../src/workflow.mjs';

const root=await mkdtemp(join(tmpdir(),'review-retry-e2e-'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
try {
 git('init','-q');git('config','user.name','Retry fixture');git('config','user.email','fixture@example.invalid');
 for(const dir of ['a','b']){
   await mkdir(join(root,'src',dir),{recursive:true});
   await writeFile(join(root,'src',dir,'index.ts'),'export const value = 1;\n');
 }
 git('add','.');git('commit','-qm','baseline');
 for(const dir of ['a','b'])await writeFile(join(root,'src',dir,'index.ts'),'export const value = 2;\n');
 const originalStatus=git('status','--porcelain=v1','-uall');
 const config=await loadConfig();
 config.policy.reviewEfficiency.qualityDepth={mode:'off'};
 config.policy.reviewEfficiency.executionBudget={maxInvocations:8};
 config.policy.reviewWork={maxFilesPerUnit:1,maxUnitsPerBatch:2,maxBatchesPerRun:1};
 config.policy.evidence.persistentStore=false;
 let attempts=0,checkpoint;
 const registry={
  resolveRole(role){return {role,providerName:'fixture',profileName:'fixture',profile:{model:'fake',contextWindow:100000}};},
  async invokeRole(role,req){
   if(role==='router')return {output:{mode:'review',complexity:'medium',risk:'normal',writeIntent:'not_requested',reason:'explicit',task:req.prompt.includes('USER TASK:\nПродолжи ревью') ? {...emptyTaskSpec('review'),continuation:{mode:'current_review'}} : {...emptyTaskSpec('review'),target:{kind:'git',selector:{type:'worktree'}}}},
    meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
   if(role==='explorer')return {output:'Inspect two source files',meta:{structuredOutput:{format:'text'}},resolved:this.resolveRole(role)};
   if(!role.startsWith('reviewer'))throw new Error('Unexpected role: '+role);
   attempts++;
   const part=req.prompt.match(/Assigned UNITS:\n([\s\S]*?)\n\nReturn scopedReview/)[1];
   const ids=[...part.matchAll(/^(F\d+|C[SA]\d+): /gm)].map(x=>x[1]);
   const rows=ids.map(id=>{
    const section=part.slice(part.indexOf(`${id}: `));
    const paths=JSON.parse(section.match(/  requiredPaths=(\[[^\n]*\])/)[1]);
    return attempts===1 ? {id,status:'not_checked',evidence:'not examined',reviewedPaths:[]} :
      {id,status:'checked',evidence:'Inspected source behavior and all requested paths.',reviewedPaths:paths,
       fileEvidence:paths.map(path=>({path,evidence:`Independently inspected ${path} and its state transitions.`}))};
   });
   return {output:{verdict:'fix',summary:'One source defect found.',issues:[{
    path:'src/a/index.ts',severity:'major',contractId:'reconnect',reproductionKey:'same-source',
    failureMode:'stale',affectedBehavior:'restore',message:'An outdated result replaces the current state.',
    evidence:`model witness from attempt ${attempts}`}],coverage:rows,
    inventory:{changedFiles:2,reviewedFiles:attempts===1?0:2,source:'git'}},
    meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
  }
 };
 const options={repoStart:root,config,registry,onReviewCheckpoint:async cp=>{checkpoint=structuredClone(cp);}};
 const first=await runWorkflow({...options,task:'/review-code Review all uncommitted changes.'});
 assert.equal(first.status,'review_incomplete');
 assert.equal(checkpoint.records.length,0);
 assert.equal(checkpoint.reports.length,1);
 assert.equal(checkpoint.reports[0].output.issues.length,1);
 const second=await runWorkflow({...options,task:'Продолжи ревью',reviewCheckpoint:checkpoint});
 assert.equal(attempts,2);
 assert.equal(second.reviewFindingsReport.raw,2,'retry must not erase distinct raw observations');
 assert.equal(second.reviewFindingsReport.unique,1);
 assert.deepEqual(second.reviewFindingsReport.ledger[0].observations.map(row=>row.batchId).sort(),
  checkpoint.reports[0].output.issues.map(row=>row.reportedBatchId).sort());
 assert.deepEqual(new Set(checkpoint.reports[0].output.issues.map(issue=>issue.evidence)),
  new Set(['model witness from attempt 1','model witness from attempt 2']));
 assert.equal(git('status','--porcelain=v1','-uall'),originalStatus);
 console.log('review-hardening-retry-integration: PASS; observations=2; same canonical=1');
} finally {await rm(root,{recursive:true,force:true});}
