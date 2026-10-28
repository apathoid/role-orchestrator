import {emptyTaskSpec} from '../../src/routing/task-spec.mjs';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { normalizeAgentEvent } from '../../src/providers/events.mjs';
import { buildRouterContext, normalizeRouterContextTelemetry } from '../../src/routing/context.mjs';
import { formatInstructionContext } from '../../src/context.mjs';
import { createEfficiencyRun } from '../../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../../src/session-store.mjs';
import { loadConfig } from '../../src/config.mjs';
import { runWorkflow } from '../../src/workflow.mjs';
import { efficiencyReadiness } from '../../src/efficiency/readiness.mjs';

assert.deepEqual(normalizeAgentEvent({type:'activity',activity:'answer'}),{type:'activity',activity:'answer'});
const profile={scope:'provider_adapter_prepared_only',characters:10,utf8Bytes:10,textBlocks:1,supplementalBlocks:0};
assert.deepEqual(normalizeAgentEvent({type:'prompt_profile',profile}),{type:'prompt_profile',profile});
const usageObservation={semantics:'occupancy',scope:'turn',contextUsedTokens:10,contextWindow:100};
assert.equal(normalizeAgentEvent({type:'usage',usage:{contextUsedTokens:10},usageObservation}).usageObservation.semantics,'occupancy');

