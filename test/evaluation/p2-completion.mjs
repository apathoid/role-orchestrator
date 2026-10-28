// P2 completion regressions: source-anchored acceptance, invalidation and
// evidence-backed finding repair. No live model or ACP SDK is required.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runVerification, planTargetedRevalidation, captureRepoState } from '../../src/repo.mjs';
import { repositoryFingerprint, planDigest, normalizeImplementationPlan } from '../../src/implementation-stages.mjs';
import { assertShape } from '../../src/schemas.mjs';
import { ingestWorkflowResult, evidenceMatrix, ensureQuality, proposeReconciliationDecision, reconciliationDecision, resolveDecision, currentDecisionBinding, expireReconciliationDecisions, proposeWorkflowDecision, applicableRiskAcceptance, assessRecovery } from '../../src/quality-state.mjs';

const dir = await mkdtemp(join(tmpdir(), 'role-orchestrator-p2-completion-'));
const repo = join(dir, 'repo');
const oldCommands = process.env.AGENT_VERIFY_COMMANDS;
const oldClosures = process.env.AGENT_VERIFY_INPUT_CLOSURES;
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const mkTask = (name, plan) => ({ version: 1, taskId: name,
  plan: { version: 1, planId: `${name}-plan`, plan }, checkpoint: null });
const snapshotKey = async () => repositoryFingerprint(await captureRepoState(repo));
const checks = async () => {
  const verification = await runVerification(repo);
  return { verification, verificationAttempt: verification.attempt, verificationWorkspaceChanged: false, verificationRepoKey: await snapshotKey() };
};
// Test-local verified input contracts; production must not trust a model's declaration.
const trusted = {
  'git diff --check': { paths: ['contract.mjs', 'other.mjs', 'behavior.mjs'], complete: true },
  'node check.mjs': { paths: ['check.mjs', 'behavior.mjs'], complete: true },
  'node check-one.mjs': { paths: ['contract.mjs', 'check-one.mjs'], complete: true },
  'node check-two.mjs': { paths: ['contract.mjs', 'check-two.mjs'], complete: true },
};
const ingestTrusted = (task, result, options = {}) => ingestWorkflowResult(task, result, repo,
  { trustedDependencyClosures: trusted, ...options });

