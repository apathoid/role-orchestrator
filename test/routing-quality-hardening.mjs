// Deterministic P0/P1 correctness and adversarial regressions; no providers.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {aggregateRoutingTraces} from '../src/routing/reporting.mjs';
import {createExecutionObserver,observableEventData} from '../src/observability/execution-observer.mjs';
import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import {selectorIdentityEqual,caseIdentity,evaluationRow,aggregateSemanticEvaluation,classifyRouterFailure} from '../src/routing/semantic-evaluation.mjs';
import {compareSemanticEvaluations} from '../src/routing/regression.mjs';
import {groundTruthDigest,validateGroundTruthCase,loadEvaluationCorpus} from '../src/routing/ground-truth.mjs';
const now='2026-10-28T00:00:00Z';
const ev=(kind,seq,data={},corr={})=>({version:1,eventId:`event${seq}`,sessionId:'session',runId:'run',sequence:seq,timestamp:now,kind,data,correlation:corr});
const trace=[ev('run.started',1),ev('role_start',2,{role:'router',invocationId:'in1'},{invocationId:'in1'}),
  ev('role_error',3,{role:'router',invocationId:'in1',code:'PROVIDER_CRASH'},{invocationId:'in1'}),
  ev('run.failed',4)];
const report=aggregateRoutingTraces([trace]);
assert.equal(report.counters.routerInvocations,1);
assert.equal(report.counters.providerFailures,1);
assert.deepEqual(report.distributions.providerErrors,{PROVIDER_CRASH:1});
assert.equal(report.rates.providerFailure.denominator,1);
assert.equal(aggregateRoutingTraces([[...trace,trace[2]],trace]).counters.providerFailures,1);
const several=aggregateRoutingTraces([[...trace,ev('role_error',5,{role:'router',invocationId:'in1',code:'PROVIDER_CRASH'},{invocationId:'in1'})]]);
assert.equal(several.counters.providerFailures,1,'one failure per invocation even if emitted twice');
const copy=(name,reason,seq=1)=>[...trace.map(e=>({...e,runId:name,eventId:`${name}-${e.eventId}`}))
  .map(e=>e.kind==='role_error'?{...e,data:{...e.data,code:reason}}:e)];
const multi=aggregateRoutingTraces([copy('a','TIMEOUT'),copy('b','PROVIDER_CRASH'),copy('c','PROVIDER_CRASH')]);
assert.deepEqual(multi.distributions.providerErrors,{PROVIDER_CRASH:2,TIMEOUT:1});
assert.equal(Object.values(multi.distributions.providerErrors).reduce((a,b)=>a+b,0),multi.counters.providerFailures);
const unknown=aggregateRoutingTraces([copy('old',null)]);
assert.equal(unknown.counters.providerFailures,0);
assert.equal(unknown.counters.unknownFailures,1);
assert.equal(unknown.distributions.failureOrigins.unknown,1);
assert.equal(unknown.status,'PARTIAL');
assert.equal(aggregateRoutingTraces([copy('auth','AUTHORIZATION_DENIED')]).distributions.failureOrigins.authorization,1);
assert.equal(aggregateRoutingTraces([copy('env','ENVIRONMENT_FAILURE')]).distributions.failureOrigins.environment,1);
assert.equal(aggregateRoutingTraces([copy('contract','CONTRACT_FAILURE')]).distributions.failureOrigins.contract,1);
assert.equal(aggregateRoutingTraces([[...trace.slice(0,2)]]).coverage.partialRuns,1);
assert.equal(aggregateRoutingTraces([[ev('run.started',1),ev('role_error',2,{role:'router',code:'PROVIDER_CRASH'})]]).counters.providerFailures,0);
// Two uncorrelated historical errors must never become two failed invocations
// when only one Router start is present.
const uncorrelated=aggregateRoutingTraces([[ev('run.started',1),ev('role_start',2,{role:'router'}),
  ev('role_error',3,{role:'router',code:'TIMEOUT'}),
  ev('role_error',4,{role:'router',code:'PROVIDER_CRASH'}),ev('run.failed',5)]]);
