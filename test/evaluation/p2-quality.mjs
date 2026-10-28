// Deterministic P2 contract evaluation; source of executed checks is the
// host-neutral repo verifier, never a model's stepResults.checks assertion.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { captureRepoState, runVerification } from '../../src/repo.mjs';
import { repositoryFingerprint } from '../../src/implementation-stages.mjs';
import {
  ensureQuality, recordEvidence, recordFinding, transitionFinding, resolveFinding, ingestWorkflowResult,
  captureDependencies, freshnessOf, evidenceMatrix, assessRecovery, proposeWorkflowDecision,
  resolveDecision, currentDecisionBinding, applicableApproval, activeQuality,
} from '../../src/quality-state.mjs';
import { qualityView } from '../../src/quality-view.mjs';
import { saveSession, loadSession } from '../../src/session-store.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-p2-evaluation-'));
const previousState = process.env.AGENT_STATE_DIR;
const previousVerify = process.env.AGENT_VERIFY_COMMANDS;
const previousClosure = process.env.AGENT_VERIFY_INPUT_CLOSURES;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
const repo = join(scratch, 'repo');
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const makeTask = (id) => ({
  version: 1, taskId: id,
  plan: { version: 1, planId: `${id}-plan`, plan: {
    steps: ['Fix source', 'Test source', 'Review'], acceptanceCriteria: ['No whitespace errors'],
    acceptanceChecks: [{ id: 'A1', commands: ['git diff --check'] }],
  } }, checkpoint: null,
});
const fakeSession = (task) => ({ cwd: repo, repoRoot: repo, implementationTasks: [task],
  activeImplementationTaskId: task.taskId, implementationPlan: task.plan, transcript: [], history: [] });
const issue = { severity: 'major', origin: 'preexisting', taskRelation: 'dependency',
  remediationScope: 'outside_scope', path: 'a.txt', message: 'Observed regression in parser',
  evidence: 'git diff --check reproduces parser problem' };

