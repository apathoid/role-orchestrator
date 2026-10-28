import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = resolve(new URL('..', import.meta.url).pathname);
const fakeCodex = join(projectRoot, 'test/fake-codex-acp.mjs');

function run(program, args, { cwd, env = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(`${program} failed (${code})\n${stderr}\n${stdout}`)));
  });
}

async function initRepo(root, { twoSourceCommits = false } = {}) {
  await writeFile(join(root, 'greeting.txt'), 'hello\n');
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'smoke@example.invalid'], { cwd: root });
  await run('git', ['config', 'user.name', 'Smoke Test'], { cwd: root });
  await run('git', ['add', '.'], { cwd: root });
  await run('git', ['commit', '-qm', 'initial'], { cwd: root });
  if (twoSourceCommits) {
    await writeFile(join(root, 'history.txt'), 'historical context\n');
    await run('git', ['add', 'history.txt'], { cwd: root });
    await run('git', ['commit', '-qm', 'history context'], { cwd: root });
  }
}

async function makeOverride(root, patch = {}) {
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify({
    providers: { subscription: { binary: fakeCodex, envAllowlist: ['FAKE_CODEX_LOG','FAKE_EXPECT_CODER_HISTORY','FAKE_EXPECT_COMMIT_REVIEW','FAKE_SOURCE_COMMIT'] } },
    ...patch,
  }));
  return path;
}

function parseLog(raw) {
  return raw.trim().split('\n').filter(Boolean).map(JSON.parse);
}

function assertProviderRuns(entries, { expectChatGPT = true, expectCustomProvider = false } = {}) {
  let sawCustomProvider = false;
  for (const entry of entries) {
    const config = entry.codexConfig ? JSON.parse(entry.codexConfig) : {};
    const hasForcedChatGPT = config.forced_login_method === 'chatgpt';
    const custom = entry.modelProvider === 'llamacpp';
    sawCustomProvider ||= custom;
    if (custom && hasForcedChatGPT) throw new Error('Custom provider must not inherit ChatGPT auth forcing.');
    if (!expectCustomProvider && expectChatGPT !== hasForcedChatGPT) throw new Error(`Unexpected ChatGPT auth forcing state: ${hasForcedChatGPT}`);
    if (!entry.model) throw new Error('ACP session model was not configured');
  }
  if (expectCustomProvider && !sawCustomProvider) throw new Error('Missing custom local model provider');
}


