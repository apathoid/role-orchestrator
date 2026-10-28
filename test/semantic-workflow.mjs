import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadConfig} from '../src/config.mjs';
import {emptyTaskSpec} from '../src/routing/task-spec.mjs';
import {runWorkflow} from '../src/workflow.mjs';
import {planDigest,repositoryFingerprint} from '../src/implementation-stages.mjs';
import {captureRepoState} from '../src/repo.mjs';
class RouteSeen extends Error {}
const root=await mkdtemp(join(tmpdir(),'semantic-workflow-'));
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr)};
try{
 git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
 await writeFile(join(root,'a.js'),'export default 42;');git('add','.');git('commit','-qm','init');
 const config=await loadConfig({repoRoot:root,home:join(root,'unconfigured-home'),env:{}});
 config.policy.reviewEfficiency={...config.policy.reviewEfficiency,enabled:true};
 async function route(task,returned,{modeOverride=null,planOnly=false,onSelectSavedImplementation=null}={}){
   let calls=0,observed=null,scope=null,semantic=null,completed=null;
   const registry={resolveRole:role=>({role,profileName:'fake',providerName:'fake',profile:{model:'fake',contextWindow:32768}}),
     invokeRole:async role=>{calls++;assert.equal(role,'router');return {output:returned,outputFormat:'structured',meta:{elapsedMs:1,structuredOutput:{format:'structured'}},resolved:{profileName:'fake',providerName:'fake',profile:{model:'fake',contextWindow:32768}}};}};
   try{await runWorkflow({task,registry,config,repoStart:root,modeOverride,planOnly,onSelectSavedImplementation,reporter:async ev=>{
     if(ev.type==='semantic_intent_validation')semantic=ev;
     if(ev.type==='complete')completed=ev.result;
     if(ev.type==='review_execution_strategy')scope=ev;
     if(ev.type==='route'){observed=ev;throw new RouteSeen();}
   }});}catch(e){if(!(e instanceof RouteSeen))throw e;}
   assert.equal(calls,1,'one Router call, no extra semantic role');return {observed,scope,semantic,completed};
 }
 const intent={...emptyTaskSpec('review'),target:{kind:'git',selector:{type:'recent_commits',count:1}},
   constraints:{...emptyTaskSpec().constraints,reviewDepth:'deep'}};
 const review=await route('Проверь один последний коммит',{mode:'review',writeIntent:'not_requested',complexity:'high',risk:'architecture',reason:'test',task:intent});
 assert.equal(review.observed.classification.task.target.selector.type,'recent_commits');
 assert.equal(review.observed.policy.mode,'review');
 assert.equal(review.scope.strategy,'deep');
 const conflict=await route('Что это?',{mode:'investigate',writeIntent:'not_requested',complexity:'medium',risk:'normal',reason:'test',
   task:emptyTaskSpec('change','explicit')});
 assert.equal(conflict.completed.status,'intent_unresolved');
 assert.equal(conflict.observed,null);
 const ambiguous=await route('Не совсем ясно',{mode:'change',writeIntent:'ambiguous',complexity:'medium',risk:'normal',reason:'test',
   task:emptyTaskSpec('investigate')});
 assert.equal(ambiguous.completed.status,'intent_unresolved');
 const missing=await route('Проведи аудит',{mode:'review',writeIntent:'not_requested',complexity:'medium',risk:'normal',reason:'legacy'});
 assert.equal(missing.completed.status,'intent_unresolved');
 assert.equal(missing.semantic.status,'missing');
 const explain=await route('Почему не стоит запускать /change?',{mode:'investigate',writeIntent:'not_requested',complexity:'low',risk:'normal',reason:'test',
   task:emptyTaskSpec()});
 assert.equal(explain.observed.policy.mode,'investigate');
 const change=await route('Исправь код',{mode:'change',writeIntent:'explicit',complexity:'medium',risk:'architecture',reason:'test',
   task:emptyTaskSpec('change','explicit')});
 assert.equal(change.observed.policy.mode,'change');
 const plan={goal:'Modify a.js',steps:['Update the code'],acceptanceCriteria:['Source passes tests'],risks:[],expectedFiles:['a.js']};
 const artifact={version:1,repoRoot:root,planId:planDigest(plan),repoKey:repositoryFingerprint(await captureRepoState(root)),plan};
 let selections=0;
 const resume=await route('Продолжи реализацию сохранённого плана',{
   mode:'change',writeIntent:'explicit',complexity:'medium',risk:'architecture',reason:'continue',
   task:{...emptyTaskSpec('change','explicit'),continuation:{mode:'current_implementation'}}
 },{onSelectSavedImplementation:async choice=>{selections++;assert.equal(choice.mode,'current_implementation');return {plan:artifact};}});
 assert.equal(selections,1);
 assert.equal(resume.observed.policy.mode,'change');
 let forbiddenSelections=0;
 const question=await route('Почему выбран такой план?',{mode:'investigate',writeIntent:'not_requested',
   complexity:'low',risk:'normal',reason:'question',task:{...emptyTaskSpec(),continuation:{mode:'information'}}},
   {onSelectSavedImplementation:async()=>{forbiddenSelections++;throw Error('Not permitted');}});
 assert.equal(question.observed.policy.mode,'investigate');
 assert.equal(forbiddenSelections,0);
}finally{await rm(root,{recursive:true,force:true})}
console.log('semantic-workflow: PASS');