const root=await mkdtemp(join(tmpdir(),'router-context-check-'));
const originalHome=process.env.HOME;
const fixtureHome=join(root,'fake-home');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
try {
  git('init','-q');git('config','user.email','test@example.invalid');git('config','user.name','Test');
  await mkdir(join(root,'.agents','role-orchestrator'),{recursive:true});
  await mkdir(join(fixtureHome,'.agents'),{recursive:true});
  // Hermetic global rules: production must keep them, while the test must not
  // accidentally load ~/.agents from whichever developer runs npm test.
  const globalRule='GLOBAL_ROUTING_RULE: Treat data deletion as security_or_data.';
  // Deliberately larger than one quarter of the initial Router prompt. An
  // unrelated, unapproved global document must survive optimization even when
  // that makes an arbitrary reduction-ratio assertion impossible to satisfy.
  const globalBody=`${globalRule}\n${'GLOBAL_RULE_STILL_REQUIRED\n'.repeat(1000).trimEnd()}`;
  await writeFile(join(fixtureHome,'.agents','AGENTS.md'),globalBody);
  process.env.HOME=fixtureHome;
  const sensitive='NO_LEAK_ROUTER_SECRET_CANARY';
  const instruction='Implementation-only UI style conventions.\n'.repeat(800)+sensitive;
  const documents=[{scope:'project',path:'AGENTS.md',body:instruction}];
  const context={instructions:documents,availableRules:[],skill:null};
  const full=formatInstructionContext(context);
  const args={repoRoot:root,invocationContext:context,fullInstructions:full,sessionHistoryText:'A required prior conversation detail',reviewTargetText:''};
  const before=await buildRouterContext({...args,mode:'optimized'});
  assert.equal(before.telemetry.reason,'manifest_missing');assert.equal(before.contextText,[full,'OUTER CONVERSATION CONTEXT:\nA required prior conversation detail'].join('\n\n'));
  const manifest={version:1,reviewed:true,excludeInstructions:[{scope:'project',sha256:createHash('sha256').update(instruction).digest('hex')}],
    routingConstraints:'Treat changes to authentication or persistence as security_or_data. Never assume write authorization.'};
  await writeFile(join(root,'.agents','role-orchestrator','router-context.json'),JSON.stringify(manifest));
  const observe=await buildRouterContext({...args,mode:'observe'});
  assert.equal(observe.telemetry.selected,'legacy');assert.equal(observe.telemetry.reason,'observe_only');
  assert.equal(observe.contextText,before.contextText);assert(observe.telemetry.projectedCharacters<observe.telemetry.originalCharacters);
  const optimized=await buildRouterContext({...args,mode:'optimized'});
  assert.equal(optimized.telemetry.selected,'optimized');assert(!optimized.contextText.includes(sensitive));
  assert(optimized.contextText.includes('authentication or persistence'));
  assert(optimized.contextText.includes('A required prior conversation detail'));
  assert(optimized.contextText.length<before.contextText.length);
  assert(!JSON.stringify(normalizeRouterContextTelemetry(optimized.telemetry)).includes(sensitive));
  const withSkill=await buildRouterContext({...args,invocationContext:{...context,skill:{scope:'project',name:'secret-skill',path:'skill',body:'Important active skill text'}},fullInstructions:formatInstructionContext({...context,skill:{scope:'project',name:'secret-skill',path:'skill',body:'Important active skill text'}}),mode:'optimized'});
  assert(withSkill.contextText.includes('Important active skill text'));
  const poisoned=await buildRouterContext({...args,invocationContext:{...context,instructions:[{...documents[0],body:instruction+' CHANGED'}]},mode:'optimized'});
  assert.equal(poisoned.telemetry.reason,'document_digest_mismatch');assert.equal(poisoned.telemetry.selected,'legacy');
  await writeFile(join(root,'AGENTS.md'),instruction);
  await writeFile(join(root,'sample.txt'),'hello\n');
  git('add','.');git('commit','-qm','baseline');
  const config=await loadConfig({repoRoot:root,home:join(root,'fake-home'),env:{}});
  const captures=[];
  async function execute(mode) {
    const prompts=[];const events=[];
    const registry={
      resolveRole:role=>({role,profileName:'fake',providerName:'fake',profile:{model:'fake',contextWindow:32000}}),
      invokeRole:async (role,request)=>{
        prompts.push({role,prompt:request.prompt});
        const output=role==='router'?{mode:'investigate',writeIntent:'not_requested',complexity:'low',risk:'normal',reason:'Question',task:emptyTaskSpec('investigate')}:
          role==='explorer'?{summary:'Found source',relevantFiles:['sample.txt'],constraints:[],existingPatterns:[],likelyVerification:[],unknowns:[]}:'Source contains hello.';
        return {output,resolved:{profileName:'fake',providerName:'fake',profile:{model:'fake',contextWindow:32000}},meta:{elapsedMs:1,structuredOutput:{format:typeof output==='string'?'text':'structured'}}};
      },
    };
    const result=await runWorkflow({task:'What is in sample.txt?',repoStart:root,config,registry,efficiency:{routerContextMode:mode},reporter:async e=>events.push(e)});
    captures.push({result,prompts,events});
  }
  await execute('legacy');await execute('observe');await execute('optimized');
  for(const c of captures) assert.equal(c.result.status,'investigated');
  assert.deepEqual(captures[0].prompts.map(r=>r.role),captures[2].prompts.map(r=>r.role));
  assert.equal(captures[0].prompts[0].prompt,captures[1].prompts[0].prompt,'observe changes no model prompt');
  assert(captures[0].prompts[0].prompt.includes(sensitive),'legacy must contain the project rules');
  assert(!captures[2].prompts[0].prompt.includes(sensitive),'optimized must exclude reviewed project rules');
  assert(captures[2].prompts[0].prompt.includes(globalBody),'optimized must preserve the entire unapproved global document');
  assert(captures[2].prompts[0].prompt.length<captures[0].prompts[0].prompt.length,'projection must reduce prompt size');
  for(let i=1;i<captures[0].prompts.length;i++) assert.equal(captures[0].prompts[i].prompt,captures[2].prompts[i].prompt,'non-router prompts must be identical');
  const routes=captures.map(c=>c.events.find(e=>e.type==='route'));
  assert.deepEqual(routes[0].classification,routes[2].classification);assert.deepEqual(routes[0].policy,routes[2].policy);
  const analytics=createEfficiencyRun('safe-run');
  for(const e of captures[2].events) analytics.onEvent(e);
  const saved=normalizeEfficiencyRuns([analytics.finish({status:'investigated'})]);
  assert.equal(saved[0].invocations[0].routerContext.selected,'optimized');
  assert(!JSON.stringify(saved).includes(sensitive));
  assert(efficiencyReadiness(saved).coverage.composition>0);
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME=originalHome;
  await rm(root,{recursive:true,force:true});
}
console.log('evaluation/p3-router-context: PASS');
