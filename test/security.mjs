import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateSecurityPath,
  mergeSecurityConfig,
  validateSecurityConfig,
} from '../src/security.mjs';
import {
  captureDeniedPathBaseline,
  captureRepoState,
  gitMetadataChanged,
  gitMetadataDiff,
  workspaceReconciliationDiff,
  runVerification,
  changedDeniedPathsBetweenBaselines,
  execFileSafe,
  restoreDeniedPaths,
} from '../src/repo.mjs';

const base = validateSecurityConfig({
  caseSensitive: false,
  denyPaths: ['.env'],
  denyGlobs: ['**/.env.*', '**/*.private.json', '**/*.key'],
  allowPaths: ['.env.example'],
  allowGlobs: ['**/.env.*.example'],
});

assert.equal(evaluateSecurityPath('.ENV', base).denied, true, 'default matching should be case-insensitive');
assert.equal(evaluateSecurityPath('.env.local', base).denied, true);
assert.equal(evaluateSecurityPath('.env.example', base).denied, false, 'exact allow should exempt a broad deny glob');
assert.equal(evaluateSecurityPath('a/.env.local.example', base).denied, false, 'allow glob should exempt a broad deny glob');

const exactWins = validateSecurityConfig({
  denyPaths: ['fixtures/public.private.json'],
  denyGlobs: ['**/*.private.json'],
  allowPaths: ['fixtures/public.private.json'],
});
assert.equal(evaluateSecurityPath('fixtures/public.private.json', exactWins).denied, true, 'exact denyPaths must win');

const merged = validateSecurityConfig(mergeSecurityConfig(base, {
  denyPaths: ['config/development.json'],
  denyGlobs: ['internal/credentials/**'],
  allowPaths: ['fixtures/public.private.json'],
}));
assert.equal(evaluateSecurityPath('.env', merged).denied, true, 'base deny rules must survive overrides');
assert.equal(evaluateSecurityPath('config/development.json', merged).denied, true);
assert.equal(evaluateSecurityPath('internal/credentials/token.txt', merged).denied, true);
assert.equal(evaluateSecurityPath('fixtures/public.private.json', merged).denied, false);

assert.throws(() => validateSecurityConfig({ denyPaths: ['C:/Windows/secret'] }), /repository-relative/);
assert.throws(() => validateSecurityConfig({ denyGlobs: ['C:relative'] }), /repository-relative/);
assert.throws(() => validateSecurityConfig({ denyPaths: ['../outside'] }), /parent-directory|inside the repository/);
assert.throws(() => validateSecurityConfig({ denyPaths: ['foo/../outside'] }), /parent-directory/);
assert.throws(() => validateSecurityConfig({ denyGlobs: ['/absolute/**'] }), /repository-relative/);
assert.throws(() => validateSecurityConfig({ denyPaths: 'not-an-array' }), /array/);
assert.throws(() => mergeSecurityConfig(base, { denyPaths: 'not-an-array' }), /array/);
assert.throws(() => validateSecurityConfig({ caseSensitive: 'false' }), /boolean/);
const trusted = mergeSecurityConfig({ denyGlobs: ['**/*.pem'], allowGlobs: ['public/*.pem'] },
  { allowGlobs: ['**/*'] }, { lockBaseDenials: true });
assert.equal(evaluateSecurityPath('tls/private.pem', trusted).denied, true,
  'project-wide allow must not override a global-level denial');
assert.equal(evaluateSecurityPath('public/example.pem', trusted).denied, false,
  'trusted exceptions remain effective at their original trust layer');
const explicitTrustedOverride = mergeSecurityConfig(trusted, { allowGlobs: ['**/*.pem'] }, { trustedOverride: true });
assert.equal(evaluateSecurityPath('tls/private.pem', explicitTrustedOverride).denied, false,
  'explicit trusted environment override may relax an inherited glob denial');


