import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, inferReviewTarget, loadInstructionContext, parseSlashInvocation } from '../src/context.mjs';

const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-context-'));
try {
  await mkdir(join(root, '.agents', 'skills', 'code-review'), { recursive: true });
  await writeFile(join(root, '.agents', 'skills', 'code-review', 'SKILL.md'), `---\nname: code-review\ndescription: Review code using project rules\nargument-hint: scope\n---\nReview carefully.\n`);
  await writeFile(join(root, 'AGENTS.md'), 'AGENTS RULE\n');
  await writeFile(join(root, '.rules'), 'PRIMARY RULE\n');

  const skills = await discoverSkills(root);
  const skill = skills.get('code-review');
  if (!skill || skill.description !== 'Review code using project rules' || skill.argumentHint !== 'scope') throw new Error('project skill discovery failed');

  const invocation = parseSlashInvocation('/code-review routing subsystem', skills);
  if (invocation.skillName !== 'code-review' || invocation.task !== 'routing subsystem') throw new Error('skill slash invocation failed');

  const review = parseSlashInvocation('/review current changes', skills);
  if (review.modeOverride !== 'review' || review.task !== 'current changes') throw new Error('review slash invocation failed');

  const genericSkill = parseSlashInvocation('/skill code-review routing subsystem', skills);
  if (genericSkill.skillName !== 'code-review' || genericSkill.task !== 'routing subsystem') throw new Error('generic /skill invocation failed');

  const reviewCommit = parseSlashInvocation('/review-commit 6a6e8ebff6 routing subsystem', skills);
  if (reviewCommit.modeOverride !== 'review' || reviewCommit.reviewTarget?.revision !== '6a6e8ebff6' || reviewCommit.task !== 'routing subsystem') {
    throw new Error('review-commit slash invocation failed');
  }

  const reviewCommitDefault = parseSlashInvocation('/review-commit 6a6e8ebff6', skills);
  if (reviewCommitDefault.reviewTarget?.revision !== '6a6e8ebff6' || reviewCommitDefault.task.includes('6a6e8ebff6')) {
    throw new Error('review-commit default task must not expose the source revision to model-facing task text');
  }

  const broadPlan = `Review NWOF-6494 completely.\n### Steps\n1. Git history includes 5b731f8d14 (breakpoint selection).\n2. Inspect all affected components.`;
  if (inferReviewTarget(broadPlan) !== null) throw new Error('historical SHA silently narrowed a full review');
  if (inferReviewTarget('Review commit 5b731f8d14\nConsider surrounding files') !== null) throw new Error('natural-language commit selection must use Router');
  if (inferReviewTarget({type:'commit',revision:'5b731f8d14'})?.revision !== '5b731f8d14') throw new Error('typed commit selection must be preserved');
  if (inferReviewTarget('Please review the feature; see commit 5b731f8d14 for context') !== null) throw new Error('incidental commit narrowed a full review');
  const slashReview = parseSlashInvocation(`/review ${broadPlan}`, skills);
  if (slashReview.reviewTarget !== null) throw new Error('slash review inferred a historical commit');
  const skillReview = parseSlashInvocation(`/code-review ${broadPlan}`, skills);
  if (skillReview.reviewTarget !== null) throw new Error('skill review inferred a historical commit');

  const instructions = await loadInstructionContext(root);
  const project = instructions.find((x) => x.scope === 'project');
  if (!project || project.path !== 'AGENTS.md' || !project.body.includes('AGENTS RULE')) throw new Error('project AGENTS.md should be canonical');
  if (instructions.some((row) => row.body.includes('PRIMARY RULE'))) throw new Error('legacy .rules was automatically loaded');

  console.log(JSON.stringify({ ok: true, context: 'passed' }));
} finally {
  await rm(root, { recursive: true, force: true });
}
