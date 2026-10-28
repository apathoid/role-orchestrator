// Real staged workflow with fake provider: verify that observed semantic
// outcomes, not a coder's interpretation of exit codes, decide stage status.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config.mjs';
import { createOrchestratorRuntime } from '../../src/orchestrator-runtime.mjs';
import { emptyTaskSpec } from '../../src/routing/task-spec.mjs';
const root = await mkdtemp(join(tmpdir(), 'verification-effects-stage-'));
const old = Object.fromEntries(['AGENT_VERIFY_COMMANDS', 'AGENT_VERIFY_POLICIES', 'AGENT_STATE_DIR'].map((k) => [k, process.env[k]]));
try {
  for (const [scenario, problems, expectedReason] of [
    ['improvement', [{ code: 'A' }], null],
    ['regression', [{ code: 'A' }, { code: 'B' }], 'verification_failed'],
    ['git-head-improvement', [{ code: 'A' }], null],
  ]) {
    const repo = join(root, scenario); await mkdir(repo);
    const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    git('init', '-q'); git('config', 'user.name', 'Stage'); git('config', 'user.email', 'stage@example.invalid');
    await writeFile(join(repo, '.gitignore'), '.verification-complete.json\n');
    await writeFile(join(repo, 'src.js'), 'initial\n');
    await writeFile(join(repo, 'diagnostics.json'), JSON.stringify({ issues: scenario !== 'regression' ? [{ code: 'A' }, { code: 'B' }] : [{ code: 'A' }] , line:1}));
    await writeFile(join(repo, 'check.mjs'), "import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';const value=JSON.parse(readFileSync('scenario.json','utf8'));writeFileSync('diagnostics.json',JSON.stringify({issues:value.issues,line:20}));if(process.env.AGENT_VERIFICATION_INVOCATION_ID)writeFileSync('.verification-complete.json',JSON.stringify({invocationId:process.env.AGENT_VERIFICATION_INVOCATION_ID,status:'completed',reportHashes:{'diagnostics.json':createHash('sha256').update(readFileSync('diagnostics.json')).digest('hex')}}));process.exit(value.exit);\n");
    await writeFile(join(repo, 'scenario.json'), JSON.stringify({ issues: [{ code: 'A' }], exit: 0 }));
    git('add', '.'); git('commit', '-qm', 'baseline');
    process.env.AGENT_STATE_DIR = join(root, `${scenario}-state`);
    process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([['node', 'check.mjs']]);
    process.env.AGENT_VERIFY_POLICIES = JSON.stringify({ 'node check.mjs': {
      kind: 'diagnostic_json_delta', baseline: scenario === 'git-head-improvement' ? 'git_head' : 'pre_run', acceptedExitCodes: [0, 3], completion: { path: '.verification-complete.json' }, reports: [{ path: 'diagnostics.json',
        itemsPath: 'issues', identityFields: ['code'] }],
    } });
    const config = await loadConfig({ repoRoot: repo, home: join(root, `${scenario}-home`), env: {} });
    let stages = 0;
    const plan = { goal: 'Exercise diagnostic verification', steps: [
      'S1 fix fixture', 'S2 check fixture', 'S3 add regression cases', 'S4 document behavior',
    ], acceptanceCriteria: ['The requested fix is complete'], risks: [], expectedFiles: [] };
    const runtime = createOrchestratorRuntime({ getConfig: async () => config,
      attachments: { persistTurnAttachments: async () => ({ attachments: [], commitSucceeded: async () => {}, commitFailed: async () => {} }),
        buildHistoricalAttachmentBlocks: async () => ({ blocks: [] }), cleanupSessionAttachments: async () => {} },
      createRegistry: async () => ({
        resolveRole: (role) => ({ role, profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } }),
        invokeRole: async (role) => {
          let output;
          if (role === 'router') output = { mode: 'change', writeIntent: 'explicit', complexity: 'high', risk: 'normal', reason: 'Test implementation', task: emptyTaskSpec('change', 'explicit') };
          else if (role === 'explorer') output = { summary: 'Fixture', relevantFiles: ['src.js'], constraints: [], existingPatterns: [], likelyVerification: [], unknowns: [] };
          else if (role === 'planner') output = plan;
          else if (role.startsWith('coder')) {
            stages++;
            if (stages === 1) {
              await writeFile(join(repo, 'src.js'), 'implemented\n');
              await writeFile(join(repo, 'scenario.json'), JSON.stringify({ issues: problems, exit: 3 }));
              // Simulate the coder running the check and reporting its nonzero exit as failed.
              const executed = spawnSync('node', ['check.mjs'], { cwd: repo }); assert.equal(executed.status, 3);
              output = { action: 'changed', summary: 'Stage I1 modified code and ran checker',
                stepResults: [1,2,3].map((i) => ({ id: `S${i}`, status: 'implemented', proofKind: 'change',
                  evidence: 'Changed the real fixture and inspected the diagnostic report after the tool run.',
                  checks: i === 1 ? [{ command: 'node check.mjs', outcome: 'failed',
                    evidence: 'The analyzer returned a nonzero exit code and updated diagnostics.json.' }] : [],
                })), changedFiles: ['src.js', 'scenario.json', 'diagnostics.json'], notes: [] };
            } else output = { action: 'no_change', summary: 'Stage I2 not yet completed', stepResults: [], changedFiles: [], notes: [] };
          } else throw new Error(`Unexpected ${role}`);
          return { output, resolved: { profileName: 'fake', providerName: 'fake', profile: { model: 'fake', contextWindow: 32000 } },
            meta: { elapsedMs: 1, structuredOutput: { format: 'structured' } } };
        }, close: async () => {},
      }),
    });
    const { sessionId } = await runtime.createSession({ cwd: repo });
    const response = await runtime.runTurn({ sessionId, invocation: { task: 'Implement code and tests' }, rawText: 'Implement code and tests' });
    assert.equal(response.result.status, 'implementation_incomplete');
    const saved = await runtime.restoreSession({ sessionId, cwd: repo });
    if (expectedReason) {
      assert.equal(saved.implementationCheckpoint.interruption.reason, expectedReason);
      assert.deepEqual(saved.implementationCheckpoint.completedStages, []);
    } else {
      assert.deepEqual(saved.implementationCheckpoint.completedStages, ['I1'],
        'semantically unchanged nonzero report is not the same as a failing implementation stage');
      assert.equal(saved.implementationCheckpoint.interruptedStage, 'I2');
    }
  }
  console.log('evaluation/verification-effects-stage: PASS (real host-neutral staged workflow, improvement and regression)');
} finally {
  for (const [k, value] of Object.entries(old)) if (value === undefined) delete process.env[k]; else process.env[k] = value;
  await rm(root, { recursive: true, force: true });
}