// Ignored sensitive files are deliberately absent from normal Git status/diff,
// so the security layer keeps a separate denied-path snapshot and delta.
const repo = await mkdtemp(join(tmpdir(), 'role-orchestrator-security-'));
try {
  await execFileSafe('git', ['init', '-q'], { cwd: repo });
  await execFileSafe('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  await execFileSafe('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await writeFile(join(repo, '.gitignore'), '.env\n*.key\n');
  await writeFile(join(repo, 'tracked.txt'), 'tracked\n');
  await execFileSafe('git', ['add', '.gitignore', 'tracked.txt'], { cwd: repo });
  await execFileSafe('git', ['commit', '-qm', 'initial'], { cwd: repo });
  await writeFile(join(repo, '.env'), 'ORIGINAL=1\n');

  const before = await captureDeniedPathBaseline(repo, base);
  assert.equal(before.has('.env'), true, 'ignored .env must be captured by the denied-path baseline');

  await writeFile(join(repo, '.env'), 'CHANGED=1\n');
  await writeFile(join(repo, 'new.key'), 'new secret\n');
  const after = await captureDeniedPathBaseline(repo, base);
  assert.deepEqual(changedDeniedPathsBetweenBaselines(before, after), ['.env', 'new.key']);

  await restoreDeniedPaths(repo, ['.env', 'new.key'], base, before);
  assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'ORIGINAL=1\n');
  await assert.rejects(() => readFile(join(repo, 'new.key'), 'utf8'), (error) => error?.code === 'ENOENT');
} finally {
  await rm(repo, { recursive: true, force: true });
}


