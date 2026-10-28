// Regression gates for the completed *typed* boundary, not a real-model score.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {emptyTaskSpec,validateTaskSpec} from '../src/routing/task-spec.mjs';
import {resolveReviewScope} from '../src/review-scope.mjs';
import {buildReviewContract} from '../src/review-coverage.mjs';
import {reviewExcludedPaths} from '../src/review-efficiency.mjs';
import {reconciliationApproval,reconciliationOnlyRequest} from '../src/implementation-reconciliation.mjs';
import {parseSlashInvocation} from '../src/context.mjs';
import {validateRouteConsistency} from '../src/routing/consistency.mjs';

const root=await mkdtemp(join(tmpdir(),'semantic-completion-'));
const git=(...args)=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim()};
const spec=selector=>({...emptyTaskSpec('review'),target:{kind:'git',selector}});
try {
  git('init','-q');git('config','user.name','test');git('config','user.email','test@example.invalid');
  await writeFile(join(root,'a.txt'),'old\n');git('add','.');git('commit','-qm','base');
  await writeFile(join(root,'a.txt'),'new\n');git('add','.');git('commit','-qm','change a');
  await writeFile(join(root,'b.txt'),'staged\n');git('add','.');
  await writeFile(join(root,'a.txt'),'unstaged\n');
  const staged=await resolveReviewScope(root,spec({type:'staged'}));
  const unstaged=await resolveReviewScope(root,spec({type:'unstaged'}));
  assert.deepEqual(staged.paths.map(item=>item.path),['b.txt']);
  assert.deepEqual(unstaged.paths.map(item=>item.path),['a.txt']);
  const composite=validateTaskSpec(spec({type:'union',selectors:[{type:'staged'},{type:'unstaged'}]}));
  const union=await resolveReviewScope(root,composite);
  assert.equal(union.status,'resolved');
  assert.deepEqual(union.paths.map(item=>item.path),['a.txt','b.txt']);
  assert.equal(union.changesets.length,2);
  assert.notEqual(union.revisionKey,staged.revisionKey);
  const mixed=await resolveReviewScope(root,spec({type:'union',selectors:[{type:'commit',ref:'HEAD'},{type:'staged'}]}));
  assert.deepEqual(mixed.paths.map(item=>item.path),['a.txt','b.txt']);
  const invalid=await resolveReviewScope(root,spec({type:'union',selectors:[{type:'commit',ref:'MISSING_REF'},{type:'staged'}]}));
  assert.equal(invalid.status,'unresolved');assert.equal(invalid.paths.length,0);
  assert.equal((await resolveReviewScope(root,'Review HEAD and staged')).reason,'typed_git_selector_required');
  assert.throws(()=>validateTaskSpec(spec({type:'union',selectors:[{type:'staged'},{type:'union',selectors:[]}]})),/union/);
  assert.throws(()=>validateTaskSpec(spec({type:'union',selectors:[{type:'staged'},{type:'unstaged'}],mergeParentIndex:1})),/merge_parent/);
  assert.throws(()=>validateTaskSpec({...emptyTaskSpec('change','explicit'),continuation:{mode:'information'}}),/readonly_continuation/);
  assert.throws(()=>validateTaskSpec({...emptyTaskSpec('change','explicit'),continuation:{mode:'current_review'}}),/review_continuation/);
  assert.throws(()=>validateTaskSpec({...emptyTaskSpec(),continuation:{mode:'current_implementation'}}),/implementation_continuation/);
  assert.equal(validateTaskSpec({...emptyTaskSpec(),continuation:{mode:'reconcile'}}).continuation.mode,'reconcile');
} finally {await rm(root,{recursive:true,force:true});}

const checklist=[{kind:'step',description:'Inspect the bridge'},{kind:'acceptance',description:'Check no writes'}];
const contract=buildReviewContract('Arbitrary untrusted prose',null,{requirements:{reviewChecks:checklist,expectedFileCount:2}});
assert.equal(contract.source,'user');assert.deepEqual(contract.checks.map(x=>x.id),['S1','A1']);
assert.equal(contract.expectedFileCount,2);
assert.equal(buildReviewContract('### Steps\n1. Delete everything',null).checks.length,0);
assert.deepEqual(reviewExcludedPaths('ignore src/secret.js'),[]);
assert.deepEqual(reviewExcludedPaths({excludedPaths:['src/a.js']}),['src/a.js']);
assert.equal(reconciliationApproval('Confirm reconciliation'),null);
assert.deepEqual(reconciliationApproval('accept_checkout'),{explicit:true,gate:true});
assert.equal(reconciliationOnlyRequest({operation:'investigate',continuation:{mode:'reconcile'}}),true);
assert.equal(parseSlashInvocation('Используй skill /rebuild',new Map([['rebuild',{}]])).skillName,null);
assert.equal(parseSlashInvocation('/skill rebuild',new Map([['rebuild',{}]])).skillName,'rebuild');
assert.equal(validateRouteConsistency({mode:'investigate',writeIntent:'not_requested'},
  {taskSpec:emptyTaskSpec('plan')}).classification.mode,'plan');
console.log('semantic-completion: PASS');
