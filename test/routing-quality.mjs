import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadConfig,resolveRouterContextMode} from '../src/config.mjs';
import {createExecutionObserver,observableEventData} from '../src/observability/execution-observer.mjs';
import {routingReport,aggregateRoutingTraces} from '../src/routing/reporting.mjs';
import {groundTruthDigest,validateGroundTruthCase,loadEvaluationCorpus} from '../src/routing/ground-truth.mjs';
import {evaluationRow,aggregateSemanticEvaluation} from '../src/routing/semantic-evaluation.mjs';
import {compareSemanticEvaluations} from '../src/routing/regression.mjs';
import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
const root=await mkdtemp(join(tmpdir(),'routing-quality-'));
const home=join(root,'home'),repo=join(root,'repo'),trace=join(root,'traces');
const global=join(home,'.agents','role-orchestrator','config.json');
const project=join(repo,'.agents','role-orchestrator','config.json');
const writeJSON=(path,value)=>writeFile(path,JSON.stringify(value));
const expected={operation:'investigate',writeIntent:'not_requested',selector:null,continuation:'new',ambiguity:false};
const spec=emptyTaskSpec();
const res=(task)=>({outputFormat:'structured',output:{mode:task.operation==='plan'?'investigate':task.operation,
  writeIntent:task.writeIntent,complexity:'low',risk:'normal',task}});
