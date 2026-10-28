import assert from 'node:assert/strict';
import { cleanPlanStep, normalizeImplementationPlan, planDigest, buildImplementationStages,
  assessImplementationStage, assessImplementationAcceptance, validateImplementationCheckpoint,
  repositoryFingerprint } from '../src/implementation-stages.mjs';
import { formatPlanMarkdown } from '../src/workflow.mjs';
import {emptyTaskSpec,validateTaskSpec} from '../src/routing/task-spec.mjs';
const saved={...emptyTaskSpec('change','explicit'),continuation:{mode:'saved_implementation'}};
assert.equal(validateTaskSpec(saved).continuation.mode,'saved_implementation');
assert.equal(validateTaskSpec({...emptyTaskSpec(),continuation:{mode:'information'}}).operation,'investigate');
assert.throws(()=>validateTaskSpec({...saved,writeIntent:'ambiguous'}),/invalid_implementation_continuation/);
assert.throws(()=>validateTaskSpec({...emptyTaskSpec('change'),writeIntent:'ambiguous'}),/task_spec_unauthorized_change/);
const input = { goal: 'Long plan', steps: ['1. First', '2. 2. Second', '3. Third', '4. Fourth', '5. Fifth'],
  acceptanceCriteria: ['a', 'b'], risks: [], expectedFiles: [], engineeringFrame: null };
const plan = normalizeImplementationPlan(input);
assert.deepEqual(plan.steps, ['First', 'Second', 'Third', 'Fourth', 'Fifth']);
assert.equal(cleanPlanStep('12. 12. Check state'), 'Check state');
assert.match(formatPlanMarkdown(input), /1\. First\n2\. Second\n3\. Third/);
assert.doesNotMatch(formatPlanMarkdown(input), /1\. 1\./);
// A saved Plan selection is typed, not inferred from quoted instructions.
assert.equal(validateTaskSpec(saved).writeIntent,'explicit');
assert.equal(buildImplementationStages(plan).length, 2);
const many = { ...plan, steps: Array.from({ length: 64 }, (_, i) => `step ${i}`) };
const groups = buildImplementationStages(many);
assert.ok(groups.length <= 12);
assert.equal(groups.flatMap((stage) => stage.steps).length, 64);
assert.equal(groups[0].steps[0].id, 'S1');
assert.equal(groups.at(-1).steps.at(-1).id, 'S64');
const group = groups[0];
const good = assessImplementationStage(group, { stepResults: group.steps.map((step) => ({ id: step.id,
  status: 'implemented', evidence: 'Checked exact change and matched request.' })) }, 'structured', { changedPaths: ['greeting.txt'] });
assert.equal(good.complete, true);
const proof = (outcome = 'passed') => ({ stepResults: [{ id: 'S4', status: 'implemented',
  proofKind: 'verification', evidence: 'Executed actual verification and recorded the result.',
  checks: [{ command: 'npm run check', outcome, evidence: 'Process exited with the captured outcome and console diagnostics.' }] }] });
const verificationStage = { id: 'I2', steps: [{ id: 'S4', description: 'Run verification' }] };
assert.equal(assessImplementationStage(verificationStage, proof(), 'structured').complete, true);
assert.ok(assessImplementationStage(verificationStage, proof('failed'), 'structured').issues.some((item) => item.includes('verification_failed')));
assert.ok(assessImplementationStage(verificationStage, proof('unavailable'), 'structured').issues.some((item) => item.includes('verification_unavailable')));
assert.ok(assessImplementationStage(verificationStage, { stepResults: [{ id:'S4', status:'implemented', proofKind:'verification', evidence:'Claimed test passed, without recording the command.', checks: [] }] }, 'structured').issues.some((x)=>x.includes('requires explicit executed check outcomes')));
assert.ok(assessImplementationStage(verificationStage, { stepResults: [{ id: 'S4', status: 'implemented', evidence: 'Verification passed without changes.' }] }, 'structured').issues.some((item) => item.includes('no file changes')));
assert.equal(assessImplementationStage(verificationStage, { stepResults: [{ id: 'S4', status: 'already_satisfied', evidence: 'Verified prior work remains satisfactory.' }] }, 'structured').complete, true);

assert.equal(assessImplementationStage(group, { stepResults: [] }, 'structured').complete, false);
assert.equal(assessImplementationStage(group, { stepResults: group.steps.map((step) => ({ id: step.id,
  status: 'blocked', evidence: 'not yet' })) }, 'structured').complete, false);
const review = { acceptanceResults: ['A1', 'A2'].map((id) => ({ id, status: 'verified', evidence: 'Read diff and test output independently.' })) };
assert.equal(assessImplementationAcceptance(plan.acceptanceCriteria, review, 'structured').complete, true);
assert.equal(assessImplementationAcceptance(plan.acceptanceCriteria, { acceptanceResults: [review.acceptanceResults[0]] }, 'structured').complete, false);
const repoKey = repositoryFingerprint({ head: 'abc', workspaceHashes: {}, gitMetadata: { stagedHash: 'z' } });
const checkpoint = { version: 1, planId: planDigest(plan), scopeKey: planDigest(plan), repoKey,
  completedStages: [groups[0].id], records: good.records };
assert.ok(validateImplementationCheckpoint(checkpoint, { planId: planDigest(plan), scopeKey: planDigest(plan), repoKey, stages: groups }));
assert.equal(validateImplementationCheckpoint({ ...checkpoint, records: [] }, { planId: planDigest(plan), scopeKey: planDigest(plan), repoKey, stages: groups }), false);
assert.equal(validateImplementationCheckpoint(checkpoint, { planId: planDigest(plan), scopeKey: planDigest(plan), repoKey: 'changed', stages: groups }), false);
console.log('implementation-stages: passed');
