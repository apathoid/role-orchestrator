import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {execFileSync} from 'node:child_process';
import {ExecutionBudget} from '../src/execution/budget.mjs';
import {resolveReviewScope} from '../src/review-scope.mjs';
import {reviewPlanFeasibility} from '../src/review-efficiency.mjs';
import {loadConfig} from '../src/config.mjs';
import {runWorkflow} from '../src/workflow.mjs';
import {createEfficiencyRun} from '../src/efficiency/analytics.mjs';
import {normalizeEfficiencyRuns} from '../src/session-store.mjs';

const root=await mkdtemp(join(tmpdir(),'ro-reliability-'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
try {
  const budget=new ExecutionBudget({maxInvocations:4,maxOperationInvocations:7});
  for(let n=0;n<4;n++)budget.observe();
  assert.deepEqual(budget.disposition().reasons,['invocations']);
  const first=budget.snapshot(), next=new ExecutionBudget(budget.limits);
  assert(next.restore(first,{newSegment:true}));
  assert.equal(next.disposition().exhausted,false);
  assert.equal(next.disposition().operationInvocations,4);
  for(let n=0;n<3;n++)next.observe();
  assert.equal(next.disposition().operationExhausted,true);
  assert.equal(next.disposition().operationInvocations,7);
  const again=new ExecutionBudget(budget.limits);
  assert(again.restore(next.snapshot(),{newSegment:true}));
  assert.equal(again.disposition().operationExhausted,true,'hard limits cannot be reset by resume');
  const old=new ExecutionBudget({maxInvocations:4});
  assert(old.restore({version:1,invocations:4,reportedUsage:0,inputTokens:0,outputTokens:0,elapsedMs:10},{newSegment:true}));
  assert.equal(old.disposition().exhausted,false,'legacy budget remains resumable');
  assert.equal(new ExecutionBudget().restore({version:2,invocations:2,elapsedMs:1,reportedUsage:0,
    inputTokens:0,outputTokens:0,segments:1,segment:{invocations:3,elapsedMs:1,reportedUsage:0,inputTokens:0,outputTokens:0}}),false);
  assert.equal(new ExecutionBudget({maxOperationInputTokens:30}).disposition().exhausted,false);
  const unknownUsage=new ExecutionBudget({maxOperationInputTokens:30});unknownUsage.observe();
  assert.deepEqual(unknownUsage.disposition().operationReasons,['usage_unavailable']);
  assert.equal(reviewPlanFeasibility({units:Array.from({length:12},(_,i)=>({id:String(i)}))},
    {maxUnitsPerBatch:2,maxInvocations:4,maxOperationInvocations:8},[],new ExecutionBudget({maxInvocations:4}).disposition()).continuationRequired,true);

  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  await writeFile(join(root,'README.md'),'starting point');git('add','.');git('commit','-qm','init');
  for(let n=1;n<=5;n++){
    for(let i=(n-1)*2;i<Math.min(n*2,8);i++){
      const folder=join(root,'src',`module-${i}`);
      await mkdir(folder,{recursive:true});
      await writeFile(join(folder,'index.ts'),`export const value = ${n};\n`);
    }
    if(n===5) await writeFile(join(root,'src','module-0','index.ts'),'export const value = 50;\n');
    git('add','.');git('commit','-qm',`commit ${n}`);
  }
  // Eight changed paths; explicit first-parent history includes five SHA values.
  const recent=await resolveReviewScope(root,{type:'recent_commits',count:5});
  assert.equal(recent.status,'resolved',recent.reason);
  assert.equal(recent.selector,'recent-first-parent');
  assert.equal(recent.changesets.length,5);
  assert.equal(recent.paths.length,8);
  assert.equal(recent.changesets[0].commit,git('rev-parse','HEAD'));
  assert.equal((await resolveReviewScope(root,{type:'recent_commits',count:5})).revisionKey,recent.revisionKey);
  const currentBranch=git('branch','--show-current');
  assert.equal((await resolveReviewScope(root,{type:'relative_ref',ref:currentBranch})).selector,'relative-ref');
  assert.equal((await resolveReviewScope(root,{type:'relative_ref',ref:currentBranch})).paths.length,0);
  await assert.rejects(()=>resolveReviewScope(root,{type:'recent_commits',count:500}),/invalid_recent_commit_count/, 'invalid typed selectors are rejected rather than interpreted as prose');
  assert.equal((await resolveReviewScope(root,{type:'recent_commits',count:8})).reason,'insufficient_commit_history');
  const stagedFile=join(root,'staged.ts'); await writeFile(stagedFile,'staged');git('add','staged.ts');
  assert.equal((await resolveReviewScope(root,{type:'staged'})).selector,'staged');
  assert.equal((await resolveReviewScope(root,{type:'unstaged'})).paths.length,0);
  git('reset','-q','--','staged.ts');
  await rm(stagedFile);
  const untouchedStatus=git('status','--porcelain=v1');
  const config=await loadConfig();
  config.policy.reviewWork={maxFilesPerUnit:1,maxUnitsPerBatch:2,maxBatchesPerRun:8};
  config.policy.reviewEfficiency.qualityDepth={mode:'off'};
  config.policy.reviewEfficiency.executionBudget={maxInvocations:4,maxOperationInvocations:8};
  config.policy.evidence.persistentStore=false;
  const calls=[],events=[],completedIds=[],unitAttempts=new Map();
  let failOnce=true,cp=null;
  const registry={
    resolveRole(role){return {role,providerName:'fake',profileName:'fake',profile:{model:'reliability-fixture',contextWindow:100000}};},
    async invokeRole(role,req){
      calls.push(role);
      if(role==='router')return {output:{mode:'review',complexity:'medium',risk:'normal',writeIntent:'not_requested',reason:'explicit review',task:req.prompt.includes('USER TASK:\nПродолжи ревью') ?
        {...emptyTaskSpec('review'),continuation:{mode:'current_review'}} :
        {...emptyTaskSpec('review'),target:{kind:'git',selector:{type:'recent_commits',count:5}}}},
        meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
      if(role==='explorer')return {output:'Source inspected.',meta:{structuredOutput:{format:'text'}},resolved:this.resolveRole(role)};
      if(role==='planner')return {output:{steps:[],acceptanceCriteria:[]},meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
      if(!role.startsWith('reviewer'))throw new Error(`Unexpected role ${role}`);
      const part=req.prompt.match(/Assigned UNITS:\n([\s\S]*?)\n\nReturn scopedReview/);
      assert(part);
      const ids=[...part[1].matchAll(/^(F\d+|C[SA]\d+): /gm)].map(x=>x[1]);
      for(const id of ids) unitAttempts.set(id,(unitAttempts.get(id)??0)+1);
      if(failOnce && calls.filter(x=>x.startsWith('reviewer')).length===2){failOnce=false;throw Object.assign(new Error('provider unexpectedly cancelled'),{code:'PROVIDER_CANCELLED'});}
      completedIds.push(...ids);
      const rows=ids.map(id=>{
        const item=part[1].slice(part[1].indexOf(`${id}: `));
        const paths=JSON.parse(item.match(/  requiredPaths=(\[[^\n]*\])/)[1]);
        return {id,status:'checked',evidence:`Reviewed ${id} source behavior and integration evidence.`,reviewedPaths:paths,
          fileEvidence:paths.map(path=>({path,evidence:`Independently inspected ${path} and neighboring source.`}))};
      });
      return {output:{verdict:'pass',summary:'Review checks performed.',coverage:rows,issues:[],
        inventory:{changedFiles:8,reviewedFiles:null,source:'git'}},meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
    },
  };
  const opts={repoStart:root,config,registry,reporter:async e=>events.push(e),onReviewCheckpoint:async c=>{cp=structuredClone(c);}};
  let result=await runWorkflow({...opts,task:'/review-code по последним 5-ти коммитам'});
  assert.equal(result.status,'review_incomplete');
  assert.equal(cp.operation.workPlan.totalUnits,12,'8 file units plus 4 independent criteria');
  assert(events.some(e=>e.type==='review_plan_feasibility'&&e.continuationRequired));
  assert.equal(cp.operation.reviewBudget.invocations,2,'failed invocations still count');
  for(let retry=0;result.status==='review_incomplete'&&retry<5;retry++)
    result=await runWorkflow({...opts,task:'Продолжи ревью',reviewCheckpoint:cp});
  assert.equal(result.status,'review_passed',JSON.stringify(result.reviewCoverage?.gaps));
  assert.equal(result.reviewCoverage.units.pending,0);
  assert.equal(cp.status,'finished');
  assert.equal(new Set(completedIds).size,12);
  assert.equal(completedIds.length,12,'complete units must not be executed twice');
  assert(cp.operation.reviewBudget.segments>=2);
  assert.equal(cp.operation.reviewBudget.invocations,7);
  assert.equal(git('status','--porcelain=v1'),untouchedStatus);
  assert(events.some(e=>e.type==='review_operation_resumed'));
  const unitMeasurements=[...unitAttempts].sort(([a],[b])=>a.localeCompare(b)).map(([unitId,attempts])=>({unitId,attempts,completed:completedIds.includes(unitId)}));
  assert.equal(unitMeasurements.length,12);
  const exported=createEfficiencyRun('reliability');
  for(const event of events) exported.onEvent(event);
  const stats=normalizeEfficiencyRuns([exported.finish({status:result.status,result})])[0];
  assert.equal(stats.reviewExecutionSegments,3);
  assert.equal(stats.reviewOperationInvocations,7);
  assert.equal(stats.reviewSegmentInvocations,1);
  assert.equal(stats.reviewSegmentFeasible,true);
  assert.equal(stats.reviewContinuationRequired,false);
  assert.equal(stats.reviewOperationHardLimitReached,false);
  const hostile=structuredClone(exported.finish({status:result.status,result}));
  hostile.reviewExecutionSegments='SECRET'; hostile.reviewOperationInvocations=-2;
  const scrubbed=normalizeEfficiencyRuns([hostile])[0];
  assert.equal(scrubbed.reviewExecutionSegments,null);
  assert.equal(scrubbed.reviewOperationInvocations,null);

  const hardConfig=structuredClone(config);
  hardConfig.policy.reviewEfficiency.executionBudget={maxInvocations:1,maxOperationInvocations:2};
  let hardCp=null;
  const hardOptions={...opts,config:hardConfig,onReviewCheckpoint:async c=>{hardCp=structuredClone(c);}};
  let hard=await runWorkflow({...hardOptions,task:'/review-code по последним 5-ти коммитам'});
  assert.equal(hard.status,'review_incomplete');
  const relaxed=structuredClone(hardConfig);
  relaxed.policy.reviewEfficiency.executionBudget={maxInvocations:4,maxOperationInvocations:100};
  hard=await runWorkflow({...hardOptions,config:relaxed,task:'Продолжи ревью',reviewCheckpoint:hardCp});
  assert.equal(hard.status,'review_incomplete');
  assert.equal(hardCp.operation.reviewBudget.invocations,2);
  assert.equal(hardCp.operation.reviewHardLimits.maxOperationInvocations,2);
  const beforeBlocked=calls.filter(x=>x.startsWith('reviewer')).length;
  hard=await runWorkflow({...hardOptions,config:relaxed,task:'Продолжи ревью',reviewCheckpoint:hardCp});
  assert.equal(hard.status,'review_incomplete');
  assert.equal(calls.filter(x=>x.startsWith('reviewer')).length,beforeBlocked,'hard operation limit blocks further reviewer calls');

  let driftCp=null;
  const driftConfig=structuredClone(config);
  driftConfig.policy.reviewEfficiency.executionBudget={maxInvocations:1};
  const driftOptions={...opts,config:driftConfig,onReviewCheckpoint:async c=>{driftCp=structuredClone(c);}};
  let drift=await runWorkflow({...driftOptions,task:'/review-code по последним 5-ти коммитам'});
  assert.equal(drift.status,'review_incomplete');
  git('commit','--allow-empty','-qm','concurrent head drift');
  const reviewerCount=calls.filter(x=>x.startsWith('reviewer')).length;
  drift=await runWorkflow({...driftOptions,task:'Продолжи ревью',reviewCheckpoint:driftCp});
  assert.equal(drift.status,'review_incomplete');
  assert.equal(calls.filter(x=>x.startsWith('reviewer')).length,reviewerCount,
    'stale source HEAD must fail closed before invoking reviewer');
  console.log('REVIEW_UNIT_MEASUREMENTS_JSON='+JSON.stringify(unitMeasurements));
  console.log('review-reliability: PASS, 12 units, 7 reviewer invocations, hard ceiling and HEAD drift');
} finally {await rm(root,{recursive:true,force:true});}
