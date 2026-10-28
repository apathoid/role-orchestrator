import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineeringCheckpointForRole, engineeringContextForRole, engineeringFrameText } from '../src/engineering-policy.mjs';
import { assertShape } from '../src/schemas.mjs';
import { loadInstructionContext } from '../src/context.mjs';
import { roleInstructions } from '../src/roles.mjs';

const planner = await engineeringContextForRole('planner');
assert.match(planner, /semantic generality without speculative complexity/i);
assert.match(planner, /Engineering decision process/i);

const coder = await engineeringContextForRole('coder');
assert.match(coder, /Engineering Core/i);
assert.doesNotMatch(coder, /Engineering Review Rubric/i);

const reviewer = await engineeringContextForRole('reviewer');
assert.match(reviewer, /Engineering review rubric/i);
assert.match(reviewer, /valid alternative designs/i);

const finalValidator = await engineeringContextForRole('finalValidator');
assert.match(finalValidator, /Engineering Hard Invariants/i);
assert.doesNotMatch(finalValidator, /semantic generality without speculative complexity/i);

assert.equal(await engineeringContextForRole('router'), '');
assert.match(await engineeringCheckpointForRole('planner'), /engineeringFrame/i);
assert.match(await engineeringCheckpointForRole('coder'), /Before substantial edits/i);
assert.match(await engineeringCheckpointForRole('reviewer'), /concrete defect/i);
assert.match(await engineeringCheckpointForRole('finalValidator'), /hard invariant/i);
assert.equal(await engineeringCheckpointForRole('router'), '');

// Quality guidance must reach the relevant role at its existing decision point,
// without promoting it to a new hard-invariant or machine schema.
const planningCheckpoint = await engineeringCheckpointForRole('planner');
assert.match(planningCheckpoint, /acceptance criteria/i);
assert.match(planningCheckpoint, /observable/i);
assert.match(planningCheckpoint, /negative.*boundary.*integration.*regression.*lifecycle/i);
assert.match(planningCheckpoint, /without inventing speculative requirements/i);
assert.match(planner, /discriminating test/i);
assert.match(planner, /observed.*supported.*hypothesis.*unverified/is);
assert.match(roleInstructions.planner, /unverifiable criteria/i);

const implementationCheckpoint = await engineeringCheckpointForRole('coder');
assert.match(implementationCheckpoint, /observable results/i);
assert.match(implementationCheckpoint, /valid newly added regression test/i);
assert.match(implementationCheckpoint, /static inspection/i);
assert.match(roleInstructions.coder, /actual checks/i);

const reviewCheckpoint = await engineeringCheckpointForRole('reviewer');
assert.match(reviewer, /Acceptance and evidence quality/i);
assert.match(reviewCheckpoint, /plausible alternative/i);
assert.match(reviewCheckpoint, /unverified tests/i);
assert.match(roleInstructions.reviewer, /alternative causes/i);
assert.match(roleInstructions.investigator, /plausible alternatives/i);
// Investigator receives its precise contract, not the architecturally broader core.
assert.equal(await engineeringContextForRole('investigator'), '');

const validationCheckpoint = await engineeringCheckpointForRole('finalValidator');
assert.match(validationCheckpoint, /observed.*supported.*hypothesis.*unverified/is);
assert.match(validationCheckpoint, /known failing tests/i);
assert.match(validationCheckpoint, /do not.*convert an uncertain theory/i);
assert.match(roleInstructions.finalValidator, /evidence/i);
assert.doesNotMatch(finalValidator, /Acceptance and evidence quality/i);

// The global template is a sample, not a project-local instruction automatically
// loaded from this checkout; users opt in by placing it in their global config.
const template = await readFile(new URL('../examples/global/ORCHESTRATOR.md', import.meta.url), 'utf8');
assert.match(template, /Discovery is unrestricted\. Remediation is scope-aware\. Validation is independent\./);
assert.match(template, /Acceptance criteria quality/i);
assert.match(template, /Hypothesis validation/i);
assert.match(template, /Evidence calibration/i);
assert.match(template, /when authorized by task scope/i);
const sandbox = await mkdtemp(join(tmpdir(), 'role-orchestrator-quality-policy-'));
try {
  const home = join(sandbox, 'home');
  const project = join(sandbox, 'project');
  await mkdir(join(home, '.agents', 'role-orchestrator'), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(home, '.agents', 'role-orchestrator', 'ORCHESTRATOR.md'), template);
  await writeFile(join(project, 'AGENTS.md'), 'PROJECT CONVENTIONS TAKE PRECEDENCE.\n');
  const resolved = await loadInstructionContext(project, { home });
  assert.equal(resolved[0].scope, 'global-orchestrator');
  assert.equal(resolved[1].scope, 'project');
  assert.match(resolved[0].body, /Evidence calibration/);
  assert.match(resolved[1].body, /PROJECT CONVENTIONS TAKE PRECEDENCE/);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

const frame = { currentOwner: 'service', existingAbstractions: ['registry'] };
assert.deepEqual(JSON.parse(engineeringFrameText({ engineeringFrame: frame })), frame);
assert.match(engineeringFrameText({}), /not produced/i);


const validPlan = {
  goal: 'Implement a change.',
  steps: ['Inspect and edit.'],
  acceptanceCriteria: ['Behavior is correct.'],
  risks: [],
  expectedFiles: ['a.ts'],
  engineeringFrame: {
    currentOwner: 'feature/a',
    existingAbstractions: ['shared/base'],
    generalMechanism: 'Reusable mechanism.',
    specificPolicy: 'Feature-specific behavior.',
    targetPlacement: ['shared/base', 'feature/a'],
    stateOwnership: ['feature/a owns mutable state'],
    resourceOwnership: [],
    contractRisks: ['Preserve public API.'],
    avoid: ['Do not move feature policy into shared/base.'],
    uncertainties: [],
  },
};
assert.doesNotThrow(() => assertShape('plan', structuredClone(validPlan)));
assert.throws(() => assertShape('plan', { ...validPlan, engineeringFrame: undefined }), /engineeringFrame/);
assert.throws(() => assertShape('plan', { ...validPlan, engineeringFrame: { ...validPlan.engineeringFrame, resourceOwnership: undefined } }), /resourceOwnership/);

console.log('engineering-policy: passed');
