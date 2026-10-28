import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import assert from 'node:assert/strict';
import { reviewWitnessSubject } from '../src/evidence/adjudication.mjs';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { runWorkflow } from '../src/workflow.mjs';
import { reviewExcludedPaths, applyUserReviewExclusions, chooseReviewStrategy,
  compactReviewEvidence } from '../src/review-efficiency.mjs';
import { buildReviewWorkPlan, nextReviewBatch, batchesForRemaining } from '../src/review-work-plan.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';

assert.deepEqual(reviewExcludedPaths({excludedPaths:['router-context.json','src/private/a.ts']}),
  ['router-context.json','src/private/a.ts']);
assert.deepEqual(reviewExcludedPaths('exclude src/private/a.ts from review'), [],
  'natural-language exclusions must be interpreted by Router, not this resolver');
const scope = { available: true, status: 'resolved', total: 3, manifestKey: 'before', paths: [
  {path:'src/a.ts'}, {path:'src/private/a.ts'}, {path:'.agents/role-orchestrator/router-context.json'},
] };
assert.deepEqual(applyUserReviewExclusions(scope, ['router-context.json']).paths.map(x => x.path), ['src/a.ts','src/private/a.ts']);
const renamed = { ...scope, paths: [{path:'src/open.ts',oldPaths:['src/private/a.ts'], changes:[{oldPath:'src/private/a.ts',status:'R'}]}], total:1 };
assert.equal(applyUserReviewExclusions(renamed, ['src/private/a.ts']).total, 0,
  'old rename paths must not bypass the explicit exclusion');
const contract = { checks:[{id:'S1',description:'Review changed modules'}], omitted: [], source: 'user' };
const plan = buildReviewWorkPlan(contract, scope, { maxFilesPerUnit: 1 });
const first = nextReviewBatch(plan, [], [], { maxUnitsPerBatch: 8, coScheduleDependents: true });
assert.ok(first.length >= 3);
assert.ok(first.some(x => x.kind === 'criterion'), 'criteria may be inspected in the same call as their source');
const legacyBatches=batchesForRemaining(plan,[],{maxUnitsPerBatch:2,batchLimit:8});
const combinedBatches=batchesForRemaining(plan,[],{maxUnitsPerBatch:8,batchLimit:8,coScheduleDependents:true});
assert.ok(combinedBatches.length < legacyBatches.length);
assert.equal(new Set(combinedBatches.flat().map(x=>x.id)).size,plan.units.length,
  'fewer model calls must still assign every coverage obligation');
assert.equal(chooseReviewStrategy({scope,classification:{risk:'normal'}}).name,'focused');
assert.equal(chooseReviewStrategy({scope,classification:{risk:'security_or_data'}}).name,'deep');
assert.ok(compactReviewEvidence([], [{output:{issues:[{path:'foo',message:'test'}]}}]).length < 3200);

