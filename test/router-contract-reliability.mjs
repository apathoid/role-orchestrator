import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { assertShape, schemas } from '../src/schemas.mjs';
import { emptyTaskSpec, validateTaskSpec, taskSpecFailureCode, TASK_SPEC_FAILURE_CODES } from '../src/routing/task-spec.mjs';
import { parseStructuredStateOrText } from '../src/structured-output.mjs';
import { ROUTING_OUTPUT_FAILURE_CODES, routingOutputFailureCode } from '../src/routing/output-failures.mjs';
import { runWorkflow } from '../src/workflow.mjs';
import { loadConfig } from '../src/config.mjs';
import { createExecutionObserver, observableEventData } from '../src/observability/execution-observer.mjs';
import { aggregateRoutingTraces } from '../src/routing/reporting.mjs';
import { parseSlashInvocation, discoverSkills } from '../src/context.mjs';

const task = {...emptyTaskSpec('change','explicit'),target:{kind:'git',selector:{type:'recent_commits',count:6}}};
const routing = {mode:'change',writeIntent:'explicit',complexity:'medium',risk:'normal',reason:'test fixture',task};
const get = (text, unphasedText='') => parseStructuredStateOrText({finalText:text,unphasedText},'routing');
const valid = JSON.stringify(routing);
assert(schemas.routing.required.includes('task'));
assert.equal(get(valid).format,'structured');
assert.equal(get(`\`\`\`json\n${valid}\n\`\`\``).format,'structured');
assert.equal(get(`Completion follows:\n${valid}\nThank you`).format,'structured');
assert.equal(get(valid,'{"fake":"commentary"}').format,'structured', 'authoritative final beats prior unphased fragments');
assert.equal(get('',valid).format,'structured', 'unphased final remains supported');
assert.equal(get('',`Provisional sample: ${valid}`).diagnostics.code,'ROUTER_OUTPUT_UNSTRUCTURED',
  'unphased commentary must not authorize an embedded JSON sample');