assert.equal(uncorrelated.counters.routerInvocations,1);
assert.equal(uncorrelated.counters.providerFailures,1);
assert.equal(uncorrelated.counters.unknownFailures,1);
assert.equal(uncorrelated.status,'PARTIAL');
assert.equal(Object.values(uncorrelated.distributions.providerErrors).reduce((a,b)=>a+b,0),1);
const ambiguous=aggregateRoutingTraces([[ev('run.started',1),ev('role_start',2,{role:'router'}),
  ev('role_start',3,{role:'router'}),ev('role_error',4,{role:'router',code:'TIMEOUT'}),ev('run.failed',5)]]);
assert.equal(ambiguous.counters.providerFailures,0);
assert.equal(ambiguous.counters.unknownFailures,1);
const correlationPriority=aggregateRoutingTraces([[ev('run.started',1),
  ev('role_start',2,{role:'router',invocationId:'in1'},{invocationId:'in1'}),
  ev('role_error',3,{role:'router',code:'TIMEOUT'}),
  ev('role_error',4,{role:'router',code:'PROVIDER_CRASH',invocationId:'in1'},{invocationId:'in1'}),
  ev('run.failed',5)]]);
assert.deepEqual(correlationPriority.distributions.providerErrors,{PROVIDER_CRASH:1});
assert.equal(correlationPriority.counters.unknownFailures,1);



const commit={type:'commit',ref:'HEAD',mergeParentIndex:2};
assert.equal(selectorIdentityEqual(commit,{mergeParentIndex:2,ref:'HEAD',type:'commit'}),true);
assert.equal(selectorIdentityEqual(commit,{type:'commit',ref:'HEAD'}),false);
assert.equal(selectorIdentityEqual({type:'commit',ref:'a'}, {type:'relative_ref',ref:'a'}),false);
assert.equal(selectorIdentityEqual({type:'range',left:'HEAD',right:'main',notation:'..'},
  {type:'range',left:'HEAD',right:'main',notation:'...'}),false);
assert.equal(selectorIdentityEqual({type:'staged'},{type:'unstaged'}),false);
assert.equal(selectorIdentityEqual({type:'worktree'},{type:'staged'}),false);
const union={type:'union',selectors:[{type:'commit',ref:'HEAD'},{type:'staged'}]};
assert.equal(selectorIdentityEqual(union,{selectors:[{ref:'HEAD',type:'commit'},{type:'staged'}],type:'union'}),true);
assert.equal(selectorIdentityEqual(union,{type:'union',selectors:[{type:'staged'},{type:'commit',ref:'HEAD'}]}),false);
assert.equal(selectorIdentityEqual({type:'commit'}, {type:'commit'}),null);
assert.equal(selectorIdentityEqual({type:'commit',ref:'HEAD',unknown:'secret'}, {type:'commit',ref:'HEAD'}),null);
assert.equal(selectorIdentityEqual(null,null),true);

const expected={operation:'review',writeIntent:'not_requested',selector:commit,continuation:'saved_review',operationId:'review123',ambiguity:false};
const spec={...emptyTaskSpec('review'),target:{kind:'git',selector:{ref:'HEAD',mergeParentIndex:2,type:'commit'}},continuation:{mode:'saved_review',operationId:'review123'}};
const response=task=>({outputFormat:'structured',output:{mode:'review',writeIntent:'not_requested',task}});
const gt={schemaVersion:1,id:'saved_review',task:'Review saved operation',taskDigest:groundTruthDigest('Review saved operation'),
  recordedAt:now,labelStatus:'confirmed',expected,provenance:{method:'manual_review',confirmedBy:'user',confirmedAt:now}};