async function scenarioChange(name, task, expected, { highHistory = false, configPatch = {}, expectChatGPT = true, expectCustomProvider = false, extraEnv = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), `role-orchestrator-${name}-`));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo, { twoSourceCommits: highHistory });
  const log = join(root, 'codex.log');
  const override = await makeOverride(root, configPatch);
  try {
    const result = await run(process.execPath, ['src/index.mjs', task], {
      cwd: projectRoot,
      env: {
        AGENT_REPO: repo,
        AGENT_CONFIG: override,
        FAKE_CODEX_LOG: log,
        ...(highHistory ? { FAKE_EXPECT_CODER_HISTORY: '1' } : {}),
        ...extraEnv,
      },
    });
    const greeting = (await readFile(join(repo, 'greeting.txt'), 'utf8')).trim();
    if (greeting !== expected) throw new Error(`${name}: expected ${expected}, got ${greeting}`);
    const entries = parseLog(await readFile(log, 'utf8'));
    assertProviderRuns(entries, { expectChatGPT, expectCustomProvider });
    const coderEntries = entries.filter((x) => x.role === 'coder');
    if (!coderEntries.length) throw new Error(`${name}: coder was not invoked`);
    if (coderEntries.some((x) => x.sandboxMode !== 'workspace-write')) throw new Error(`${name}: coder did not use workspace-write`);
    if (coderEntries.some((x) => x.cwd !== repo)) throw new Error(`${name}: coder was not run in the real project workspace`);
    if (entries.filter((x) => x.role !== 'coder').some((x) => x.sandboxMode !== 'read-only')) throw new Error(`${name}: non-coder role was not read-only`);
    const parsed = JSON.parse(result.stdout);
    if (!['applied', 'no_change'].includes(parsed.status)) throw new Error(`${name}: unexpected status ${parsed.status}`);
    return entries.length;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioDirtyFollowup() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-dirty-followup-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const override = await makeOverride(root);
  try {
    await run(process.execPath, ['src/index.mjs', 'Change the greeting.'], { cwd: projectRoot, env: { AGENT_REPO: repo, AGENT_CONFIG: override } });
    const statusAfterFirst = await run('git', ['status', '--porcelain=v1'], { cwd: repo });
    if (!statusAfterFirst.stdout.trim()) throw new Error('dirty-followup: first run should leave an uncommitted accepted change');
    await run(process.execPath, ['src/index.mjs', 'NEEDS_FIX Change the greeting.'], { cwd: projectRoot, env: { AGENT_REPO: repo, AGENT_CONFIG: override } });
    const greeting = (await readFile(join(repo, 'greeting.txt'), 'utf8')).trim();
    if (greeting !== 'hello world!') throw new Error(`dirty-followup: expected hello world!, got ${greeting}`);
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioReviewOnly({ explicitMode = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-review-only-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo, { twoSourceCommits: true });
  const log = join(root, 'codex.log');
  const override = await makeOverride(root);
  try {
    const argv = explicitMode
      ? ['src/index.mjs', '--mode', 'review', 'REVIEW_FINDING Review my code.']
      : ['src/index.mjs', 'REVIEW_FINDING Review my code.'];
    const result = await run(process.execPath, argv, { cwd: projectRoot, env: { AGENT_REPO: repo, AGENT_CONFIG: override, FAKE_CODEX_LOG: log } });
    const greeting = (await readFile(join(repo, 'greeting.txt'), 'utf8')).trim();
    if (greeting !== 'hello') throw new Error('review-only modified source repository');
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'review_findings') throw new Error(`review-only: expected review_findings, got ${parsed.status}`);
    const entries = parseLog(await readFile(log, 'utf8'));
    if (entries.some((x) => x.sandboxMode !== 'read-only')) throw new Error('review-only invoked a writable model role');
    if (entries.some((x) => x.role === 'coder')) throw new Error('review-only invoked coder');
    return entries.length;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioReviewSkillFormatting() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-review-skill-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo, { twoSourceCommits: true });
  const skillDir = join(repo, '.agents', 'skills', 'review-code');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: review-code\ndescription: Review code using a custom evidence-first report format.\n---\n\n# Output format\n\nUse the heading \"Skill review format\" and an \"Evidence\" section.\n`);
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', '--mode', 'review', '--skill', 'review-code', 'REVIEW_FINDING Review my code.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override },
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'review_findings') throw new Error(`review-skill: expected review_findings, got ${parsed.status}`);
    if (parsed.activeSkill?.name !== 'review-code') throw new Error('review-skill: active skill metadata missing');
    if (!parsed.responseText?.includes('Skill review format')) throw new Error('review-skill: final responder did not preserve the skill-driven presentation');
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioReviewSpecificCommit() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-review-commit-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  await writeFile(join(repo, 'greeting.txt'), 'hello target\n');
  await run('git', ['add', 'greeting.txt'], { cwd: repo });
  await run('git', ['commit', '-qm', 'target change'], { cwd: repo });
  const target = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  await writeFile(join(repo, 'greeting.txt'), 'hello later\n');
  await run('git', ['add', 'greeting.txt'], { cwd: repo });
  await run('git', ['commit', '-qm', 'later change'], { cwd: repo });

  const log = join(root, 'codex.log');
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', `Review commit ${target}.\nREVIEW_FINDING`], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override, FAKE_CODEX_LOG: log, FAKE_EXPECT_COMMIT_REVIEW: '1', FAKE_SOURCE_COMMIT: target },
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'review_findings') throw new Error(`review-commit: unexpected status ${parsed.status}`);
    if (parsed.reviewTarget?.sourceCommit !== target) throw new Error('review-commit: resolved commit missing from result');
    const entries = parseLog(await readFile(log, 'utf8'));
    if (entries.some((x) => x.sandboxMode !== 'read-only')) throw new Error('review-commit invoked writable role');
    if (entries.some((x) => x.cwd !== repo)) throw new Error('review-commit roles were not run in the real source repository');
    return entries.length;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioInvestigateOnly() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-investigate-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo, { twoSourceCommits: true });
  const log = join(root, 'codex.log');
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', '--mode', 'investigate', 'INVESTIGATE_ONLY Explain the greeting implementation.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override, FAKE_CODEX_LOG: log },
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'investigated') throw new Error(`investigate-only: unexpected status ${parsed.status}`);
    const entries = parseLog(await readFile(log, 'utf8'));
    if (entries.some((x) => x.sandboxMode !== 'read-only')) throw new Error('investigate-only invoked writable role');
    if (!entries.some((x) => x.role === 'investigator')) throw new Error('investigate-only did not invoke investigator');
    if (entries.some((x) => x.role === 'planner')) throw new Error('investigate-only invoked planner even though no executor consumes its plan');
    if (!parsed.responseText?.includes('greeting')) throw new Error('investigate-only missing native user-facing investigation response');
    return entries.length;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}


