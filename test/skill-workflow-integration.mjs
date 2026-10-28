import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverSkills, parseSlashInvocation } from '../src/context.mjs';
import { loadConfig } from '../src/config.mjs';
import { runWorkflow } from '../src/workflow.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';

const root=await mkdtemp(join(tmpdir(),'ro-skill-e2e-'));
try {
  execFileSync('git',['init','-q'],{cwd:root});
  execFileSync('git',['config','user.name','Fixture'],{cwd:root});
  execFileSync('git',['config','user.email','fixture@example.invalid'],{cwd:root});
  await writeFile(join(root,'example.txt'),'Initial file\n');
  execFileSync('git',['add','example.txt'],{cwd:root});
  execFileSync('git',['commit','-qm','initial'],{cwd:root});
  await mkdir(join(root,'.agents','skills','changed'),{recursive:true});
  await writeFile(join(root,'.agents','skills','changed','SKILL.md'),`---\nname: changed\ndescription: Generate pull request description for a selected commit\norchestrator-mode: investigate\n---\nProduce a read-only summary of the selected commit. Do not edit files.`);
  const invocation=parseSlashInvocation('/changed по коммиту abcdef123',await discoverSkills(root));
  const seen=[];
  const registry={
    resolveRole(role) {return {role,profileName:'fake',providerName:'fake',profile:{model:'fixture',contextWindow:100000}};},
    async invokeRole(role,request) {
      seen.push({role,prompt:request.prompt});
      if(role==='router') return {output:{mode:'investigate',writeIntent:'not_requested',complexity:'low',risk:'normal',reason:'read-only skill invocation',task:emptyTaskSpec('investigate')},meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
      if(role==='explorer') return {output:{summary:'Inspected example.txt',relevantFiles:['example.txt'],constraints:[],existingPatterns:[],likelyVerification:[],unknowns:[]},meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
      if(role==='investigator') return {output:'### Что было сделано\n\n- Описан коммит.',meta:{structuredOutput:{format:'text'}},resolved:this.resolveRole(role)};
      throw new Error('Wrong role '+role);
    },
  };
  const events=[];
  const result=await runWorkflow({task:invocation.task,repoStart:root,config:await loadConfig(),registry,
    skillName:invocation.skillName,skillInvocation:invocation.skillInvocation,
    reporter:async(event)=>events.push(event)});
  assert.equal(result.status,'investigated');
  assert.deepEqual(seen.map(x=>x.role),['router','explorer','investigator']);
  for(const item of seen) assert.match(item.prompt,/EXPLICIT SKILL INVOCATION/);
  assert.match(seen[0].prompt,/Skill: changed/);
  assert.match(seen[1].prompt,/Arguments: по коммиту abcdef123/);
  assert(events.some(x=>x.type==='route_validation'&&x.status==='accepted'), 'skill instructions cannot independently choose a different semantic route');
  assert(events.some(x=>x.type==='skill_invocation_resolved'&&x.status==='resolved'));
  console.log('skill-workflow-integration: PASS');
} finally { await rm(root,{recursive:true,force:true}); }
