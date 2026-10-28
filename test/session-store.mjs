import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageName = packageJson.name;

function runNode(code, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => stdout += c);
    child.stderr.on('data', (c) => stderr += c);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout)));
  });
}

const xdg = await mkdtemp(path.join(tmpdir(), 'role-orchestrator-state-root-'));
const defaultDir = await runNode(
  "const m=await import('./src/session-store.mjs'); console.log(m.getSessionStateDir())",
  { XDG_STATE_HOME: xdg, AGENT_STATE_DIR: '' },
);
assert.equal(defaultDir, path.join(xdg, packageName));

const root = await mkdtemp(path.join(tmpdir(), 'role-orchestrator-session-store-'));
process.env.AGENT_STATE_DIR = root;
const { saveSession, loadSession, deleteSession, getSessionStateDir } = await import('../src/session-store.mjs');

const sessionId = 'test-session-123';
await saveSession(sessionId, {
  cwd: '/tmp/project',
  repoRoot: '/tmp/project',
  createdAt: '2026-09-16T00:00:00.000Z',
  history: [{ user: 'hello', result: 'world' }],
  transcript: [{ user: 'hello', assistant: 'world' }],
  title: 'Short useful title',
  roleEditor: 'reviewerMedium',
  codexAgentMode: 'agent-full-access',
  codexCollaborationMode: 'plan',
  implementationPlan: { version: 1, planId: 'validplan', repoRoot: '/tmp/project', repoKey: 'repo', plan: { steps: ['First'], acceptanceCriteria: ['Pass'] } },
  implementationCheckpoint: { version: 1, planId: 'validplan', repoKey: 'state', completedStages: ['I1'], records: [], reconciliationHistory: [{ repoKey: 'changed', revalidationRequired: true }] },
  implementationReconciliation: { version: 1, token: 'abcdef123456', planId: 'validplan', baseKey: 'state', repoKey: 'changed', changes: {}, analysis: { decision: 'reverify' }, completedStages: ['I1'] },
  reviewCheckpoint: { version: 1, scopeKey: 'fingerprint', contractKey: 'criteria', repoKey: 'head', status: 'in_progress', completedBatches: [0], records: [], reports: [], problems: [] },
});

const loaded = await loadSession(sessionId);
assert.equal(loaded.cwd, '/tmp/project');
assert.equal(loaded.repoRoot, '/tmp/project');
assert.deepEqual(loaded.history, [{ user: 'hello', result: 'world' }]);
assert.deepEqual(loaded.transcript, [{ user: 'hello', assistant: 'world', attachments: [] }]);
assert.equal(loaded.title, 'Short useful title');
assert.equal(loaded.roleEditor, 'reviewerMedium');
assert.equal(loaded.codexAgentMode, 'agent-full-access');
assert.equal(loaded.codexCollaborationMode, 'plan');
assert.deepEqual(loaded.reviewCheckpoint.completedBatches, [0]);
assert.equal(loaded.implementationPlan.planId, 'validplan');
assert.deepEqual(loaded.implementationCheckpoint.completedStages, ['I1']);
assert.equal(loaded.implementationReconciliation.token, 'abcdef123456');
assert.equal(loaded.implementationCheckpoint.reconciliationHistory[0].revalidationRequired, true);

const file = path.join(getSessionStateDir(), 'sessions', `${sessionId}.json`);
assert.equal((await stat(file)).mode & 0o777, 0o600);
assert.match(await readFile(file, 'utf8'), /test-session-123/);


const reviewV2SessionId = 'review-v2-session';
const reviewV2 = { version: 2, scopeKey: 'scope', planKey: 'plan', repoKey: 'repo', status: 'in_progress', unitsTotal: 5,
  records: [{ id: 'CS1', status: 'checked', evidence: 'Inspected repository source code with concrete commands.', reviewedPaths: [] }],
  reports: [{ batchId: 'CS1_1', unitIds: ['CS1'], outputFormat: 'structured',
    output: { verdict: 'pass', summary: 'Source checked', issues: [] } }] };
