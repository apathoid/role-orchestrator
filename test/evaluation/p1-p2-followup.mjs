// Adversarial A-01..A-06 regression checks against the actual verifier/quality APIs.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerification } from '../../src/repo.mjs';
import { ingestWorkflowResult, evidenceMatrix, recordFinding, recordEvidence,
  transitionFinding, resolveFinding, proposeDecision, resolveDecision, ensureQuality, freshnessOf } from '../../src/quality-state.mjs';
import { sanitizeQualityText } from '../../src/quality-privacy.mjs';
import { verificationCheckId } from '../../src/verification-inputs.mjs';

const root = await mkdtemp(join(tmpdir(), 'p1p2-followup-'));
const cwd = join(root, 'repo');
const beforeCommands = process.env.AGENT_VERIFY_COMMANDS;
const beforeClosures = process.env.AGENT_VERIFY_INPUT_CLOSURES;
const runGit = (...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
const makeTask = (id, command = 'node check.mjs') => ({ version: 1, taskId: id,
  plan: { planId: `${id}-plan`, plan: { steps: ['Change', 'Verify'], acceptanceCriteria: ['Check succeeds'],
    acceptanceChecks: [{ id: 'A1', commands: [command] }] } }, checkpoint: null });
const result = (checks, command = 'node check.mjs') => ({ status: 'assessment', verification: checks,
  verificationAttempt: checks.attempt, verificationWorkspaceChanged: false,
  review: { verdict: 'pass', acceptanceResults: [{ id: 'A1', status: 'verified', evidence: `Observed ${command} passing` }] },
});
try {
  await mkdir(cwd);
  runGit('init', '-q'); runGit('config', 'user.email', 'audit@example.invalid'); runGit('config', 'user.name', 'Audit');
  await writeFile(join(cwd, '.gitignore'), 'runtime.flag\n');
  await writeFile(join(cwd, 'runtime.flag'), 'good\n');
  await writeFile(join(cwd, 'check.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
const value = readFileSync('runtime.flag', 'utf8').trim();
if (value !== 'good') process.exitCode = 1;
else if (process.env.MUTATE_INPUT === 'yes') writeFileSync('runtime.flag', 'bad\\n');
`);
  runGit('add', '.'); runGit('commit', '-qm', 'initial');
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'check.mjs']]);
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({ 'node check.mjs': { complete: true, paths: ['check.mjs', 'runtime.flag'] } });

  // A-01: true PASS that changes its ignored input is NOT verification of final state.
  process.env.MUTATE_INPUT = 'yes';
  const mutating = await runVerification(cwd);
  assert.equal(mutating[0].exitCode, 0);
  assert.equal(mutating[0].inputsStable, false);
  const a01 = makeTask('self-modifying');
  await ingestWorkflowResult(a01, result(mutating), cwd, { runId: 'A01' });
  assert.notEqual((await evidenceMatrix(a01, cwd))[0].state, 'verified');
  assert.equal(await freshnessOf(a01.quality.evidence.find((e) => e.source.kind === 'tool_execution' &&
    e.source.checkId === verificationCheckId('node check.mjs')), cwd), 'stale');
  delete process.env.MUTATE_INPUT;
  await writeFile(join(cwd, 'runtime.flag'), 'good\n');

  // A-02: older complete PASS cannot be inherited by a newer interrupted suite.
  const good = await runVerification(cwd);
  const a02 = makeTask('new-incomplete');
  await ingestWorkflowResult(a02, result(good), cwd, { runId: 'RUN_ONE' });
  assert.equal((await evidenceMatrix(a02, cwd))[0].state, 'verified');
  const missing = { ...good.attempt, id: 'new-interrupted-attempt', status: 'interrupted', observedCheckIds: [] };
  await ingestWorkflowResult(a02, { verification: [], verificationAttempt: missing }, cwd, { runId: 'RUN_TWO' });
  assert.equal((await evidenceMatrix(a02, cwd))[0].state, 'not_verified');

  // A-03: an invalidated decision is never returned as a new pending decision.
  const a03 = makeTask('gate-reissue');
  const binding = { planId: 'gate-reissue-plan', repositoryFingerprint: 'a'.repeat(64) };
  const request = { kind: 'remediation_scope', summary: 'Repair disputed issue', rationale: 'Needs user decision',
    options: [{ id: 'approve', description: 'Permit' }, { id: 'decline', description: 'Refuse' }], stateBinding: binding };
  const first = proposeDecision(a03, request);
  resolveDecision(a03, first.id, 'approve', { ...binding, repositoryFingerprint: 'b'.repeat(64) }, { userInitiated: true });
  assert.equal(first.status, 'invalidated');
  const second = proposeDecision(a03, request);
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'pending');
  assert.equal(proposeDecision(a03, request).id, second.id);

  // A-04: a success from another check cannot close an unrelated defect.
  const a04 = makeTask('finding-resolution');
  const failure = recordEvidence(a04, { subject: { kind: 'finding', id: 'authorization' },
    claim: 'Authorization regression', source: { kind: 'tool_execution', checkId: verificationCheckId('node auth.mjs') },
    assessment: 'observed', outcome: 'fail', runId: 'failure-run',
    dependencies: { kind: 'paths', completeness: 'complete', entries: [{ path: 'check.mjs', fingerprint: 'a'.repeat(64) }] } });
  const finding = recordFinding(a04, { message: 'Authorization broken', path: 'check.mjs', contractId: 'auth', reproductionKey: 'login' },
    { evidenceIds: [failure.id] });
  transitionFinding(a04, finding.id, 'confirmed', [failure.id]);
  const otherPass = recordEvidence(a04, { subject: { kind: 'verification', id: 'lint' },
    claim: 'Lint succeeds', source: { kind: 'tool_execution', checkId: verificationCheckId('node lint.mjs') },
    assessment: 'observed', outcome: 'pass', runId: 'repair-run', inputsStable: true,
    dependencies: { kind: 'paths', completeness: 'complete', entries: [{ path: 'check.mjs', fingerprint: 'b'.repeat(64) }] } });
  await assert.rejects(resolveFinding(a04, finding.id, [otherPass.id], cwd), /resolution requires/);
  assert.equal(finding.lifecycle, 'confirmed');

  // A-05: no raw argv / userinfo / common CLI secrets in durable Quality JSON.
  const a05 = makeTask('secrets');
  recordEvidence(a05, { subject: { kind: 'contract', id: 'privacy' },
    claim: 'curl https://name:PASSMARKER_81234@example.test --token TOKMARKER_81234',
    source: { kind: 'role_report', role: 'reviewer' }, assessment: 'supported' });
  const json = JSON.stringify(ensureQuality(a05));
  assert(!json.includes('PASSMARKER_81234') && !json.includes('TOKMARKER_81234'));
  assert(!sanitizeQualityText('node script.mjs --token=ANOTHERMARKER_81234').includes('ANOTHERMARKER_81234'));

  // A-06: explicit current-run outcome without a closure; no durable reuse.
  delete process.env.AGENT_VERIFY_INPUT_CLOSURES;
  const current = await runVerification(cwd);
  const a06 = makeTask('no-manifest');
  await ingestWorkflowResult(a06, result(current), cwd, { runId: 'CURRENT' });
  assert.equal((await evidenceMatrix(a06, cwd, { currentAttemptId: current.attempt.id }))[0].state, 'verified_current_run');
  assert.equal((await evidenceMatrix(a06, cwd))[0].state, 'not_verified');
  assert(a06.quality.evidence.every((e) => !JSON.stringify(e).includes('node check.mjs')));
  console.log('evaluation/p1-p2-followup: PASS (A-01..A-06, real pre/post verifier, attempt isolation, fresh gate IDs, finding linkage, privacy, current-run/reuse separation)');
} finally {
  if (beforeCommands === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = beforeCommands;
  if (beforeClosures === undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES; else process.env.AGENT_VERIFY_INPUT_CLOSURES = beforeClosures;
  delete process.env.MUTATE_INPUT;
  await rm(root, { recursive: true, force: true });
}
