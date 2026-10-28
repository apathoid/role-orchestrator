import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loadInvocationContext} from '../../src/context.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadConfig} from '../../src/config.mjs';
import {evaluateRouterFixture,compareRouterDecisions,validateRouterFixture} from '../../src/routing/evaluation.mjs';
import {emptyTaskSpec} from '../../src/routing/task-spec.mjs';
const root=await mkdtemp(join(tmpdir(),'p3-router-ab-'));
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
try {
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  await writeFile(join(root,'AGENTS.md'),'For changes, explicit user authorization is always required.\n'.repeat(120));
  await writeFile(join(root,'file.js'),'const value=42;\n');
  git('add','.');git('commit','-qm','test');
  const config=await loadConfig({repoRoot:root,home:join(root,'unused-home'),env:{}});
  let calls=0;let nonRouter=0;
  const registryFactory=()=>({
    resolveRole:role=>({role,profileName:'fake',providerName:'fake',profile:{model:'fake',contextWindow:32000}}),
    invokeRole:async (role,{prompt})=>{
      if(role!=='router'){nonRouter++;throw new Error('Evaluator must never call non-router roles');}
      assert(prompt.includes('USER TASK:'));calls++;
      return {output:{mode:'investigate',writeIntent:'not_requested',complexity:'low',risk:'normal',reason:'Read-only question',task:emptyTaskSpec('investigate')},
        outputFormat:'structured',resolved:{profileName:'fake',providerName:'fake',profile:{model:'fake',contextWindow:32000}},meta:{elapsedMs:1,structuredOutput:{format:'structured'}}};
    },close:async()=>{},
  });
  const fixture={id:'read_only_query',task:'What does file.js do?',expected:{mode:'investigate',writeIntent:'not_requested',complexity:'low',risk:'normal'}};
  const result=await evaluateRouterFixture({fixture,repoRoot:root,config,registryFactory});
  assert.equal(calls,2);assert.equal(nonRouter,0);assert.equal(result.equivalent,true);
  assert.equal(result.eligible,false,'no manifest means no actual optimizer experiment');
  assert.equal(result.pass,false,'never treat full-context fallback as successful optimization');
  assert.equal(result.manifestReason,'manifest_missing');
  // A real eligible pair (both invocations still Router-only) requires a
  // reviewed, exact, content-bound manifest; the corpus expectation is external.
  const invocation=await loadInvocationContext(root,{scopePaths:[root],home:join(root,'unused-home')});
  const instruction=invocation.instructions.find(i=>i.scope==='project');
  assert(instruction);
  await mkdir(join(root,'.agents','role-orchestrator'),{recursive:true});
  await writeFile(join(root,'.agents','role-orchestrator','router-context.json'), JSON.stringify({
    version:1,reviewed:true,excludeInstructions:[{scope:'project',sha256:createHash('sha256').update(instruction.body).digest('hex')}],
    routingConstraints:'Explicit user permission is mandatory before any repository write. High-risk security and data changes require high risk classification.',
  }));
  const eligible=await evaluateRouterFixture({fixture,repoRoot:root,config,registryFactory});
  assert.equal(eligible.eligible,true);assert.equal(eligible.pass,true);
  assert(eligible.candidateContextChars<eligible.legacyContextChars);
  assert.equal(calls,4);assert.equal(nonRouter,0);
  const wrongExpectation=await evaluateRouterFixture({fixture:{...fixture,id:'wrong',expected:{...fixture.expected,risk:'security_or_data'}},repoRoot:root,config,registryFactory});
  assert.equal(wrongExpectation.eligible,true);assert.equal(wrongExpectation.pass,false);
  assert(wrongExpectation.expectedMismatches.includes('risk'));
  const bad=compareRouterDecisions({classification:{mode:'review',risk:'architecture',complexity:'high'},policy:{runVerification:true,finalValidation:true}},
    {classification:{mode:'change',writeIntent:'explicit',risk:'normal',complexity:'low'},policy:{runVerification:false,finalValidation:false}});
  assert(bad.violations.includes('unexpected_write_route'));assert(bad.violations.includes('risk_downgrade'));
  assert(bad.violations.includes('required_verification_lost'));
  assert.throws(()=>validateRouterFixture({id:'x',task:'good',expected:{secret:'untrusted'}}));
  const {readFile}=await import('node:fs/promises');
  assert.equal(await readFile(join(root,'file.js'),'utf8'),'const value=42;\n');
} finally { await rm(root,{recursive:true,force:true}); }
console.log('evaluation/p3-router-evaluation: PASS');
