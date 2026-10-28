import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSafe, captureDeniedPathBaseline, captureRepoState, resolveCommitReviewTarget } from '../src/repo.mjs';
import { saveSession, loadSession, deleteSession } from '../src/session-store.mjs';
import { validateSecurityConfig } from '../src/security.mjs';

// Streaming UTF-8 sequences must not be replaced with U+FFFD when the pipe
// delivers the leading and trailing bytes as separate chunks.
const utf8 = await execFileSafe(process.execPath, ['-e', `
  process.stdout.write(Buffer.from([0xc3]));
  setTimeout(() => process.stdout.write(Buffer.from([0xa9,0])), 40);
`], { maxCaptureChars: 20, maxResultChars: 20, requireComplete: true });
assert.equal(utf8.stdout, 'é\0');

// Exactly filling the buffer in one chunk, then writing an extra chunk, must
// report incomplete data (this used to silently lose all later bytes).
await assert.rejects(() => execFileSafe(process.execPath, ['-e', `
  process.stdout.write('ABCD');
  setTimeout(() => process.stdout.write('EF'), 40);
`], { maxCaptureChars: 4, maxResultChars: 4, requireComplete: true }),
  error => error.code === 'COMMAND_OUTPUT_TRUNCATED');

// A consumer-provided line handler can reject malformed upstream data. This is
// an invocation failure, not an uncaught EventEmitter exception/process crash.
await assert.rejects(() => execFileSafe(process.execPath,
  ['-e', 'process.stdout.write("first\\nsecond\\n")'],
  { onStdoutLine: () => { throw new Error('line processing rejected'); } }),
  /line processing rejected/);

const temp = await mkdtemp(join(tmpdir(), 'role-remediation-post-audit-'));
const originalStateDir = process.env.AGENT_STATE_DIR;
const originalPath = process.env.PATH;
try {
  process.env.AGENT_STATE_DIR = join(temp, 'state');
  await mkdir(process.env.AGENT_STATE_DIR);
  const id = 'stale-same-process';
  await saveSession(id, { cwd: temp, transcript: [], history: [] });
  const first = await loadSession(id);
  const stale = await loadSession(id);
  first.title = 'first version';
  await saveSession(id, first);
  stale.title = 'should not overwrite';
  await assert.rejects(() => saveSession(id, stale), error => error.code === 'SESSION_REVISION_CONFLICT');
  assert.equal((await loadSession(id)).title, 'first version');
  // Spread/copied session state must preserve optimistic concurrency version.
  const copy = { ...stale, title: 'spread should not overwrite' };
  await assert.rejects(() => saveSession(id, copy), error => error.code === 'SESSION_REVISION_CONFLICT');
  await deleteSession(id);

  // A missing result from the ignored-file pathspec query must fail closed.
  // The separate workspace listing remains empty; the second ls-files query
  // emits just over the 32 MB cap of valid NUL separators (no paths).
  const bin = join(temp, 'bin');
  await mkdir(bin);
  const mockGit = join(bin, 'git');
  await writeFile(mockGit, `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args.includes('--ignored')) process.stdout.write(Buffer.alloc(32_000_001));
    else if (args[0] === 'rev-parse') process.stdout.write('a'.repeat(40) + '\\n');
    else if (args[0] === 'show') process.stdout.write('B'.repeat(200_001));
    else if (args[0] === 'symbolic-ref') process.stdout.write('C'.repeat(10_001));
  `);
  await chmod(mockGit, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const policy = validateSecurityConfig({ denyGlobs: ['**/*.key'] });
  await assert.rejects(() => captureDeniedPathBaseline(temp, policy),
    error => error.code === 'COMMAND_OUTPUT_TRUNCATED');
  await assert.rejects(() => resolveCommitReviewTarget(temp, 'HEAD'),
    error => error.code === 'COMMAND_OUTPUT_TRUNCATED',
    'commit metadata must not be silently truncated');
  await assert.rejects(() => captureRepoState(temp),
    error => error.code === 'COMMAND_OUTPUT_TRUNCATED',
    'branch reference metadata must not be silently truncated');
} finally {
  process.env.AGENT_STATE_DIR = originalStateDir;
  process.env.PATH = originalPath;
  await rm(temp, { recursive: true, force: true });
}
console.log('remediation-post-audit: passed');
