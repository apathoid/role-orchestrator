import {emptyTaskSpec} from '../../src/routing/task-spec.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runWorkflow } from '../../src/workflow.mjs';
import { planDigest, repositoryFingerprint } from '../../src/implementation-stages.mjs';
import { captureRepoState } from '../../src/repo.mjs';
import { loadConfig } from '../../src/config.mjs';
const scratch = await mkdtemp(join(tmpdir(), 'p3-continue-'));
const repo = join(scratch, 'repo');
const git = (...args) => { const r = spawnSync('git', args, { cwd: repo }); assert.equal(r.status, 0); };
try {
  await mkdir(repo);
  git('init', '-q'); git('config','user.name','Agent'); git('config','user.email','agent@example.invalid');
  await writeFile(join(repo, 'hello.txt'), 'hello\n'); git('add', '.'); git('commit', '-qm', 'initial');
  const config = await loadConfig({ repoRoot: repo, home: join(scratch, 'home'), env: {} });
  const base = await captureRepoState(repo);
  const repoKey = repositoryFingerprint(base);
  const plan = { goal: 'Update greeting', steps: ['Update greeting'], acceptanceCriteria: ['Greeting correct'], risks: [], expectedFiles: ['hello.txt'] };
  const planId = planDigest(plan);
  const authoritativePlan = { version: 1, planId, repoRoot: repo, repoKey, plan };
  const implementationCheckpoint = { version: 1, planId, scopeKey: planId, repoKey, status: 'interrupted', completedStages: [], records: [] };
  const tryResume = async (fast) => {
    const called = [], events = [];
    const registry = {
      resolveRole: role => ({ role, profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } }),
      invokeRole: async (role) => {
        called.push(role);
        if (role.startsWith('coder')) throw new Error('HALT_BEFORE_WRITE');
        const output = role === 'router'
          ? { mode: 'change', writeIntent: 'explicit', complexity: 'high', risk: 'architecture', reason: 'requested', task:{...emptyTaskSpec('change','explicit'),continuation:{mode:'current_implementation'}} }
          : { summary: 'Greeting lives in hello.txt', relevantFiles: ['hello.txt'], constraints: [], existingPatterns: [], likelyVerification: [], unknowns: [] };
        return { output, resolved: { profileName: 'fake', providerName: 'fake', profile: { model: 'fake' } }, meta: { structuredOutput: { format: 'structured' }, elapsedMs: 2 } };
      },
    };
    const outcome = await runWorkflow({ task: `Продолжи реализацию плана ${planId}`, registry, config, repoStart: repo,
      authoritativePlan, implementationCheckpoint, efficiency: { continuationFastPath: fast },
      reporter: event => events.push(event) }).catch(error => error);
    assert.equal(outcome instanceof Error ? outcome.message.includes('HALT_BEFORE_WRITE') : outcome.status === 'implementation_incomplete', true);
    return { called, events };
  };
  const normal = await tryResume(false);
  assert.equal(normal.called[0], 'router');
  const fast = await tryResume(true);
  assert.equal(fast.called[0], 'router', 'saved Plan must not bypass semantic interpretation on a new text turn');
  assert(fast.events.some(e => e.type === 'implementation_plan_reused'), 'saved plan remains authoritative');
  assert(!fast.events.some(e => e.type === 'efficiency_router_bypassed'));
  assert.deepEqual((await captureRepoState(repo)).diff, base.diff, 'no implicit writes or Plan modification');
} finally { await rm(scratch, { recursive: true, force: true }); }
console.log('evaluation/p3-continuation: PASS (fresh text requires Router; saved Plan remains bound to checkpoint)');
