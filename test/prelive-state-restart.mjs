import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,readFile,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { captureRepoState } from '../src/repo.mjs';
import { planDigest,normalizeImplementationPlan,buildImplementationStages,validateImplementationCheckpoint,repositoryFingerprint } from '../src/implementation-stages.mjs';
import { registerImplementationPlan,updateActiveImplementationTask } from '../src/implementation-tasks.mjs';
import { reviewOperationCompatible } from '../src/review-continuity.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';

const scratch=await mkdtemp(join(tmpdir(),'prelive-restart-'));
const root=join(scratch,'repo'),stateDir=join(scratch,'state');
const git=(...args)=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim()};
async function nodeProcess(code,extraEnv={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code],{
      cwd:new URL('..',import.meta.url).pathname,
      env:{...process.env,AGENT_STATE_DIR:stateDir,...extraEnv},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',buf=>stdout+=buf);child.stderr.on('data',buf=>stderr+=buf);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout:stdout.trim(),stderr}));
  });
}
try{
  await mkdir(root);git('init','-q');git('config','user.name','Test');git('config','user.email','prelive@example.invalid');
  await writeFile(join(root,'a.js'),'export const a = 1;\n');git('add','.');git('commit','-qm','initial');
  const plan=normalizeImplementationPlan({goal:'Implement feature',steps:['Change a.js','Add checks','Update docs','Verify'],
    acceptanceCriteria:['Unit and security tests pass'],risks:[],expectedFiles:['a.js']});
  const repoKey=repositoryFingerprint(await captureRepoState(root));
  const artifact={version:1,repoRoot:root,repoKey,plan,planId:planDigest(plan)};
  const session={cwd:root,repoRoot:root,transcript:[],history:[],implementationTasks:[]};
  const task=registerImplementationPlan(session,artifact);
  const stages=buildImplementationStages(plan,{preferredStepsPerStage:2});
  const checkpoint={version:1,planId:artifact.planId,scopeKey:'scope',repoKey,completedStages:['I1'],
    records:[{id:'S1',status:'implemented',evidence:'Changed a.js'},{id:'S2',status:'implemented',evidence:'Checks'}],
    cumulativeBudget:{roleInvocations:2,tokens:99}};
  assert.equal(validateImplementationCheckpoint(checkpoint,{planId:artifact.planId,scopeKey:'scope',repoKey,stages}),true);
  updateActiveImplementationTask(session,'checkpoint',checkpoint);
  const reviewSpec=emptyTaskSpec('review');
  const reviewCheckpoint={version:4,status:'in_progress',scopeKey:'review-scope',planKey:'review-plan',repoKey,
    unitsTotal:2,records:[{id:'U1',status:'checked',evidence:'Reviewed first unit, sufficient evidence.'}],
    reports:[{batchId:'B1',unitIds:['U1'],output:{verdict:'pass',issues:[]}}],
    operation:{id:'11111111-2222-4333-8444-555555555555',repoRoot:root,task:'Review change',taskSpec:reviewSpec,contract:{checks:[]},
      workPlan:{version:1,planKey:'review-plan',totalUnits:2,units:[{id:'U1'},{id:'U2'}]},cumulativeBudgets:{invocations:1}},qualityState:{version:1,risks:[]}};
  session.reviewCheckpoint=reviewCheckpoint;
  const id='real-plan-review-restart';
  const save=await nodeProcess(`import {saveSession} from './src/session-store.mjs';
    await saveSession(${JSON.stringify(id)},${JSON.stringify(session)});console.log('saved')`);
  assert.equal(save.code,0,save.stderr);assert.equal(save.stdout,'saved');
  const reopen=await nodeProcess(`import {loadSession} from './src/session-store.mjs';
    const s=await loadSession(${JSON.stringify(id)});console.log(JSON.stringify({plan:s.implementationPlan,
      taskId:s.activeImplementationTaskId,checkpoint:s.implementationCheckpoint,review:s.reviewCheckpoint}));`);
  assert.equal(reopen.code,0,reopen.stderr);
  const restored=JSON.parse(reopen.stdout);
  assert.equal(restored.taskId,task.taskId);
  assert.deepEqual(restored.plan,artifact);
  assert.deepEqual(restored.checkpoint,checkpoint);
  assert.deepEqual(restored.review,reviewCheckpoint);
  assert.equal(reviewOperationCompatible(restored.review,{repoRoot:root}),true);
  assert.equal(reviewOperationCompatible(restored.review,{repoRoot:scratch}),false);
  assert.equal(restored.review.reports.length,1);
  assert.equal(restored.review.operation.cumulativeBudgets.invocations,1);
  assert.equal(restored.checkpoint.cumulativeBudget.tokens,99);
  assert.equal(validateImplementationCheckpoint(checkpoint,{planId:'bad-digest',scopeKey:'scope',repoKey,stages}),false);
  assert.equal(validateImplementationCheckpoint(checkpoint,{planId:artifact.planId,scopeKey:'wrong',repoKey,stages}),false);
  assert.equal(validateImplementationCheckpoint(checkpoint,{planId:artifact.planId,scopeKey:'scope',repoKey:'wrong-repo',stages}),false);
  await writeFile(join(root,'b.js'),'export const b=2;\n');git('add','.');git('commit','-qm','HEAD drift');
  const afterKey=repositoryFingerprint(await captureRepoState(root));assert.notEqual(afterKey,repoKey);
  assert.equal(validateImplementationCheckpoint(checkpoint,{planId:artifact.planId,scopeKey:'scope',repoKey:afterKey,stages}),false);
  // The failed writer has loaded a stale snapshot in another process. The
  // kernel lock + revision token permits exactly one checkpoint update.
  const barrier=join(scratch,'barrier');
  const racer=(suffix)=>nodeProcess(`import {loadSession,saveSession} from './src/session-store.mjs';
    import {writeFile,access} from 'node:fs/promises';
    const s=await loadSession(${JSON.stringify(id)});
    await writeFile(${JSON.stringify(join(scratch,`ready-${suffix}`))},'1');
    for(let i=0;i<250;i++){try{await access(${JSON.stringify(barrier)});break;}catch{}
      await new Promise(r=>setTimeout(r,10));}
    s.title=${JSON.stringify(suffix)};
    try{await saveSession(${JSON.stringify(id)},s);console.log('saved');}
    catch(e){console.log(e.code??e.message);}`);
  const a=racer('A'),b=racer('B');
  for(let i=0;i<250;i++){
    try{await Promise.all(['A','B'].map(c=>access(join(scratch,`ready-${c}`))));break;}
    catch{await new Promise(r=>setTimeout(r,10));}
  }
  await writeFile(barrier,'go');
  const outcomes=await Promise.all([a,b]);
  assert.ok(outcomes.every(o=>o.code===0),JSON.stringify(outcomes));
  assert.deepEqual(outcomes.map(o=>o.stdout).sort(),['SESSION_REVISION_CONFLICT','saved']);
  const reread=await nodeProcess(`import {loadSession} from './src/session-store.mjs';
    const s=await loadSession(${JSON.stringify(id)});console.log(JSON.stringify({title:s.title,planId:s.implementationPlan.planId,
      reviews:s.reviewCheckpoint.reports.length,completed:s.implementationCheckpoint.completedStages.length}));`);
  assert.equal(reread.code,0,reread.stderr);const verified=JSON.parse(reread.stdout);
  assert.ok(['A','B'].includes(verified.title));assert.equal(verified.planId,artifact.planId);
  assert.equal(verified.reviews,1);assert.equal(verified.completed,1);
  // Filesystem-level evidence: no spurious temporary session snapshots.
  const persisted=JSON.parse(await readFile(join(stateDir,'sessions',`${id}.json`),'utf8'));
  assert.equal(persisted.implementationPlan.planId,artifact.planId);
  assert.equal(persisted.reviewCheckpoint.operation.taskSpec.operation,'review');
}finally{await rm(scratch,{recursive:true,force:true});}
console.log('prelive-state-restart: PASS (multiprocess Plan/Review and concurrency)');