async function scenarioToolUnavailableDoesNotFixLoop() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-tool-unavailable-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo, { twoSourceCommits: true });
  const log = join(root, 'codex.log');
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', 'Change the greeting.'], {
      cwd: projectRoot,
      env: {
        AGENT_REPO: repo,
        AGENT_CONFIG: override,
        FAKE_CODEX_LOG: log,
        AGENT_VERIFY_COMMANDS: JSON.stringify([['definitely-missing-vitest-binary']]),
      },
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'completed_with_unverified_checks') throw new Error(`tool-unavailable: unexpected status ${parsed.status}`);
    if (parsed.verificationDisposition !== 'UNVERIFIED') throw new Error(`tool-unavailable: unexpected disposition ${parsed.verificationDisposition}`);
    if (!parsed.verification.some((x) => x.status === 'TOOL_UNAVAILABLE')) throw new Error('tool-unavailable: failure was not classified as TOOL_UNAVAILABLE');
    const entries = parseLog(await readFile(log, 'utf8'));
    if (entries.filter((x) => x.role === 'coder').length !== 1) throw new Error('tool-unavailable: environment failure incorrectly triggered a fix loop');
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioUsesExistingNodeModules() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-existing-node-modules-'));
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(repo, 'greeting.txt'), 'hello\n');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }, null, 2));
  const vitest = join(repo, 'node_modules', '.bin', 'vitest');
  await writeFile(vitest, '#!/bin/sh\necho existing-node-modules-vitest\nexit 0\n');
  await chmod(vitest, 0o755);
  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['config', 'user.email', 'smoke@example.invalid'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Smoke Test'], { cwd: repo });
  await run('git', ['add', 'greeting.txt', 'package.json'], { cwd: repo });
  await run('git', ['commit', '-qm', 'initial'], { cwd: repo });
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', 'Change the greeting.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override },
    });
    const parsed = JSON.parse(result.stdout);
    const testResult = parsed.verification.find((x) => x.command === 'npm run test');
    if (!testResult || testResult.status !== 'PASS' || !testResult.output.includes('existing-node-modules-vitest')) {
      throw new Error(`existing-node-modules: project-local vitest was not used: ${JSON.stringify(testResult)}`);
    }
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}


