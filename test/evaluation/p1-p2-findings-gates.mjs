// N-01..N-03 regressions, including ordinary workflow calls, identity, restart
// and proof-bound reopening. No provider or ACP SDK is needed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { saveSession, loadSession } from '../../src/session-store.mjs';
import {
  recordFinding, recordEvidence, transitionFinding, resolveFinding, proposeWorkflowDecision,
  currentDecisionBinding, resolveDecision, applicableApproval, ensureQuality, findingIdentity, captureDependencies,
} from '../../src/quality-state.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'orchestrator-findings-gates-'));
const previousStore = process.env.AGENT_STATE_DIR;
process.env.AGENT_STATE_DIR = join(tmp, 'session-state');
const repo = join(tmp, 'repo');
const task = (id) => ({ version: 1, taskId: id, plan: { version: 1, planId: `${id}-plan`, plan: { acceptanceCriteria: [] } } });
const issue = (message, opts = {}) => ({ contractId: 'authorization', reproductionKey: 'session-refresh',
  path: 'src/auth.js', message, evidence: `Evidence: ${message}`, severity: 'major', ...opts });
const command = 'check-auth';
const deps = (fingerprint) => ({ kind: 'paths', completeness: 'complete', entries: [{ path: 'src/auth.js', fingerprint }] });
const check = (t, outcome, runId, fingerprint) => recordEvidence(t, {
  subject: { kind: 'finding', id: 'authorization' }, claim: `${command}: ${outcome}`,
  source: { kind: 'tool_execution', checkId: command }, assessment: 'observed', outcome,
  inputsStable: true, runId, dependencies: deps(fingerprint),
});
try {
  await mkdir(repo);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), 'test\n'); git('add', '.'); git('commit', '-qm', 'base');

  // N-01: changing a related finding invalidates a resolved gate automatically,
  // reissues a fresh pending gate and never reuses its previous approval.
  const t1 = task('n01');
  const f1 = recordFinding(t1, issue('Unauthorized access on session refresh'));
  const request = { fixDisposition: { action: 'approval_required', findings: [issue('Unauthorized access on session refresh')] } };
  const first = await proposeWorkflowDecision(t1, request, repo);
  assert.equal(first.status, 'pending');
  const binding = await currentDecisionBinding(t1, repo);
  resolveDecision(t1, first.id, 'approve_scope', binding, { userInitiated: true });
  assert.equal((await applicableApproval(t1, repo)).length, 1);
  recordFinding(t1, issue('Unauthorized access on session refresh', { severity: 'blocking' }));
  assert.deepEqual(await applicableApproval(t1, repo), []);
  const second = await proposeWorkflowDecision(t1, request, repo);
  assert.notEqual(second.id, first.id);
  assert.equal(first.status, 'invalidated');
  assert.equal(second.status, 'pending');
  assert.equal((await proposeWorkflowDecision(t1, request, repo)).id, second.id);
  assert.deepEqual(await applicableApproval(t1, repo), []);
  resolveDecision(t1, second.id, 'approve_scope', binding, { userInitiated: true });
  assert.equal((await applicableApproval(t1, repo)).length, 1);
  assert.equal(t1.quality.findings[0].id, f1.id);
  const reloaded1 = structuredClone(t1);
  assert.equal((await proposeWorkflowDecision(reloaded1, request, repo)).id, second.id);

  // A loaded legacy authorization with missing subject binding is not valid.
  const legacyGateTask = structuredClone(t1);
  const restoredGate = legacyGateTask.quality.decisions.find((d) => d.id === second.id);
  delete restoredGate.subjectStateKey;
  assert.deepEqual(await applicableApproval(legacyGateTask, repo), []);
  const freshForLegacy = await proposeWorkflowDecision(legacyGateTask, request, repo);
  assert.notEqual(freshForLegacy.id, second.id);
  assert.equal(freshForLegacy.status, 'pending');
  assert.equal(restoredGate.status, 'invalidated');

  // An unchanged explicit refusal is idempotent; changing a finding requires
  // a fresh decision instead of silently upgrading the old response.
  const tDecline = task('n01-decline');
  const declinedFinding = recordFinding(tDecline, issue('Refusal scenario'));
  const refusalRequest = { fixDisposition: { action: 'approval_required', findings: [issue('Refusal scenario')] } };
  const refusal = await proposeWorkflowDecision(tDecline, refusalRequest, repo);
  resolveDecision(tDecline, refusal.id, 'decline', await currentDecisionBinding(tDecline, repo), { userInitiated: true });
  assert.equal((await proposeWorkflowDecision(tDecline, refusalRequest, repo)).id, refusal.id);
  recordFinding(tDecline, issue('Refusal scenario', { severity: 'blocking' }));
  const retryAfterChange = await proposeWorkflowDecision(tDecline, refusalRequest, repo);
  assert.notEqual(retryAfterChange.id, refusal.id);
  assert.equal(retryAfterChange.status, 'pending');
  assert.equal(declinedFinding.severity, 'blocking');

  // N-02: insufficiently specific contract + reproducer must not erase two
  // distinct assertions. Similar findings are only suggestions for merging.
  const t2 = task('n02');
  const x = issue('Anonymous user can read admin page', { evidence: 'GET /admin returns 200' });
  const y = issue('Anonymous user can change account password', { evidence: 'POST /password returns 200' });
  const fa = recordFinding(t2, x);
  const fb = recordFinding(t2, y);
  assert.notEqual(fa.id, fb.id);
  assert.notEqual(fa.identity, fb.identity);
  assert.equal(ensureQuality(t2).findings.length, 2);
  assert(fb.possibleDuplicateIds.includes(fa.id));
  assert.equal(recordFinding(t2, x).id, fa.id);
  // No dedup based only on same assertion text when the reproduced observation differs.
  const fc = recordFinding(t2, { ...x, evidence: 'Different independently reproduced defect' });
  assert.notEqual(fc.id, fa.id);
  assert.equal(structuredClone(t2).quality.findings.length, 3);

  // A pre-v3 finding is loaded without rewriting its stable identity or
  // silently transferring its scope approval to another assertion.
  const legacyFindingTask = task('legacy-finding');
  const legacyIssue = issue('Legacy authorization error');
  const legacyFinding = recordFinding(legacyFindingTask, legacyIssue);
  legacyFinding.identityVersion = 2;
  legacyFinding.identity = 'f'.repeat(64);
  assert.equal(recordFinding(legacyFindingTask, legacyIssue).id, legacyFinding.id);
  const legacyProposal = { fixDisposition: { action: 'approval_required', findings: [legacyIssue] } };
  const legacyGate = await proposeWorkflowDecision(legacyFindingTask, legacyProposal, repo);
  assert.deepEqual(legacyGate.findingKeys, [legacyFinding.identity]);
  resolveDecision(legacyFindingTask, legacyGate.id, 'approve_scope',
    await currentDecisionBinding(legacyFindingTask, repo), { userInitiated: true });
  assert.deepEqual(new Set(await applicableApproval(legacyFindingTask, repo)),
    new Set([legacyFinding.identity, findingIdentity(legacyIssue)]));
  const distinctLegacy = issue('Different authorization violation');
  const newFinding = recordFinding(legacyFindingTask, distinctLegacy);
  assert.notEqual(newFinding.id, legacyFinding.id);
  assert.notEqual(newFinding.identity, legacyFinding.identity);
  assert(!(await applicableApproval(legacyFindingTask, repo)).includes(newFinding.identity),
    'legacy scope must never authorize another issue with shared broad reproduction fields');

  // N-03: the model repeating a resolved finding is NOT regression evidence.
  const t3 = task('n03');
  const oldFailure = check(t3, 'fail', 'old-fail', 'a'.repeat(64));
  const issue3 = issue('Authorization check rejects valid user');
  const f3 = recordFinding(t3, issue3, { evidenceIds: [oldFailure.id] });
  transitionFinding(t3, f3.id, 'confirmed', [oldFailure.id]);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/auth.js'), 'export const authorized = true;\n');
  const repairHash = (await captureDependencies(repo, ['src/auth.js'])).entries[0].fingerprint;
  const repair = check(t3, 'pass', 'repair-pass', repairHash);
  await resolveFinding(t3, f3.id, [repair.id], repo);
  assert.equal(recordFinding(t3, issue3).lifecycle, 'resolved');
  assert.equal(recordFinding(t3, issue3, { evidenceIds: [oldFailure.id] }).lifecycle, 'resolved');
  assert.throws(() => transitionFinding(t3, f3.id, 'reopened', [oldFailure.id]), /reopen|regression/i);
  await saveSession('n03-resolved-session', {
    cwd: repo, repoRoot: repo, createdAt: new Date().toISOString(),
    implementationTasks: [t3], activeImplementationTaskId: t3.taskId,
    implementationPlan: t3.plan, history: [], transcript: [],
  });
  const persisted = await loadSession('n03-resolved-session');
  const reloaded3 = persisted.implementationTasks[0];
  assert.equal(recordFinding(reloaded3, issue3).lifecycle, 'resolved');
  const newFailure = check(reloaded3, 'fail', 'regression-run', 'c'.repeat(64));
  assert.equal(recordFinding(reloaded3, issue3, { evidenceIds: [newFailure.id] }).lifecycle, 'reopened');
  assert(reloaded3.quality.findings[0].transitions.some((tr) => tr.reason === 'new_observed_regression'));
  assert.equal(recordFinding(reloaded3, issue3).lifecycle, 'reopened');
  // False claims about another check do not reopen this finding.
  const t4 = structuredClone(t3);
  const unrelated = recordEvidence(t4, { subject: { kind: 'finding', id: 'other' }, claim: 'unrelated fail',
    source: { kind: 'tool_execution', checkId: 'unrelated' }, assessment: 'observed', outcome: 'fail',
    runId: 'newer', dependencies: deps('d'.repeat(64)) });
  assert.equal(recordFinding(t4, issue3, { evidenceIds: [unrelated.id] }).lifecycle, 'resolved');
  console.log('evaluation/p1-p2-findings-gates: PASS (N-01/N-02/N-03 + replay + lifecycle)');
} finally {
  if (previousStore === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = previousStore;
  await rm(tmp, { recursive: true, force: true });
}
