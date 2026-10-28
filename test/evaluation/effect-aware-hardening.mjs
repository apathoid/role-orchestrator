// Independent regressions for EA-01 .. EA-04, using real processes, Git and
// the host-neutral read-only workflow. No ACP service or model is required.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerification, runVerificationCommand, runPreparation, verificationDisposition } from '../../src/repo.mjs';
import { ingestWorkflowResult, evidenceMatrix } from '../../src/quality-state.mjs';
import { runWorkflow } from '../../src/workflow.mjs';
import { emptyTaskSpec } from '../../src/routing/task-spec.mjs';
import { loadConfig } from '../../src/config.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'verification-hardening-'));
const original = Object.fromEntries(['AGENT_VERIFY_COMMANDS', 'AGENT_VERIFY_POLICIES',
  'AGENT_VERIFY_INPUT_CLOSURES', 'AGENT_PREPARE_COMMANDS', 'AGENT_PREPARE_TIMEOUT_MS'].map((key) => [key, process.env[key]]));
const policy = (baseline = 'git_head') => ({
  'node checker.mjs': {
    kind: 'diagnostic_json_delta', baseline, acceptedExitCodes: [0, 3],
    completion: { path: '.complete.json' },
    reports: [{ path: 'diagnostics.json', itemsPath: 'issues', identityFields: ['id'] }],
  },
});
const writeIssues = (repo, ids) => writeFile(join(repo, 'diagnostics.json'),
  JSON.stringify({ issues: ids.map((id) => ({ id })) }, null, 2) + '\n');
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
async function initRepo(name, { ignoredReport = false } = {}) {
  const repo = join(scratch, name);
  await mkdir(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Hardening'); git(repo, 'config', 'user.email', 'hardening@example.invalid');
  await writeFile(join(repo, '.gitignore'), `.complete.json\n${ignoredReport ? 'diagnostics.json\n' : ''}`);
  await writeIssues(repo, ['a', 'b']);
  await writeFile(join(repo, 'checker.mjs'), 'process.exit(0);\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  return repo;
}
async function configure(cmdPolicy = policy()) {
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'checker.mjs']]);
  process.env.AGENT_VERIFY_POLICIES = JSON.stringify(cmdPolicy);
}
async function script(repo, body) { await writeFile(join(repo, 'checker.mjs'), body); }
const marker = `import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const digest = createHash('sha256').update(readFileSync('diagnostics.json')).digest('hex');
const nonce = process.env.AGENT_VERIFICATION_INVOCATION_ID;
if (nonce) writeFileSync('.complete.json', JSON.stringify({invocationId:nonce,status:'completed',reportHashes:{'diagnostics.json':digest}}));
`;
try {
  // E-01: an analyzer touching timestamps and crashing must not claim a successful
  // improvement already present relative to HEAD. In particular it cannot mint
  // a `verified` evidence record for an acceptance criterion.
  const crash = await initRepo('crashing-checker');
  await configure();
  await writeIssues(crash, ['a']);
  await script(crash, `import {utimesSync} from 'node:fs'; const future=new Date(Date.now()+4000); utimesSync('diagnostics.json',future,future); console.error('fatal analysis failure'); process.exit(3);`);
  let outcome = await runVerification(crash);
  let check = outcome.find((item) => item.command === 'node checker.mjs');
  assert.equal(check.exitCode, 3);
  assert.notEqual(check.status, 'PASS', 'mtime-only mutation plus nonzero exit must fail closed');
  assert.equal(check.diagnostic?.completionVerified, false);
  const task = { version: 1, taskId: 'checker', plan: { planId: 'p', plan: {
    acceptanceCriteria: ['Checker completed'], acceptanceChecks: [{ id: 'A1', commands: ['node checker.mjs'] }],
  } } };
  await ingestWorkflowResult(task, { verification: outcome, verificationAttempt: outcome.attempt,
    review: { verdict: 'pass', acceptanceResults: [{ id: 'A1', status: 'verified', evidence: 'Checker completed' }] },
  }, crash, { runId: 'crashing-run' });
  assert.notEqual((await evidenceMatrix(task, crash))[0].state, 'verified');

  // E-01 positive: a host-generated invocation nonce and exact output hashes
  // permit a documented nonzero improvement without trusting timestamps.
  await script(crash, `import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
writeFileSync('diagnostics.json',JSON.stringify({issues:[{id:'a'}]}));
const nonce=process.env.AGENT_VERIFICATION_INVOCATION_ID;
if(nonce) writeFileSync('.complete.json',JSON.stringify({invocationId:nonce,status:'completed',reportHashes:{'diagnostics.json':createHash('sha256').update(readFileSync('diagnostics.json')).digest('hex')}}));
process.exit(3);`);
  outcome = await runVerification(crash);
  check = outcome.find((item) => item.command === 'node checker.mjs');
  assert.equal(check.status, 'PASS', 'fresh success marker must permit intended nonzero semantics');
  assert.equal(check.diagnostic.completionVerified, true);
  assert.equal(check.diagnostic.outcome, 'improved');
  await script(crash, "import {writeFileSync} from 'node:fs';writeFileSync('.complete.json',JSON.stringify({invocationId:'stale',status:'completed',reportHashes:{'diagnostics.json':'stale'}}));process.exit(3);\n");
  check = (await runVerification(crash)).find((item) => item.command === 'node checker.mjs');
  assert.notEqual(check.status, 'PASS', 'reused or mismatched completion marker is never sufficient');

  // E-02: mandatory final diff check must see mutations made by verifiers.
  const whitespace = await initRepo('trailing-whitespace');
  await configure(policy('pre_run'));
  await script(whitespace, `import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
writeFileSync('diagnostics.json','{\\n  "issues": [{"id":"a"}]   \\n}\\n');
const nonce=process.env.AGENT_VERIFICATION_INVOCATION_ID;
if(nonce) writeFileSync('.complete.json',JSON.stringify({invocationId:nonce,status:'completed',reportHashes:{'diagnostics.json':createHash('sha256').update(readFileSync('diagnostics.json')).digest('hex')}}));
process.exit(3);`);
  outcome = await runVerification(whitespace);
  assert.equal(outcome.find((item) => item.command === 'node checker.mjs').status, 'PASS');
  assert.equal(outcome.at(-1).command, 'git diff --check');
  assert.equal(outcome.at(-1).status, 'TEST_FAILED');
  assert.equal(verificationDisposition(outcome), 'CODE_FAILURE');
  assert.equal(outcome.attempt.observedCheckIds.length, outcome.attempt.requiredCheckIds.length);
  await script(whitespace, `import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
writeFileSync('diagnostics.json',JSON.stringify({issues:[{id:'a'}]},null,2)+'\\n');
const nonce=process.env.AGENT_VERIFICATION_INVOCATION_ID;
if(nonce) writeFileSync('.complete.json',JSON.stringify({invocationId:nonce,status:'completed',reportHashes:{'diagnostics.json':createHash('sha256').update(readFileSync('diagnostics.json')).digest('hex')}}));
process.exit(3);`);
  outcome = await runVerification(whitespace);
  assert.equal(outcome.at(-1).status, 'PASS', 'final check accepts the clean final checkout');

  // E-03: read-only review must refuse *before* a declared mutating verifier
  // executes, even if its output is ignored by Git.
  const ignored = await initRepo('read-only-ignored', { ignoredReport: true });
  await writeIssues(ignored, ['a', 'b']);
  await configure(policy('pre_run'));
  await script(ignored, "import {writeFileSync} from 'node:fs';writeFileSync('diagnostics.json',JSON.stringify({issues:[{id:'a'}]}));process.exit(0);\n");
  const config = await loadConfig({ repoRoot: ignored, home: join(scratch, 'home'), env: {} });
  config.policy.reviewVerification = true;
  const registry = {
    resolveRole: (role) => ({ role, profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } }),
    invokeRole: async (role) => ({ output: role === 'router' ? {
      mode: 'review', writeIntent: 'not_requested', complexity: 'low', risk: 'normal', reason: 'review', task: emptyTaskSpec('review'),
    } : { summary: 'read-only' }, resolved: { profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } },
    meta: { elapsedMs: 1, structuredOutput: { format: 'structured' } } }), close: async () => {},
  };
  await assert.rejects(runWorkflow({ task: 'Review code', config, registry, repoStart: ignored, modeOverride: 'review' }), /Read-only verification unavailable.*effectful/);
  assert.equal(JSON.parse(await readFile(join(ignored, 'diagnostics.json'), 'utf8')).issues.length, 2);

  // E-04: SIGTERM followed by exit(0) is STILL a timeout/infra failure, for
  // both verification and preparation. A clean zero-exit remains PASS.
  const timed = await initRepo('timed');
  await script(timed, "process.on('SIGTERM',()=>{console.error('aborted mid-check');process.exit(0)});setInterval(()=>{},100);\n");
  delete process.env.AGENT_VERIFY_POLICIES;
  check = await runVerificationCommand(timed, ['node', 'checker.mjs'], { timeoutMs: 500, policies: {} });
  assert.equal(check.exitCode, 0);
  assert.equal(check.timedOut, true);
  assert.equal(check.status, 'INFRA_FAILURE');
  assert.equal(check.ok, false);
  process.env.AGENT_PREPARE_COMMANDS = JSON.stringify([['node', 'checker.mjs']]);
  process.env.AGENT_PREPARE_TIMEOUT_MS = '500';
  let prepared = await runPreparation(timed);
  assert.equal(prepared[0].timedOut, true);
  assert.equal(prepared[0].status, 'INFRA_FAILURE');
  await script(timed, 'process.exit(0);\n');
  check = await runVerificationCommand(timed, ['node', 'checker.mjs'], { timeoutMs: 2000, policies: {} });
  assert.equal(check.status, 'PASS');
  prepared = await runPreparation(timed);
  assert.equal(prepared[0].status, 'PASS');
  console.log('evaluation/effect-aware-hardening: PASS (E-01 crash and attestation, E-02 final diff, E-03 ignored read-only, E-04 timeout and preparation)');
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(scratch, { recursive: true, force: true });
}
