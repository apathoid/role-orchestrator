// Integration-level contract test independent of an installed ACP SDK. The
// actual smoke test still verifies subprocess transport with the real SDK.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { runWorkflow } from '../src/workflow.mjs';
import { fakeReviewCoverage } from './fake-review-coverage.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';
const root=await mkdtemp(join(tmpdir(),'ro-smoke-review-contract-'));
try {
  const git=(...args)=>execFileSync('git',args,{cwd:root});
  await writeFile(join(root,'greeting.txt'),'hello\n');
  git('init','-q');git('config','user.email','smoke@example.invalid');git('config','user.name','Smoke Test');
  git('add','.');git('commit','-qm','initial');
  await writeFile(join(root,'history.txt'),'historical context\n');
  git('add','history.txt');git('commit','-qm','history context');
  const config=await loadConfig();
  const observed=[];
  const registry={
    resolveRole(role){return {role,providerName:'fake',profileName:'fake',profile:{model:'fake',contextWindow:100000}};},
    async invokeRole(role,req){
      observed.push({role, schemaKind:req.schemaKind});
      const response=(output)=>({output,meta:{structuredOutput:{format: typeof output==='string'?'text':'structured'}},resolved:this.resolveRole(role)});
      if(role==='router')return response({mode:'review',writeIntent:'not_requested',complexity:'low',risk:'normal',reason:'explicit review',task:emptyTaskSpec('review')});
      if(role==='explorer')return response({summary:'Greeting is stored in greeting.txt',relevantFiles:['greeting.txt'],constraints:[],existingPatterns:[],likelyVerification:[],unknowns:[]});
      if(role.startsWith('reviewer')){
        assert.equal(req.schemaKind,'scopedReview');
        const scoped=fakeReviewCoverage(req.prompt);
        assert(scoped,'Reviewer fixture failed to find current work batch prompt');
        return response({verdict:'fix',summary:'Smoke finding',issues:[{severity:'major',path:'greeting.txt',message:'Example review finding.',suggestedFix:'Check greeting semantics.'}],...scoped});
      }
      if(role.startsWith('finalValidator')) return response({verdict:'fix',summary:'Finding confirmed',issues:[]});
      if(role.startsWith('responder')) return response('The scoped review reported a finding.');
      throw new Error(`unexpected role: ${role}`);
    },
  };
  const result=await runWorkflow({repoStart:root,config,registry,task:'REVIEW_FINDING Review my code.',modeOverride:'review'});
  assert.equal(result.status,'review_findings',JSON.stringify(result.reviewCoverage?.gaps));
  assert(result.reviewCoverage.complete);
  // The smoke skill requests a non-default title and an Evidence section.
  // The production renderer (not the fake responder) must honor those while
  // retaining all mandatory sections and its authoritative finding ledger.
  const skillDir=join(root,'.agents','skills','review-code');
  await mkdir(skillDir,{recursive:true});
  await writeFile(join(skillDir,'SKILL.md'),`---\nname: review-code\ndescription: Review code using a custom evidence-first report format.\n---\n\n# Output format\n\nUse the heading "Skill review format" and an "Evidence" section.\n`);
  const skillResult=await runWorkflow({repoStart:root,config,registry,
    task:'REVIEW_FINDING Review my code.',modeOverride:'review',skillName:'review-code'});
  assert.equal(skillResult.status,'review_findings',JSON.stringify(skillResult.reviewCoverage?.gaps));
  assert.equal(skillResult.activeSkill?.name,'review-code');
  assert.match(skillResult.responseText,/^# Skill review format$/m);
  assert.match(skillResult.responseText,/^### Evidence$/m);
  assert.match(skillResult.responseText,/^### Замечания и проблемы$/m);
  assert.equal((skillResult.responseText.match(/RF-[a-f0-9]{16}/g)??[]).length,skillResult.reviewFindingsReport.unique);
  console.log('fake-review-smoke-contract: PASS; units=',result.reviewCoverage.units.verified,'roles=',observed.map(x=>x.role).join(','));
} finally { await rm(root,{recursive:true,force:true}); }