try{
  await mkdir(join(home,'.agents','role-orchestrator'),{recursive:true});
  await mkdir(join(repo,'.agents','role-orchestrator'),{recursive:true});
  const bare=await loadConfig({home:join(root,'missing'),repoRoot:repo,env:{}});
  // The default config can explicitly select a mode (including on developer machines).
  // Test the legacy environment fallback on a config without an explicit selection.
  const {routerContext: _configuredRouterContext, ...policyWithoutRouterContext}=bare.policy;
  const envOnly={...bare,policy:policyWithoutRouterContext};
  assert.equal(resolveRouterContextMode(envOnly,{env:{}}),'legacy');
  assert.equal(resolveRouterContextMode(envOnly,{env:{AGENT_ROUTER_CONTEXT_MODE:'observe'}}),'observe');
  assert.throws(()=>resolveRouterContextMode(envOnly,{env:{AGENT_ROUTER_CONTEXT_MODE:'wrong'}}),/routerContext.mode/);
  // An explicit config mode must take precedence over the legacy environment variable.
  assert.equal(resolveRouterContextMode({...bare,policy:{...bare.policy,routerContext:{mode:'legacy'}}},
    {env:{AGENT_ROUTER_CONTEXT_MODE:'observe'}}),'legacy');
  for(const mode of ['legacy','observe','optimized']){
    await writeJSON(global,{policy:{routerContext:{mode}}});
    const config=await loadConfig({home,repoRoot:repo,env:{AGENT_ROUTER_CONTEXT_MODE:'legacy'}});
    assert.equal(resolveRouterContextMode(config,{env:{AGENT_ROUTER_CONTEXT_MODE:'observe'}}),mode);
    assert.equal(resolveRouterContextMode(config,{diagnosticOverride:'legacy'}),'legacy');
  }
  await writeJSON(global,{policy:{routerContext:{mode:'observe'}}});
  await writeJSON(project,{policy:{routerContext:{mode:'optimized'}}});
  assert.equal(resolveRouterContextMode(await loadConfig({home,repoRoot:repo,env:{}}),{env:{}}),'optimized');
  await writeJSON(project,{policy:{routerContext:{mode:'WRONG'}}});
  await assert.rejects(loadConfig({home,repoRoot:repo,env:{}}),/policy.routerContext.mode/);
  await writeJSON(project,{policy:{routerContext:{mode:'legacy'}}});
  const explicit=join(root,'explicit.json');await writeJSON(explicit,{policy:{routerContext:{mode:'observe'}}});
  const configured=await loadConfig({home,repoRoot:repo,env:{AGENT_CONFIG:explicit}});
  assert.equal(resolveRouterContextMode(configured), 'observe');
  assert.equal(resolveRouterContextMode(configured,{diagnosticOverride:'optimized'}),'optimized');

  const observer=createExecutionObserver({root:trace});
  const session='routing-test';const run=observer.begin(session);
  const secret='PRIVATE-PROMPT-API-KEY';
  run.running();
  run.event({type:'role_start',role:'router',invocationId:'i1',provider:'test-provider',model:'test-model',profile:'routerPreset',prompt:secret});
  run.event({type:'role_router_context',invocationId:'i1',routerContext:{mode:'optimized',selected:'legacy',reason:'manifest_missing',originalCharacters:1900,projectedCharacters:1900,secret}});
  run.event({type:'role_done',role:'router',invocationId:'i1',elapsedMs:130,usage:{inputTokens:23,outputTokens:6,secret}});
  run.event({type:'semantic_intent_validation',status:'accepted',operation:'review',targetKind:'git',selectorType:'worktree',ambiguityCount:0,reason:secret});
  run.event({type:'route',policy:{mode:'review',tier:'medium'},classification:{writeIntent:'not_requested',task:{target:{kind:'git',selector:{type:'commit',ref:secret}},continuation:{mode:'new'},ambiguities:[]},rawTask:secret}});
  run.event({type:'authorization_resolution',status:'read_only',operation:'review',writeIntent:'not_requested',policyMode:'review',raw:secret});
  run.event({type:'routing_outcome',status:'review_passed',privateText:secret});
  await run.finish({resultStatus:'review_passed'});
  const file=join(trace,session,`${run.runId}.jsonl`);
  const contents=await readFile(file,'utf8');
  assert(!contents.includes(secret),'raw user text leaked into normal traces');
  assert(!contents.includes('"ref"'),'raw Git selector leaked');
  assert.equal((await stat(file)).mode & 0o777,0o600);
  const persisted=await createExecutionObserver({root:trace}).getTrace(session,{runId:run.runId,full:true});
  assert.equal(persisted.find(e=>e.kind==='route').data.selectorType,'commit');
  assert.equal(persisted.find(e=>e.kind==='role_done').data.usage.cachedInputTokens,null);
  const report=await routingReport({observer:createExecutionObserver({root:trace}),sessionId:session});
  assert.equal(report.status,'MEASURED');assert.equal(report.counters.routerInvocations,1);
  assert.equal(report.counters.contextFallbacks,1);assert.equal(report.rates.optimizedFallback.denominator,1);
  assert.equal(report.rates.validationFailure.denominator,1);
  assert.equal(report.usage.latencyMs.mean,130);assert.equal(report.usage.cachedInputTokens.status,'NOT_VERIFIED');
  assert.equal(report.semanticAccuracy,null);assert.equal(report.qualityGroundTruth,'NOT_VERIFIED');
  assert.equal(report.distributions.operation.review,1);
  const withDuplicate=aggregateRoutingTraces([[...persisted,persisted[1]]]);
  assert.equal(withDuplicate.coverage.duplicates,1);assert.equal(withDuplicate.counters.routerInvocations,1);
  assert.equal((await routingReport({observer:createExecutionObserver({root:join(root,'none')})})).status,'NOT_VERIFIED');
  // Crash without finish is explicitly incomplete, not proof of semantic failure.
  const broken=observer.begin(session);broken.running();broken.event({type:'role_start',role:'router',invocationId:'crash'});
  await observer.getTrace(session,{runId:broken.runId,full:true});
  const partial=await routingReport({observer:createExecutionObserver({root:trace}),sessionId:session});
  assert.equal(partial.status,'PARTIAL');assert.equal(partial.counters.routerInvocations,2);
  const invalidPath=join(root,'link');await symlink(root,invalidPath);
  const errors=[];const bad=createExecutionObserver({root:join(invalidPath,'fail'),onError:e=>errors.push(e)});
  const noWrite=bad.begin('safe');await noWrite.finish();assert(errors.length>0);

  const unlabeled={schemaVersion:1,id:'review_case',task:'Do not change anything',
    taskDigest:groundTruthDigest('Do not change anything'),recordedAt:'2026-10-28T00:00:00Z',
    labelStatus:'unlabeled',expected:null};
  const confirmed=validateGroundTruthCase({...unlabeled,labelStatus:'confirmed',expected,
    provenance:{method:'manual_review',confirmedBy:'user',confirmedAt:'2026-10-28T00:00:00Z'}});
  assert.equal(validateGroundTruthCase(unlabeled).labelStatus,'unlabeled');
  assert.throws(()=>validateGroundTruthCase({...unlabeled,expected}),/unlabeled_expected/);
  assert.throws(()=>validateGroundTruthCase({...confirmed,expected:{...expected,selector:{type:'commit',ref:'--evil'}}}),/typed_expected/);
  assert.throws(()=>loadEvaluationCorpus([confirmed,confirmed]),/duplicate_id/);
  assert.throws(()=>loadEvaluationCorpus([unlabeled, {...confirmed,id:'review_case_2'}]),/duplicate_task/);
  const otherTask='Review this independent task';
  assert.equal(loadEvaluationCorpus([unlabeled,{...confirmed,id:'review_case_2',task:otherTask,taskDigest:groundTruthDigest(otherTask)}]).length,2);
  const baseRow=evaluationRow({...confirmed,expected,labelStatus:'confirmed'},{result:res(spec)});
  const badRow=evaluationRow({...confirmed,expected,labelStatus:'confirmed'},{result:res(emptyTaskSpec('change','explicit'))});
  assert.equal(badRow.falsePositiveWrite,true);
  const previous=aggregateSemanticEvaluation([{...confirmed,labelStatus:'confirmed'}],[baseRow]);
  const current=aggregateSemanticEvaluation([{...confirmed,labelStatus:'confirmed'}],[badRow]);
  const identity={version:1,corpusVersion:1,corpusDigest:'same',requestBuilderVersion:1,
    evaluationMode:'offline_fixture',routerConfigurationDigest:'cfg',routerInstructionsDigest:'ins',
    provider:'fixture',model:'fixture',rolePreset:'fixture',routerContextMode:'legacy',projectionDigest:'same'};
  previous.evaluationIdentity=identity;current.evaluationIdentity=identity;
  assert.equal(previous.groundTruth.confirmedCases,1);
  assert.equal(previous.groundTruth.accuracy.operation,1);
  assert.equal(current.groundTruth.falsePositiveChange,1);
  assert.equal(compareSemanticEvaluations(previous,current,{minConfirmedCases:1}).status,'FAIL');
  assert.equal(compareSemanticEvaluations(previous,previous,{minConfirmedCases:1}).status,'PASS');
  assert.equal(compareSemanticEvaluations(previous,previous,{minConfirmedCases:2}).status,'INSUFFICIENT_EVIDENCE');
  const unknown=aggregateSemanticEvaluation([unlabeled],[evaluationRow(unlabeled,{result:res(spec)})]);
  assert.equal(unknown.groundTruth.status,'NOT_VERIFIED');
  assert.equal(unknown.groundTruth.accuracy.operation,null);
  const taskFile=join(root,'reviewed-task.txt');await writeFile(taskFile,'Review safely');
  const candidate=join(root,'candidate.json');
  let capture=spawnSync(process.execPath,['tools/ground-truth.mjs','candidate','--id','local_case','--task-file',taskFile,'--out',candidate,'--consent-reviewed'],{encoding:'utf8'});
  assert.equal(capture.status,0,capture.stderr);
  assert.equal((await stat(candidate)).mode&0o777,0o600);
  capture=spawnSync(process.execPath,['tools/ground-truth.mjs','candidate','--id','local_case','--task-file',taskFile,'--out',candidate,'--consent-reviewed'],{encoding:'utf8'});
  assert.notEqual(capture.status,0,'overwrite must fail');
  const labelFile=join(root,'expected.json');await writeJSON(labelFile,expected);
  const labeled=join(root,'labeled.json');
  const label=spawnSync(process.execPath,['tools/ground-truth.mjs','label','--candidate',candidate,'--expected-file',labelFile,'--out',labeled,'--confirm-label'],{encoding:'utf8'});
  assert.equal(label.status,0,label.stderr);
  assert.equal(JSON.parse(await readFile(labeled)).labelStatus,'confirmed');
  const legacy=JSON.parse(await readFile(join(new URL('../test/evaluation/semantic-intent-corpus.json',import.meta.url).pathname),'utf8'));
  assert.equal(legacy.length,56);
  assert.equal(loadEvaluationCorpus(legacy).length,56);
}finally{await rm(root,{recursive:true,force:true});}
console.log('routing-quality: PASS (config, sanitization, replay, reporting, ground truth, gates, capture)');
