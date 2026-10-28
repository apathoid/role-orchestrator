import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {emptyTaskSpec,validateTaskSpec} from '../src/routing/task-spec.mjs';
import {resolveReviewScope} from '../src/review-scope.mjs';
import {chooseReviewStrategy} from '../src/review-efficiency.mjs';
import {validateRouteConsistency} from '../src/routing/consistency.mjs';
const root=await mkdtemp(join(tmpdir(),'semantic-intent-'));
const git=(...args)=>{const x=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(x.status,0,x.stderr);return x.stdout.trim()};
const spec=(selector=null)=>({...emptyTaskSpec('review'),target:selector?{kind:'git',selector}:{kind:'none',selector:null}});
try{
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  for(let i=1;i<=5;i++){
    await writeFile(join(root,`file${i}.txt`),String(i));git('add','.');git('commit','-qm',`c${i}`);
  }
  const current=git('rev-parse','HEAD');
  const recent=validateTaskSpec(spec({type:'recent_commits',count:5}));
  const resolved=await resolveReviewScope(root,recent);
  assert.equal(resolved.status,'resolved');assert.equal(resolved.selector,'recent-first-parent');
  assert.equal(resolved.changesets.length,5);assert.equal(resolved.paths.length,5);
  assert.equal(resolved.revisions[0],current);
  const relative=await resolveReviewScope(root,spec({type:'relative_ref',ref:'HEAD~1'}));
  assert.equal(relative.status,'resolved');assert.equal(relative.paths.length,1);
  const sha=await resolveReviewScope(root,spec({type:'commit',ref:current}));
  assert.equal(sha.status,'resolved');assert.equal(sha.paths.length,1);
  const range=await resolveReviewScope(root,spec({type:'range',left:'HEAD~2',right:'HEAD',notation:'..'}));
  assert.equal(range.status,'resolved');assert.equal(range.paths.length,2);
  assert.equal((await resolveReviewScope(root,spec({type:'staged'}))).paths.length,0);
  assert.equal((await resolveReviewScope(root,spec({type:'unstaged'}))).paths.length,0);
  assert.equal((await resolveReviewScope(root,spec({type:'worktree'}))).paths.length,0);
  assert.equal((await resolveReviewScope(root,spec({type:'commit',ref:'unknown_branch'}))).available,false);
  assert.equal((await resolveReviewScope(root,spec())).available,false);
  assert.throws(()=>validateTaskSpec(spec({type:'recent_commits',count:129})),/invalid_recent_commit_count/);
  assert.throws(()=>validateTaskSpec(spec({type:'range',left:'--exec',right:'HEAD',notation:'..'})),/git_range/);
  assert.throws(()=>validateTaskSpec(spec({type:'worktree',cmd:'rm -rf /'})),/selector/);
  assert.throws(()=>validateTaskSpec({...emptyTaskSpec('change','explicit'),writeIntent:'ambiguous'}),/unauthorized_change/);
  const wrong=validateRouteConsistency({mode:'change',writeIntent:'explicit'},
    {taskSpec:emptyTaskSpec('investigate')});
  assert.equal(wrong.classification.mode,'investigate');
  const strategy=chooseReviewStrategy({scope:resolved,classification:{risk:'normal'},requirements:{reviewDepth:'deep'}});
  assert.equal(strategy.name,'deep');
  git('commit','--allow-empty','-qm','c6');
  const changed=await resolveReviewScope(root,recent);
  assert.notEqual(changed.revisionKey,resolved.revisionKey,'HEAD drift must produce a different scope fingerprint');
  // A combined user scope must preserve dirty worktree files AND all six commits.
  await writeFile(join(root,'untracked.txt'),'uncommitted');
  await writeFile(join(root,'staged.txt'),'staged');git('add','staged.txt');
  await writeFile(join(root,'file5.txt'),'modified without commit');
  const combined=validateTaskSpec({...emptyTaskSpec('change','explicit'),
    target:{kind:'git',selector:{type:'union',selectors:[{type:'recent_commits',count:6},{type:'worktree'}]}},
    constraints:{...emptyTaskSpec().constraints,priorityAreas:['незакоммиченный функционал','последние шесть коммитов']}});
  const combinedScope=await resolveReviewScope(root,combined);
  assert.equal(combinedScope.status,'resolved');
  assert.equal(combinedScope.selector,'union');
  assert.equal(combinedScope.changesets.length,7,'six commits plus one worktree changeset');
  assert(combinedScope.paths.some(row=>row.path==='untracked.txt'));
  assert(combinedScope.paths.some(row=>row.path==='staged.txt'));
  assert(combinedScope.paths.some(row=>row.path==='file5.txt'));
  assert(combinedScope.paths.some(row=>row.path==='file1.txt'));
}finally{await rm(root,{recursive:true,force:true})}
console.log('semantic-intent: PASS');