const root = await mkdtemp(join(tmpdir(), 'ro-efficient-review-'));
try {
  execFileSync('git', ['init','-q'], {cwd:root});
  execFileSync('git', ['config','user.name','Test'], {cwd:root});
  execFileSync('git', ['config','user.email','test@example.invalid'], {cwd:root});
  await mkdir(join(root,'src'),{recursive:true});
  await writeFile(join(root,'src','alpha.ts'),'export const a = 0;\n');
  await writeFile(join(root,'src','beta.ts'),'export const b = 0;\n');
  execFileSync('git',['add','.'],{cwd:root}); execFileSync('git',['commit','-qm','initial'],{cwd:root});
  await writeFile(join(root,'src','alpha.ts'),'export const a = 1;\n');
  await writeFile(join(root,'src','beta.ts'),'export const b = 2;\n');
  await mkdir(join(root,'.agents','role-orchestrator'),{recursive:true});
  await writeFile(join(root,'.agents','role-orchestrator','router-context.json'),'{}\n');
  const config=await loadConfig();
  assert.equal(config.policy.reviewEfficiency.enabled,true);
  const calls=[], events=[];
  const registry = {
    resolveRole(role){return {role,providerName:'fake',profileName:'fake',profile:{model:'fake',contextWindow:100000}};},
    async invokeRole(role,req){
      calls.push(role);
      if(role==='router') return {output:{mode:'review',complexity:'medium',risk:'normal',writeIntent:'not_requested',reason:'review',task:req.prompt.includes('USER TASK:\nПродолжи ревью') ? {...emptyTaskSpec('review'),continuation:{mode:'current_review'}} : {...emptyTaskSpec('review'),target:{kind:'git',selector:{type:'worktree'}},constraints:{...emptyTaskSpec().constraints,excludedPaths:['router-context.json']}}},
        meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
      if(role.startsWith('reviewer')) {
        const part=req.prompt.match(/REVIEW WORK BATCH \d+ \(limit \d+ batches per run\)\. Assigned UNITS:\n([\s\S]*?)\n\nReturn scopedReview/)[1];
        const ids=[...part.matchAll(/^(F\d+|C[SA]\d+): /gm)].map(x=>x[1]);
        const rows=ids.map(id=>{
          const snippet=part.slice(part.indexOf(`${id}: `)).split('\n'+(ids[ids.indexOf(id)+1]??'___')+': ')[0];
          const paths=JSON.parse(snippet.match(/  requiredPaths=(\[[^\n]*\])/)[1]);
          return {id,status:'checked',evidence:'Inspected the actual code changes and evaluated behavior against the requested contract.',reviewedPaths:paths,
            fileEvidence:paths.map(path=>({path,evidence:`Inspected ${path} for data flow behavior and regressions.`}))};
        });
        return {output:{verdict:'pass',summary:'Inspected the changed sources.',issues:[],coverage:rows,
          inventory:{changedFiles:2,reviewedFiles:2,source:'git diff'}},
          meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
      }
      throw new Error(`Unnecessary expensive role: ${role}`);
    }
  };
  const result = await runWorkflow({task:'/review-code Незакоммиченных изменений. router-context.json не является частью изменений ветки - учитывать его в ревью ненужно',
    repoStart:root,config,registry,reporter:async e=>events.push(e)});
  assert.equal(result.status,'review_passed',JSON.stringify(result.reviewCoverage?.gaps));
  assert.deepEqual(calls,['router','reviewerMedium']);
  assert.equal(result.reviewCoverage.files.known,2);
  assert.ok(result.reviewCoverage.complete);
  assert.ok(!JSON.stringify(result.review).includes('router-context.json'));
  assert.match(result.responseText,/### Краткое резюме/);
  assert.ok(!result.responseText.includes('### Проверка и ограничения'));
  assert(events.some(e=>e.type==='review_execution_strategy'&&e.strategy==='focused'));
  assert.equal(events.find(e=>e.type==='review_user_scope_excluded').count,1);
  // Independent host adjudication is explicitly opt-in and never delegated
  // to a model's self-certified witness. It affects presentation only.
  const mergedRegistry={...registry,async invokeRole(role,req){
    const response=await registry.invokeRole(role,req);
    if (!role.startsWith('reviewer')) return response;
    const first={path:'src/alpha.ts',severity:'major',contractId:'lifecycle',
      reproductionKey:'reconnect-race',failureMode:'stale-update',
      affectedBehavior:'model diagnostics',message:'Late result replaces state',evidence:'Source inspection A'};
    return {...response,output:{...response.output,verdict:'fix',issues:[first,
      {...first,affectedBehavior:'diagnostic state',message:'Same verified race',evidence:'Source inspection B'}]}};
  }};
  let adjudicated=false;
  const merged=await runWorkflow({task:'/review-code Незакоммиченных изменений. router-context.json не является частью изменений ветки - учитывать его в ревью ненужно',
    repoStart:root,config,registry:mergedRegistry,
    onReviewFindingAdjudication:async ({ledger,candidates,scopeKey,sourceKey})=>{
      adjudicated=true;
      assert.equal(candidates.length,1);
      assert.equal(ledger.length,2);
      const decision={left:ledger[0].findingId,right:ledger[1].findingId,
        authority:'independently_verified',relation:'equivalent',witnessDigest:'a'.repeat(64)};
      return {verifiedWitnesses:[{digest:decision.witnessDigest,
        subjectDigest:reviewWitnessSubject({left:ledger[0],right:ledger[1],decision,scopeKey,sourceKey}),
        origin:'trusted_host_verifier',verifierId:'integration-host',evidenceRefs:['fake-host-review']}],decisions:[decision]};
    }});
  assert(adjudicated);
  assert.equal(merged.reviewFindingsReport.unique,1);
  assert.equal(merged.reviewFindingsReport.raw,2);
  assert.equal(merged.status,'review_findings');
  assert.equal((merged.responseText.match(/^- \*\*RF-[a-f0-9]{16}/gm)??[]).length,1, 'one canonical finding line; merged aliases remain visible');
  // Role-specific Review history compaction is opt-in. It never removes
  // source scope, the current user task, the skill or project rules.
  const historyConfig=structuredClone(config);
  historyConfig.policy.reviewEfficiency.contextMode='bounded_history';
  historyConfig.policy.reviewEfficiency.maxHistoryCharacters=3200;
  let reviewerPrompt='';
  const historyEvents=[];
  const historyRegistry={...registry,async invokeRole(role,req){
    if (role.startsWith('reviewer')) reviewerPrompt=req.prompt;
    return registry.invokeRole(role,req);
  }};
  const longHistory='historical optional conversation\n'.repeat(800);
  const historyReview=await runWorkflow({task:'/review-code Незакоммиченных изменений. router-context.json не является частью изменений ветки - учитывать его в ревью ненужно',
    repoStart:root,config:historyConfig,registry:historyRegistry,
    sessionContextText:longHistory,reporter:async e=>historyEvents.push(e)});
  assert.equal(historyReview.status,'review_passed');
  assert.match(reviewerPrompt,/HISTORICAL CONTEXT PARTIAL/);
  assert.match(reviewerPrompt,/router-context\.json/);
  assert(reviewerPrompt.length<longHistory.length+12000);
  assert(historyEvents.some(e=>e.type==='review_history_bounded'&&e.savedCharacters>5000));
  const metrics=createEfficiencyRun('optimized');
  for (const event of events) metrics.onEvent(event);
  const normalized=normalizeEfficiencyRuns([metrics.finish({status:result.status,result})])[0];
  assert.equal(normalized.reviewExecutionStrategy,'focused');
  assert.equal(normalized.reviewScopeExcludedFiles,1);
  assert.equal(normalized.reviewRolesBypassed,3);
  assert.equal(normalized.reviewBatches,1);
  // Budget exhaustion is a PAUSE, never a synthetic review pass. Persist
  // successful source evidence so a later continuation can finish the work.
  const budgetConfig = structuredClone(config);
  budgetConfig.policy.reviewEfficiency.executionBudget = {maxInvocations:1};
  budgetConfig.policy.evidence={persistentStore:true};
  const evidenceRoot=await mkdtemp(join(tmpdir(),'ro-review-evidence-'));
  const previousStateDir=process.env.AGENT_STATE_DIR;
  process.env.AGENT_STATE_DIR=evidenceRoot;
  budgetConfig.policy.reviewWork = {...budgetConfig.policy.reviewWork, maxUnitsPerBatch:1};
  const budgetCalls=[],budgetEvents=[];
  const budgetRegistry={...registry,async invokeRole(role,req) {
    budgetCalls.push(role); return registry.invokeRole(role,req);
  }};
  let savedCheckpoint=null;
  const paused=await runWorkflow({
    task:'/review-code Незакоммиченных изменений. router-context.json не является частью изменений ветки - учитывать его в ревью ненужно',
    repoStart:root,config:budgetConfig,registry:budgetRegistry,reporter:async e=>budgetEvents.push(e),
    onReviewCheckpoint:async checkpoint=>{savedCheckpoint=checkpoint;},
  });
  assert.equal(paused.status,'review_incomplete');
  assert.equal(budgetCalls.filter(x=>x.startsWith('reviewer')).length,1);
  assert.equal(savedCheckpoint?.status,'in_progress');
  assert((await readdir(join(evidenceRoot,'evidence',savedCheckpoint.operation.id))).includes('manifest.json'),
    'authoritative review checkpoint persists before the CAS evidence mirror');
  // Cumulative expensive-reviewer usage must survive continuation. A fresh
  // explicit segment gets its own allowance without hiding total spend.
  assert.equal(savedCheckpoint.operation.reviewBudget.invocations,1);
  const expandedBudgetConfig=structuredClone(budgetConfig);
  expandedBudgetConfig.policy.reviewEfficiency.executionBudget={maxInvocations:2};
  const beforeResumeCalls=budgetCalls.filter(x=>x.startsWith('reviewer')).length;
  const resumedReview=await runWorkflow({task:'/review-resume',repoStart:root,
    config:expandedBudgetConfig,registry:budgetRegistry,reviewCheckpoint:savedCheckpoint,
    onReviewCheckpoint:async checkpoint=>{savedCheckpoint=checkpoint;}});
  assert.equal(resumedReview.status,'review_incomplete');
  const afterResumeCalls=budgetCalls.filter(x=>x.startsWith('reviewer')).length;
  assert(afterResumeCalls>beforeResumeCalls && afterResumeCalls<=beforeResumeCalls+2);
  assert.equal(savedCheckpoint.operation.reviewBudget.invocations,afterResumeCalls);
  const previousCalls=budgetCalls.length;
  const stillPaused=await runWorkflow({task:'/review-resume',repoStart:root,
    config:expandedBudgetConfig,registry:budgetRegistry,reviewCheckpoint:savedCheckpoint,
    onReviewCheckpoint:async checkpoint=>{savedCheckpoint=checkpoint;}});
  assert(['review_incomplete','review_passed'].includes(stillPaused.status));
  assert(budgetCalls.length>previousCalls && budgetCalls.length<=previousCalls+2,'explicit resume starts a new budget segment');
  assert.equal(savedCheckpoint.operation.reviewBudget.invocations,budgetCalls.filter(x=>x.startsWith('reviewer')).length,'operation-level usage remains cumulative');
  assert.equal(savedCheckpoint.operation.reviewBudget.segments,3);
  if (previousStateDir === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR=previousStateDir;
  await rm(evidenceRoot,{recursive:true,force:true});
  assert.ok(savedCheckpoint?.records.length>0,'completed evidence must be durable across resume');
  assert(budgetEvents.some(e=>e.type==='execution_budget_paused'&&e.reason==='invocations'));
  const budgetMetrics=createEfficiencyRun('paused');
  for(const event of budgetEvents)budgetMetrics.onEvent(event);
  assert.equal(normalizeEfficiencyRuns([budgetMetrics.finish({status:paused.status,result:paused})])[0].executionBudgetPauseReason,'invocations');
  const directCalls=[],directEvents=[];
  const directConfig=structuredClone(config);
  directConfig.policy.workflowEfficiency={investigationDirect:true};
  const directRegistry={...registry,async invokeRole(role,req){
    directCalls.push(role);
    if (role==='router')return {output:{mode:'investigate',complexity:'low',risk:'normal',writeIntent:'not_requested',reason:'read-only analysis',task:emptyTaskSpec('investigate')},
      meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
    if (role==='investigator')return {output:'Verified a small read-only investigation.',
      meta:{structuredOutput:{format:'text'}},resolved:this.resolveRole(role)};
    throw new Error('Unexpected expensive role: '+role);
  }};
  const direct=await runWorkflow({task:'Explain the behavior of a small function without modifying files.',
    repoStart:root,config:directConfig,registry:directRegistry,reporter:async e=>directEvents.push(e)});
  assert.equal(direct.status,'investigated');
  assert.deepEqual(directCalls,['router','investigator']);
  assert(directEvents.some(e=>e.type==='review_role_bypassed'&&e.reason==='direct_low_risk_investigation'));
  await mkdir(join(root,'.agents','skills','no-delegation'),{recursive:true});
  await writeFile(join(root,'.agents','skills','no-delegation','SKILL.md'),
    '---\nname: no-delegation\norchestrator-mode: review\norchestrator-delegation: forbidden\n---\nReview without any multiagent delegation.\n');
  const conflictCalls=[];
  const conflictRegistry={...registry,async invokeRole(role,req){
    conflictCalls.push(role);return registry.invokeRole(role,req);
  }};
  const conflict=await runWorkflow({task:'Review the current code using this skill.',skillName:'no-delegation',
    repoStart:root,config,registry:conflictRegistry});
  assert.equal(conflict.status,'skill_execution_conflict');
  assert.deepEqual(conflictCalls,['router']);
  console.log('review-efficiency: PASS');
} finally {await rm(root,{recursive:true,force:true});}
