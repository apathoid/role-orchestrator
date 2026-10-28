// End-to-end staged Change on the actual workflow and durable host-neutral
// execution runtime. An invalid I2 evidence report must leave I1 complete,
// preserve I2 edits and preserve the exact Plan needed for a later resume.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config.mjs';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { planDigest } from '../../src/implementation-stages.mjs';
import { runVerification } from '../../src/repo.mjs';
import { recordEvidence } from '../../src/quality-state.mjs';
import { emptyTaskSpec } from '../../src/routing/task-spec.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-plan-durable-'));
const oldState = process.env.AGENT_STATE_DIR;
const oldVerify = process.env.AGENT_VERIFY_COMMANDS;
process.env.AGENT_STATE_DIR = join(scratch, 'state');
const repo = join(scratch, 'repo');
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const plan = {
  goal: 'Implement the staged test fixture',
  steps: ['Introduce fixture interface', 'Implement fixture behavior', 'Write fixture unit test', 'Verify regression evidence'],
  acceptanceCriteria: ['Implementation is present and tested'],
  risks: [], expectedFiles: [],
};
let stageIndex = 0;
let routeCount = 0;
let savedBeforeCoder = false;
try {
  await mkdir(repo);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'fixture.txt'), 'start\n'); git('add', '.'); git('commit', '-qm', 'initial');
  const config = await loadConfig({ repoRoot: repo, home: join(scratch, 'home'), env: {} });
  const runtime = createOrchestratorRuntime({
    getConfig: async () => config,
    attachments: {
      persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
      buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {},
    },
    createRegistry: async () => ({
      resolveRole: (role) => ({ role, profileName: 'fixture', providerName: 'fixture', profile: { model: 'fixture', contextWindow: 32768 } }),
      invokeRole: async (role, request) => {
        let output;
        if (role === 'router') {
          routeCount++;
          const resume = routeCount >= 3;
          output = { mode: 'change', writeIntent: 'explicit', complexity: 'high', risk: 'normal', reason: 'User requested code.',
            task: { ...emptyTaskSpec('change','explicit'), ...(resume ? {continuation:{mode:'current_implementation'}} : {}) } };
        }
        else if (role === 'investigator') output = 'Read-only audit: update fixture behavior and add focused verification.';
        else if (role === 'explorer') output = { summary: 'One fixture file.', relevantFiles: ['fixture.txt'], constraints: [], existingPatterns: [], likelyVerification: [], unknowns: [] };
        else if (role === 'planner') output = plan;
        else if (role.startsWith('coder')) {
          stageIndex += 1;
          const saved = await runtime.restoreSession({ sessionId, cwd: repo });
          assert.equal(saved.implementationPlan?.planId, planDigest(plan));
          assert.equal(saved.implementationTasks.length, 1);
          savedBeforeCoder = true;
          if (stageIndex <= 2) await writeFile(join(repo, 'fixture.txt'), `stage-${stageIndex}\n`);
          output = stageIndex >= 3
            ? { action: 'no_change', summary: 'I2 already implemented; verified the saved edits', stepResults: [{ id: 'S4', status: 'already_satisfied', evidence: 'Verified fixture.txt already contains the requested regression behavior.' }], changedFiles: [], notes: [] }
            : stageIndex === 1
            ? { action: 'changed', summary: 'Stage I1 done', stepResults: [1, 2, 3].map((i) => ({ id: `S${i}`, status: 'implemented', evidence: 'Concrete repository fixture behavior updated and inspected.' })), changedFiles: ['fixture.txt'], notes: [] }
            : { action: 'changed', summary: 'Stage I2 edits preserved but the evidence row is missing', stepResults: [], changedFiles: ['fixture.txt'], notes: [] };
        } else if (role.startsWith('reviewer')) output = { verdict: 'pass', summary: 'All acceptance criteria supported by fixture evidence', issues: [], acceptanceResults: [{ id: 'A1', status: 'verified', evidence: 'Inspected fixture.txt and the saved stage implementation evidence.' }] };
        else if (role === 'finalValidator') output = { verdict: 'pass', summary: 'Verification consistent', issues: [] };
        else if (role.startsWith('responder')) output = 'Implementation finished with evidence.';
        else throw new Error(`Unexpected role: ${role}`);
        return { output, resolved: { profileName: 'fixture', providerName: 'fixture', profile: { model: 'fixture', contextWindow: 32768 } },
          meta: { elapsedMs: 1, structuredOutput: { format: 'structured' } } };
      },
      close: async () => {},
    }),
  });
  const { sessionId } = await runtime.createSession({ cwd: repo });
  // An investigator's textual audit is not a saved Plan. A normal follow-up
  // implementation must create a NEW durable Plan without invoking /plans.
  const audit = await runtime.runTurn({ sessionId,
    invocation: { task: 'Что осталось исправить в этом коде?', modeOverride: 'investigate' },
    rawText: 'Что осталось исправить в этом коде?' });
  assert.equal(audit.result.status, 'investigated');
  const afterAudit = await runtime.restoreSession({ sessionId, cwd: repo });
  assert.equal(afterAudit.implementationPlan ?? null, null);
  const changeRequest = 'Внеси необходимые изменения и закончи реализацию задачи';
  const response = await runtime.runTurn({ sessionId,
    invocation: { task: changeRequest }, rawText: changeRequest });
  assert.equal(response.result.status, 'implementation_incomplete');
  assert.equal(response.result.implementationCoverage.reason, 'invalid_stage_evidence');
  assert.equal(savedBeforeCoder, true);
  assert.equal(stageIndex, 2);
  const saved = await runtime.restoreSession({ sessionId, cwd: repo });
  assert.equal(saved.implementationPlan.planId, planDigest(plan));
  assert.equal(saved.implementationCheckpoint.status, 'interrupted');
  assert.equal(saved.implementationCheckpoint.interruptedStage, 'I2');
  assert.deepEqual(saved.implementationCheckpoint.completedStages, ['I1']);
  assert(saved.implementationCheckpoint.interruption.problems.some((problem) => problem.includes('S4')));
  assert.equal((await readFile(join(repo, 'fixture.txt'), 'utf8')), 'stage-2\n');
  const loaded = await JSON.parse(await readFile(join(process.env.AGENT_STATE_DIR, 'sessions', `${sessionId}.json`), 'utf8'));
  assert.equal(loaded.implementationTasks[0].plan.planId, planDigest(plan));
  // Persist an observed but dependency-unknown check from an earlier run.
  // Resume I2 should run just that configured check diagnostically; the normal
  // integration verifier MUST still run the whole suite afterward.
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', '--version'], ['node', '-p', 'process.version']]);
  const observedChecks = await runVerification(repo);
  assert.equal(observedChecks[0].status, 'PASS');
  recordEvidence(saved.implementationTasks[0], {
    subject: { kind: 'verification', id: 'node-version' },
    claim: 'Observed node --version but dependencies are deliberately unknown',
    source: { kind: 'tool_execution', command: observedChecks[0].command },
    assessment: 'observed', outcome: 'pass', dependencies: { kind: 'unknown' }, runId: 'prior-real-check',
  });
  await runtime.persistSession(sessionId, saved);
  const recoveryEvents = [];
  const continuation = await runtime.runTurn({ sessionId, invocation: { task: 'Продолжи реализацию плана' },
    rawText: 'Продолжи реализацию плана', reporter: (event) => recoveryEvents.push(event) });
  const targeted = recoveryEvents.filter((e) => e.type === 'quality_targeted_revalidation');
  assert.equal(targeted.length, 1);
  assert.deepEqual(targeted[0].commands, ['node --version']);
  assert.equal(targeted[0].disposition, 'PASS');
  assert(recoveryEvents.some((e) => e.type === 'verification_done' && e.phase === 'mandatory'
    && e.results.some((c) => c.command === 'node -p process.version')),
  'final full verification is retained after targeted diagnostic');
  assert.equal(stageIndex, 3, 'only interrupted I2 must be invoked on resume');
  // P2 deliberately separates completed implementation stages from independently
  // verified acceptance. This fixture's reviewer only *claims* verification:
  // it never associates its criterion with an actually executed command.
  assert.equal(continuation.result.status, 'implementation_incomplete',
    'finished stages must not fabricate observed acceptance evidence');
  assert.equal(continuation.result.qualityAssessment.complete, false);
  const continued = await runtime.restoreSession({ sessionId, cwd: repo });
  assert.deepEqual(continued.implementationCheckpoint.completedStages, ['I1', 'I2']);
  assert.equal(continued.implementationCheckpoint.interruption, undefined);
  assert.equal((await readFile(join(repo, 'fixture.txt'), 'utf8')), 'stage-2\n', 'resume must preserve previous I2 edits');
  console.log('evaluation/implementation-plan-durability: passed (real staged Change, Plan saved before coder, I1 retained, invalid I2 evidence, edits preserved)');
} finally {
  if (oldState === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = oldState;
  if (oldVerify === undefined) delete process.env.AGENT_VERIFY_COMMANDS;
  else process.env.AGENT_VERIFY_COMMANDS = oldVerify;
  await rm(scratch, { recursive: true, force: true });
}