try {
  await mkdir(repo);
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify(trusted);
  git('init', '-q'); git('config', 'user.email', 'p2-test@example.invalid'); git('config', 'user.name', 'P2 Test');
  await writeFile(join(repo, 'contract.mjs'), "export function keepContract(value) { return value ?? 'fallback'; }\n");
  await writeFile(join(repo, 'other.mjs'), "export const independent = true;\n");
  await writeFile(join(repo, 'behavior.mjs'), "export const behavior = 'broken';\n");
  await writeFile(join(repo, 'check.mjs'), "import { behavior } from './behavior.mjs'; if (behavior !== 'fixed') process.exit(1);\n");
  git('add', '.'); git('commit', '-qm', 'initial');
  const plan = { steps: ['Implement', 'Review'], acceptanceCriteria: ['Fallback is preserved'],
    acceptanceChecks: [{ id: 'A1', commands: [] }],
    acceptanceReviews: [{ id: 'A1', paths: ['contract.mjs'] }] };
  assert(normalizeImplementationPlan(plan));
  assert.notEqual(planDigest(plan), planDigest({ ...plan, acceptanceReviews: undefined }));
  const row = { id: 'A1', status: 'verified', evidence: 'Nullish fallback is preserved via ??',
    sourceAnchors: [{ path: 'contract.mjs', excerpt: "value ?? 'fallback'" }] };
  const sourceResult = { review: { verdict: 'pass', issues: [], acceptanceResults: [row] } };
  const source = mkTask('source', plan);
  await ingestWorkflowResult(source, sourceResult, repo);
  const matrix = await evidenceMatrix(source, repo);
  assert.equal(matrix[0].state, 'supported');
  assert.equal(matrix[0].proofMethod, 'source_attested_not_semantically_verified');
  assert(source.quality.evidence.some((e) => e.source.kind === 'static_review' && e.assessment === 'supported'));
  assert(!source.quality.evidence.some((e) => e.source.kind === 'tool_execution'));

  const noAnchors = mkTask('no-anchors', plan);
  await ingestWorkflowResult(noAnchors, { review: { ...sourceResult.review,
    acceptanceResults: [{ ...row, sourceAnchors: [] }] } }, repo);
  assert.equal((await evidenceMatrix(noAnchors, repo))[0].state, 'not_verified');
  const invented = mkTask('invented', plan);
  await ingestWorkflowResult(invented, { review: { ...sourceResult.review, acceptanceResults: [{ ...row,
    sourceAnchors: [{ path: 'contract.mjs', excerpt: 'this cannot exist in repository content' }] }] } }, repo);
  assert.equal((await evidenceMatrix(invented, repo))[0].state, 'not_verified');
  const undeclared = mkTask('undeclared', { ...plan, acceptanceReviews: undefined });
  await ingestWorkflowResult(undeclared, sourceResult, repo);
  assert.equal((await evidenceMatrix(undeclared, repo))[0].state, 'not_verified');
  const untrustedPath = mkTask('untrusted-path', { ...plan, acceptanceReviews: [{ id: 'A1', paths: ['../escape'] }] });
  await ingestWorkflowResult(untrustedPath, { review: { ...sourceResult.review, acceptanceResults: [{ ...row,
    sourceAnchors: [{ path: '../escape', excerpt: 'impossible external snippet' }] }] } }, repo);
  assert.equal((await evidenceMatrix(untrustedPath, repo))[0].state, 'not_verified');
  await writeFile(join(repo, 'other.mjs'), 'export const independent = false;\n');
  assert.equal((await evidenceMatrix(source, repo))[0].state, 'supported', 'unrelated file does not invalidate source attestation');
  await writeFile(join(repo, 'contract.mjs'), "export function keepContract(value) { return value ?? 'changed'; }\n");
  assert.equal((await evidenceMatrix(source, repo))[0].state, 'revalidation_required');

  const binding = { goal: 'Fix behavior', steps: ['Fix', 'Check'], acceptanceCriteria: ['Behavior works'],
    acceptanceChecks: [{ id: 'A1', commands: ['node check.mjs'] }] };
  const findingTask = mkTask('findings', binding);
  const originalCommands = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'check.mjs']]);
  const issue = { path: 'behavior.mjs', severity: 'major', message: 'Behavior is broken',
    evidence: 'node check.mjs fails', origin: 'introduced', taskRelation: 'requirement', remediationScope: 'in_scope' };
  const brokenChecks = await checks();
  assert.equal(brokenChecks.verification[0].status, 'TEST_FAILED');
  await ingestTrusted(findingTask, { ...brokenChecks,
    review: { verdict: 'fix', issues: [issue], acceptanceResults: [{ id: 'A1', status: 'blocked', evidence: 'node check.mjs fails' }] },
    finalValidation: { verdict: 'fix', issues: [issue] },
  });
  assert.equal(findingTask.quality.findings.length, 1);
  assert.equal(findingTask.quality.findings[0].lifecycle, 'confirmed');
  // A claim of success without a newer checkout cannot auto-resolve a failure.
  await ingestTrusted(findingTask, { ...brokenChecks,
    verification: brokenChecks.verification.map((c) => ({ ...c, status: 'PASS', exitCode: 0 })),
    review: { verdict: 'pass', issues: [] }, finalValidation: { verdict: 'pass', issues: [] },
  });
  assert.equal(findingTask.quality.findings[0].lifecycle, 'confirmed');
  await writeFile(join(repo, 'behavior.mjs'), "export const behavior = 'fixed';\n");
  const fixedChecks = await checks();
  assert.equal(fixedChecks.verification[0].status, 'PASS');
  await ingestTrusted(findingTask, { ...fixedChecks, changedPaths: ['other.mjs'],
    review: { verdict: 'pass', issues: [] }, finalValidation: { verdict: 'pass', issues: [] } });
  assert.equal(findingTask.quality.findings[0].lifecycle, 'confirmed', 'unrelated change cannot prove remediation');
  await ingestTrusted(findingTask, { ...fixedChecks, changedPaths: ['behavior.mjs'],
    review: { verdict: 'pass', issues: [] }, finalValidation: { verdict: 'pass', issues: [] } });
  assert.equal(findingTask.quality.findings[0].lifecycle, 'resolved');
  const resolvedCount = findingTask.quality.findings[0].transitions.length;
  await ingestTrusted(findingTask, { ...fixedChecks, changedPaths: ['behavior.mjs'],
    review: { verdict: 'pass', issues: [] }, finalValidation: { verdict: 'pass', issues: [] } });
  assert.equal(findingTask.quality.findings[0].transitions.length, resolvedCount, 'replayed success is idempotent');
  assert(ensureQuality(findingTask).findings[0].evidenceIds.length >= 2);
  process.env.AGENT_VERIFY_COMMANDS = originalCommands;

  assert.throws(() => assertShape('implementationReview', { verdict: 'pass', summary: 'ok', issues: [],
    acceptanceResults: [{ ...row, sourceAnchors: [{ path: 'contract.mjs', excerpt: 'short' }] }] }), /sourceAnchors/);
  // Multi-command acceptance must be ALL-of within the same observed run.
  // A single successful check, an older success, or a model PASS cannot
  // substitute for the missing/failing command.
  const multiPlan = { steps: ['Implement', 'Verify'], acceptanceCriteria: ['Both checks pass'],
    acceptanceChecks: [{ id: 'A1', commands: ['node check-one.mjs', 'node check-two.mjs'] }] };
  const multi = mkTask('multi-command', multiPlan);
  const observed = (command, status) => ({ command, status,
    exitCode: status === 'PASS' ? 0 : status === 'TEST_FAILED' ? 1 : null });
  const reviewAll = { verdict: 'pass', acceptanceResults: [{ id: 'A1', status: 'verified',
    evidence: 'node check-one.mjs and node check-two.mjs were exercised and reviewed' }] };
  const k = await snapshotKey();
  await ingestTrusted(multi, { verification: [observed('node check-one.mjs', 'PASS')],
    verificationRepoKey: k, review: reviewAll }, { runId: 'partial' });
  assert.equal((await evidenceMatrix(multi, repo))[0].state, 'not_verified');
  await ingestTrusted(multi, { verification: [observed('node check-two.mjs', 'PASS')],
    verificationRepoKey: k, review: reviewAll }, { runId: 'other-partial' });
  assert.equal((await evidenceMatrix(multi, repo))[0].state, 'not_verified', 'cannot join two distinct runs');
  // Run both configured commands, not model-synthesized check results.
  await writeFile(join(repo, 'check-one.mjs'), "process.exit(0);\n");
  await writeFile(join(repo, 'check-two.mjs'), "process.exit(1);\n");
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'check-one.mjs'], ['node', 'check-two.mjs']]);
  const failedRun = await checks();
  await ingestTrusted(multi, { ...failedRun, review: reviewAll }, { runId: 'failure' });
  assert.equal((await evidenceMatrix(multi, repo))[0].state, 'conflict');
  await writeFile(join(repo, 'check-two.mjs'), "process.exit(0);\n");
  const successfulRun = await checks();
  await ingestTrusted(multi, { ...successfulRun, review: reviewAll }, { runId: 'successful-rerun' });
  assert.equal((await evidenceMatrix(multi, repo))[0].state, 'verified', 'new independent full-suite observation resolves previous conflict');
  // A new incomplete attempt invalidates an older passing series.
  await ingestTrusted(multi, { verification: [], verificationAttempt: {
    ...successfulRun.verificationAttempt, id: 'unavailable-rerun', status: 'interrupted', observedCheckIds: [],
  }, review: reviewAll }, { runId: 'unavailable-rerun' });
  assert.equal((await evidenceMatrix(multi, repo))[0].state, 'not_verified', 'new incomplete verification cannot reuse older PASS');

  // Targeted recovery can only run commands from the actual configured suite.
  // It is diagnostic and never substitutes for final full verification.
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'check.mjs'], ['node', 'other.mjs']]);
  await writeFile(join(repo, 'other.mjs'), 'export const other = true;\n');
  const subset = await planTargetedRevalidation(repo, [{ action: 'rerun_configured_verification',
    command: 'node check.mjs' }]);
  assert.equal(subset.mode, 'targeted');
  assert.deepEqual(subset.commands, ['node check.mjs']);
  const subsetResults = await runVerification(repo, { onlyCommands: subset.commands });
  assert.deepEqual(subsetResults.map((x) => x.command), ['node check.mjs', 'git diff --check']);
  const malicious = await planTargetedRevalidation(repo, [{ action: 'rerun_configured_verification',
    command: 'sh -c rm -rf /' }]);
  assert.equal(malicious.mode, 'full_fallback');
  assert.rejects(runVerification(repo, { onlyCommands: ['sh -c rm -rf /'] }), /unconfigured command/);
  assert.equal((await planTargetedRevalidation(repo, [
    { action: 'rerun_configured_verification', command: 'node check.mjs' },
    { action: 'rerun_configured_verification', command: 'node other.mjs' },
  ])).mode, 'full_fallback', 'all affected means mandatory full suite instead of duplicated subset');
  process.env.AGENT_VERIFY_COMMANDS = originalCommands;

  // Independently corroborated nonblocking out-of-scope defects may prompt
  // risk acknowledgement, but the decision never changes task correctness.
  const riskTask = mkTask('risk', { steps: ['Verify', 'Review'], acceptanceCriteria: ['No whitespace errors'],
    acceptanceChecks: [{ id: 'A1', commands: ['git diff --check'] }] });
  const issueOutside = { path: 'other.mjs', severity: 'major', message: 'Missing unrelated contract invariant',
    evidence: 'other.mjs exports stale external contract, independently inspected',
    origin: 'preexisting', taskRelation: 'independent', remediationScope: 'outside_scope' };
  const passCommand = [{ command: 'git diff --check', status: 'PASS', exitCode: 0 }];
  const riskResult = { verification: passCommand, verificationRepoKey: await snapshotKey(),
    review: { verdict: 'fix', issues: [issueOutside], acceptanceResults: [{ id: 'A1', status: 'verified',
      evidence: 'git diff --check passes; other issue is independent' }] },
    finalValidation: { verdict: 'fix', issues: [issueOutside], assessment: { correctness: 'defect_confirmed' } },
    verificationDisposition: 'PASS', qualityAssessment: { complete: true },
    fixDisposition: { action: 'report_only', findings: [issueOutside] } };
  await ingestTrusted(riskTask, riskResult, { runId: 'corroborated-risk' });
  assert.equal(riskTask.quality.findings[0].lifecycle, 'confirmed');
  assert.equal(riskTask.quality.findings[0].confidence, 'supported', 'two model judgments are not observed execution');
  const riskGate = await proposeWorkflowDecision(riskTask, riskResult, repo);
  assert.equal(riskGate.kind, 'risk_acceptance');
  assert.deepEqual(await applicableRiskAcceptance(riskTask, repo), []);
  resolveDecision(riskTask, riskGate.id, 'acknowledge_risk', await currentDecisionBinding(riskTask, repo), { userInitiated: true });
  assert.equal((await applicableRiskAcceptance(riskTask, repo)).length, 1);
  assert.equal(riskTask.quality.findings[0].lifecycle, 'confirmed', 'risk acknowledgement is not remediation');
  // Same count and checkout, different finding identities: no permission carryover.
  const otherRisk = { ...issueOutside, message: 'Separate legacy contract fails' };
  const otherResult = { ...riskResult,
    review: { ...riskResult.review, issues: [otherRisk] },
    finalValidation: { ...riskResult.finalValidation, issues: [otherRisk] },
    fixDisposition: { action: 'report_only', findings: [otherRisk] } };
  await ingestTrusted(riskTask, otherResult, { runId: 'distinct-risk' });
  const otherGate = await proposeWorkflowDecision(riskTask, otherResult, repo);
  assert(otherGate && otherGate.id !== riskGate.id);
  assert.equal(otherGate.status, 'pending');
  assert.equal((await assessRecovery(riskTask, repo)).requiresApproval, false,
    'optional risk acknowledgement cannot block independent recovery');
  assert.equal((await applicableRiskAcceptance(riskTask, repo)).length, 1, 'other finding was never accepted');
  await writeFile(join(repo, 'other.mjs'), 'export const other = false;\n');
  assert.deepEqual(await applicableRiskAcceptance(riskTask, repo), [], 'stale risk acceptance cannot be silently reused');

  // Checkout reconciliation uses the same state-bound explicit choice channel.
  const reconTask = mkTask('reconciliation', binding);
  reconTask.reconciliation = { token: '123abc567def', planId: reconTask.plan.planId, repoKey: await snapshotKey(),
    analysis: { summary: 'Reviewed checkout source change; requires explicit acknowledgement.' } };
  const reconGate = await proposeReconciliationDecision(reconTask, reconTask.reconciliation, repo);
  assert.equal(reconGate.status, 'pending');
  assert.equal(reconGate.kind, 'checkout_reconciliation');
  assert.equal(await reconciliationDecision(reconTask, repo), null);
  assert.throws(() => resolveDecision(reconTask, reconGate.id, 'accept_checkout', reconGate.stateBinding), /host-verified/);
  resolveDecision(reconTask, reconGate.id, 'accept_checkout', await currentDecisionBinding(reconTask, repo), { userInitiated: true });
  assert.equal(await reconciliationDecision(reconTask, repo), 'accept_checkout');
  // Replacing the evaluated proposal (same checkout, different token) cannot
  // inherit authorization from the previous decision.
  const previouslyAccepted = reconGate.id;
  reconTask.reconciliation = { ...reconTask.reconciliation, token: 'abcabcabcabc' };
  const distinct = await proposeReconciliationDecision(reconTask, reconTask.reconciliation, repo);
  assert.notEqual(distinct.id, previouslyAccepted);
  assert.equal(await reconciliationDecision(reconTask, repo), null);
  await writeFile(join(repo, 'behavior.mjs'), "export const behavior = 'broken again';\n");
  assert.equal(await reconciliationDecision(reconTask, repo), null, 'old checkout approval is invalid after drift');
  reconTask.reconciliation = { ...reconTask.reconciliation, repoKey: await snapshotKey(), token: '123abc567dee' };
  const declined = await proposeReconciliationDecision(reconTask, reconTask.reconciliation, repo);
  resolveDecision(reconTask, declined.id, 'decline', await currentDecisionBinding(reconTask, repo), { userInitiated: true });
  assert.equal(await reconciliationDecision(reconTask, repo), 'decline');
  reconTask.reconciliation = null;
  expireReconciliationDecisions(reconTask);
  assert.equal(await reconciliationDecision(reconTask, repo), null);
  console.log('evaluation/p2-completion: passed (static source anchoring, schema, freshness, finding confirmation/revalidation/resolution, idempotence)');
} finally {
  if (oldClosures === undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES;
  else process.env.AGENT_VERIFY_INPUT_CLOSURES = oldClosures;
  if (oldCommands === undefined) delete process.env.AGENT_VERIFY_COMMANDS;
  else process.env.AGENT_VERIFY_COMMANDS = oldCommands;
  await rm(dir, { recursive: true, force: true });
}
