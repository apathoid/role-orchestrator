import {emptyTaskSpec} from '../../src/routing/task-spec.mjs';
// Independent C-01/C-02/G-01 adversarial checks. Uses real Git/filesystem and
// the real verification executor; does not require ACP SDK or a model.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config.mjs';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { runVerification, captureRepoState, changedPathsBetweenStates,
  captureDeniedPathBaseline, changedDeniedPathsBetweenBaselines } from '../../src/repo.mjs';
import { captureDependencies, recordEvidence, recordFinding, transitionFinding,
  resolveFinding, ingestWorkflowResult, evidenceMatrix, freshnessOf } from '../../src/quality-state.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'p1-p2-proof-boundaries-'));
const repo = join(scratch, 'repo');
const oldVerifyCommands = process.env.AGENT_VERIFY_COMMANDS;
const oldInputClosures = process.env.AGENT_VERIFY_INPUT_CLOSURES;
const oldState = process.env.AGENT_STATE_DIR;
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const task = (id, commands) => ({ version: 1, taskId: id, plan: {
  planId: `${id}-plan`, plan: { acceptanceCriteria: ['Configured verification succeeds'],
    acceptanceChecks: [{ id: 'A1', commands }] },
} });
const reviewer = (commands) => ({ verdict: 'pass', acceptanceResults: [{ id: 'A1', status: 'verified',
  evidence: `Observed ${commands.join(' and ')} passing` }] });
