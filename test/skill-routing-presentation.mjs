import assert from 'node:assert/strict';
import { parseSlashInvocation } from '../src/context.mjs';
import { validateRouteConsistency } from '../src/routing/consistency.mjs';
import { emptyTaskSpec } from '../src/routing/task-spec.mjs';
import { ReviewNoProgressGuard } from '../src/review-progress.mjs';
import { normalizeFinalMarkdown } from '../src/response-normalization.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';

const skills = new Map([['changed', {name:'changed',body:'Describe commits using git', description:'Describe changes'}]]);
const args='по коммиту 2642156cc98f на ветке feature/NWOF-7976-git-status-deleted';
const a=parseSlashInvocation(`/changed ${args}`,skills);
assert.equal(a.skillInvocation?.source,'slash');
assert.equal(a.skillInvocation?.name,'changed');
assert.equal(a.skillInvocation?.arguments,args);
assert.equal(a.skillInvocation?.originalRequest,`/changed ${args}`);
assert.equal(a.task,args,'backwards-compatible routing task remains arguments');
const b=parseSlashInvocation(`/skill changed ${args}`,skills);
assert.equal(b.skillInvocation?.name,'changed');
for(const natural of [
  'Опиши последний коммит. Используй skill /changed.',
  'Примени скилл changed к последнему коммиту',
  'Use skill /changed to describe HEAD',
  '`Используй skill /changed`',
  'Как работает /changed?',
  'Не используй skill /changed',
  'Используй skill /not-present',
]) assert.equal(parseSlashInvocation(natural,skills).skillName,null,'Only Router can resolve a named natural-language skill');
assert.match(parseSlashInvocation('/not-present arg',skills).error,/UNKNOWN_COMMAND/);
assert.match(parseSlashInvocation('/skill not-present arg',skills).error,/SKILL_NOT_FOUND/);
const classification={mode:'review',writeIntent:'not_requested',complexity:'low',risk:'normal',reason:'model'};
assert.equal(validateRouteConsistency(classification,{userTask:'Не проверяй код',taskSpec:emptyTaskSpec('review')}).status,'accepted');
assert.equal(validateRouteConsistency(classification,{userTask:'Проверяй код',taskSpec:emptyTaskSpec('investigate')}).status,'rejected');
assert.equal(validateRouteConsistency(classification,{userTask:'Применить /change'}).status,'missing');

const guard = new ReviewNoProgressGuard();
assert.equal(guard.observe({ assigned:2, verified:0, outputFormat:'text',problems:[] }).blocked,false);
const stopped=guard.observe({ assigned:2, verified:0, outputFormat:'text',problems:[] });
assert.equal(stopped.blocked,true);
assert.equal(stopped.reason,'UNSTRUCTURED_REVIEW_OUTPUT');
assert.equal(guard.observe({ assigned:1,verified:1,outputFormat:'structured',problems:[] }).blocked,false);
assert.equal(guard.observe({ assigned:2,verified:0,outputFormat:'structured',problems:['A: missing_unit_result','B: missing_unit_result'] }).blocked,false);
assert.equal(guard.observe({ assigned:2,verified:0,outputFormat:'structured',problems:['C: missing_unit_result','D: missing_unit_result'] }).blocked,true);
const independent = new ReviewNoProgressGuard();
assert.equal(independent.observe({assigned:2,verified:0,outputFormat:'structured',problems:['a: reviewed_paths_not_verified']}).blocked,false);
assert.equal(independent.observe({assigned:2,verified:0,outputFormat:'structured',problems:['b: reviewed_paths_not_verified']}).blocked,false);
const invalidFiles=new ReviewNoProgressGuard();
assert.equal(invalidFiles.observe({assigned:2,verified:0,outputFormat:'structured',problems:['F1: reviewed_paths_not_verified','F2: reviewed_paths_not_verified']}).blocked,false);
assert.equal(invalidFiles.observe({assigned:2,verified:0,outputFormat:'structured',problems:['F3: reviewed_paths_not_verified','F4: reviewed_paths_not_verified']}).reason,'REPEATED_INVALID_FILE_EVIDENCE');

const wrapped='```markdown\n### Что было сделано\n- Два изменения\n```';
assert.equal(normalizeFinalMarkdown(wrapped),'### Что было сделано\n- Два изменения');
assert.equal(normalizeFinalMarkdown(wrapped,{preserveLiteral:true}),wrapped);
assert.equal(normalizeFinalMarkdown('```typescript\nconst x=1\n```'),'```typescript\nconst x=1\n```');
assert.equal(normalizeFinalMarkdown('Example:\n```markdown\n### heading\n```'),'Example:\n```markdown\n### heading\n```');
assert.equal(normalizeFinalMarkdown('```markdown\nnot a document\n```'),'```markdown\nnot a document\n```');

const run=createEfficiencyRun('p3-safe-123');
run.onEvent({type:'skill_invocation_resolved',source:'slash',status:'resolved',skillName:'SUPER_SECRET'});
run.onEvent({type:'route_validation',status:'corrected',reason:'explicit_explanation_not_code_review',unsafePrompt:'VERY_PRIVATE'});
run.onEvent({type:'review_progress_blocked',reason:'UNSTRUCTURED_REVIEW_OUTPUT',consecutiveBatches:2});
const exported=normalizeEfficiencyRuns([run.finish({status:'review_incomplete'})])[0];
assert.equal(exported.skillInvocationSource,'slash');
assert.equal(exported.routeValidationStatus,'corrected');
assert.equal(exported.reviewStopReason,'UNSTRUCTURED_REVIEW_OUTPUT');
assert.equal(exported.reviewNoProgressBatches,2);
assert(!JSON.stringify(exported).includes('SUPER_SECRET'));
assert(!JSON.stringify(exported).includes('VERY_PRIVATE'));
console.log('skill-routing-presentation: PASS');
