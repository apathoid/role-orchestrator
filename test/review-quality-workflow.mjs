import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { runWorkflow } from '../src/workflow.mjs';

const root=await mkdtemp(join(tmpdir(),'ro-quality-flow-'));
const task='/review-code Review uncommitted source changes, including async event lifecycle.';
const uuid='11111111-2222-4333-8444-555555555555';
try {
  execFileSync('git',['init','-q'],{cwd:root});
  execFileSync('git',['config','user.name','Test'],{cwd:root});
  execFileSync('git',['config','user.email','test@example.invalid'],{cwd:root});
  await mkdir(join(root,'src'),{recursive:true});
  await writeFile(join(root,'src','socket.ts'),'export function connect() {return 1}\n');
  execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['commit','-qm','baseline'],{cwd:root});
  await writeFile(join(root,'src','socket.ts'),'export function connect() {return 2}\n');
  const config=await loadConfig();
  config.policy.reviewEfficiency.qualityDepth={mode:'enforce',followUpPolicy:'material_only',maxAdditionalInvocations:1};
  const metrics=[];
  const calls=[];
  let answerRisksInitially=false;
  let answerRisksOnFollowUp=false;
  const registry={
    resolveRole(role){return {role,providerName:'fake',profileName:'fake',profile:{model:'fake',contextWindow:100000}};},
    async invokeRole(role,req){
      calls.push(role);
      if (role==='router') return {output:{mode:'review',complexity:'medium',risk:'normal',writeIntent:'not_requested',reason:'review',task:req.prompt.includes('USER TASK:\nПродолжи ревью') ? {...emptyTaskSpec('review'),continuation:{mode:'current_review'}} : {...emptyTaskSpec('review'),target:{kind:'git',selector:{type:'worktree'}}}},
        meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
      if (role==='explorer') return {output:'Source can be inspected in src/socket.ts.',
        meta:{structuredOutput:{format:'text'}},resolved:this.resolveRole(role)};
      if (!role.startsWith('reviewer')) throw new Error('Unexpected additional expensive role: '+role);
      const isFollowUp=req.prompt.includes('RISK-ONLY FOLLOW-UP');
      const ids=[...req.prompt.matchAll(/^(F\d+|C[SA]\d+): /gm)].map(x=>x[1]);
      const rows=isFollowUp?[]:ids.map(id=>{
        const start=req.prompt.indexOf(`${id}: `);
        const part=req.prompt.slice(start).split(/\n(?:F\d+|C[SA]\d+): /)[0];
        const paths=JSON.parse(part.match(/  requiredPaths=(\[[^\n]*\])/)[1]);
        return {id,status:'checked',evidence:'Inspected exact source behavior and the changed data flow.',reviewedPaths:paths,
          fileEvidence:paths.map(path=>({path,evidence:'Inspected the new call ordering and tested implications for the subscriber.'}))};
      });
      const riskId=req.prompt.match(/"id":"(RR-[a-f\d]{20})"/)?.[1];
      if (!riskId) throw new Error('Enforcement must identify an explicit source-anchored risk');
      const resolved=(isFollowUp&&answerRisksOnFollowUp)||(!isFollowUp&&answerRisksInitially);
      const riskAssessments=resolved?[{riskId,status:'investigated',outcome:'no_issue_supported',
        evidence:'Inspected socket state transition and verified that the onConnect listener is registered before notification.',
        sourceRefs:['src/socket.ts']}]:[];
      return {output:{verdict:'pass',summary:'Inspected all changed source paths.',issues:[],coverage:rows,
        inventory:{changedFiles:1,reviewedFiles:1,source:'git'},riskAssessments,openQuestions:[]},
        meta:{structuredOutput:{format:'structured'}},resolved:this.resolveRole(role)};
    },
  };
  const cpStore={value:null};
  const opts={task,repoStart:root,config,registry,
    reporter:async event=>metrics.push(event),onReviewCheckpoint:async cp=>{cpStore.value=cp;}};
  answerRisksInitially=true;
  let outcome=await runWorkflow(opts);
  assert.equal(outcome.status,'review_passed',JSON.stringify(outcome.reviewCoverage.gaps));
  assert.equal(outcome.reviewQuality?.status,'satisfied');
  assert.equal(calls.filter(x=>x.startsWith('reviewer')).length,1,'no extra LLM pass without material risk');
  assert.equal(cpStore.value.version,4);
  assert.equal(cpStore.value.status,'finished');
  assert(metrics.some(e=>e.type==='review_quality_assessed'&&e.open===0));
  // Spending the *exact* allowed reviewer invocation with all risks
  // resolved must not falsely set incomplete due to a budget check on the
  // subsequent loop iteration.
  const exactBudget=structuredClone(config);
  exactBudget.policy.reviewEfficiency.executionBudget={maxInvocations:1};
  calls.length=0;
  const exact=await runWorkflow({...opts,config:exactBudget});
  assert.equal(exact.status,'review_passed');
  assert.equal(calls.filter(x=>x.startsWith('reviewer')).length,1);
  // Missing material evidence does NOT become complete just because the
  // filename-based units are checked. No model invocation can bypass budget.
  calls.length=0; metrics.length=0;
  answerRisksInitially=false;
  answerRisksOnFollowUp=false;
  const limited=structuredClone(config);
  limited.policy.reviewEfficiency.executionBudget={maxInvocations:1};
  outcome=await runWorkflow({...opts,config:limited});
  assert.equal(outcome.status,'review_incomplete');
  assert.equal(outcome.reviewCoverage.units.pending,0);
  assert.equal(outcome.reviewQuality?.open,1);
  assert(outcome.reviewCoverage.gapCodes.includes('MATERIAL_RISK_UNRESOLVED'));
  assert.equal(cpStore.value.status,'in_progress');
  const persisted=cpStore.value;
  assert.equal(persisted.qualityState.risks.length,1);
  assert.equal(persisted.operation.reviewBudget.invocations,1);
  assert.equal(calls.filter(x=>x.startsWith('reviewer')).length,1);
  // Continuation restores the risk and takes only a narrow follow-up; it never
  // re-executes the completed Unit or resets the reviewer budget.
  answerRisksOnFollowUp=true;
  const expanded=structuredClone(config);
  expanded.policy.reviewEfficiency.executionBudget={maxInvocations:2};
  outcome=await runWorkflow({...opts,task:'Продолжи ревью',config:expanded,reviewCheckpoint:persisted});
  assert.equal(outcome.status,'review_passed',JSON.stringify(outcome.reviewCoverage.gaps));
  assert.equal(outcome.reviewQuality.open,0);
  assert.equal(outcome.reviewQuality.followUps,1);
  assert.equal(cpStore.value.status,'finished');
  assert.equal(cpStore.value.reports.filter(x=>x.kind==='risk_follow_up').length,1);
  assert.equal(calls.filter(x=>x.startsWith('reviewer')).length,2);
  assert.equal(outcome.reviewCoverage.units.pending,0);
  console.log('review-quality-workflow: PASS');
} finally { await rm(root,{recursive:true,force:true}); }
