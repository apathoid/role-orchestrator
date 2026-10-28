import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveReviewScope } from '../src/review-scope.mjs';
import { buildReviewWorkPlan, reviewWorkCoverage, reviewProgressSnapshot } from '../src/review-work-plan.mjs';
import { validateReviewCheckpoint } from '../src/review-checkpoint.mjs';
import { reconcileReviewFindings } from '../src/review-findings.mjs';
import { sanitizeUnverifiedTestCounts, reviewVerificationEvidence, createReviewToolEvidenceObserver } from '../src/review-verification.mjs';
import { evaluateSecurityPath, validateSecurityConfig } from '../src/security.mjs';
import { createEfficiencyRun } from '../src/efficiency/analytics.mjs';
import { normalizeEfficiencyRuns } from '../src/session-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'review-scope-audit-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
  ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.org',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.org',
} }).trim();
const put = async (path, content) => {
  await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
  await writeFile(join(root, path), content);
};
const commit = (message) => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
try {
  git('init', '-q'); git('checkout', '-qb', 'main');
  await put('src/base.ts', 'export const base = 1;\n');
  commit('Base');
  await put('src/base.ts', 'export const base = 2;\n');
  const first = commit('NWOF-7976 update A');
  await put('src/feature.ts', 'export const feature = 1;\n');
  const second = commit('NWOF-7976 update B');
  // Non-ticket merge into main: one matching ticket merge must not hide the
  // two independently resolved ticket commits.
  git('checkout', '-qb', 'ticket-side', first);
  await put('src/other.ts', 'export const other = 1;\n');
  commit('Side branch');
  git('checkout', 'main');
  git('merge', '-q', '--no-ff', '-m', 'NWOF-7976 integrate branch', 'ticket-side');
  const merge = git('rev-parse', 'HEAD');
  const partial = await resolveReviewScope(root, {type:'ticket_commits',ticket:'NWOF-7976'});
  assert.equal(partial.status, 'partial');
  assert.equal(partial.available, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.unresolvedChanges, 1);
  assert.equal(partial.resolvedChanges, 2);
  assert.ok(partial.paths.some((x) => x.path === 'src/base.ts'));
  assert.ok(partial.paths.some((x) => x.path === 'src/feature.ts'));
  assert.ok(partial.unresolved[0].commit === merge);
  assert.ok(partial.paths.every((entry) => entry.changes.every((change) => change.commit !== merge)));
  const contract = { checks: [{ id: 'S1', description: 'Review changed source contracts' }], omitted: [], source: 'user' };
  const plan = buildReviewWorkPlan(contract, partial);
  const records = plan.units.map((u) => ({ id: u.id, status: 'checked', evidence: 'Reviewed source behavior and surrounding contracts.', reviewedPaths: u.paths,
    fileEvidence: u.paths.map((path) => ({ path, evidence: `Confirmed all source changes in ${path}.` })) }));
  const coverage = reviewWorkCoverage(contract, plan, records);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.units.pending, 0);
  assert.equal(coverage.scope.status, 'partial');
  assert.equal(coverage.files.total, null);
  assert.equal(coverage.files.totalKnown, false);
  assert.equal(coverage.files.known, 2);
  assert.ok(coverage.gapCodes.includes('SCOPE_PARTIAL'));
  const progress = reviewProgressSnapshot(coverage, { batches: 2, maxBatches: 8 });
  assert.equal(progress.batches, 2); assert.equal(progress.maxBatches, 8);
  const explicitTicket = await resolveReviewScope(root,
    {type:'ticket_commits',ticket:'NWOF-7976',mergeParentIndex:1});
  assert.equal(explicitTicket.status, 'resolved');
  assert.equal(explicitTicket.unresolvedChanges, 0);
  assert.ok(explicitTicket.paths.some((entry) => entry.path === 'src/other.ts'));
  assert.notEqual(explicitTicket.revisionKey, partial.revisionKey);
  const explicit = await resolveReviewScope(root, {type:'commit',ref:merge,mergeParentIndex:1});
  assert.equal(explicit.status, 'resolved');
  assert.equal(explicit.selector, 'commit');
  assert.equal((await resolveReviewScope(root, {type:'commit',ref:merge})).status, 'unresolved');
  assert.notEqual(explicit.revisionKey, partial.revisionKey);
  const differentPlan = buildReviewWorkPlan(contract, explicit);
  assert.notEqual(differentPlan.planKey, plan.planKey);
  assert.equal(validateReviewCheckpoint({ version: 2, scopeKey: 'one', planKey: plan.planKey },
    { scopeKey: 'one', repoKey: 'git', plan: differentPlan }), null);

  // The same file changed twice is one path but two change occurrences.
  await put('src/base.ts', 'export const base = 3;\n');
  commit('NWOF-7976 update C');
  const multiple = await resolveReviewScope(root, {type:'ticket_commits',ticket:'NWOF-7976'});
  assert.equal(multiple.paths.find((x) => x.path === 'src/base.ts').changes.length, 2);

  // Multiple parents must not be silently treated as first-parent ticket delta.
  git('checkout', '-qb', 'octo-a'); await put('a.txt', 'A'); commit('Octo A');
  git('checkout', 'main'); git('checkout', '-qb', 'octo-b'); await put('b.txt', 'B'); commit('Octo B');
  git('checkout', 'main'); git('merge', '-q', '--no-ff', '-m', 'NWOF-7976 octopus', 'octo-a', 'octo-b');
  const octo = git('rev-parse', 'HEAD');
  const octoScope = await resolveReviewScope(root, {type:'ticket_commits',ticket:'NWOF-7976'});
  assert.equal(octoScope.status, 'partial');
  assert.ok(octoScope.unresolved.some((x) => x.commit === octo && x.parentCount > 2));

  // Older rename must remain security-relevant when a newer matching commit
  // merely modifies the destination (the path-level entry is then M, not R).
  await put('secret/tokens.txt', 'private\n'); commit('Prepare private file');
  await mkdir(join(root, 'public'), { recursive: true });
  git('mv', 'secret/tokens.txt', 'public/tokens.txt'); commit('NWOF-7976 rename secret');
  await put('public/tokens.txt', 'private revised\n'); commit('NWOF-7976 modify destination');
  const renamed = await resolveReviewScope(root, {type:'ticket_commits',ticket:'NWOF-7976'});
  const renamedEntry = renamed.paths.find((entry) => entry.path === 'public/tokens.txt');
  assert.ok(renamedEntry.oldPaths.includes('secret/tokens.txt'));
  const policy = validateSecurityConfig({ denyGlobs: ['secret/**'] });
  const allPaths = [renamedEntry.path, renamedEntry.oldPath, ...renamedEntry.oldPaths,
    ...renamedEntry.changes.map((change) => change.oldPath)].filter(Boolean);
  assert.equal(allPaths.every((path) => !evaluateSecurityPath(path, policy).denied), false);

  const issue = (message, evidence, repro = 'R1') => ({ severity: 'major', path: 'src/base.ts', contractId: 'base',
    reproductionKey: repro, message, evidence });
  const findings = reconcileReviewFindings([
    issue('First defect', 'Observed error A'), issue('Same defect reworded', 'Observed error B'),
    issue('Second distinct defect', 'Observed error C', 'R2'),
  ]);
  assert.equal(findings.raw, 3);
  assert.equal(findings.unique, 2);
  assert.equal(findings.issues.some(item => item.evidence.includes('error B')),true,'all observations remain in their canonical group');
  assert.equal(reconcileReviewFindings([issue('a', 'one', 'R1'), issue('b', 'two', 'R2')]).unique, 2);

  const observer = createReviewToolEvidenceObserver();
  observer.observe({ type: 'role_tool_event', invocationId: 'one', update: { toolCallId: 't1', kind: 'execute', status: 'in_progress' } });
  observer.observe({ type: 'role_tool_event', invocationId: 'one', update: { toolCallId: 't1', status: 'completed' } });
  const observedEvidence = reviewVerificationEvidence([], observer.snapshot());
  assert.equal(observedEvidence.source, 'observed');
  assert.equal(observedEvidence.observedExecuteCalls, 1);
  assert.equal(observedEvidence.testCount, null);
  const evidence = reviewVerificationEvidence([]);
  assert.equal(evidence.testCount, null);
  assert.equal(evidence.testCountVerified, false);
  assert.ok(!sanitizeUnverifiedTestCounts('Пять наборов прошли: 102 теста успешно', evidence).includes('102 теста'));
  assert.ok(!sanitizeUnverifiedTestCounts('102 tests passed', evidence).includes('102 tests'));

  const meter = createEfficiencyRun('test-run');
  meter.onEvent({ type: 'review_plan_created', total: 3 });
  meter.onEvent({ type: 'review_batch_start', batch: 1, maxBatchesPerRun: 8 });
  meter.onEvent({ type: 'review_batch_done', batch: 1 });
  meter.onEvent({ type: 'review_progress', progress, rawFindings: 3, uniqueFindings: 2, potentialDuplicates: 0 });
  const run = meter.finish({ status: 'review_incomplete' });
  assert.equal(run.reviewBatches, 1);
  assert.equal(run.reviewBatchLimit, 8);
  assert.equal(run.reviewScopeStatus, 'partial');
  assert.equal(run.reviewFilesTotal, null);
  assert.equal(run.reviewFilesVerified, 2);
  const saved = normalizeEfficiencyRuns([run])[0];
  assert.equal(saved.reviewScopeStatus, 'partial');
  assert.equal(saved.reviewFilesTotal, null);
  assert.equal(saved.reviewFindingsRaw, 3);
  assert.equal(saved.reviewFindingsUnique, 2);
  console.log('review-scope-hardening: PASS');
} finally { await rm(root, { recursive: true, force: true }); }