assert.equal(validateGroundTruthCase(gt).expected.operationId,'review123');
const row=evaluationRow(gt,{result:response(spec)});
assert.equal(row.target,true);assert.equal(row.continuation,true);assert.equal(row.operationSelection,true);
const wrong=evaluationRow(gt,{result:response({...spec,continuation:{mode:'saved_review',operationId:'wrong123'}})});
assert.equal(wrong.continuation,false);assert.equal(wrong.operationSelection,false);
assert.equal(evaluationRow(gt,{result:response({...spec,continuation:{mode:'saved_review'}})}).operationSelection,false);
assert.notEqual(caseIdentity(gt),caseIdentity({...gt,hostConstraints:{planOnly:true}}));
assert.notEqual(caseIdentity(gt),caseIdentity({...gt,routerInput:{savedOperationMetadata:'saved'}}));
assert.notEqual(caseIdentity(gt),caseIdentity({...gt,routerInput:{planOnly:true}}));
assert.notEqual(caseIdentity(gt),caseIdentity({...gt,projectContext:{fixtureId:'changed'}}));
assert.equal(caseIdentity({...gt,routerInput:{planOnly:true,modeOverride:'review'}}),
  caseIdentity({...gt,routerInput:{modeOverride:'review',planOnly:true}}));
assert.equal(classifyRouterFailure(Object.assign(new Error(),{code:'TIMEOUT'}),{providerInvoked:false,offline:true}).category,'simulated_provider');
assert.equal(classifyRouterFailure(Object.assign(new Error(),{code:'OFFLINE_FIXTURE_MISSING'}),{providerInvoked:false,offline:true}).type,'FIXTURE_MISSING');
assert.equal(classifyRouterFailure(new Error('invalid_task_spec_git_ref')).category,'contract');
assert.equal(classifyRouterFailure(Object.assign(new Error(),{code:'ENVIRONMENT_ERROR'})).category,'environment');

const evaluationIdentity={version:1,corpusVersion:1,corpusDigest:'same',requestBuilderVersion:1,
  evaluationMode:'offline_fixture',routerConfigurationDigest:'cfg',routerInstructionsDigest:'ins',provider:'fixture',
  model:'fixture',rolePreset:'preset',routerContextMode:'legacy',projectionDigest:'projection'};
const baseline={...aggregateSemanticEvaluation([gt],[row]),evaluationIdentity};
const candidate={...aggregateSemanticEvaluation([gt],[wrong]),evaluationIdentity};
assert.equal(compareSemanticEvaluations(baseline,candidate,{minConfirmedCases:1}).status,'FAIL');
assert.deepEqual(compareSemanticEvaluations(baseline,candidate,{minConfirmedCases:1}).continuationRegression,['saved_review']);
assert.equal(compareSemanticEvaluations(baseline,baseline,{minConfirmedCases:1}).status,'PASS');
assert.equal(compareSemanticEvaluations(baseline,baseline,{minConfirmedCases:2}).status,'INSUFFICIENT_EVIDENCE');
assert.equal(compareSemanticEvaluations(baseline,{...candidate,evaluationIdentity:{...evaluationIdentity,routerContextMode:'optimized'}},{minConfirmedCases:1}).status,'INSUFFICIENT_EVIDENCE');
assert.equal(compareSemanticEvaluations(baseline,{...candidate,evaluationIdentity:{...evaluationIdentity,routerContextMode:'optimized'}},
  {minConfirmedCases:1,allowConfigurationChange:true}).status,'FAIL');
assert.equal(compareSemanticEvaluations(baseline,{...candidate,results:[{...wrong,caseDigestVersion:1}]},
  {minConfirmedCases:1}).status,'INSUFFICIENT_EVIDENCE');
assert.equal(compareSemanticEvaluations(baseline,{...candidate,results:[]},{minConfirmedCases:1}).status,'INSUFFICIENT_EVIDENCE');
assert.equal(compareSemanticEvaluations(baseline,{...candidate,evaluationIdentity:null},{minConfirmedCases:1}).status,'INSUFFICIENT_EVIDENCE');
// A provider regression cannot have a numerator drawn from rows outside the
// paired provider-invocation eligibility denominator.
const providerNotInvokedBefore={...baseline,results:[{...row,invoked:false}]};
const providerOnlyAfter={...candidate,results:[{...wrong,invoked:true,errorCategory:'provider',valid:false}]};
assert.equal(compareSemanticEvaluations(providerNotInvokedBefore,providerOnlyAfter,{minConfirmedCases:1,denyNewProviderFailure:true}).gates.providerFailure.numerator,0);
assert.equal(compareSemanticEvaluations(providerNotInvokedBefore,providerOnlyAfter,{minConfirmedCases:1,denyNewProviderFailure:true}).gates.providerFailure.denominator,0);

