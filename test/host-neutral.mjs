import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { loadInstructionContext, loadInvocationContext, formatInstructionContext } from '../src/context.mjs';
import { readScopedText } from '../src/instruction-files.mjs';
import { implementationStagePresentation } from '../src/acp-presentation.mjs';
import { createSessionLifecycle } from '../src/session-lifecycle.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'role-orchestrator-host-'));
const home = join(scratch, 'home');
const project = join(scratch, 'project');
const other = join(scratch, 'other');
const state = join(scratch, 'state');
const oldState = process.env.AGENT_STATE_DIR;
const oldOverride = process.env.AGENT_CONFIG;
try {
  delete process.env.AGENT_CONFIG;
  process.env.AGENT_STATE_DIR = state;
  for (const path of [home, project, other]) await mkdir(path, { recursive: true });
  const git = (dir, args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  for (const dir of [project, other]) git(dir, ['init', '-q']);

  const global = join(home, '.agents');
  const projectAgents = join(project, '.agents');
  const globalConfig = join(global, 'role-orchestrator');
  const projectConfig = join(projectAgents, 'role-orchestrator');
  await mkdir(globalConfig, { recursive: true });
  await mkdir(projectConfig, { recursive: true });
  await mkdir(join(project, 'src', 'ui'), { recursive: true });
  await mkdir(join(projectAgents, 'review'), { recursive: true });

  await writeFile(join(globalConfig, 'ORCHESTRATOR.md'), 'GLOBAL ORCHESTRATOR\n');
  await writeFile(join(global, 'AGENTS.md'), 'GLOBAL AGENTS\n');
  await writeFile(join(projectConfig, 'ORCHESTRATOR.md'), 'PROJECT ORCHESTRATOR\n[Guide](../review/guide.md)\n');
  await writeFile(join(projectAgents, 'review', 'guide.md'), 'LINKED REVIEW RULES\n');
  await writeFile(join(projectAgents, 'review', 'optional.md'), 'UNREFERENCED RULES\n');
  await writeFile(join(project, 'AGENTS.md'), 'PROJECT AGENTS OVERRIDE\n[Guide](.agents/review/guide.md)\n');
  await writeFile(join(project, 'src', 'AGENTS.md'), 'SRC RULES\n');
  await writeFile(join(project, 'src', 'ui', 'AGENTS.md'), 'UI RULES\n');
  for (const name of ['CLAUDE.md', 'GEMINI.md', '.cursorrules', '.clinerules']) {
    await writeFile(join(project, name), 'DO NOT LOAD\n');
  }

  const instructions = await loadInstructionContext(project, { home, scopePaths: [join(project, 'src', 'ui')] });
  assert.deepEqual(instructions.map((entry) => entry.body.split('\n')[0]), [
    'GLOBAL ORCHESTRATOR', 'GLOBAL AGENTS', 'PROJECT ORCHESTRATOR',
    'LINKED REVIEW RULES', 'PROJECT AGENTS OVERRIDE', 'SRC RULES', 'UI RULES',
  ]);
  assert.equal(new Set(instructions.map((entry) => entry.absolutePath)).size, instructions.length);
  const context = await loadInvocationContext(project, { home, scopePaths: [join(project, 'src', 'ui')] });
  assert(context.availableRules.includes('.agents/review/optional.md'));
  assert(!formatInstructionContext(context).includes('UNREFERENCED RULES'));
  assert(!formatInstructionContext(context).includes('DO NOT LOAD'));
  assert.equal((await loadInstructionContext(other, { home: join(scratch, 'empty-home') })).length, 0);
  await writeFile(join(projectAgents, 'review', 'large.md'), 'x'.repeat(41_000));
  await writeFile(join(projectConfig, 'ORCHESTRATOR.md'), '[Oversized](../review/large.md)');
  await assert.rejects(() => loadInstructionContext(project, { home }), /exceeds.*limit/);
  await writeFile(join(projectConfig, 'ORCHESTRATOR.md'), 'PROJECT ORCHESTRATOR\n[Guide](../review/guide.md)');

  await writeFile(join(scratch, 'secret.md'), 'SECRET');
  await symlink(join(scratch, 'secret.md'), join(projectAgents, 'review', 'secret.md'));
  await assert.rejects(() => readScopedText(join(projectAgents, 'review', 'secret.md'), projectAgents), /symlink escapes/);
  await writeFile(join(projectConfig, 'ORCHESTRATOR.md'), '[Unsafe](../review/secret.md)');
  await assert.rejects(() => loadInstructionContext(project, { home }), /symlink escapes/);
  await writeFile(join(projectConfig, 'ORCHESTRATOR.md'), 'PROJECT ORCHESTRATOR');

  const configPath = join(globalConfig, 'config.json');
  await writeFile(configPath, JSON.stringify({ rolePresets: [{ id: 'globalextra', label: 'Global', roles: {} }] }));
  await writeFile(join(projectConfig, 'config.json'), JSON.stringify({
    rolePresets: [
      { id: 'globalextra', label: 'Local replacement', roles: {} },
      { id: 'projectextra', label: 'Local', roles: {} },
    ],
    policy: { maxFixRounds: 3 },
  }));
  const cfg = await loadConfig({ home, repoRoot: project, env: {} });
  assert.deepEqual(cfg.rolePresets.slice(-2).map((preset) => preset.id), ['globalextra', 'projectextra']);
  assert.equal(cfg.rolePresets.find((preset) => preset.id === 'globalextra').label, 'Local replacement');
  assert.equal(cfg.policy.maxFixRounds, 3);
  await writeFile(join(projectConfig, 'config.json'), JSON.stringify({
    rolePresets: [{ id: 'duplicate', label: 'A', roles: {} }, { id: 'duplicate', label: 'B', roles: {} }],
  }));
  await assert.rejects(() => loadConfig({ home, repoRoot: project, env: {} }), /Duplicate rolePresets IDs/);
  await writeFile(join(projectConfig, 'config.json'), JSON.stringify({
    rolePresets: [
      { id: 'globalextra', label: 'Local replacement', roles: {} },
      { id: 'projectextra', label: 'Local', roles: {} },
    ],
    policy: { maxFixRounds: 3 },
  }));
  const globalOnly = await loadConfig({ home, repoRoot: other, env: {} });
  assert.equal(globalOnly.rolePresets.some((preset) => preset.id === 'projectextra'), false);

  const event = { index: 6, total: 9, steps: [
    { id: 'S16', description: 'Покрыть debugger/breakpoint. ' + 'Очень длинное описание. '.repeat(50) },
    { id: 'S17', description: 'Тесты state-flow и Unicode 🧪' },
    { id: 'S18', description: 'Проверить порядок вычислений' },
  ] };
  const display = implementationStagePresentation(event);
  assert.equal(display.summary, '▶ **Implementation 6/9** — S16–S18');
  assert(display.details.includes(event.steps[0].description.trim()));
  assert(display.details.includes('S18 — Проверить порядок вычислений'));
  assert.equal(display.summary.includes('Очень'), false);
  assert.equal(implementationStagePresentation({ index: 2, total: 5, steps: [{ id: 'S2', description: 'a' }, { id: 'S6', description: 'b' }] }).summary, '▶ **Implementation 2/5** — S2, S6');

  // A minimal headless adapter uses the same session service as ACP, with no
  // Zed process or protocol SDK and without touching provider implementations.
  const lifecycle = createSessionLifecycle({ getConfig: async (repoRoot) => loadConfig({ home, repoRoot, env: {} }) });
  const created = await lifecycle.create({ cwd: project });
  assert.equal(created.session.roleAssignments.router.profileName != null, true);
  created.session.implementationCheckpoint = { version: 1, planId: 'p1', repoKey: 'k1', completedStages: ['I1'], records: [] };
  created.session.fastModeOverride = true;
  await lifecycle.persist(created.sessionId, created.session);
  const reloaded = createSessionLifecycle({ getConfig: async (repoRoot) => loadConfig({ home, repoRoot, env: {} }) });
  await writeFile(join(projectConfig, 'config.json'), JSON.stringify({
    rolePresets: [{ id: 'projectextra', label: 'Changed after session creation', roles: { reviewerLow: 'balanced' } }],
    defaultRolePreset: 'projectextra',
  }));
  const restored = await reloaded.restore({ sessionId: created.sessionId, cwd: project });
  assert.deepEqual(restored.implementationCheckpoint.completedStages, ['I1']);
  assert.deepEqual(restored.roleAssignments, created.session.roleAssignments);
  assert.equal(restored.fastModeOverride, true);
  await assert.rejects(() => reloaded.restore({ sessionId: created.sessionId, cwd: other }), /belongs to/);
  assert((await readFile(join(state, 'sessions', `${created.sessionId}.json`), 'utf8')).includes('roleAssignments'));
  console.log('host-neutral: passed');
} finally {
  if (oldState === undefined) delete process.env.AGENT_STATE_DIR; else process.env.AGENT_STATE_DIR = oldState;
  if (oldOverride === undefined) delete process.env.AGENT_CONFIG; else process.env.AGENT_CONFIG = oldOverride;
  await rm(scratch, { recursive: true, force: true });
}
