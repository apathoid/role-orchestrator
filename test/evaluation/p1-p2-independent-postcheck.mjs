// Independent post-implementation red-team checks. This is intentionally
// separate from the acceptance scenarios used during implementation.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runVerification } from '../../src/repo.mjs';
import { ensureQuality, beginVerificationAttempt, evidenceMatrix, ingestWorkflowResult,
  recordFinding, recordEvidence, transitionFinding, resolveFinding, proposeDecision, resolveDecision } from '../../src/quality-state.mjs';
import { verificationCheckId, configuredVerificationInputClosures } from '../../src/verification-inputs.mjs';
import { scrubQualityStateFile } from '../../tools/scrub-quality-state.mjs';
const root = await mkdtemp(join(tmpdir(), 'quality-second-pass-'));
const repo = join(root, 'repo');
const oldCommands = process.env.AGENT_VERIFY_COMMANDS;
const oldClosures = process.env.AGENT_VERIFY_INPUT_CLOSURES;
const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
const task = () => ({ version: 1, taskId: 'audit-task',
  plan: { planId: 'audit-plan', plan: { steps: ['Verify'], acceptanceCriteria: ['Verifier passes'],
    acceptanceChecks: [{ id: 'A1', commands: ['node verify.mjs'] }] } } });
try {
  await mkdir(repo); git('init', '-q'); git('config', 'user.email', 'redteam@example.invalid'); git('config', 'user.name', 'RedTeam');
  await writeFile(join(repo, 'verify.mjs'), "if (process.env.FAIL_TEST === 'yes') process.exit(1);\n");
  await writeFile(join(repo, 'input.txt'), 'one\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'verify.mjs']]);
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({ 'node verify.mjs': {
    paths: ['input.txt', 'verify.mjs'], complete: true } });
  const checks = await runVerification(repo);
  const t = task();
  const base = { verification: checks, verificationAttempt: checks.attempt, verificationWorkspaceChanged: false, status: 'assessment',
    review: { verdict: 'pass', acceptanceResults: [{ id: 'A1', status: 'verified', evidence: 'node verify.mjs observed' }] } };
  await ingestWorkflowResult(t, base, repo);
  assert.equal((await evidenceMatrix(t, repo))[0].state, 'verified');
  const safeEnv = process.env.SAFE_TEST_MODE;
  process.env.SAFE_TEST_MODE = 'old';
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({ 'node verify.mjs': {
    paths: ['input.txt', 'verify.mjs'], complete: true, environment: ['SAFE_TEST_MODE'] } });
  const envChecks = await runVerification(repo);
  const envTask = task();
  await ingestWorkflowResult(envTask, { ...base, verification: envChecks,
    verificationAttempt: envChecks.attempt }, repo);
  assert.equal((await evidenceMatrix(envTask, repo))[0].state, 'verified');
  process.env.SAFE_TEST_MODE = 'new';
  assert.equal((await evidenceMatrix(envTask, repo))[0].state, 'revalidation_required');
  process.env.SAFE_TEST_MODE = safeEnv;
  assert.throws(() => configuredVerificationInputClosures(JSON.stringify({ 'node verify.mjs': {
    paths: ['input.txt'], complete: true, environment: ['ACCESS_TOKEN'] } })), /Invalid verification input closure/);
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({ 'node verify.mjs': {
    paths: ['input.txt', 'verify.mjs'], complete: true } });

  // A new attempt is authoritative even when it crashes before executing a command.
  beginVerificationAttempt(t, { id: 'crashed-before-first-command', phase: 'mandatory_final',
    requiredCheckIds: checks.attempt.requiredCheckIds, suiteId: checks.attempt.suiteId });
  assert.equal((await evidenceMatrix(t, repo))[0].state, 'not_verified');
  // Callback executes before the subprocess. An already-aborted controller
  // still leaves a start record visible to the persistence owner.
  const seen = [];
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runVerification(repo, { signal: controller.signal,
    onAttemptStart: async (attempt) => seen.push(attempt) }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 'started');
  // Check B modifies check A's dependency before the final verdict.
  await writeFile(join(repo, 'input.txt'), 'two\n');
  assert.equal((await evidenceMatrix({ ...t, quality: { ...t.quality,
    attempts: t.quality.attempts.slice(0, -1) } }, repo))[0].state, 'revalidation_required');
  // Lifecycle transition must not be approved by any unrelated PASS even when
  // evidence is deliberately constructed with otherwise valid-looking hashes.
  const bad = recordEvidence(t, { subject: { kind: 'finding', id: 'x' },
    source: { kind: 'tool_execution', checkId: verificationCheckId('node authorization.mjs') },
    claim: 'Authorization regression', assessment: 'observed', outcome: 'fail', runId: 'R1',
    dependencies: { kind: 'paths', completeness: 'complete', entries: [{ path: 'input.txt', fingerprint: 'a'.repeat(64) }] } });
  const finding = recordFinding(t, { message: 'Authorization fails', path: 'verify.mjs',
    contractId: 'authorization', reproductionKey: 'session-refresh' }, { evidenceIds: [bad.id] });
  transitionFinding(t, finding.id, 'confirmed', [bad.id]);
  const unrelated = recordEvidence(t, { subject: { kind: 'verification', id: 'lint' },
    source: { kind: 'tool_execution', checkId: verificationCheckId('node lint.mjs') },
    claim: 'Lint succeeds', assessment: 'observed', outcome: 'pass', inputsStable: true, runId: 'R2',
    dependencies: { kind: 'paths', completeness: 'complete', entries: [{ path: 'input.txt', fingerprint: 'b'.repeat(64) }] } });
  await assert.rejects(resolveFinding(t, finding.id, [unrelated.id], repo));
  assert.equal(finding.lifecycle, 'confirmed');
  // A previously invalidated gate gets a fresh id and remains pending.
  const binding = { planId: 'audit-plan', repositoryFingerprint: 'a'.repeat(64) };
  const request = { kind: 'remediation_scope', summary: 'Repair', rationale: 'Permission',
    options: [{ id: 'yes', description: 'Approve' }, { id: 'no', description: 'Decline' }], stateBinding: binding };
  const oldGate = proposeDecision(t, request);
  resolveDecision(t, oldGate.id, 'yes', { ...binding, repositoryFingerprint: 'b'.repeat(64) }, { userInitiated: true });
  const newGate = proposeDecision(t, request);
  assert.equal(newGate.status, 'pending'); assert.notEqual(newGate.id, oldGate.id);
  // Offline legacy scrub replaces known sensitive values atomically and
  // preserves unrelated session metadata and task identity.
  const filename = join(root, 'legacy.json');
  await writeFile(filename, JSON.stringify({ version: 2, sessionId: 'legacy', title: 'keep title',
    implementationTasks: [{ version: 1, taskId: 'legacy-task', quality: { version: 1, revision: 0,
      evidence: [{ claim: 'https://user:URLPASS_9000@example.com --token TOKVALUE_9000' }], findings: [], decisions: [] } }] }));
  assert.equal((await scrubQualityStateFile(filename)).modified, 1);
  const raw = await readFile(filename, 'utf8');
  assert(!raw.includes('URLPASS_9000') && !raw.includes('TOKVALUE_9000'));
  assert.equal(JSON.parse(raw).title, 'keep title');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await scrubQualityStateFile(filename)).modified, 0);
  console.log('evaluation/p1-p2-independent-postcheck: PASS (pre-exec crash, abort, post-verification drift, finding cross-link, reissued gate, atomic legacy scrub)');
} finally {
  if (oldCommands === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = oldCommands;
  if (oldClosures === undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES; else process.env.AGENT_VERIFY_INPUT_CLOSURES = oldClosures;
  await rm(root, { recursive: true, force: true });
}