await saveSession(reviewV2SessionId, { cwd: '/tmp/project', history: [], transcript: [], reviewCheckpoint: reviewV2 });
assert.deepEqual((await loadSession(reviewV2SessionId)).reviewCheckpoint, reviewV2);
await deleteSession(reviewV2SessionId);
const reviewV3 = { ...reviewV2, version: 3,
  operation: { id: '12345678-1234-4234-8234-123456789abc', repoRoot: '/tmp/project', task: 'Inspect test feature',
    skillName: 'review-code', contract: { checks: [], omitted: [], expectedFileCount: null },
    workPlan: { version: 1, planKey: 'plan', units: [{ id: 'CS1', kind: 'criterion' }] }, maxFilesPerUnit: 4 } };
await saveSession('review-v3-session', { cwd: '/tmp/project', history: [], transcript: [], reviewCheckpoint: reviewV3 });
assert.deepEqual((await loadSession('review-v3-session')).reviewCheckpoint, reviewV3);
await deleteSession('review-v3-session');
const reviewV4 = { ...reviewV3, version: 4, qualityState: { version: 1, risks: [] } };
await saveSession('review-v4-session', { cwd: '/tmp/project', history: [], transcript: [], reviewCheckpoint: reviewV4 });
assert.deepEqual((await loadSession('review-v4-session')).reviewCheckpoint, reviewV4,
  'review checkpoint v4 and quality evidence must survive persistent session round-trip');
await assert.rejects(() => saveSession('invalid-review-version', {
  cwd: '/tmp/project', reviewCheckpoint: { ...reviewV4, version: 999 },
}), /Unsupported.*review checkpoint/);
await deleteSession('review-v4-session');



await deleteSession(sessionId);
assert.equal(await loadSession(sessionId), null);
await assert.rejects(() => saveSession('../escape', { cwd: '/tmp', history: [], transcript: [] }), /Invalid ACP session id/);

const safeRoot = process.env.AGENT_STATE_DIR;
const symlinkRoot = await mkdtemp(path.join(tmpdir(), 'role-orchestrator-session-symlink-'));
const victim = await mkdtemp(path.join(tmpdir(), 'role-orchestrator-session-victim-'));
await writeFile(path.join(victim, 'keep.txt'), 'safe');
await symlink(victim, path.join(symlinkRoot, 'sessions'));
process.env.AGENT_STATE_DIR = symlinkRoot;
await assert.rejects(() => saveSession('symlink-session', { cwd: '/tmp', history: [], transcript: [] }), /must not be a symlink/);
await assert.rejects(() => loadSession('symlink-session'), /must not be a symlink/);
assert.equal(await readFile(path.join(victim, 'keep.txt'), 'utf8'), 'safe');
process.env.AGENT_STATE_DIR = safeRoot;
await rm(symlinkRoot, { recursive: true, force: true });
await rm(victim, { recursive: true, force: true });

// Two independent hosts load the same revision. Only the first committed
// snapshot may win; the second must explicitly report a revision conflict.
const competingId = 'cross-process-race';
await saveSession(competingId, { cwd: '/tmp/project', transcript: [], history: [] });
const barrier = path.join(root, 'go');
const readyA = path.join(root, 'ready-a');
const readyB = path.join(root, 'ready-b');
const contender = async (label, readyFile) => runNode(`
  import { loadSession, saveSession } from './src/session-store.mjs';
  import { writeFile, access } from 'node:fs/promises';
  const state = await loadSession(${JSON.stringify(competingId)});
  await writeFile(${JSON.stringify(readyFile)}, 'ready');
  for (let i = 0; i < 500; i++) {
    try { await access(${JSON.stringify(barrier)}); break; } catch {}
    await new Promise(r => setTimeout(r, 10));
  }
  state.title = ${JSON.stringify(label)};
  try { await saveSession(${JSON.stringify(competingId)}, state); console.log('saved'); }
  catch (e) { console.log(e.code ?? e.message); }
`, { AGENT_STATE_DIR: root });
const contenderA = contender('A', readyA);
const contenderB = contender('B', readyB);
for (let i = 0; i < 500; i++) {
  try { await Promise.all([stat(readyA), stat(readyB)]); break; }
  catch { await new Promise(r => setTimeout(r, 10)); }
}
await writeFile(barrier, 'go');
const outcomes = await Promise.all([contenderA, contenderB]);
assert.deepEqual(outcomes.sort(), ['SESSION_REVISION_CONFLICT', 'saved'].sort());
await loadSession(competingId);
await deleteSession(competingId);

console.log('session-store: passed');