assert.equal(get(valid+'\n'+valid).diagnostics.code,'ROUTER_OUTPUT_AMBIGUOUS');
assert.equal(get(valid+'\n{"mode":"review"}').diagnostics.ambiguousFragments,true);
assert.equal(get('hello').diagnostics.code,'ROUTER_OUTPUT_UNSTRUCTURED');
assert.equal(get('').diagnostics.code,'ROUTER_OUTPUT_UNSTRUCTURED');
assert.equal(get('{"mode":').diagnostics.code,'ROUTER_OUTPUT_INCOMPLETE');
assert.equal(get('{not-json}').diagnostics.code,'ROUTER_OUTPUT_MALFORMED');
assert.equal(get(valid.slice(0,-1)).diagnostics.code,'ROUTER_OUTPUT_INCOMPLETE');
assert.equal(get('Here is a plain-text response.').format,'text');
for (const [response,expected] of [
  [{...routing,task:undefined},'ROUTER_TASK_MISSING'],
  [{...routing,task:null},'ROUTER_TASK_INVALID'],
  [{...routing,task:[]},'ROUTER_TASK_INVALID'],
  [{...routing,task:{...task,continuation:null}},'ROUTER_TASK_INVALID'],
  [{...routing,task:{...task,target:{kind:'git',selector:{type:'recent_commits',count:9999}}}},'ROUTER_TASK_INVALID'],
  [{...routing,task:{...task,target:{kind:'git',selector:{type:'commit',ref:'../danger'}}}},'ROUTER_TASK_INVALID'],
  [{...routing,unexpected:1},'ROUTER_OUTPUT_INVALID'],
  [{...routing,mode:'execute'},'ROUTER_OUTPUT_INVALID'],
]) {
  const result=get(JSON.stringify(response));
  assert.equal(result.format,'text');
  assert.equal(result.diagnostics.code,expected);
  assert.equal(result.diagnostics.jsonRecognized,true);
}
assert.throws(()=>assertShape('routing',Object.fromEntries(Object.entries(routing).filter(([key])=>key!=='task'))),/missing_task_spec/);
assert.equal(get(valid).diagnostics.code,null);
assert.equal(get(valid).diagnostics.stage,'validated');
assert.equal(get(valid).diagnostics.taskPresent,true);
// Precise reason codes must survive parsing and remain allowlisted (no raw model text).
for (const [mutatedTask,expected] of [
  [{...task,target:{kind:'git',selector:{type:'recent_commits',count:0}}},'invalid_recent_commit_count'],
  [{...task,target:{kind:'git',selector:{type:'recent_commits',count:129}}},'invalid_recent_commit_count'],
  [{...task,target:{kind:'git',selector:{type:'commit',ref:'../danger'}}},'invalid_task_spec_git_ref'],
  [{...task,continuation:null},'invalid_task_spec_continuation'],
  [{...task,constraints:{...task.constraints,reviewDepth:'excessive'}},'invalid_task_spec_review_depth'],
  [{...task,continuation:{mode:'information'}},'invalid_readonly_continuation'],
  [{...task,skillName:'NOT-VALID'},'invalid_task_spec_skill'],
]) {
  const parsed=get(JSON.stringify({...routing,task:mutatedTask}));
  assert.equal(parsed.diagnostics.code,'ROUTER_TASK_INVALID');
  assert.equal(parsed.diagnostics.stage,'shape_validation');
  assert.equal(parsed.diagnostics.taskFailureCode,expected);
  assert(TASK_SPEC_FAILURE_CODES.includes(expected));
}
assert.equal(get(JSON.stringify({...routing,task:null})).diagnostics.taskFailureCode,'invalid_task_spec_root');
assert.equal(get(JSON.stringify({...routing,mode:'wrong'})).diagnostics.taskFailureCode,null);
assert.equal(taskSpecFailureCode({message:'invalid_task_spec_injected_secret'}),null);
assert.equal(taskSpecFailureCode({message:'custom error leaked secret'}),null);
assert.equal(get(valid).diagnostics.taskFailureCode,null);
// Live Zed regression: ROUTER_OUTPUT_INVALID is an outer contract failure.
// Retain only an allowlisted machine-readable reason, not the field value.
for (const [mutation, expected] of [
  [{mode:'plan'},'invalid_routing_mode'],
  [{writeIntent:'write'},'invalid_routing_write_intent'],
  [{complexity:'extreme'},'invalid_routing_complexity'],
  [{risk:'critical'},'invalid_routing_risk'],
  [{reason:null},'invalid_routing_reason'],
  [{title:'x'.repeat(121)},'invalid_routing_title'],
  [{extra:'SECRET_ROUTER_OUTPUT'},'invalid_routing_extra_fields'],
]) {
  const result=get(JSON.stringify({...routing,...mutation}));
  assert.equal(result.format,'text');
  assert.equal(result.diagnostics.code,'ROUTER_OUTPUT_INVALID');
  assert.equal(result.diagnostics.stage,'shape_validation');
  assert.equal(result.diagnostics.outputFailureCode,expected);
  assert.equal(result.diagnostics.taskFailureCode,null);
  assert(ROUTING_OUTPUT_FAILURE_CODES.includes(expected));
}
assert.equal(routingOutputFailureCode('invalid_routing_extra_fields_SECRET'),null);
assert.equal(get(valid).diagnostics.outputFailureCode,null);
const secretOuter='SECRET_USER_FIELD_VALUE';
assert.equal(observableEventData({type:'semantic_intent_validation',outputFailureCode:secretOuter}).outputFailureCode,null);
assert.equal(observableEventData({type:'router_output_diagnostic',diagnostics:{outputFailureCode:secretOuter}}).outputFailureCode,null);

