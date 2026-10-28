// Independent regression scenarios for the findings of the 2026-10-21 audit.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createExecutionObserver } from '../../src/observability/execution-observer.mjs';
import { runVerification } from '../../src/repo.mjs';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { ensureQuality, recordEvidence, recordFinding, ingestWorkflowResult, evidenceMatrix, freshnessOf, captureDependencies } from '../../src/quality-state.mjs';
import { qualityView } from '../../src/quality-view.mjs';

const root = await mkdtemp(join(tmpdir(), 'p1-p2-remediation-'));
const previous = process.env.AGENT_STATE_DIR;
const prevCommands = process.env.AGENT_VERIFY_COMMANDS;
const prevClosures = process.env.AGENT_VERIFY_INPUT_CLOSURES;
process.env.AGENT_STATE_DIR = join(root, 'state');
const repo = join(root, 'repo');
const git = (...args) => {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
};
const task = (id, criterion = 'Behavior is correct', commands = ['node check.mjs']) => ({
  version: 1, taskId: id, plan: { version: 1, planId: `${id}-plan`, plan: { steps: ['fix'],
    acceptanceCriteria: [criterion], acceptanceChecks: [{ id: 'A1', commands }] } }, checkpoint: null,
});
const reviewer = (command) => ({ verdict: 'pass', acceptanceResults: [{ id: 'A1', status: 'verified', evidence: `Observed ${command} passing` }] });
try {
  await mkdir(repo);
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(repo, '.gitignore'), 'runtime.flag\n');
  await writeFile(join(repo, 'check.mjs'), "import { readFileSync } from 'node:fs'; if (readFileSync('runtime.flag','utf8').trim() !== 'good') process.exit(1);\n");
  await writeFile(join(repo, 'runtime.flag'), 'good\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const cmd = 'node check.mjs';
  assert.equal(spawnSync('node', ['check.mjs'], { cwd: repo }).status, 0);
  const ordinary = task('ignored-dependency');
  await ingestWorkflowResult(ordinary, { verification: [{ command: cmd, status: 'PASS', exitCode: 0 }], review: reviewer(cmd) }, repo);
  assert.equal((await evidenceMatrix(ordinary, repo))[0].state, 'not_verified', 'F-01: arbitrary command cannot inherit checkout closure');
  assert.equal(await freshnessOf(ordinary.quality.evidence.find((x) => x.source.kind === 'tool_execution'), repo), 'unknown');
  await writeFile(join(repo, 'runtime.flag'), 'bad\n');
  assert.equal(spawnSync('node', ['check.mjs'], { cwd: repo }).status, 1);
  assert.notEqual((await evidenceMatrix(ordinary, repo))[0].state, 'verified');
  const trusted = task('declared-inputs');
  await writeFile(join(repo, 'runtime.flag'), 'good\n');
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'check.mjs']]);
  process.env.AGENT_VERIFY_INPUT_CLOSURES = JSON.stringify({ [cmd]: { paths: ['check.mjs', 'runtime.flag'], complete: true } });
  const observed = await runVerification(repo);
  await ingestWorkflowResult(trusted, { verification: observed, verificationAttempt: observed.attempt, verificationWorkspaceChanged: false,
    review: reviewer(cmd) }, repo);
  assert.equal((await evidenceMatrix(trusted, repo))[0].state, 'verified');
  await writeFile(join(repo, 'runtime.flag'), 'bad\n');
  assert.equal((await evidenceMatrix(trusted, repo))[0].state, 'revalidation_required', 'F-01: ignored input invalidates declared closure');

  // F-02: source citation verifies text membership, not the reviewer's semantics.
  await writeFile(join(repo, 'auth.mjs'), 'export const authorized = false;\n');
  const staticTask = task('false-source-attestation', 'Authentication works', []);
  staticTask.plan.plan.acceptanceReviews = [{ id: 'A1', paths: ['auth.mjs'] }];
  await ingestWorkflowResult(staticTask, { review: { verdict: 'pass', acceptanceResults: [{ id: 'A1', status: 'verified',
    evidence: 'Authentication works', sourceAnchors: [{ path: 'auth.mjs', excerpt: 'authorized = false' }] }] } }, repo);
  const staticRow = (await evidenceMatrix(staticTask, repo))[0];
  assert.equal(staticRow.state, 'supported');
  assert.equal(staticRow.proofMethod, 'source_attested_not_semantically_verified');

  // F-03: strict scenario+contract identity, stable finding ID independent of severity/scope/prose.
  const findingsTask = task('findings');
  const original = { path: 'auth.mjs', message: 'User receives 403 after token refresh',
    evidence: 'Request /refresh then GET /account', contractId: 'session-refresh', reproductionKey: 'token-refresh-403', severity: 'major' };
  const first = recordFinding(findingsTask, original);
  const restated = recordFinding(findingsTask, { ...original, message: 'Authorized user is rejected after session renewal',
    severity: 'blocking', remediationScope: 'outside_scope' });
  assert.notEqual(first.id, restated.id, 'distinct assertions with only shared broad contract/reproducer must remain separate');
  assert(restated.possibleDuplicateIds.includes(first.id));
  assert.equal(first.severity, 'major');
  assert.equal(restated.severity, 'blocking');
  const distinct = recordFinding(findingsTask, { ...original, reproductionKey: 'logout-403' });
  assert.notEqual(distinct.id, first.id);
  const fallbackA = recordFinding(findingsTask, { path: 'auth.mjs', message: 'Same text', evidence: 'Scenario one' });
  const fallbackB = recordFinding(findingsTask, { path: 'auth.mjs', message: 'Same text', evidence: 'Scenario two' });
  assert.notEqual(fallbackA.id, fallbackB.id);

  // F-05: protect new durable prose and read-only rendering of old sessions.
  const privacyTask = task('privacy');
  recordEvidence(privacyTask, { subject: { kind: 'contract', id: 'privacy' }, claim: 'ENV_TOKEN=AUDIT_SECRET_VALUE_934',
    source: { kind: 'role_report', role: 'reviewer' }, assessment: 'supported' });
  recordFinding(privacyTask, { path: 'auth.mjs', message: 'Bearer abc123456789012345',
    evidence: 'ENV_TOKEN=AUDIT_SECRET_VALUE_934', severity: 'major' });
  assert(!JSON.stringify(privacyTask.quality).includes('AUDIT_SECRET_VALUE_934'));
  const session = (t) => ({ cwd: repo, repoRoot: repo, createdAt: new Date().toISOString(), history: [], transcript: [],
    implementationTasks: [t], activeImplementationTaskId: t.taskId, implementationPlan: t.plan });
  const legacy = task('legacy-privacy');
  ensureQuality(legacy).findings.push({ id: 'legacy-finding', lifecycle: 'candidate', severity: 'major', confidence: 'hypothesis',
    title: 'PASSWORD=old-secret-value', taskImpact: 'undetermined', remediationAuthorization: 'not_authorized',
    affectedPaths: [], evidenceIds: [] });
  assert(!String(await qualityView(session(legacy), 'findings')).includes('old-secret-value'));

  // F-04: P2 events are persisted as compact structured trace, never raw commands.
  const trace = createExecutionObserver({ root: join(root, 'trace') });
  const run = trace.begin('remediation-sid');
  run.event({ type: 'quality_recovery_assessed', completedStages: 1, staleEvidence: 2, findings: 1,
    rawOutput: 'ENV_TOKEN=AUDIT_SECRET_VALUE_934' });
  run.event({ type: 'quality_targeted_revalidation', commands: ['node check.mjs --token AUDIT_SECRET_VALUE_934'], disposition: 'PASS' });
  await run.finish({ status: 'completed' });
  const events = await trace.getTrace('remediation-sid');
  assert(events.some((e) => e.kind === 'quality_recovery_assessed'));
  assert(events.some((e) => e.kind === 'quality_targeted_revalidation'));
  assert.equal((await trace.getView('remediation-sid')).qualityActivity.targetedChecks, 1);
  assert(!JSON.stringify(events).includes('AUDIT_SECRET_VALUE_934'));

  // F-06: live subscription and snapshot carry the same durable quality revision.
  const live = createExecutionObserver({ root: join(root, 'live-trace') });
  const runtime = createOrchestratorRuntime({ getConfig: async () => ({}), observer: live });
  const liveTask = task('live-quality');
  ensureQuality(liveTask);
  const liveSession = session(liveTask);
  runtime.sessions.set('live-sid', liveSession);
  const activeRun = live.begin('live-sid');
  activeRun.running();
  const updates = [];
  const subscribed = [];
  const unsubscribe = runtime.subscribeExecution('live-sid', (view) => subscribed.push(view));
  const unwatch = await runtime.watchExecution('live-sid', (view) => updates.push(view));
  recordFinding(liveTask, { message: 'Missing contract', path: 'auth.mjs', evidence: 'broken', severity: 'major' });
  await runtime.persistSession('live-sid', liveSession);
  await activeRun.finish({ status: 'completed' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const snapshot = await runtime.getExecutionView('live-sid');
  assert(snapshot.quality);
  assert(updates.some((view) => view.quality?.revision === snapshot.quality.revision));
  assert(subscribed.some((view) => view.quality?.revision === snapshot.quality.revision), 'subscribe must agree with snapshot');
  assert((await runtime.getExecutionView('live-sid', activeRun.runId)).quality === undefined,
    'historical view must never acquire present Quality State');
  unwatch(); unsubscribe();

  // R-01: safe compaction can remove only superseded, unreferenced model
  // claims. Open findings and their evidence must remain intact.
  const longTask = task('capacity');
  const retained = recordEvidence(longTask, { subject: { kind: 'finding', id: 'fixed-id' },
    claim: 'Observed and retained', source: { kind: 'tool_execution', command: 'node check.mjs' },
    assessment: 'observed', outcome: 'fail' });
  const protectedFinding = recordFinding(longTask, { path: 'auth.mjs', message: 'Long-running unresolved defect',
    evidence: 'Reproduced', severity: 'major' }, { evidenceIds: [retained.id] });
  for (let i = 0; i < 806; i++) recordEvidence(longTask, { subject: { kind: 'stage', id: 'S1' },
    claim: `unverified historical claim ${i}`, source: { kind: 'role_report', role: 'coder' },
    assessment: 'unverified', runId: `run-${i}` });
  assert(longTask.quality.evidence.length <= 800);
  assert(longTask.quality.compaction?.supersededUnverifiedClaims > 0);
  assert(longTask.quality.evidence.some((entry) => entry.id === retained.id));
  assert(longTask.quality.findings.some((entry) => entry.id === protectedFinding.id && entry.evidenceIds.includes(retained.id)));
  const fullTask = task('capacity-protected');
  for (let i = 0; i < 800; i++) recordEvidence(fullTask, { subject: { kind: 'contract', id: `contract-${i}` },
    claim: `historical supported proof ${i}`, source: { kind: 'repository_inspection' }, assessment: 'supported' });
  assert.throws(() => recordEvidence(fullTask, { subject: { kind: 'contract', id: 'overflow' },
    claim: 'must refuse unprotected loss', source: { kind: 'repository_inspection' }, assessment: 'supported' }),
  /QUALITY_CAPACITY_EXCEEDED/);
  assert.equal(fullTask.quality.evidence.length, 800);

  console.log('evaluation/p1-p2-remediation: passed (F-01..F-06, R-01, ignored inputs, static attestation, identity, redaction, trace, live view, capacity)');
} finally {
  if (prevCommands === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = prevCommands;
  if (prevClosures === undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES; else process.env.AGENT_VERIFY_INPUT_CLOSURES = prevClosures;
  if (previous === undefined) delete process.env.AGENT_STATE_DIR;
  else process.env.AGENT_STATE_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
