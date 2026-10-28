import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveReviewScope } from '../src/review-scope.mjs';
import { inspectReviewRelationships } from '../src/review-relationships.mjs';
import { buildReviewWorkPlan, batchesForRemaining, nextReviewBatch, assessReviewUnits, reviewWorkCoverage } from '../src/review-work-plan.mjs';
import { validateReviewCheckpoint, makeReviewCheckpoint } from '../src/review-checkpoint.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';

const cwd = await mkdtemp(join(tmpdir(), 'review-unit-scope-'));
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
try {
  git('init', '-q'); git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'review@example.invalid');
  await writeFile(join(cwd, 'initial.txt'), 'initial\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  await mkdir(join(cwd, 'src'));
  for (let i = 0; i < 9; i++) await writeFile(join(cwd, 'src', `file-${i}.ts`), `export const n=${i};\n`);
  git('add', '.'); git('commit', '-qm', 'NWOF-7976 add feature');
  const head = git('rev-parse', 'HEAD');
  // Typed selector replaces the former free-form language-driven Git scope.
  const range = await resolveReviewScope(cwd, {type:'range',left:base,right:'HEAD',notation:'...'});
  assert.equal(range.available, true);
  assert.equal(range.total, 9);
  assert.equal(range.selector, 'merge-base-range');
  const ticket = await resolveReviewScope(cwd, {type:'ticket_commits',ticket:'NWOF-7976'});
  assert.equal(ticket.available, true);
  assert.equal(ticket.total, 9);
  assert.equal(ticket.selector, 'commits-by-key');
  const historical = await resolveReviewScope(cwd, {type:'commit',ref:head});
  assert.equal(historical.available, true);
  assert.equal(historical.total, 9);
  assert.equal((await resolveReviewScope(cwd, null)).available, false);
  assert.equal((await resolveReviewScope(cwd, null)).required, true);
  assert.equal((await resolveReviewScope(cwd, {type:'range',left:'a',right:'HEAD',notation:'...'})).available, false);
  const explicit = { checks: [{ id: 'S1', description: 'Inspect behavior' }, { id: 'A1', description: 'Check regression' }], omitted: [], source: 'user' };
  const plan = buildReviewWorkPlan(explicit, range);
  assert.equal(plan.totalUnits, 5, '2 criteria + 3 separate file groups');
  assert.equal(plan.units.filter((u) => u.kind === 'file-group').length, 3);
  assert.deepEqual(batchesForRemaining(plan, [] ).map((batch) => batch.length), [2, 1, 2]);
  const fileGroup = plan.units.find((u) => u.kind === 'file-group');
  const bogus = { outputFormat: 'structured', output: { coverage: [
    { id: fileGroup.id, status: 'checked', evidence: 'I inspected all files in src/ and verified their behavior.', reviewedPaths: [fileGroup.paths[0]] },
  ] } };
  assert.equal(assessReviewUnits([fileGroup], bogus).records[0].status, 'not_checked', 'partial paths do not count');
  const noPerFileEvidence = { ...bogus, output: { coverage: [{ ...bogus.output.coverage[0], reviewedPaths: fileGroup.paths }] } };
  assert.equal(assessReviewUnits([fileGroup], noPerFileEvidence).records[0].status, 'not_checked', 'each path requires evidence');
  const completeRow = { id: fileGroup.id, status: 'checked', evidence: 'Read each assigned file and compared concrete changed behavior.', reviewedPaths: fileGroup.paths,
    fileEvidence: fileGroup.paths.map((path) => ({ path, evidence: `Inspected ${path}: checked its changed behavior.` })) };
  const assessed = assessReviewUnits([fileGroup], { outputFormat: 'structured', output: { coverage: [completeRow] } });
  assert.deepEqual(assessed.problems, []);
  const report = { batchId: fileGroup.id, unitIds: [fileGroup.id], outputFormat: 'structured',
    output: { verdict: 'pass', summary: 'Inspected assigned file group.', issues: [] } };
  const scopeKey = 'review-task-key', repoKey = 'workspace-hash';
  const saved = makeReviewCheckpoint({ scopeKey, plan, repoKey, status: 'in_progress', records: [assessed.records[0]], reports: [report] });
  assert.equal(saved.version, 2);
  assert.equal(validateReviewCheckpoint(saved, { scopeKey, repoKey, plan }).records.length, 1);
  assert.equal(batchesForRemaining(plan, saved.records.map((r) => r.id)).flat().some((u) => u.id === fileGroup.id), false);
  const tampered = structuredClone(saved);
  tampered.records[0].reviewedPaths.pop();
  assert.equal(validateReviewCheckpoint(tampered, { scopeKey, repoKey, plan }), null);
  assert.equal(validateReviewCheckpoint(saved, { scopeKey, repoKey: 'drift', plan }), null);
  assert.equal(validateReviewCheckpoint({ version: 1 }, { scopeKey, repoKey, plan }), null);
  const coverage = reviewWorkCoverage(explicit, plan, [assessed.records[0]]);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.files.verified, fileGroup.paths.length);
  assert.equal(coverage.units.pending, 4);
  const all = plan.units.map((u) => ({ id: u.id, status: 'checked', evidence: 'Inspected all required source contracts and tests.', reviewedPaths: u.paths,
    fileEvidence: u.paths.map((path) => ({ path, evidence: `Inspected ${path}: checked its changed behavior.` })) }));
  assert.equal(reviewWorkCoverage(explicit, plan, all).complete, true);
  assert.throws(() => buildReviewWorkPlan(explicit, range, { maxFilesPerUnit: 0 }), /Invalid review file-unit size/);
  assert.throws(() => batchesForRemaining(plan, [], { maxUnitsPerBatch: 0 }), /Invalid review batch limits/);
  const deniedScope = { ...range, paths: range.paths.slice(1), deniedCount: 1 };
  const deniedPlan = buildReviewWorkPlan(explicit, deniedScope);
  const deniedRows = deniedPlan.units.map((u) => ({ id: u.id, status: 'checked', evidence: 'Inspected permitted source.', reviewedPaths: u.paths,
    fileEvidence: u.paths.map((path) => ({ path, evidence: `Inspected ${path}: checked its changed behavior.` })) }));
  assert.equal(reviewWorkCoverage(explicit, deniedPlan, deniedRows).complete, false);
  assert.ok(reviewWorkCoverage(explicit, deniedPlan, deniedRows).gaps.some((gap) => gap.includes('inaccessible')));
  const changedScope = await resolveReviewScope(cwd, {type:'range',left:base,right:'HEAD',notation:'..'});
  assert.equal(changedScope.available, true);
  assert.notEqual(buildReviewWorkPlan(explicit, changedScope).planKey, plan.planKey, 'selector is part of scope key');
  await writeFile(join(cwd, 'src', 'file-10.ts'), 'new file\n');
  const worktree = await resolveReviewScope(cwd, {type:'worktree'});
  assert.equal(worktree.available, true);
  assert.equal(worktree.total, 1);
  assert.equal(worktree.paths[0].path, 'src/file-10.ts');
  // Subsystems, static changed-file dependencies, and criteria have separate
  // responsibilities: a matching criterion cannot pass before its source Unit.
  await mkdir(join(cwd, 'src', 'modules', 'auth'), { recursive: true });
  await mkdir(join(cwd, 'src', 'modules', 'checkout'), { recursive: true });
  await writeFile(join(cwd, 'src/modules/auth/core.ts'), 'export const auth = true;\n');
  await writeFile(join(cwd, 'src/modules/auth/core.test.ts'), "import { auth } from './core';\n");
  await writeFile(join(cwd, 'src/modules/checkout/payment.ts'), "import { auth } from '../auth/core';\n");
  git('add', '.'); git('commit', '-qm', 'Add subsystem dependencies');
  const dependScope = await resolveReviewScope(cwd, {type:'worktree'});
  // Explicit commit scope ensures the dependency scanner reads the immutable
  // Git tree, never a stale or unrelated working-tree file.
  const depCommit = await resolveReviewScope(cwd, {type:'commit',ref:git('rev-parse','HEAD')});
  const filtered = { ...depCommit, paths: depCommit.paths.filter((row) => row.path.includes('/modules/')) };
  filtered.relationships = await inspectReviewRelationships(cwd, filtered);
  assert.ok(filtered.relationships.some((row) => row.from.endsWith('checkout/payment.ts') && row.to.endsWith('auth/core.ts')));
  const semantic = buildReviewWorkPlan({ checks: [
    { id: 'S1', description: 'Verify auth core behavior' },
    { id: 'A1', description: 'Verify checkout payment behavior' },
  ], omitted: [], source: 'user' }, filtered, { maxFilesPerUnit: 2 });
  const authUnit = semantic.units.find((u) => u.kind === 'file-group' && u.subsystem.endsWith('auth'));
  const checkoutUnit = semantic.units.find((u) => u.kind === 'file-group' && u.subsystem.endsWith('checkout'));
  assert.deepEqual(authUnit.paths, ['src/modules/auth/core.test.ts', 'src/modules/auth/core.ts']);
  assert.deepEqual(checkoutUnit.dependencies, [authUnit.id]);
  assert.deepEqual(semantic.units.find((u) => u.id === 'CS1').dependencies, [authUnit.id]);
  assert.deepEqual(semantic.units.find((u) => u.id === 'CA1').dependencies, [checkoutUnit.id]);
  assert.deepEqual(nextReviewBatch(semantic, []).map((u) => u.id), [authUnit.id]);
  assert.deepEqual(nextReviewBatch(semantic, [], [authUnit.id]), [], 'failed dependency blocks downstream units');
  const readyAfterAuth = nextReviewBatch(semantic, [authUnit.id]);
  assert.ok(readyAfterAuth.some((u) => u.id === checkoutUnit.id));
  assert.ok(readyAfterAuth.some((u) => u.id === 'CS1'));
  const incomplete = reviewWorkCoverage({ checks: [{ id: 'A1', description: 'Check payment' }], omitted: [], source: 'user' },
    semantic, [{ id: checkoutUnit.id, status: 'checked', evidence: 'Inspected checkout code and verified behavior.' }]);
  assert.equal(incomplete.files.verified, 0, 'dependent evidence without prerequisites is not authoritative');
  const fakeRow = { id: checkoutUnit.id, status: 'checked', evidence: 'Inspected checkout code and verified behavior.',
    reviewedPaths: checkoutUnit.paths,
    fileEvidence: checkoutUnit.paths.map((path) => ({ path, evidence: `Inspected ${path} and verified source.` })) };
  const invalidCheckpoint = makeReviewCheckpoint({ scopeKey, repoKey, plan: semantic, status: 'in_progress',
    records: [fakeRow], reports: [{ batchId: checkoutUnit.id, unitIds: [checkoutUnit.id], outputFormat: 'structured',
      output: { verdict: 'pass', summary: 'Checked', issues: [] } }] });
  assert.equal(validateReviewCheckpoint(invalidCheckpoint, { scopeKey, repoKey, plan: semantic }), null,
    'missing prerequisite evidence must reject a persisted checkpoint');

  // Mutual imports must not produce an unexecutable dependency cycle.
  const cyclicScope = { ...filtered, relationships: [
    { from: 'src/modules/checkout/payment.ts', to: 'src/modules/auth/core.ts', relation: 'import' },
    { from: 'src/modules/auth/core.ts', to: 'src/modules/checkout/payment.ts', relation: 'import' },
  ] };
  const cyclePlan = buildReviewWorkPlan({ checks: [], omitted: [] }, cyclicScope);
  const allScheduled = batchesForRemaining(cyclePlan, [], { maxUnitsPerBatch: 1, batchLimit: 8 }).flat();
  assert.equal(allScheduled.length, 2, 'cyclic source references remain schedulable with deterministic break');

  const metrics = createEfficiencyRun('review-units-test');
  metrics.onEvent({ type: 'review_plan_created', total: 5, files: 9 });
  metrics.onEvent({ type: 'review_checkpoint_resumed', completed: 2, total: 5 });
  metrics.onEvent({ type: 'review_unit_started', unitId: 'F00001' });
  metrics.onEvent({ type: 'review_unit_completed', unitId: 'F00001', checked: true });
  metrics.onEvent({ type: 'review_continuation_ready', verified: 3, pending: 2, durable: true });
  const record = normalizeEfficiencyRuns([metrics.finish({ status: 'review_incomplete' })])[0];
  assert.deepEqual([record.reviewUnitsTotal, record.reviewUnitsVerified, record.reviewUnitsPending, record.reviewUnitsResumed], [5, 3, 2, 2]);
  console.log('review-work-plan: passed');
} finally { await rm(cwd, { recursive: true, force: true }); }