async function runAndAssess(t, commands) {
  const before = await captureRepoState(repo);
  const verification = await runVerification(repo);
  const after = await captureRepoState(repo);
  const changed = changedPathsBetweenStates(before, after);
  await ingestWorkflowResult(t, {
    verification, verificationAttempt: verification.attempt,
    verificationWorkspaceChanged: changed.length > 0,
    review: reviewer(commands),
  }, repo, { runId: `run-${t.taskId}` });
  return { verification, changed, criterion: (await evidenceMatrix(t, repo))[0] };
}
try {
  await mkdir(repo);
  git('init', '-q'); git('config', 'user.name', 'Proof boundaries'); git('config', 'user.email', 'audit@example.invalid');
  await writeFile(join(repo, '.gitignore'), '.env\n');
  await writeFile(join(repo, 'verify.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('other.js', 'export const broken = true;\\n');\n");
  await writeFile(join(repo, 'other.js'), 'export const broken = false;\n');
  await writeFile(join(repo, 'auth.js'), 'export const authorized = false;\n');
  git('add', '.'); git('commit', '-qm', 'base');

  // C-01: a genuine PASS mutates ANOTHER tracked file (not its declared inputs).
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'verify.mjs']]);
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({ 'node verify.mjs': {
    complete: true, paths: ['verify.mjs'],
  } });
  const mutating = await runAndAssess(task('c01-changed-checkout', ['node verify.mjs']), ['node verify.mjs']);
  assert.equal(mutating.verification.find((item) => item.command === 'node verify.mjs').status, 'PASS');
  assert.deepEqual(mutating.changed, ['other.js']);
  assert.equal(mutating.verification.find((item) => item.command === 'node verify.mjs').inputsStable, true);
  assert.equal(mutating.criterion.state, 'revalidation_required', 'a changed checkout cannot be a durable or current-run success');

  // Later check changing an earlier check's input invalidates the suite too.
  await writeFile(join(repo, 'first.mjs'), "import { readFileSync } from 'node:fs'; if (!readFileSync('other.js', 'utf8')) process.exit(1);\n");
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'first.mjs'], ['node', 'verify.mjs']]);
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({
    'node first.mjs': { complete: true, paths: ['first.mjs', 'other.js'] },
    'node verify.mjs': { complete: true, paths: ['verify.mjs'] },
  });
  await writeFile(join(repo, 'other.js'), 'export const broken = false;\n');
  const multi = await runAndAssess(task('c01-multiple-checks', ['node first.mjs', 'node verify.mjs']),
    ['node first.mjs', 'node verify.mjs']);
  assert.equal(multi.verification.find((item) => item.command === 'node verify.mjs').status, 'PASS');
  assert.deepEqual(multi.changed, ['other.js']);
  assert.equal(multi.criterion.state, 'revalidation_required', 'a later command invalidates the earlier observation');

  // C-02: lower-level finding API must reject even otherwise relevant PASS
  // after its declared input has changed again. It must not mutate lifecycle.
  const findingTask = task('c02-freshness', []);
  const failure = recordEvidence(findingTask, { subject: { kind: 'finding', id: 'auth' },
    claim: 'Observed auth failure', source: { kind: 'tool_execution', checkId: 'auth-check' },
    assessment: 'observed', outcome: 'fail', runId: 'before-fix',
    dependencies: { kind: 'paths', completeness: 'complete', entries: [{ path: 'auth.js', fingerprint: 'a'.repeat(64) }] },
  });
  const finding = recordFinding(findingTask, { message: 'Authorization regression', path: 'auth.js',
    contractId: 'authorization', reproductionKey: 'login' }, { evidenceIds: [failure.id] });
  transitionFinding(findingTask, finding.id, 'confirmed', [failure.id]);
  await writeFile(join(repo, 'auth.js'), 'export const authorized = true;\n');
  const passing = recordEvidence(findingTask, { subject: { kind: 'finding', id: 'auth' },
    claim: 'Observed auth repair', source: { kind: 'tool_execution', checkId: 'auth-check' },
    assessment: 'observed', outcome: 'pass', runId: 'after-fix', inputsStable: true,
    dependencies: { ...(await captureDependencies(repo, ['auth.js'])), completeness: 'complete' },
  });
  assert.equal(await freshnessOf(passing, repo), 'fresh');
  await writeFile(join(repo, 'auth.js'), 'export const authorized = null;\n');
  assert.equal(await freshnessOf(passing, repo), 'stale');
  assert.throws(() => transitionFinding(findingTask, finding.id, 'resolved', [passing.id]), /resolveFinding/);
  await assert.rejects(resolveFinding(findingTask, finding.id, [passing.id], repo), /fresh/);
  assert.equal(finding.lifecycle, 'confirmed');
  await writeFile(join(repo, 'auth.js'), 'export const authorized = true;\n');
  assert.equal((await resolveFinding(findingTask, finding.id, [passing.id], repo)).lifecycle, 'resolved');

  // A PASS whose input binding is unknown must not close a finding.
  const second = task('c02-unknown', []);
  const original = recordEvidence(second, { subject: { kind: 'finding', id: 'auth' },
    claim: 'Failure', source: { kind: 'tool_execution', checkId: 'auth-check' },
    assessment: 'observed', outcome: 'fail', runId: 'old',
    dependencies: { kind: 'paths', completeness: 'complete', entries: [{ path: 'auth.js', fingerprint: 'b'.repeat(64) }] },
  });
  const openFinding = recordFinding(second, { message: 'Authorization issue' }, { evidenceIds: [original.id] });
  transitionFinding(second, openFinding.id, 'confirmed', [original.id]);
  const unknown = recordEvidence(second, { subject: { kind: 'finding', id: 'auth' },
    claim: 'Unbound PASS', source: { kind: 'tool_execution', checkId: 'auth-check' },
    assessment: 'observed', outcome: 'pass', runId: 'new', inputsStable: true,
  });
  await assert.rejects(resolveFinding(second, openFinding.id, [unknown.id], repo), /fresh/);

  // G-01: bounded configured denied paths include ignored existing and new
  // secret files, without hashing all ignored caches/build artifacts.
  const security = { caseSensitive: false, denyPaths: ['.env'], denyGlobs: [], allowPaths: [], allowGlobs: [] };
  const beforeIgnored = await captureDeniedPathBaseline(repo, security);
  await writeFile(join(repo, '.env'), 'SECRET=one\n');
  const addedIgnored = await captureDeniedPathBaseline(repo, security);
  assert.deepEqual(changedDeniedPathsBetweenBaselines(beforeIgnored, addedIgnored), ['.env']);
  await writeFile(join(repo, '.env'), 'SECRET=two\n');
  assert.deepEqual(changedDeniedPathsBetweenBaselines(addedIgnored,
    await captureDeniedPathBaseline(repo, security)), ['.env']);
  // G-01 also holds through the real host-neutral workflow, not just the
  // witness API: a fake read-only provider writing an ignored denied path
  // cannot produce an accepted investigation response.
  process.env.AGENT_STATE_DIR = join(scratch, 'state');
  const config = await loadConfig({ repoRoot: repo, home: join(scratch, 'home'), env: {} });
  config.security = security;
  let tampered = false;
  const runtime = createOrchestratorRuntime({
    getConfig: async () => config,
    createRegistry: async () => ({
      resolveRole: (role) => ({ role, profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } }),
      invokeRole: async (role) => {
        if (role === 'explorer' || role === 'investigator') { await writeFile(join(repo, '.env'), 'SECRET=provider-mutated\n'); tampered = true; }
        const output = role === 'router'
          ? { mode: 'investigate', writeIntent: 'not_requested', complexity: 'low', risk: 'normal', reason: 'Question only', task:emptyTaskSpec('investigate') }
          : role === 'explorer'
            ? { summary: 'explored', relevantFiles: ['auth.js'], constraints: [], existingPatterns: [], likelyVerification: [], unknowns: [] }
            : 'Investigation complete';
        return { output, resolved: { profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } },
          meta: { elapsedMs: 10, structuredOutput: { format: typeof output === 'string' ? 'text' : 'structured' } } };
      },
      close: async () => {},
    }),
    attachments: {
      persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
      buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {},
    },
  });
  const session = await runtime.createSession({ cwd: repo });
  let blocked = false;
  try {
    const response = await runtime.runTurn({ sessionId: session.sessionId,
      invocation: { task: 'Investigate repository' }, rawText: 'Investigate repository' });
    assert.notEqual(response?.result?.status, 'investigated', 'mutating read-only response must not be accepted');
    blocked = true;
  } catch (error) {
    assert.match(String(error), /READ_ONLY_PROTECTED_PATH_CHANGED|Protected path changed/);
    blocked = true;
  }
  assert(tampered && blocked, 'the read-only mutation must be detected');
  console.log('evaluation/p1-p2-final-proof-boundaries: PASS (C-01, C-02, G-01, runtime read-only protection)');
} finally {
  if (oldVerifyCommands === undefined) delete process.env.AGENT_VERIFY_COMMANDS;
  else process.env.AGENT_VERIFY_COMMANDS = oldVerifyCommands;
  if (oldInputClosures === undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES;
  else process.env.AGENT_VERIFY_INPUT_CLOSURES = oldInputClosures;
  if (oldState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = oldState;
  await rm(scratch, { recursive: true, force: true });
}