try {
  await mkdir(repo);
  git('init', '-q'); git('config', 'user.email', 'p2@example.invalid'); git('config', 'user.name', 'P2');
  await writeFile(join(repo, 'a.txt'), 'alpha\n');
  await writeFile(join(repo, 'b.txt'), 'beta\n');
  git('add', '.'); git('commit', '-qm', 'initial');
  const task = makeTask('task-one');
  const command = 'git diff --check';
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({ 'git diff --check': { complete: true, paths: ['a.txt', 'b.txt'] } });
  const checks = await runVerification(repo); // real observed execution with explicit bounded inputs
  assert.equal(checks[0].exitCode, 0);
  const verifiedRepoKey = repositoryFingerprint(await captureRepoState(repo));
  const passResult = { status: 'applied', verification: checks, verificationAttempt: checks.attempt, verificationWorkspaceChanged: false, verificationRepoKey: verifiedRepoKey,
    review: { acceptanceResults: [{ id: 'A1', status: 'verified', evidence: `Executed ${command} to validate the absence of whitespace issues.` }] },
  };
  await ingestWorkflowResult(task, passResult, repo, { runId: 'p2-observed-pass',
    trustedDependencyClosures: { [command]: { paths: ['a.txt', 'b.txt'], complete: true } } });
  assert.equal((await evidenceMatrix(task, repo))[0].state, 'verified', 'observed successful command + explicit reviewed criterion binding');
  assert(task.quality.evidence.some((e) => e.source.kind === 'tool_execution' && e.outcome === 'pass'));

  // Model says it passed but no executed command; must NOT mint observed evidence.
  const modelOnly = makeTask('model-only');
  await ingestWorkflowResult(modelOnly, {
    review: { acceptanceResults: [{ id: 'A1', status: 'verified', evidence: 'I ran all checks successfully (model assertion).' }] },
  }, repo);
  assert.equal((await evidenceMatrix(modelOnly, repo))[0].state, 'not_verified');
  assert(modelOnly.quality.evidence.every((e) => e.source.kind === 'role_report'));

  const unrelatedCheck = makeTask('unrelated-check');
  unrelatedCheck.plan.plan.acceptanceChecks = [{ id: 'A1', commands: ['npm run semantic-test'] }];
  await ingestWorkflowResult(unrelatedCheck, passResult, repo);
  assert.equal((await evidenceMatrix(unrelatedCheck, repo))[0].state, 'not_verified',
    'a passing but semantically unrelated tool command cannot prove acceptance');

  // Observed failing code check conflicts with a model's positive claim.
  const failing = makeTask('failing');
  await ingestWorkflowResult(failing, {
    verification: [{ command, exitCode: 1, status: 'TEST_FAILED' }], verificationRepoKey: verifiedRepoKey,
    review: { acceptanceResults: [{ id: 'A1', status: 'verified', evidence: `Executed ${command}, all tests pass.` }] },
  }, repo, { trustedDependencyClosures: { [command]: { paths: ['a.txt', 'b.txt'], complete: true } } });
  assert.equal((await evidenceMatrix(failing, repo))[0].state, 'conflict');

  // An unavailable test is neither PASS nor a code defect.
  const unavailable = makeTask('unavailable');
  await ingestWorkflowResult(unavailable, {
    verification: [{ command, exitCode: null, status: 'ENVIRONMENT_ERROR' }], verificationRepoKey: verifiedRepoKey,
    review: { acceptanceResults: [{ id: 'A1', status: 'verified', evidence: `Executed ${command}.` }] },
  }, repo);
  assert.equal((await evidenceMatrix(unavailable, repo))[0].state, 'not_verified');
  assert(unavailable.quality.evidence.some((e) => e.outcome === 'unavailable'));

  // Exact path dependency: unrelated changes do not invalidate this claim.
  const boundA = await captureDependencies(repo, ['a.txt']);
  const bound = recordEvidence(task, { subject: { kind: 'contract', id: 'source-a' },
    claim: 'a content inspected', source: { kind: 'repository_inspection' },
    assessment: 'supported', dependencies: boundA });
  assert.equal(await freshnessOf(bound, repo), 'fresh');
  await writeFile(join(repo, 'b.txt'), 'changed unrelated file\n');
  assert.equal(await freshnessOf(bound, repo), 'fresh');
  assert.equal((await evidenceMatrix(task, repo))[0].state, 'revalidation_required', 'global checks conservatively become stale');
  await writeFile(join(repo, 'a.txt'), 'changed relevant content\n');
  assert.equal(await freshnessOf(bound, repo), 'stale');
  const unbound = recordEvidence(task, { subject: { kind: 'stage', id: 'unknown' }, claim: 'unbound test',
    source: { kind: 'role_report', role: 'coder' }, assessment: 'supported' });
  assert.equal(await freshnessOf(unbound, repo), 'unknown');

  // Durable findings, dedupe, independent scope, evidence-bound lifecycle.
  const finding = recordFinding(task, issue);
  const duplicate = recordFinding(task, { ...issue });
  assert.equal(duplicate.id, finding.id);
  assert.equal(task.quality.findings.length, 1);
  assert.equal(finding.lifecycle, 'candidate');
  assert.equal(finding.remediationAuthorization, 'requires_scope_check');
  await assert.rejects(resolveFinding(task, finding.id, [], repo), /requires saved evidence/);
  transitionFinding(task, finding.id, 'confirmed', [bound.id]);
  await assert.rejects(resolveFinding(task, finding.id, [bound.id], repo), /resolution requires/);
  const independentSourceReview = recordEvidence(task, {
    subject: { kind: 'finding', id: finding.id }, claim: 'Independent source review verified corrected contract',
    source: { kind: 'static_review', role: 'reviewer' }, assessment: 'supported', outcome: 'pass',
    dependencies: await captureDependencies(repo, ['a.txt']),
  });
  await assert.rejects(resolveFinding(task, finding.id, [independentSourceReview.id], repo), /resolution requires/,
    'anchored prose alone cannot resolve a confirmed defect');
  const priorBroken = recordEvidence(task, { subject: { kind: 'finding', id: finding.id },
    claim: 'Previously failing exact check', source: { kind: 'tool_execution', command },
    assessment: 'observed', outcome: 'fail', runId: 'failed-prior',
    dependencies: { kind: 'paths', completeness: 'complete', entries: [{ path: 'a.txt', fingerprint: '0'.repeat(64) }] } });
  transitionFinding(task, finding.id, 'confirmed', [priorBroken.id]);
  const observedRepair = recordEvidence(task, { subject: { kind: 'finding', id: finding.id },
    claim: 'Executed trusted repair regression', source: { kind: 'tool_execution', command },
    assessment: 'observed', outcome: 'pass', runId: 'fixed-later', inputsStable: true,
    dependencies: { ...(await captureDependencies(repo, ['a.txt'])), completeness: 'complete' } });
  await resolveFinding(task, finding.id, [observedRepair.id], repo);
  assert.equal(recordFinding(task, issue).lifecycle, 'resolved', 'repeat of an old report must not imply regression');
  assert.equal(task.quality.findings.length, 1);
  assert(task.quality.findings[0].transitions.length >= 4);
  recordFinding(task, { ...issue, severity: 'blocking' }, { source: 'finalValidator' });
  assert.equal(task.quality.findings[0].severity, 'major', 'stale model report must not escalate a resolved finding');
  const newBroken = recordEvidence(task, { subject: { kind: 'finding', id: finding.id },
    claim: 'Same exact verification fails again after repair', source: { kind: 'tool_execution', command },
    assessment: 'observed', outcome: 'fail', runId: 'regression-after-repair',
    dependencies: { kind: 'paths', completeness: 'complete', entries: [{ path: 'a.txt', fingerprint: 'c'.repeat(64) }] } });
  recordFinding(task, issue, { evidenceIds: [newBroken.id] });
  assert.equal(task.quality.findings[0].lifecycle, 'reopened');
  recordFinding(task, { ...issue, severity: 'blocking' }, { source: 'finalValidator' });
  assert.equal(task.quality.findings[0].severity, 'blocking');
  assert.equal(task.quality.findings[0].taskImpact, 'blocking');
  assert(task.quality.findings[0].transitions.some((t) => t.reason.startsWith('severity_escalated:')));
  recordFinding(task, { ...issue, severity: 'minor' });
  assert.equal(task.quality.findings[0].severity, 'blocking', 'do not silently downgrade confirmed severity');

  // Read-only recovery: saved stages reused, checkout drift requires reconciliation.
  task.checkpoint = { version: 1, planId: task.plan.planId, repoKey: verifiedRepoKey,
    status: 'interrupted', completedStages: ['I1'], interruptedStage: 'I2',
    repoSnapshot: { head: (await captureRepoState(repo)).head, workspaceHashes: {} } };
  const recovery = await assessRecovery(task, repo);
  assert.deepEqual(recovery.completedStages, ['I1']);
  assert.equal(recovery.nextStage, 'I2');
  assert.equal(recovery.checkoutDrift, true);
  assert.equal(recovery.recoverable, false);
  assert(recovery.requiredActions.includes('checkout_reconciliation_required'));
  assert(recovery.staleEvidenceIds.length > 0);
  assert(recovery.unknownEvidenceIds.length > 0);

  // Decisions have authoritative task & checkout bindings. Provider text
  // cannot resolve; an out-of-date choice invalidates instead of granting.
  const currentBinding = await currentDecisionBinding(task, repo);
  const result = { fixDisposition: { action: 'approval_required', findings: [issue] } };
  const gate = await proposeWorkflowDecision(task, result, repo);
  assert.equal(gate.status, 'pending');
  assert.equal((await proposeWorkflowDecision(task, result, repo)).id, gate.id);
  assert.throws(() => resolveDecision(task, gate.id, 'approve_scope', currentBinding), /host-verified/);
  assert.equal(resolveDecision(task, gate.id, 'approve_scope', currentBinding, { userInitiated: true }).status, 'resolved');
  assert.equal(resolveDecision(task, gate.id, 'approve_scope', currentBinding, { userInitiated: true }).selection, 'approve_scope');
  assert.equal((await applicableApproval(task, repo)).length, 1);
  await writeFile(join(repo, 'b.txt'), 'changed after approval\n');
  assert.equal((await applicableApproval(task, repo)).length, 0, 'stale approval may not be applied');
  assert.equal(resolveDecision(task, gate.id, 'approve_scope', await currentDecisionBinding(task, repo), { userInitiated: true }).status, 'invalidated');

  // Save alongside the task: atomic session JSON survives process restart;
  // legacy task without quality loads and projects empty quality, no corruption.
  const sessionId = 'evaluation-p2';
  const session = fakeSession(task);
  await saveSession(sessionId, session);
  const loaded = await loadSession(sessionId);
  assert.equal(loaded.implementationTasks[0].quality.findings[0].lifecycle, 'reopened');
  assert.equal(loaded.implementationTasks[0].quality.decisions[0].status, 'invalidated');
  assert.match(await qualityView(loaded, 'evidence'), /revalidation_required/);
  assert.match(await qualityView(loaded, 'findings'), /reopened/);
  assert.match(await qualityView(loaded, 'recovery'), /I2/);
  assert.match(await qualityView(loaded, 'decisions'), /invalidated/);
  const beforeReadonly = JSON.stringify(loaded);
  for (const kind of ['evidence', 'findings', 'recovery', 'decisions']) await qualityView(loaded, kind);
  assert.equal(JSON.stringify(loaded), beforeReadonly, 'read-only views must not mutate task state');
  assert.equal((await readFile(join(repo, 'a.txt'), 'utf8')), 'changed relevant content\n');
  const second = makeTask('independent');
  assert.equal(ensureQuality(second).findings.length, 0, 'independent tasks do not inherit findings');
  assert.equal(activeQuality(fakeSession(second)).state.decisions.length, 0);
  const legacy = fakeSession(makeTask('old'));
  await saveSession('legacy-p2', legacy);
  const old = await loadSession('legacy-p2');
  assert.equal(old.implementationTasks[0].quality, undefined);
  assert.match(await qualityView(old, 'findings'), /No recorded findings/);
  console.log('evaluation/p2-quality: passed (observed provenance, model-only claims, fail/unavailable, scoped freshness, findings lifecycle, approvals, restart, recovery, read-only views, independent tasks)');
} finally {
  if (previousState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = previousState;
  if (previousVerify === undefined) delete process.env.AGENT_VERIFY_COMMANDS;
  else process.env.AGENT_VERIFY_COMMANDS = previousVerify;
  if (previousClosure === undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES;
  else process.env.AGENT_VERIFY_INPUT_CLOSURES = previousClosure;
  await rm(scratch, { recursive: true, force: true });
}