async function scenarioGeneratedReportIsAccepted() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-generated-report-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo, { twoSourceCommits: true });
  const log = join(root, 'codex.log');
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', 'GENERATED_REPORT Change the greeting and run architecture reporting.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override, FAKE_CODEX_LOG: log },
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'applied') throw new Error(`generated-report: unexpected status ${parsed.status}`);
    if (!parsed.changedPaths?.includes('report/index.json')) throw new Error(`generated-report: actual generated file missing from changedPaths: ${JSON.stringify(parsed.changedPaths)}`);
    const generated = await readFile(join(repo, 'report/index.json'), 'utf8');
    if (!generated.includes('generated')) throw new Error('generated-report: generated artifact was not preserved');
    const entries = parseLog(await readFile(log, 'utf8'));
    if (entries.filter((x) => x.role === 'coder').length !== 1) throw new Error('generated-report: generated side effect incorrectly triggered a fix loop');
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioUnstructuredExplorerAccepted() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-unstructured-explorer-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', 'MALFORMED_FINAL Change the greeting.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override },
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'applied') throw new Error(`unstructured-explorer: unexpected status ${parsed.status}`);
    if (parsed.exploration?.format !== 'text') throw new Error('unstructured-explorer: plain text result was not preserved');
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioUnstructuredReviewResolved() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-unstructured-review-resolved-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', 'MALFORMED_REVIEWER Change the greeting.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override },
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'applied') throw new Error(`unstructured-review-resolved: unexpected status ${parsed.status}`);
    if (parsed.review?.verdict !== 'unknown') throw new Error('unstructured-review-resolved: reviewer text was not marked indeterminate');
    if (parsed.finalValidation?.verdict !== 'pass') throw new Error('unstructured-review-resolved: final validator did not resolve reviewer text');
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioUnstructuredReviewUnresolved() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-unstructured-review-unresolved-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', 'MALFORMED_REVIEWER MALFORMED_FINAL_VALIDATOR Change the greeting.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override },
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.status !== 'completed_with_unresolved_review') throw new Error(`unstructured-review-unresolved: unexpected status ${parsed.status}`);
    const greeting = (await readFile(join(repo, 'greeting.txt'), 'utf8')).trim();
    if (greeting !== 'hello world') throw new Error('unstructured-review-unresolved: workspace changes were not preserved');
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioUnstructuredRouterRejected() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-unstructured-router-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const log = join(root, 'codex.log');
  const override = await makeOverride(root);
  try {
    const result = await run(process.execPath, ['src/index.mjs', 'MALFORMED_ROUTER Explain the greeting implementation.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override, FAKE_CODEX_LOG: log },
    });
    const parsed = JSON.parse(result.stdout);
    // A malformed Router result cannot be treated as a successful semantic
    // interpretation, even for read-only Investigate.
    if (parsed.status !== 'intent_unresolved' || parsed.errorCode !== 'missing_task_spec')
      throw new Error(`unstructured-router: expected fail-closed intent_unresolved, got ${parsed.status}/${parsed.errorCode}`);
    const entries = parseLog(await readFile(log, 'utf8'));
    if (entries.length !== 1 || entries[0].role !== 'router')
      throw new Error('unstructured-router: unexpected additional model invocation after invalid Router output');
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenarioLinkedWorktreeSource() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-linked-source-'));
  const main = join(root, 'main');
  const linked = join(root, 'linked');
  await mkdir(main, { recursive: true });
  await initRepo(main, { twoSourceCommits: true });
  await run('git', ['branch', 'dev'], { cwd: main });
  await run('git', ['worktree', 'add', '-q', linked, 'dev'], { cwd: main });
  const override = await makeOverride(root);
  try {
    await run(process.execPath, ['src/index.mjs', 'Change the greeting.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: linked, AGENT_CONFIG: override, FAKE_EXPECT_CODER_HISTORY: '1' },
    });
    const greeting = (await readFile(join(linked, 'greeting.txt'), 'utf8')).trim();
    if (greeting !== 'hello world') throw new Error(`linked-worktree-source: expected hello world, got ${greeting}`);
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}


async function scenarioMountedFilesystemWorkspace() {
  // Ensure the real-workspace flow behaves the same when the repository lives
  // on a mounted filesystem rather than the filesystem containing /tmp.
  const sourceParent = '/dev/shm';
  let sourceStat;
  let tempStat;
  try {
    const fs = await import('node:fs/promises');
    [sourceStat, tempStat] = await Promise.all([fs.stat(sourceParent), fs.stat(tmpdir())]);
  } catch {
    return 'skipped';
  }
  if (sourceStat.dev === tempStat.dev) return 'skipped';

  const root = await mkdtemp(join(sourceParent, 'role-orchestrator-cross-fs-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo, { twoSourceCommits: true });
  const overrideRoot = await mkdtemp(join(tmpdir(), 'role-orchestrator-cross-fs-config-'));
  const override = await makeOverride(overrideRoot);
  try {
    await run(process.execPath, ['src/index.mjs', 'Change the greeting.'], {
      cwd: projectRoot,
      env: { AGENT_REPO: repo, AGENT_CONFIG: override, FAKE_EXPECT_CODER_HISTORY: '1' },
    });
    const greeting = (await readFile(join(repo, 'greeting.txt'), 'utf8')).trim();
    if (greeting !== 'hello world') throw new Error(`cross-filesystem: expected hello world, got ${greeting}`);
    return 'passed';
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(overrideRoot, { recursive: true, force: true });
  }
}

async function scenarioRejectsDeniedWrite() {
  const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-denied-write-'));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await initRepo(repo);
  const override = await makeOverride(root, { security: { denyPaths: ['config/development.json'] } });
  try {
    try {
      await run(process.execPath, ['src/index.mjs', 'DENIED_PATCH Change the greeting.'], { cwd: projectRoot, env: { AGENT_REPO: repo, AGENT_CONFIG: override } });
      throw new Error('denied-write: workflow unexpectedly succeeded');
    } catch (error) {
      if (!String(error.message).includes('security-denied path')) throw error;
    }
    return 'rejected';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const dirtyFollowup = await scenarioDirtyFollowup();
const reviewOnly = await scenarioReviewOnly();
const reviewInferred = await scenarioReviewOnly({ explicitMode: false });
const reviewSkillFormatting = await scenarioReviewSkillFormatting();
const reviewCommit = await scenarioReviewSpecificCommit();
const investigateOnly = await scenarioInvestigateOnly();
const low = await scenarioChange('low', 'Change the greeting.', 'hello world', { highHistory: true });
const high = await scenarioChange('high', 'HIGH_RISK Change the greeting.', 'hello world', { highHistory: true });
const fix = await scenarioChange('fix', 'NEEDS_FIX Change the greeting.', 'hello world!', { highHistory: true });
const escalation = await scenarioChange('escalation', 'ESCALATE Change the greeting.', 'hello world!', { highHistory: true });
const deniedWrite = await scenarioRejectsDeniedWrite();
const toolUnavailable = await scenarioToolUnavailableDoesNotFixLoop();
const existingNodeModules = await scenarioUsesExistingNodeModules();
const generatedReport = await scenarioGeneratedReportIsAccepted();
const unstructuredExplorer = await scenarioUnstructuredExplorerAccepted();
const unstructuredReviewResolved = await scenarioUnstructuredReviewResolved();
const unstructuredReviewUnresolved = await scenarioUnstructuredReviewUnresolved();
const unstructuredRouterRejected = await scenarioUnstructuredRouterRejected();
const linkedWorktreeSource = await scenarioLinkedWorktreeSource();
const mountedFilesystemWorkspace = await scenarioMountedFilesystemWorkspace();

const hybrid = await scenarioChange('hybrid', 'Change the greeting.', 'hello world', {
  highHistory: true,
  expectChatGPT: false,
  expectCustomProvider: true,
  configPatch: {
    providers: {
      subscription: { binary: fakeCodex, envAllowlist: ['FAKE_CODEX_LOG','FAKE_EXPECT_CODER_HISTORY','FAKE_EXPECT_COMMIT_REVIEW','FAKE_SOURCE_COMMIT'] },
      local: {
        type: 'codex-acp', auth: 'none', binary: fakeCodex, envAllowlist: ['FAKE_CODEX_LOG','FAKE_EXPECT_CODER_HISTORY','FAKE_EXPECT_COMMIT_REVIEW','FAKE_SOURCE_COMMIT'],
        modelProvider: { id: 'llamacpp', name: 'llama.cpp', baseURL: 'http://127.0.0.1:8080/v1' },
      },
    },
    profiles: { localFast: { provider: 'local', model: 'small' }, localWorker: { provider: 'local', model: 'medium' } },
    roles: { router: 'localFast', explorer: 'localFast', coderLow: 'localWorker', reviewerLow: 'localWorker' },
  },
});

console.log(JSON.stringify({
  ok: true,
  scenarios: { dirtyFollowup, reviewOnly, reviewInferred, reviewSkillFormatting, reviewCommit, investigateOnly, low, high, fix, escalation, deniedWrite, toolUnavailable, existingNodeModules, generatedReport, unstructuredExplorer, unstructuredReviewResolved, unstructuredReviewUnresolved, unstructuredRouterRejected, linkedWorktreeSource, mountedFilesystemWorkspace, hybrid },
}, null, 2));