// A denied path with a symlink ancestor must never traverse into a directory
// outside the repository, even when that path is explicitly deny-listed.
const linkedRepo = await mkdtemp(join(tmpdir(), 'role-orchestrator-linked-'));
const outside = await mkdtemp(join(tmpdir(), 'role-orchestrator-outside-'));
try {
  await execFileSafe('git', ['init', '-q'], { cwd: linkedRepo });
  await writeFile(join(outside, 'secret.txt'), 'UNCHANGED');
  await symlink(outside, join(linkedRepo, 'linked'));
  const policy = validateSecurityConfig({ denyPaths: ['linked/secret.txt'] });
  await assert.rejects(() => captureDeniedPathBaseline(linkedRepo, policy),
    /ELOOP|ENOTDIR|symlink|Unsafe|directory/i);
  await assert.rejects(() => restoreDeniedPaths(linkedRepo, ['linked/secret.txt'], policy,
    new Map([['linked/secret.txt', { type: 'file', data: Buffer.from('WRONG'), mode: 0o600 }]])),
  /ELOOP|ENOTDIR|symlink|Unsafe|directory/i);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'UNCHANGED');
} finally {
  await rm(linkedRepo, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

const incomplete = await execFileSafe(process.execPath,
  ['-e', 'process.stdout.write("A".repeat(150))'], { maxCaptureChars: 30, maxResultChars: 30 });
assert.equal(incomplete.truncated, true);
await assert.rejects(() => execFileSafe(process.execPath,
  ['-e', 'process.stdout.write("A".repeat(150))'],
  { maxCaptureChars: 30, maxResultChars: 30, requireComplete: true }),
/COMMAND_OUTPUT_TRUNCATED|incomplete machine-readable/);

// Git metadata mutations are semantically tracked even when HEAD itself does not
// move. This catches staging, refs, and local-config writes without hashing the
// volatile binary index file directly.
const metaRepo = await mkdtemp(join(tmpdir(), 'role-orchestrator-gitmeta-'));
try {
  await execFileSafe('git', ['init', '-q'], { cwd: metaRepo });
  await execFileSafe('git', ['config', 'user.email', 'test@example.invalid'], { cwd: metaRepo });
  await execFileSafe('git', ['config', 'user.name', 'Test'], { cwd: metaRepo });
  await writeFile(join(metaRepo, 'a.txt'), 'one\n');
  await execFileSafe('git', ['add', 'a.txt'], { cwd: metaRepo });
  await execFileSafe('git', ['commit', '-qm', 'initial'], { cwd: metaRepo });

  const clean = await captureRepoState(metaRepo);
  await writeFile(join(metaRepo, 'a.txt'), 'two\n');
  const unstaged = await captureRepoState(metaRepo);
  assert.equal(gitMetadataChanged(clean, unstaged), false, 'ordinary worktree edits are not Git metadata mutations');
  await execFileSafe('git', ['add', 'a.txt'], { cwd: metaRepo });
  const staged = await captureRepoState(metaRepo);
  assert.equal(gitMetadataChanged(unstaged, staged), true, 'git add must be detected');
  assert.deepEqual(gitMetadataDiff(unstaged, staged).fields, ['index']);
  assert.deepEqual(workspaceReconciliationDiff(unstaged, staged).gitFields, ['index'], 'index changes are semantic for read-only reconciliation');
  assert.equal((await execFileSafe('git', ['diff', '--cached', '--name-only'], { cwd: metaRepo })).stdout.trim(), 'a.txt', 'staging must be preserved');

  await execFileSafe('git', ['reset', '-q', 'HEAD', '--', 'a.txt'], { cwd: metaRepo });
  const beforeConfig = await captureRepoState(metaRepo);
  await execFileSafe('git', ['config', 'audit.marker', 'yes'], { cwd: metaRepo });
  const afterConfig = await captureRepoState(metaRepo);
  assert.equal(gitMetadataChanged(beforeConfig, afterConfig), true, 'local git config mutation must be detected');
  assert.deepEqual(gitMetadataDiff(beforeConfig, afterConfig).fields, ['localConfig']);
  assert.equal(workspaceReconciliationDiff(beforeConfig, afterConfig).changed, false, 'local config changes are audit-only for read-only reconciliation');
  assert.deepEqual(workspaceReconciliationDiff(beforeConfig, afterConfig).ignoredGitFields, ['localConfig']);
  const marker = await execFileSafe('git', ['config', '--get', 'audit.marker'], { cwd: metaRepo });
  assert.equal(marker.stdout.trim(), 'yes', 'local config change must be preserved');



  const beforeRef = await captureRepoState(metaRepo);
  await execFileSafe('git', ['branch', 'audit-temp'], { cwd: metaRepo });
  const afterRef = await captureRepoState(metaRepo);
  assert.equal(gitMetadataChanged(beforeRef, afterRef), true, 'ref creation must be detected');
  assert.deepEqual(gitMetadataDiff(beforeRef, afterRef).fields, ['refs']);
  assert.equal(workspaceReconciliationDiff(beforeRef, afterRef).changed, false, 'unrelated ref changes are audit-only for read-only reconciliation');
  assert.deepEqual(workspaceReconciliationDiff(beforeRef, afterRef).ignoredGitFields, ['refs']);
  assert.deepEqual(gitMetadataDiff(beforeRef, afterRef).refs.added, ['refs/heads/audit-temp']);
  const branch = await execFileSafe('git', ['show-ref', '--verify', '--quiet', 'refs/heads/audit-temp'], { cwd: metaRepo, allowFailure: true });
  assert.equal(branch.code, 0, 'ref changes must be preserved');


  await mkdir(join(metaRepo, 'node_modules'));
  const oldVerify = process.env.AGENT_VERIFY_COMMANDS;
  process.env.AGENT_VERIFY_COMMANDS = JSON.stringify([[process.execPath, '-e', "console.error('Error [ERR_MODULE_NOT_FOUND]: Cannot find package x'); process.exit(1)"]]);
  try {
    const verification = await runVerification(metaRepo);
    assert.equal(verification.find((item) => item.command.startsWith(process.execPath)).status, 'TEST_FAILED', 'module resolution failure with an installed dependency tree is a code/test failure, not TOOL_UNAVAILABLE');
  } finally {
    if (oldVerify === undefined) delete process.env.AGENT_VERIFY_COMMANDS; else process.env.AGENT_VERIFY_COMMANDS = oldVerify;
  }
} finally {
  await rm(metaRepo, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, securityPolicy: 'passed' }));