// Regression from Zed (2026-10-28): semantic priorities are labels, not paths.
const priorities=['незакоммиченный функционал', 'последние 6 коммитов этой ветки'];
const combinedTask={...task,
  target:{kind:'git',selector:{type:'union',selectors:[{type:'worktree'},{type:'recent_commits',count:6}]}},
  constraints:{...task.constraints,priorityAreas:priorities,verification:'required'},
  skillName:'test-it'};
const combinedRoute={...routing,task:combinedTask};
assert.deepEqual(validateTaskSpec(combinedTask).constraints.priorityAreas,priorities);
assert.equal(get(JSON.stringify(combinedRoute)).format,'structured',
  'live-style worktree + six-commits request must pass the typed router contract');
const prioritiesSchema=schemas.routing.properties.task.properties.constraints.properties.priorityAreas;
assert.equal(prioritiesSchema.items.maxLength,240);
assert.equal(prioritiesSchema.items.minLength,1);
for(const value of [...priorities,'src/index.mjs']) {
  assert(new RegExp(prioritiesSchema.items.pattern,'u').test(value));
  assert.equal(get(JSON.stringify({...routing,task:{...task,
    constraints:{...task.constraints,priorityAreas:[value]}}})).format,'structured');
}
for(const invalid of ['', ' ', ' leading', 'trailing ', 'line\nbreak', 'tab\tvalue',
  'x'.repeat(241), null, 42, {reason:'unsafe'}]) {
  const output=get(JSON.stringify({...routing,task:{...task,
    constraints:{...task.constraints,priorityAreas:[invalid]}}}));
  assert.equal(output.diagnostics.code,'ROUTER_TASK_INVALID',String(invalid));
  assert.equal(output.diagnostics.taskFailureCode,'invalid_task_spec_priorities',String(invalid));
  if(typeof invalid==='string') assert.equal(invalid.length <= prioritiesSchema.items.maxLength &&
    new RegExp(prioritiesSchema.items.pattern,'u').test(invalid),false);
}
for (const malformed of [null, 'a', priorities.concat(Array(23).fill('extra'))]) {
  const output=get(JSON.stringify({...routing,task:{...task,
    constraints:{...task.constraints,priorityAreas:malformed}}}));
  assert.equal(output.diagnostics.taskFailureCode,'invalid_task_spec_priorities');
}
// Relaxing priority labels must NOT loosen path validation or authorization.
assert.equal(get(JSON.stringify({...routing,task:{...task,
  constraints:{...task.constraints,excludedPaths:['./file with spaces']}}})).diagnostics.taskFailureCode,
  'invalid_task_spec_exclusions');
assert.equal(get(JSON.stringify({...routing,task:{...task,writeIntent:'not_requested',
  constraints:{...task.constraints,priorityAreas:priorities}}})).diagnostics.taskFailureCode,
  'task_spec_unauthorized_change');

// Exact constraints shared by prompt JSON Schema and the authoritative runtime validator.
const specSchema=schemas.routing.properties.task;
const selectorSchema=specSchema.properties.target.properties.selector.anyOf[1];
assert.equal(selectorSchema.properties.count.minimum,1);
assert.equal(selectorSchema.properties.count.maximum,128);
assert.equal(selectorSchema.properties.mergeParentIndex.maximum,16);
assert.equal(selectorSchema.properties.selectors.items.properties.count.maximum,128);
assert.equal(selectorSchema.properties.selectors.items.properties.mergeParentIndex.minimum,1);
assert.equal(specSchema.properties.continuation.properties.operationId.maxLength,128);
assert.equal(specSchema.properties.ambiguities.items.maxLength,350);
assert.equal(specSchema.properties.skillName.pattern,'^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$');


const secret='SECRET_FROM_ROUTER_RESPONSE';
assert(!JSON.stringify(observableEventData({type:'router_output_diagnostic',diagnostics:{
  code:secret,stage:secret,rawText:secret,taskPresent:true},providerCompletionStatus:secret})).includes(secret));
assert(!JSON.stringify(observableEventData({type:'semantic_intent_validation',status:'invalid',
  code:secret,stage:secret,reason:secret,rawText:secret})).includes(secret));