assert.equal(aggregateSemanticEvaluation([gt],[evaluationRow(gt,{error:Object.assign(new Error(),{code:'TIMEOUT'}),invoked:false,offline:true})]).providerFailures,0);
const ignored={...gt,id:'candidate_unlabeled',task:'unlabeled',taskDigest:groundTruthDigest('unlabeled'),labelStatus:'unlabeled',expected:null,provenance:undefined};
assert.equal(aggregateSemanticEvaluation([ignored],[evaluationRow(ignored,{result:response(spec)})]).accuracy.operation,null);
assert.equal(loadEvaluationCorpus([gt]).length,1);
const capture={sessionId:'session-1',runId:'run-1',invocationId:'invocation-1',eventSchemaVersion:1,
  typedTaskVersion:1,routerConfigurationDigest:'abcdef',provider:'test',model:'fake',rolePreset:'preset'};
assert.equal(validateGroundTruthCase({...gt,capture}).capture.runId,'run-1');
assert.throws(()=>validateGroundTruthCase({...gt,capture:{...capture,rawPrompt:'sensitive'}}),/capture/);

const root=await mkdtemp(join(tmpdir(),'routing-hardening-'));
try {
  const token='SECRET_FROM_PROMPT';
  const data=observableEventData({type:'role_error',role:'router',code:token,reason:token,source:token,message:token});
  assert(!JSON.stringify(data).includes(token));
  // Model-looking/identifier-looking secrets must not escape through legacy or
  // newly added telemetry types, even when the caller supplies unexpected keys.
  for(const type of ['run.finished','run.failed','run.cancelled','role_start','role_done','role_error',
    'route_validation','review_unit_started','implementation_stage_start','review_batch_done',
    'verification_done','workspace_drift','complete']){
    const raw=observableEventData({type,role:token,invocationId:token,code:token,
      model:token,profile:token,provider:token,resultStatus:token,status:token,stage:token,
      reason:token,unitId:token,action:token,disposition:token,source:token,
      gitFields:[token],completedStepIds:[token],result:{status:token}});
    assert(!JSON.stringify(raw).includes(token),`redaction failed for ${type}`);
  }
  const obs=createExecutionObserver({root:join(root,'traces')});const run=obs.begin('session');
  run.event({type:'role_start',role:'router',invocationId:token,model:token,provider:token,profile:token});
  run.event({type:'role_error',role:'router',invocationId:token,code:token,reason:token});
  run.event({type:'workspace_drift',gitFields:['/home/user/token','HEAD'],reason:token});
  await run.finish({status:'failed',reason:token});
  const file=join(root,'traces','session',`${run.runId}.jsonl`);
  assert(!String(await readFile(file)).includes(token));
  assert.equal((await stat(file)).mode&0o777,0o600);
  const replay=await createExecutionObserver({root:join(root,'traces')}).getTrace('session',{runId:run.runId,full:true});
  assert.equal(replay.length>=2,true);
  const candidateTask=join(root,'task.txt'),out=join(root,'candidate.json');
  await writeFile(candidateTask,'Redacted task');
  const command=spawnSync(process.execPath,['tools/ground-truth.mjs','candidate','--id','test_case',
    '--task-file',candidateTask,'--out',out,'--consent-reviewed','--session-id','session-1','--run-id','run-1',
    '--invocation-id','invocation-1','--config-digest','abcdef'],{encoding:'utf8'});
  assert.equal(command.status,0,command.stderr);
  assert.equal(JSON.parse(await readFile(out)).labelStatus,'unlabeled');
  assert.equal(JSON.parse(await readFile(out)).capture.invocationId,'invocation-1');
  assert.equal((await stat(out)).mode&0o777,0o600);
  const link=join(root,'link');await symlink(root,link);
  assert.notEqual(spawnSync(process.execPath,['tools/ground-truth.mjs','candidate','--id','bad_case',
    '--task-file',candidateTask,'--out',join(link,'bad.json'),'--consent-reviewed'],{encoding:'utf8'}).status,0);
}finally{await rm(root,{recursive:true,force:true});}
console.log('routing-quality-hardening: PASS (distribution, selector, provenance, privacy, digest, gates)');
