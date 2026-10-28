import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import {buildTestCoverageEvidence} from '../src/testing/coverage-evidence.mjs';
const root=await mkdtemp(path.join(tmpdir(),'ro-test-coverage-'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
const put=(file,content)=>writeFile(path.join(root,file),content);
try {
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@invalid');
  await put('a.ts','export const a=0;');git('add','.');git('commit','-qm','start');
  await put('a.ts','export const a=1;');git('add','.');git('commit','-qm','changed a');
  await put('b.ts','export const b=2;');git('add','.');git('commit','-qm','added b');
  await put('a.test.ts','import {a} from "./a";');
  await put('b.ts','export const b=3;');
  const task={...emptyTaskSpec('change','explicit'),qualityGoals:['test_inventory','scenario_assessment'],target:{kind:'git',selector:{type:'union',selectors:[{type:'recent_commits',count:2},{type:'worktree'}]}}};
  const report=await buildTestCoverageEvidence(root,task);
  for (const name of [undefined,'test-it','bespoke-test-skill','refactor']) {
    const candidate={...task,...(name ? {skillName:name}:{})};
    assert.deepEqual(await buildTestCoverageEvidence(root,candidate),report,
      'generic coverage evidence must be independent of skill identity');
  }

  assert.equal(report.status,'INVENTORIED_NOT_VERIFIED');
  assert.equal(report.productionFilesTotal,2,'merge commit history and working tree without duplicate paths');
  assert.deepEqual(report.files.map(x=>x.productionPath),['a.ts','b.ts']);
  assert.equal(report.files[0].changedTests.length,1);
  assert.equal(report.files[0].scenarios.length,0,'no invented scenario coverage');
  assert.equal(report.files[0].scenarioAssessment.status,'NOT_VERIFIED');
  assert.equal(report.codeCoverage.percentage,null);
  await assert.rejects(()=>buildTestCoverageEvidence(root,{...task,target:{kind:'none',selector:{type:'recent_commits',count:2}}}),/invalid_task_spec/);
  const incomplete=await buildTestCoverageEvidence(root,{...task,target:{kind:'git',selector:{type:'recent_commits',count:9}}});
  assert.equal(incomplete.status,'UNVERIFIED');
  console.log('execution-coverage-evidence: PASS');
} finally {await rm(root,{recursive:true,force:true});}