assert.equal(observableEventData({type:'router_output_diagnostic',diagnostics:{
  code:'ROUTER_TASK_INVALID',stage:'shape_validation',taskFailureCode:'invalid_recent_commit_count',
  rawText:secret}}).taskFailureCode,'invalid_recent_commit_count');
assert.equal(observableEventData({type:'router_output_diagnostic',diagnostics:{
  taskFailureCode:`invalid_task_spec_${secret}`}}).taskFailureCode,null);


const root=await mkdtemp(join(tmpdir(),'router-contract-'));
const traces=await mkdtemp(join(tmpdir(),'router-contract-traces-'));
try {
  for(const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fake@example.invalid']])
    execFileSync('git',args,{cwd:root});
  await writeFile(join(root,'a.js'),'export const x = 1;\n');
  execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['commit','-qm','fixture'],{cwd:root});
  await mkdir(join(root,'.agents','skills','write-tests'),{recursive:true});
  await writeFile(join(root,'.agents','skills','write-tests','SKILL.md'),
    '---\nname: write-tests\ndescription: Add tests\n---\nWrite tests when the user explicitly authorizes changes.');
  const slash=parseSlashInvocation('/write-tests необходимо покрыть тестами функционал, реализованный на последних 6-ти коммитах этой ветки',
    await discoverSkills(root));
  assert.equal(slash.skillName,'write-tests');
  await mkdir(join(root,'.agents','skills','test-it'),{recursive:true});
  await writeFile(join(root,'.agents','skills','test-it','SKILL.md'),
    '---\nname: test-it\ndescription: Add tests\n---\nRun tests when user requests.');
  const altSlash=parseSlashInvocation('/test-it необходимо покрыть тестами функционал, реализованный на последних 6-ти коммитах этой ветки',
    await discoverSkills(root));
  assert.equal(altSlash.skillName,'test-it');
  const config=await loadConfig({repoRoot:root,home:join(root,'empty'),env:{}});
  const observer=createExecutionObserver({root:traces});
  const RouteReached=class extends Error{};
  for (const [name,parsed,shouldAccept] of [
    ['valid',get(valid),true],['combined-priorities',get(JSON.stringify(combinedRoute)),true],
    ['bad-priorities',get(JSON.stringify({...routing,task:{...task,constraints:{...task.constraints,priorityAreas:['not valid\nline']}}})),false],
    ['missing',get(JSON.stringify({...routing,task:undefined})),false],
    ['malformed',get('{not-json}'),false],['ambiguous',get(valid+'\n'+valid),false],
    ['unstructured',get('plain-text'),false],['incomplete',get(valid.slice(0,-1)),false],
    ['invalid',get(JSON.stringify({...routing,task:null})),false],
    ['bad-recent-count',get(JSON.stringify({...routing,task:{...task,target:{kind:'git',selector:{type:'recent_commits',count:999}}}})),false],
    // A provider adapter could hand off an invalid object without prior JSON parsing.
    ['bad-outer-mode',get(JSON.stringify({...routing,mode:'plan'})),false],
    ['bad-extra-field',get(JSON.stringify({...routing,extraneous:'SECRETS_IN_EXTRA_FIELD'})),false],
    ['invalid-direct', {format:'structured',data:{...routing,task:{...task,skillName:'INVALID'}}}, false],
  ]) {
    const run=observer.begin(name);run.running();const events=[];let calls=0;
    const registry={resolveRole:role=>({role,profileName:'fixture',providerName:'fixture',profile:{model:'test',contextWindow:32768}}),
      invokeRole:async role=>{
        calls++;
        assert.equal(role,'router','no explorer/coder/reviewer before a valid contract');
        return {output:parsed.format==='structured'?parsed.data:parsed.text,
          meta:{structuredOutput:{format:parsed.format,source:parsed.source,parseError:parsed.parseError,
            rawText:parsed.rawText,diagnostics:parsed.diagnostics,providerCompletionStatus:'end_turn'}},
          resolved:registry.resolveRole(role)};
      }};
    let result;
    try {result=await runWorkflow({task:slash.task,skillName:slash.skillName,skillInvocation:slash.skillInvocation,
      config,repoStart:root,registry,reporter:async e=>{events.push(e);run.event(e);if(e.type==='route')throw new RouteReached();}});}
    catch(e){if(!(e instanceof RouteReached))throw e;assert(shouldAccept);}
    assert.equal(calls,1,'one Router invocation; no automatic retries');
    assert(events.some(e=>e.type==='skill_invocation_resolved'&&e.status==='resolved'));
    if(shouldAccept){
      assert(events.some(e=>e.type==='route'&&e.policy.mode==='change'));
      assert(events.some(e=>e.type==='semantic_intent_validation'&&e.status==='accepted'));
    }else{
      assert.equal(result.status,'intent_unresolved',name);
      assert(!events.some(e=>e.type==='route'),name);
      assert(events.some(e=>e.type==='semantic_intent_validation'&&e.status!=='accepted'));
    }
    await run.finish({status:shouldAccept?'completed':'failed'});
    const persisted=await observer.getTrace(name,{runId:run.runId,full:true});
    if(name==='invalid-direct') {
      assert.equal(events.find(e=>e.type==='semantic_intent_validation').taskFailureCode,'invalid_task_spec_skill');
      assert.equal(events.find(e=>e.type==='semantic_intent_validation').stage,'workflow_validation');
    }
    if(name==='bad-outer-mode'||name==='bad-extra-field') {
      const expected=name==='bad-outer-mode'?'invalid_routing_mode':'invalid_routing_extra_fields';
      assert.equal(events.find(e=>e.type==='semantic_intent_validation').outputFailureCode,expected);
      assert.equal(events.find(e=>e.type==='router_output_diagnostic').diagnostics.outputFailureCode,expected);
      assert.equal(aggregateRoutingTraces([persisted]).distributions.outputValidationReasons[expected],1);
      assert(!JSON.stringify(persisted).includes('SECRETS_IN_EXTRA_FIELD'));
    }
    if(name==='bad-priorities') {
      assert.equal(events.find(e=>e.type==='semantic_intent_validation').taskFailureCode,
        'invalid_task_spec_priorities');
      assert.equal(aggregateRoutingTraces([persisted]).distributions.taskValidationReasons.invalid_task_spec_priorities,1);
    }
    if(name==='bad-recent-count') {
      const diagnostic=events.find(e=>e.type==='semantic_intent_validation');
      assert.equal(diagnostic.taskFailureCode,'invalid_recent_commit_count');
      assert.equal(diagnostic.stage,'shape_validation');
      assert.equal(events.find(e=>e.type==='router_output_diagnostic').diagnostics.taskFailureCode,
        'invalid_recent_commit_count');
    }
    assert(persisted.some(e=>e.kind==='router_output_diagnostic'));
    assert(!JSON.stringify(persisted).includes(slash.task),'no raw task in traces');
    const report=aggregateRoutingTraces([persisted]);
    assert.equal(report.counters.routerInvocations,1);
    assert.equal(report.counters.validationFailures,shouldAccept?0:1);
    assert.equal(report.counters.providerFailures,0);
    if(!shouldAccept)assert(Object.keys(report.distributions.validationReasons).length>0);
    if(name==='bad-recent-count') {
      assert.equal(report.distributions.validationReasons.ROUTER_TASK_INVALID,1);
      assert.equal(report.distributions.validationStages.shape_validation,1);
      assert.equal(report.distributions.taskValidationReasons.invalid_recent_commit_count,1);
      assert(!JSON.stringify(persisted).includes(secret));
    }
  }
  console.log('router-contract-reliability: PASS (typed task, extraction, privacy, slash change, fail-closed traces)');
} finally {await rm(root,{recursive:true,force:true});await rm(traces,{recursive:true,force:true});}
