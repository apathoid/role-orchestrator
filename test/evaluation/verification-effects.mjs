import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configuredVerificationPolicies, witnessDiagnosticReports, assessDiagnosticDelta, expectedReportEffects } from '../../src/verification-effects.mjs';
import { runVerification, captureRepoState, changedPathsBetweenStates, runVerificationCommand, gitMetadataDiff } from '../../src/repo.mjs';
import { recordEvidence, ingestWorkflowResult, evidenceMatrix } from '../../src/quality-state.mjs';
const dir = await mkdtemp(join(tmpdir(), 'verification-effects-'));
const repo = join(dir, 'repo');
const originalPolicies = process.env.AGENT_VERIFY_POLICIES;
const originalCommands = process.env.AGENT_VERIFY_COMMANDS;
const originalClosure = process.env.AGENT_VERIFY_INPUT_CLOSURES;
const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
const report = join(repo, 'diagnostics.json');
const policy = { 'node analyze.mjs': { kind: 'diagnostic_json_delta', acceptedExitCodes: [0, 3], completion: { path: '.verification-complete.json' },
  reports: [{ path: 'diagnostics.json', itemsPath: 'problems', identityFields: ['code', 'file', 'message'] }] } };
const writeProblems = (problems) => writeFile(report, JSON.stringify({ problems }, null, 2));
const a = (line) => ({ code: 'A', file: 'src.js', message: 'broken export', line });
const b = (line) => ({ code: 'B', file: 'src.js', message: 'unsafe call', line });
const c = (line) => ({ code: 'C', file: 'src.js', message: 'new regression', line });
const script = `import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = readFileSync('scenario.json', 'utf8');
const value = JSON.parse(source);
writeFileSync('diagnostics.json', JSON.stringify({problems:value.problems},null,2));
if (value.mutateSource) writeFileSync('src.js', 'changed by diagnostic command\\n');
if (process.env.AGENT_VERIFICATION_INVOCATION_ID) writeFileSync('.verification-complete.json', JSON.stringify({ invocationId: process.env.AGENT_VERIFICATION_INVOCATION_ID, status: 'completed', reportHashes: { 'diagnostics.json': createHash('sha256').update(readFileSync('diagnostics.json')).digest('hex') } }));
process.exit(value.exitCode);
`;
const scenario = (problems, exitCode, mutateSource = false) => writeFile(join(repo, 'scenario.json'), JSON.stringify({ problems, exitCode, mutateSource }));
const task = () => ({ version: 1, taskId: 'effects', plan: { planId: 'effects-plan', plan: {
  acceptanceCriteria: ['Diagnostic report has no regressions'], acceptanceChecks: [{ id: 'A1', commands: ['node analyze.mjs'] }],
} } });
async function observe(problems, exitCode, mutateSource = false) {
  await scenario(problems, exitCode, mutateSource);
  const before = await captureRepoState(repo);
  const verification = await runVerification(repo);
  const after = await captureRepoState(repo);
  const paths = changedPathsBetweenStates(before, after);
  const effects = expectedReportEffects(verification, paths,
    !gitMetadataDiff(before, after).fields.some((f) => ['HEAD', 'headRef', 'index'].includes(f)));
  return { verification, result: verification.find((x) => x.command === 'node analyze.mjs'), before, after, paths, effects };
}
try {
  await mkdir(repo); git('init', '-q'); git('config', 'user.name', 'Check'); git('config', 'user.email', 'check@example.invalid');
  await writeFile(join(repo, '.gitignore'), '.verification-complete.json\n');
  await writeFile(join(repo, 'analyze.mjs'), script);
  await writeFile(join(repo, 'src.js'), 'original\n');
  await writeProblems([a(10), b(15)]); await scenario([a(10), b(15)], 0);
  git('add', '.'); git('commit', '-qm', 'baseline');
  process.env.AGENT_VERIFY_POLICIES = JSON.stringify(policy);
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'analyze.mjs']]);
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({ 'node analyze.mjs': {
    complete: true, paths: ['analyze.mjs', 'scenario.json', 'src.js'],
  } });
  const configured = configuredVerificationPolicies();
  assert.deepEqual(Object.keys(configured), ['node analyze.mjs']);
  assert.throws(() => configuredVerificationPolicies('{"node analyze.mjs":{"kind":"diagnostic_json_delta","reports":[{"path":"../secret", "identityFields":["code"]}], "acceptedExitCodes":[0]}}'), /Invalid/);
  assert.throws(() => configuredVerificationPolicies('{"node analyze.mjs":{"kind":"diagnostic_json_delta","reports":[{"path":"diagnostics.json", "identityFields":["code"]}], "acceptedExitCodes":[1]}}'), /Invalid/);

  let observation = await observe([a(15), b(20)], 0);
  assert.equal(observation.result.status, 'PASS');
  assert.equal(observation.result.diagnostic.outcome, 'unchanged');
  assert.deepEqual(observation.paths, ['diagnostics.json']);
  assert.equal(observation.effects, true, 'expected report line movement is not unexpected source drift');
  assert.equal(observation.result.diagnostic.added, 0);
  assert.equal(observation.result.diagnostic.removed, 0);

  observation = await observe([a(22)], 3);
  assert.equal(observation.result.status, 'PASS', 'explicit nonzero success with fresh completion attestation is accepted');
  assert.equal(observation.result.diagnostic.outcome, 'improved');
  assert.equal(observation.effects, true);
  assert.equal(observation.result.diagnostic.removed, 1);
  const t = task();
  await ingestWorkflowResult(t, { verification: observation.verification, verificationAttempt: observation.verification.attempt,
    verificationWorkspaceChanged: !observation.effects,
    review: { verdict: 'pass', acceptanceResults: [{ id: 'A1', status: 'verified', evidence: 'node analyze.mjs passed with fewer problems' }] },
  }, repo, { runId: 'run-effects' });
  assert.equal((await evidenceMatrix(t, repo, { currentAttemptId: observation.verification.attempt.id }))[0].state, 'verified',
    'host-observed accepted nonzero exit must be eligible for the Evidence Matrix');

  observation = await observe([a(33), c(12)], 3);
  assert.equal(observation.result.status, 'TEST_FAILED');
  assert.equal(observation.result.diagnostic.outcome, 'regressed');
  assert.equal(observation.effects, true);

  // Equal total counts are not enough: one issue disappeared, another arrived.
  observation = await observe([a(33), b(12)], 0);
  assert.equal(observation.result.status, 'TEST_FAILED');
  assert.equal(observation.result.diagnostic.added, 1);
  assert.equal(observation.result.diagnostic.removed, 1);

  await scenario([a(33)], 3);
  observation = await observe([a(33)], 3);
  assert.equal(observation.result.status, 'PASS', 'removing issues is still an improvement');
  observation = await observe([a(33)], 3);
  assert.equal(observation.result.status, 'ENVIRONMENT_ERROR', 'nonzero exit with unchanged reports cannot claim improvement');

  // A checker must not hide unrelated source mutations behind its report policy.
  observation = await observe([a(33)], 0, true);
  assert.equal(observation.result.status, 'PASS');
  assert.equal(observation.effects, false);
  assert(observation.paths.includes('src.js'));

  // The analyzer may compare the current reports with committed HEAD,
  // returning a nonzero status even on repeated runs with unchanged output.
  // A trusted git_head policy can classify that baseline without confusing
  // "unchanged since the previous invocation" with "unchanged from HEAD".
  process.env.AGENT_VERIFY_POLICIES = JSON.stringify({
    'node analyze.mjs': { ...policy['node analyze.mjs'], baseline: 'git_head' },
  });
  observation = await observe([a(33)], 3);
  assert.equal(observation.result.status, 'PASS', 'an attested improvement over trusted committed reports can pass');
  assert.equal(observation.result.diagnostic.outcome, 'improved');
  assert.equal(observation.effects, true);
  observation = await observe([a(35), c(5)], 0);
  assert.equal(observation.result.status, 'TEST_FAILED', 'equal total count with a new issue must fail against HEAD');
  // Restore the pre-run policy for the remaining scenario.
  process.env.AGENT_VERIFY_POLICIES = JSON.stringify(policy);

  const before = await witnessDiagnosticReports(repo, configured['node analyze.mjs']);
  await writeProblems([a(36), b(77)]);
  const after = await witnessDiagnosticReports(repo, configured['node analyze.mjs']);
  assert.equal(assessDiagnosticDelta(before, after, configured['node analyze.mjs'], 0).outcome, 'regressed',
    'stage-level baseline must detect regressions introduced before host rerun');
  await writeFile(report, '{invalid');
  const malformed = await runVerificationCommand(repo, ['node', 'analyze.mjs']);
  assert.equal(malformed.status, 'ENVIRONMENT_ERROR', 'unparseable pre-run report cannot give trusted semantic PASS');
  console.log('evaluation/verification-effects: PASS (line drift, improvement, mixed issue churn, unknown, protected effects, stage baseline)');
} finally {
  if (originalPolicies === undefined) delete process.env.AGENT_VERIFY_POLICIES;
  else process.env.AGENT_VERIFY_POLICIES = originalPolicies;
  if (originalCommands === undefined) delete process.env.AGENT_VERIFY_COMMANDS;
  else process.env.AGENT_VERIFY_COMMANDS = originalCommands;
  if (originalClosure === undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES;
  else process.env.AGENT_VERIFY_INPUT_CLOSURES = originalClosure;
  await rm(dir, { recursive: true, force: true });
}
