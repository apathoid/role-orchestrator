import { createHash, randomUUID } from 'node:crypto';
import { configuredVerificationPolicies, witnessDiagnosticReports, witnessGitBaselineReports, witnessDiagnosticCompletion, assessDiagnosticDelta } from './verification-effects.mjs';
import { configuredVerificationInputClosures, witnessVerificationInputs, verificationCheckId, verificationSuiteId, verificationAttemptId } from './verification-inputs.mjs';
import {
  access,
  chmod,
  mkdir,
  lstat,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  join,
} from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { withWorkspaceEntry } from './workspace-fs-boundary.mjs';
import { evaluateSecurityPath } from './security.mjs';
import { cancellationErrorFromSignal } from './cancellation.mjs';
import { createVerificationAttemptCache } from './verification/attempt-cache.mjs';

const MAX_TOOL_OUTPUT = 80_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_GIT_LIST_OUTPUT = 32_000_000;
const GIT_READ_ENV = { GIT_OPTIONAL_LOCKS: '0' }; // Avoid stat-only index refresh/lock contention in observers.

function truncate(text, max = MAX_TOOL_OUTPUT) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n...[truncated ${text.length - max} chars]`;
}

export async function execFileSafe(program, args, {
  cwd,
  input,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = {},
  unsetEnv = [],
  inheritEnv = true,
  killProcessGroup = false,
  allowFailure = false,
  maxCaptureChars = MAX_TOOL_OUTPUT * 4,
  maxResultChars = MAX_TOOL_OUTPUT,
  requireComplete = false,
  signal: abortSignal,
  onStdoutLine,
  onStderrLine,
} = {}) {
  return await new Promise((resolvePromise, reject) => {
    if (abortSignal?.aborted) {
      reject(cancellationErrorFromSignal(abortSignal));
      return;
    }
    const hasInput = input !== undefined;
    const childEnv = { ...(inheritEnv ? process.env : {}), CI: '1', ...env };
    for (const key of unsetEnv) delete childEnv[key];
    if (cwd) childEnv.PWD = cwd;

    const child = spawn(program, args, {
      cwd,
      shell: false,
      env: childEnv,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: killProcessGroup && process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let stdoutTail='', stderrTail='', stdoutTotalChars=0, stderrTotalChars=0;
    let stdoutLineBuffer = '';
    let stderrLineBuffer = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const killChild = (signal) => {
      if (killProcessGroup && process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
        // The group leader may have exited while a grandchild still holds our
        // stdout/stderr pipes open. A process group survives its leader, so
        // never use the leader's exitCode as proof the group is gone.
        try { process.kill(-child.pid, signal); return; } catch {
          // Fall back to the leader if signalling the group is unsupported.
        }
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(signal); } catch {}
    };
    let escalationTimer = null;
    const terminateChild = () => {
      killChild('SIGTERM');
      // Do not schedule multiple escalations when cancellation and timeout race.
      if (escalationTimer === null) {
        escalationTimer = setTimeout(() => killChild('SIGKILL'), 2_000);
        escalationTimer.unref();
      }
    };
    const clearTimers = () => {
      clearTimeout(timer);
      if (escalationTimer !== null) clearTimeout(escalationTimer);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      terminateChild();
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const emitLines = (chunk, kind) => {
      // stdout/stderr are byte streams: a UTF-8 character can span chunks.
      const text = typeof chunk === 'string' ? chunk :
        kind === 'stdout' ? stdoutDecoder.write(chunk) : stderrDecoder.write(chunk);
      if (kind === 'stdout') {
        stdoutTotalChars += text.length;
        stdoutTail=(stdoutTail+text).slice(-4000);
        if (stdout.length + text.length > maxCaptureChars) stdoutTruncated = true;
        if (stdout.length < maxCaptureChars) stdout += text.slice(0, maxCaptureChars - stdout.length);
        if (onStdoutLine) {
          stdoutLineBuffer += text;
          let idx;
          while ((idx = stdoutLineBuffer.indexOf('\n')) >= 0) {
            const line = stdoutLineBuffer.slice(0, idx);
            stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
            onStdoutLine(line);
          }
        }
      } else {
        stderrTotalChars += text.length;
        stderrTail=(stderrTail+text).slice(-4000);
        if (stderr.length + text.length > maxCaptureChars) stderrTruncated = true;
        if (stderr.length < maxCaptureChars) stderr += text.slice(0, maxCaptureChars - stderr.length);
        if (onStderrLine) {
          stderrLineBuffer += text;
          let idx;
          while ((idx = stderrLineBuffer.indexOf('\n')) >= 0) {
            const line = stderrLineBuffer.slice(0, idx);
            stderrLineBuffer = stderrLineBuffer.slice(idx + 1);
            onStderrLine(line);
          }
        }
      }
    };

    // A streaming observer is application code. Its exception must reject this
    // subprocess invocation, never escape through EventEmitter as a host crash.
    const failStream = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      abortSignal?.removeEventListener('abort', onAbort);
      terminateChild();
      reject(error);
    };
    const safelyEmit = (chunk, kind) => {
      if (settled) return;
      try { emitLines(chunk, kind); } catch (error) { failStream(error); }
    };
    child.stdout.on('data', (chunk) => safelyEmit(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => safelyEmit(chunk, 'stderr'));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      abortSignal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (code, exitSignal) => {
      if (settled) return;
      // Flush trailing partial code points before evaluating completeness.
      try {
        emitLines(stdoutDecoder.end(), 'stdout');
        emitLines(stderrDecoder.end(), 'stderr');
        if (onStdoutLine && stdoutLineBuffer) { onStdoutLine(stdoutLineBuffer); stdoutLineBuffer = ''; }
        if (onStderrLine && stderrLineBuffer) { onStderrLine(stderrLineBuffer); stderrLineBuffer = ''; }
      } catch (error) { failStream(error); return; }
      settled = true;
      clearTimers();
      abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(cancellationErrorFromSignal(abortSignal));
        return;
      }
      const result = {
        code: code ?? -1,
        signal: exitSignal,
        timedOut,
        stdout: truncate(stdout, maxResultChars),
        stderr: truncate(stderr, maxResultChars),
        outputTail: {stdout:stdoutTail,stderr:stderrTail},
        outputCharacters: {stdout:stdoutTotalChars,stderr:stderrTotalChars},
        truncated: stdoutTruncated || stderrTruncated || stdout.length > maxResultChars || stderr.length > maxResultChars,
        stdoutTruncated: stdoutTruncated || stdout.length > maxResultChars,
        stderrTruncated: stderrTruncated || stderr.length > maxResultChars,
      };
      if (requireComplete && result.truncated) {
        const error = new Error(`${program}: incomplete machine-readable command output; refusing truncated capture.`);
        error.code = 'COMMAND_OUTPUT_TRUNCATED';
        error.result = result;
        reject(error);
        return;
      }
      if (!allowFailure && code !== 0) {
        const error = new Error(
          `${program} ${args.join(' ')} failed with code ${code}${exitSignal ? ` (${exitSignal})` : ''}\n${result.stderr || result.stdout}`,
        );
        error.result = result;
        reject(error);
        return;
      }
      resolvePromise(result);
    });

    if (hasInput) {
      child.stdin.on('error', (error) => {
        // A child may reject/exit before consuming all stdin. Its exit status and
        // stderr are the authoritative failure signal; an EPIPE must not crash
        // the orchestrator process.
        if (error.code !== 'EPIPE' && !settled) {
          settled = true;
          clearTimers();
          abortSignal?.removeEventListener('abort', onAbort);
          terminateChild();
          reject(error);
        }
      });
      child.stdin.end(input);
    }
  });
}

export async function resolveRepoRoot(start = process.cwd()) {
  const { stdout } = await execFileSafe('git', ['rev-parse', '--show-toplevel'], { cwd: start });
  return stdout.trim();
}

async function getHead(repoRoot) {
  const { stdout } = await execFileSafe('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env: GIT_READ_ENV });
  return stdout.trim();
}

async function untrackedPaths(repoRoot) {
  const { stdout } = await execFileSafe('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    maxCaptureChars: MAX_GIT_LIST_OUTPUT,
    maxResultChars: MAX_GIT_LIST_OUTPUT, requireComplete: true,
  });
  return stdout.split('\0').filter(Boolean);
}

/**
 * Capture the real project workspace without modifying its index. Hashes cover
 * tracked and non-ignored untracked paths so a coding step can be compared to
 * an already-dirty editor baseline. Ignored dependency/cache trees are omitted.
 */
async function workspacePaths(repoRoot) {
  const { stdout } = await execFileSafe('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    maxCaptureChars: MAX_GIT_LIST_OUTPUT,
    maxResultChars: MAX_GIT_LIST_OUTPUT, requireComplete: true,
  });
  return [...new Set(stdout.split('\0').filter(Boolean))].sort();
}

async function dirtyWorkspacePaths(repoRoot) {
  const [tracked, untracked] = await Promise.all([
    execFileSafe('git', ['diff', '--name-only', '-z', 'HEAD', '--'], {
      cwd: repoRoot,
      env: GIT_READ_ENV,
      maxCaptureChars: MAX_GIT_LIST_OUTPUT,
      maxResultChars: MAX_GIT_LIST_OUTPUT, requireComplete: true,
    }),
    untrackedPaths(repoRoot),
  ]);
  return [...new Set([...tracked.stdout.split('\0').filter(Boolean), ...untracked])].sort();
}

async function hashWorkspacePath(repoRoot, path) {
  const target = join(repoRoot, path);
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) return `symlink:${await readlink(target)}`;
    if (!st.isFile()) return `other:${st.mode}`;
    const data = await readFile(target);
    return `file:${createHash('sha256').update(data).digest('hex')}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function parseRefs(text) {
  const refs = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('\0');
    if (separator <= 0) continue;
    refs.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return refs;
}

async function captureGitMetadata(repoRoot) {
  const [headRef, refs, staged, localConfig] = await Promise.all([
    execFileSafe('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: repoRoot, env: GIT_READ_ENV, allowFailure: true, maxResultChars: 10_000, requireComplete: true }),
    execFileSafe('git', ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs'], {
      cwd: repoRoot, env: GIT_READ_ENV, maxCaptureChars: MAX_GIT_LIST_OUTPUT, maxResultChars: MAX_GIT_LIST_OUTPUT, requireComplete: true,
    }),
    execFileSafe('git', ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD', '--'], {
      cwd: repoRoot, env: GIT_READ_ENV, maxCaptureChars: MAX_GIT_LIST_OUTPUT, maxResultChars: MAX_GIT_LIST_OUTPUT, requireComplete: true,
    }),
    execFileSafe('git', ['config', '--local', '--null', '--list'], {
      cwd: repoRoot, env: GIT_READ_ENV, allowFailure: true, maxCaptureChars: MAX_GIT_LIST_OUTPUT, maxResultChars: MAX_GIT_LIST_OUTPUT, requireComplete: true,
    }),
  ]);
  const digest = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');
  const metadata = {
    headRef: headRef.code === 0 ? headRef.stdout.trim() : null,
    refsHash: digest(refs.stdout),
    stagedHash: digest(staged.stdout),
    localConfigHash: digest(localConfig.stdout),
    refs: parseRefs(refs.stdout),
  };
  return metadata;
}

export function gitMetadataChanged(before, after) {
  const a = before?.gitMetadata;
  const b = after?.gitMetadata;
  if (!a || !b) return before?.head !== after?.head;
  return before?.head !== after?.head
    || a.headRef !== b.headRef
    || a.refsHash !== b.refsHash
    || a.stagedHash !== b.stagedHash
    || a.localConfigHash !== b.localConfigHash;
}

/**
 * Decide whether a read-only role's repository assumptions may actually be
 * stale. This is intentionally narrower than gitMetadataChanged(): background
 * fetches may move unrelated refs and editor/tooling may touch local Git
 * configuration without changing the checkout the role is reasoning about.
 * Those remain audit observations, but they must not consume reconciliation
 * turns or suppress an otherwise valid final answer.
 */
export function workspaceReconciliationDiff(before, after) {
  const changedPaths = changedPathsBetweenStates(before, after);
  const fullGitDiff = gitMetadataDiff(before, after);
  const semanticGitFields = fullGitDiff.fields.filter((field) =>
    field === 'HEAD' || field === 'headRef' || field === 'index');
  const ignoredGitFields = fullGitDiff.fields.filter((field) =>
    !semanticGitFields.includes(field));
  return {
    changed: changedPaths.length > 0 || semanticGitFields.length > 0,
    changedPaths,
    gitFields: semanticGitFields,
    ignoredGitFields,
    refs: fullGitDiff.refs,
  };
}

/** Changes are observations, not attribution: an editor or Git integration may
 * update refs/index while the role or verification command is running.
 * Never restore Git internals from a stale snapshot. */
export function gitMetadataDiff(before, after) {
  const a = before?.gitMetadata;
  const b = after?.gitMetadata;
  const fields = [];
  if (before?.head !== after?.head) fields.push('HEAD');
  if (a?.headRef !== b?.headRef) fields.push('headRef');
  if (a?.refsHash !== b?.refsHash) fields.push('refs');
  if (a?.stagedHash !== b?.stagedHash) fields.push('index');
  if (a?.localConfigHash !== b?.localConfigHash) fields.push('localConfig');
  const previousRefs = a?.refs instanceof Map ? a.refs : new Map();
  const currentRefs = b?.refs instanceof Map ? b.refs : new Map();
  const refs = {
    added: [...currentRefs.keys()].filter((name) => !previousRefs.has(name)),
    removed: [...previousRefs.keys()].filter((name) => !currentRefs.has(name)),
    updated: [...currentRefs.keys()].filter((name) => previousRefs.has(name) && currentRefs.get(name) !== previousRefs.get(name)),
  };
  // Do not surface config contents, staged diffs, or commit messages in events.
  return { fields, refs };
}

export async function captureGitMetadataState(repoRoot) {
  const [head, gitMetadata] = await Promise.all([getHead(repoRoot), captureGitMetadata(repoRoot)]);
  return { head, gitMetadata };
}

export async function captureRepoState(repoRoot) {
  const [head, diffResult, paths, gitMetadata] = await Promise.all([
    getHead(repoRoot),
    execFileSafe('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], {
      cwd: repoRoot,
      env: GIT_READ_ENV,
      maxCaptureChars: MAX_GIT_LIST_OUTPUT,
      maxResultChars: MAX_GIT_LIST_OUTPUT, requireComplete: true,
    }),
    dirtyWorkspacePaths(repoRoot),
    captureGitMetadata(repoRoot),
  ]);
  const workspaceHashes = {};
  for (const path of paths) workspaceHashes[path] = await hashWorkspacePath(repoRoot, path);
  return { head, diff: diffResult.stdout, workspaceHashes, gitMetadata };
}

export function changedPathsBetweenStates(before, after) {
  const keys = new Set([
    ...Object.keys(before?.workspaceHashes ?? {}),
    ...Object.keys(after?.workspaceHashes ?? {}),
  ]);
  return [...keys].filter((path) => (before?.workspaceHashes?.[path] ?? 'missing') !== (after?.workspaceHashes?.[path] ?? 'missing')).sort();
}

function validateRevisionInput(revision) {
  if (typeof revision !== 'string' || !revision.trim()) throw new Error('Review revision must be a non-empty string.');
  const value = revision.trim();
  if (value.length > 200 || value.includes('\0') || /[\r\n]/.test(value) || value.startsWith('-')) {
    throw new Error(`Unsafe or invalid Git revision: ${JSON.stringify(revision)}`);
  }
  return value;
}

async function resolveCommitRevision(repoRoot, revision) {
  const value = validateRevisionInput(revision);
  const { stdout } = await execFileSafe(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`],
    { cwd: repoRoot, maxResultChars: 10_000 },
  );
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Git did not resolve ${value} to a commit.`);
  return commit;
}

async function commitMetadata(repoRoot, commit) {
  const { stdout } = await execFileSafe(
    'git',
    ['show', '-s', '--format=%H%x00%P%x00%s%x00%an%x00%aI', commit],
    { cwd: repoRoot, maxCaptureChars: 200_000, maxResultChars: 200_000, requireComplete: true },
  );
  const [hash, parents, subject, author, authoredAt] = stdout.replace(/\n$/, '').split('\0');
  return { hash, parents: parents ? parents.split(/\s+/).filter(Boolean) : [], subject, author, authoredAt };
}



function parseCommandList(raw, envName) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((x) => !Array.isArray(x) || x.length === 0 || x.some((y) => typeof y !== 'string'))) {
    throw new Error(`${envName} must be JSON like [["pnpm","test"],["pnpm","lint"]].`);
  }
  return parsed;
}

async function autoVerificationCommands(repoRoot) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    return [];
  }

  let manager = 'npm';
  if (typeof pkg.packageManager === 'string') {
    manager = pkg.packageManager.split('@')[0];
  } else {
    for (const [file, candidate] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
    ]) {
      try {
        await access(join(repoRoot, file));
        manager = candidate;
        break;
      } catch {}
    }
  }

  const scripts = pkg.scripts ?? {};
  const names = ['typecheck', 'lint', 'test'].filter((name) => typeof scripts[name] === 'string');
  return names.map((name) => {
    if (manager === 'npm') return ['npm', 'run', name];
    return [manager, 'run', name];
  });
}

export async function runPreparation(repoRoot, { signal } = {}) {
  const commands = parseCommandList(process.env.AGENT_PREPARE_COMMANDS, 'AGENT_PREPARE_COMMANDS');
  if (!commands) return [];

  const results = [];
  const policies = configuredVerificationPolicies();
  const closures = configuredVerificationInputClosures();
  for (const command of commands) {
    const [program, ...args] = command;
    let item;
    if (Object.hasOwn(policies, command.join(' '))) {
      item = await runVerificationCommand(repoRoot, command, { signal,
        timeoutMs: Number(process.env.AGENT_PREPARE_TIMEOUT_MS ?? 600_000), policies, inputClosures: closures });
      results.push(item);
      if (!item.ok) break;
      continue;
    }
    try {
      const result = await execFileSafe(program, args, {
        cwd: repoRoot,
        allowFailure: true,
        timeoutMs: Number(process.env.AGENT_PREPARE_TIMEOUT_MS ?? 600_000),
        signal,
      });
      const status = result.timedOut || result.signal ? 'INFRA_FAILURE' :
        result.code === 0 ? 'PASS' : await verificationFailureKind(repoRoot, command.join(' '), result);
      item = {
        command: [program, ...args].join(' '),
        status,
        ok: status === 'PASS',
        exitCode: result.code, timedOut: result.timedOut, signal: result.signal,
        output: boundedVerificationOutput(result),
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const status = await verificationFailureKind(repoRoot, command.join(' '), null, error);
      item = {
        command: [program, ...args].join(' '), status, ok: false, exitCode: null,
        output: truncate(error?.message ?? String(error), 30_000),
      };
    }
    results.push(item);
    if (!item.ok) break;
  }
  return results;
}

async function dependencyTreeAvailable(repoRoot) {
  try {
    await access(join(repoRoot, 'node_modules'));
    return true;
  } catch {
    return false;
  }
}

export function boundedVerificationOutput(result, maxChars=30000) {
  if (!result) return '';
  const head = [result.stdout,result.stderr].filter(Boolean).join('\n');
  if (head.length<=maxChars && !result.truncated) return head;
  const prefix=head.slice(0,Math.floor(maxChars*0.65));
  const tail=[result.outputTail?.stdout,result.outputTail?.stderr].filter(Boolean).join('\n').slice(-Math.floor(maxChars*0.3));
  const captured=Number(result.outputCharacters?.stdout??0)+Number(result.outputCharacters?.stderr??0);
  return `${prefix}\n...[output bounded; ${Math.max(0,captured-prefix.length-tail.length)} characters omitted; see complete verifier log]\n${tail}`;
}

async function verificationFailureKind(repoRoot, command, result, error = null) {
  if (error?.code === 'ENOENT') return 'TOOL_UNAVAILABLE';
  if (result?.timedOut) return 'INFRA_FAILURE';
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}\n${error?.message ?? ''}`;
  if (/command not found|(?:^|[\r\n])[^\r\n]*:\s*not found(?:[\r\n]|$)|could not determine executable/i.test(text)) {
    return 'TOOL_UNAVAILABLE';
  }
  const moduleMissing = /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i.test(text);
  if (moduleMissing) {
    if (!(await dependencyTreeAvailable(repoRoot))) return 'ENVIRONMENT_ERROR';
    // A partial node_modules directory is NOT proof that the project's
    // declared dependencies are installed. Missing declared packages are an
    // environment/setup failure, not a failing source regression test.
    const missing = text.match(/Cannot find (?:module|package) ['"]([^'"\r\n]+)['"]/);
    if (missing && !missing[1].startsWith('.') && !missing[1].startsWith('/')) {
      try {
        const pkg=JSON.parse(await readFile(join(repoRoot,'package.json'),'utf8'));
        if (Object.hasOwn(pkg.dependencies??{},missing[1]) || Object.hasOwn(pkg.devDependencies??{},missing[1]))
          return 'ENVIRONMENT_ERROR';
      } catch { /* unresolved package name; do not guess classification */ }
    }
  }
  if (/dependencies? (?:are|is) missing|lockfile|workspace package|failed to load config|compiler .*not found/i.test(text)) {
    return 'ENVIRONMENT_ERROR';
  }
  if (result?.signal) return 'INFRA_FAILURE';
  return 'TEST_FAILED';
}

// Inspect only host-configured commands, never generate or rewrite shell text.
// Known interactive/watch scripts are refused with a diagnostic; fixing the
// script is an operator decision. Indirect script expansion is bounded.
export async function verificationWatchPreflight(repoRoot, command) {
  const tokens = command.map(String);
  const joined = tokens.join(' ');
  const reason = (script) => {
    if (/(?:^|\s)(?:--watch(?:All)?|--watch=|--watchAll=|-w)(?:\s|$)/.test(script) ||
        /(?:^|\s)(?:nodemon|node\s+--watch|jest\s+--watch)/.test(script)) return 'watch_option';
    if (/(?:^|[;&|]\s*|\s)(?:vitest)(?:\s|$)/.test(script) &&
        !/(?:^|\s)vitest\s+run(?:\s|$)|(?:^|\s)vitest[^\n]*\s--run(?:\s|$)/.test(script)) return 'vitest_default_watch';
    return null;
  };
  if (['vitest','jest','node','nodemon'].includes(tokens[0])) {
    const type = reason(joined);
    return type ? { code:'INTERACTIVE_VERIFICATION', reason:type, command:joined } : null;
  }
  const pm = ['npm','pnpm','yarn'].includes(tokens[0]);
  if (!pm) return null;
  const scriptIndex = tokens[1] === 'run' ? 2 : 1;
  const scriptName = tokens[scriptIndex];
  if (!scriptName || !/^[a-zA-Z0-9:_-]{1,100}$/.test(scriptName)) return null;
  const suffix = tokens.slice(scriptIndex+1).join(' ');
  if (reason(suffix)) return { code:'INTERACTIVE_VERIFICATION', reason:'watch_option', command:joined };
  let pkg;
  try { pkg = JSON.parse(await readFile(join(repoRoot,'package.json'),'utf8')); } catch { return null; }
  const visited=new Set();
  let current=scriptName;
  for (let depth=0; depth<8 && !visited.has(current); depth++) {
    visited.add(current);
    const text=pkg?.scripts?.[current];
    if (typeof text !== 'string' || text.length > 10_000) break;
    const type=reason(text);
    if (type) return { code:'INTERACTIVE_VERIFICATION', reason:type, command:joined, script:current };
    const nested=text.match(/^(?:npm|pnpm|yarn)\s+(?:run\s+)?([a-zA-Z0-9:_-]+)\s*$/);
    if (!nested) break;
    current=nested[1];
  }
  return null;
}

export async function runVerificationCommand(repoRoot, command, { signal, timeoutMs, observerOnly = false, inputClosures = {}, policies = configuredVerificationPolicies() } = {}) {
  const name = command.join(' ');
  if (signal?.aborted) throw cancellationErrorFromSignal(signal);
  const watch = await verificationWatchPreflight(repoRoot, command);
  if (watch) return { command:name,status:'ENVIRONMENT_ERROR',ok:false,exitCode:null,
    timedOut:false,signal:null,reasonCode:watch.code,diagnostics:watch,
    output:'Interactive/watch verification refused; configure a finite non-interactive test command.',
    checkId:verificationCheckId(name),inputsStable:null,inputBinding:{kind:'unknown'} };
  const declaration = inputClosures[name];
  const policy = policies[name];
  const invocationId = policy ? randomUUID() : null;
  const reportBefore = await witnessDiagnosticReports(repoRoot, policy);
  const baseline = policy?.baseline === 'git_head'
    ? await witnessGitBaselineReports(repoRoot, policy) : reportBefore;
  const inputBefore = await witnessVerificationInputs(repoRoot, declaration);
  const finishObservation = async (result) => {
    const inputAfter = await witnessVerificationInputs(repoRoot, declaration);
    const reportAfter = await witnessDiagnosticReports(repoRoot, policy);
    const completionVerified = result.status !== 'INFRA_FAILURE' &&
      result.status !== 'TOOL_UNAVAILABLE' && result.status !== 'ENVIRONMENT_ERROR' &&
      !result.timedOut && !result.signal &&
      await witnessDiagnosticCompletion(repoRoot, policy, invocationId, reportAfter);
    const diagnostic = policy ? assessDiagnosticDelta(baseline, reportAfter, policy, result.exitCode, {
      timedOut: result.timedOut, signal: result.signal, completionVerified,
    }) : null;
    const effectiveStatus = !policy || ['INFRA_FAILURE', 'TOOL_UNAVAILABLE', 'ENVIRONMENT_ERROR'].includes(result.status)
      ? result.status : diagnostic?.outcome === 'regressed' ? 'TEST_FAILED'
        : diagnostic?.accepted ? 'PASS' : 'ENVIRONMENT_ERROR';
    const inputsStable = inputBefore.kind === 'paths' && inputAfter.kind === 'paths'
      ? JSON.stringify(inputBefore) === JSON.stringify(inputAfter) : null;
    return { ...result, status: effectiveStatus, ok: effectiveStatus === 'PASS', ...(diagnostic ? { diagnostic } : {}), checkId: verificationCheckId(name), inputBefore, inputAfter,
      inputsStable, inputBinding: inputsStable === true ? inputAfter : { kind: 'unknown' } };
  };
  const [program, ...args] = command;
  try {
    const result = await execFileSafe(program, args, {
      cwd: repoRoot,
      allowFailure: true,
      timeoutMs,
      signal,
      // Package managers may spawn Vitest/Jest workers. Killing only the
      // parent on timeout/cancel can strand an interactive child indefinitely.
      killProcessGroup: true,
      env: { ...(observerOnly ? GIT_READ_ENV : {}),
        ...(invocationId ? { AGENT_VERIFICATION_INVOCATION_ID: invocationId } : {}) },
    });
    const status = result.timedOut || result.signal ? 'INFRA_FAILURE' :
      result.code === 0 ? 'PASS' : await verificationFailureKind(repoRoot, command.join(' '), result);
    return await finishObservation({
      command: command.join(' '),
      status, reasonCode: result.timedOut ? 'VERIFICATION_TIMEOUT' :
        result.signal ? 'VERIFICATION_SIGNAL' : status === 'TOOL_UNAVAILABLE' ? 'EXECUTABLE_UNAVAILABLE' :
        status === 'ENVIRONMENT_ERROR' ? 'VERIFICATION_ENVIRONMENT' :
        status === 'TEST_FAILED' ? 'NONZERO_EXIT' : null,
      diagnostics:{ timedOut:result.timedOut, signal:result.signal, exitCode:result.code },
      ok: status === 'PASS',
      exitCode: result.code, timedOut: result.timedOut, signal: result.signal,
      output: boundedVerificationOutput(result),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const status = await verificationFailureKind(repoRoot, command.join(' '), null, error);
    return await finishObservation({ command: command.join(' '), status, ok: false, exitCode: null,
      reasonCode:status === 'TOOL_UNAVAILABLE' ? 'EXECUTABLE_UNAVAILABLE' : 'VERIFICATION_EXECUTION_ERROR',
      diagnostics:{errorCode:typeof error?.code === 'string' ? error.code.slice(0,60) : null},
      output: truncate(error.message ?? String(error), 30_000) });
  }
}

// Only commands already admitted by the repository's configured verifier may
// be re-run selectively. Saved evidence/provider output is never shell input.
// This is an *additional* diagnostic pass: it cannot replace the mandatory
// full verification used for final task acceptance.
export async function planTargetedRevalidation(repoRoot, targets) {
  const configured = parseCommandList(process.env.AGENT_VERIFY_COMMANDS, 'AGENT_VERIFY_COMMANDS');
  const commands = configured ?? await autoVerificationCommands(repoRoot);
  const allowed = commands.map((args) => args.join(' '));
  const requested = new Set();
  let unsafe = false;
  for (const target of targets ?? []) {
    if (target?.action !== 'rerun_configured_verification') continue;
    // The built-in diff check is always run by runVerification, including in
    // targeted mode, and must not make an otherwise valid subset unsupported.
    if (target.checkId === verificationCheckId('git diff --check') || target.command === 'git diff --check') continue;
    const matched = allowed.find((c) => verificationCheckId(c) === target.checkId || c === target.command);
    if (!matched) { unsafe = true; continue; }
    requested.add(matched);
  }
  if (unsafe) return { mode: 'full_fallback', reason: 'unknown_or_removed_command', commands: allowed };
  const selected = allowed.filter((c) => requested.has(c));
  return { mode: selected.length && selected.length < allowed.length ? 'targeted' :
    selected.length ? 'full_fallback' : 'none',
    reason: selected.length === allowed.length && selected.length ? 'all_commands_affected' : null,
    commands: selected.length === allowed.length ? allowed : selected,
    totalConfigured: allowed.length };
}

export async function configuredVerificationCommands(repoRoot) {
  return parseCommandList(process.env.AGENT_VERIFY_COMMANDS, 'AGENT_VERIFY_COMMANDS') ?? await autoVerificationCommands(repoRoot);
}

export async function runVerification(repoRoot, { signal, onCommandComplete, onAttemptStart, onlyCommands = null, phase = 'mandatory_final' } = {}) {
  const configured = parseCommandList(process.env.AGENT_VERIFY_COMMANDS, 'AGENT_VERIFY_COMMANDS');
  const available = configured ?? await autoVerificationCommands(repoRoot);
  // A subset is permitted only when its members match the configured suite.
  // Never execute an arbitrary persisted/model-proposed command.
  const allowed = new Set(available.map((args) => args.join(' ')));
  if (onlyCommands !== null && (!Array.isArray(onlyCommands) ||
      onlyCommands.some((cmd) => typeof cmd !== 'string' || !allowed.has(cmd)))) {
    throw new Error('Targeted verification includes an unconfigured command; refusing execution.');
  }
  const selected = onlyCommands === null ? available :
    available.filter((args) => onlyCommands.includes(args.join(' ')));
  const results = [];
  const fullSuite = [...available, ['git', 'diff', '--check']].map((args) => args.join(' '));
  const expected = [...selected, ['git', 'diff', '--check']].map((args) => args.join(' '));
  const attempt = { id: verificationAttemptId(), phase, suiteId: verificationSuiteId(fullSuite),
    requiredCheckIds: expected.map(verificationCheckId), observedCheckIds: [],
    status: 'started', startedAt: new Date().toISOString() };
  results.attempt = attempt;
  const closures = configuredVerificationInputClosures();
  const policies = configuredVerificationPolicies();
  const cache = createVerificationAttemptCache(repoRoot,{closures,policies});
  await onAttemptStart?.({ ...attempt }); // persist before the first command
  const note = async (item) => { results.push(item); attempt.observedCheckIds.push(item.checkId); await onCommandComplete?.(item); };

  for (const command of selected) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    const reused = await cache.lookup(command);
    const item = reused.hit ? reused.result : {
      ...await runVerificationCommand(repoRoot, command, {
        signal,
        timeoutMs: Number(process.env.AGENT_VERIFY_TIMEOUT_MS ?? 300_000),
        inputClosures: closures, policies,
      }),cache:{hit:false,scope:'attempt',reason:reused.reason},
    };
    if (!reused.hit) await cache.remember(command,item,reused.key);
    await note(item);
  }
  // Run the required diff check on the final workspace, after any declared
  // verification outputs have been written. Never reuse an earlier PASS.
  const finalDiffCheck = await runVerificationCommand(repoRoot, ['git', 'diff', '--check'], {
    signal, timeoutMs: 60_000, observerOnly: true, inputClosures: closures, policies,
  });
  await note(finalDiffCheck);
  attempt.status = 'completed';
  attempt.completedAt = new Date().toISOString();
  return results;
}

export function verificationDisposition(results) {
  if (results.every((item) => item.status === 'PASS')) return 'PASS';
  if (results.some((item) => item.status === 'TEST_FAILED')) return 'CODE_FAILURE';
  if (results.some((item) => ['TOOL_UNAVAILABLE', 'ENVIRONMENT_ERROR', 'INFRA_FAILURE'].includes(item.status))) return 'UNVERIFIED';
  return 'UNVERIFIED';
}

export function assertChangedPathsSafe(paths, security) {
  for (const path of paths) {
    const decision = evaluateSecurityPath(path, security);
    if (decision.denied) throw new Error(`Changed path rejected by security policy: ${decision.path} (${decision.reason})`);
    if (decision.path === '.git' || decision.path.startsWith('.git/')) throw new Error(`Change to Git internals rejected: ${decision.path}`);
  }
}

function securityPathspecs(security) {
  const prefix = security.caseSensitive ? '' : 'icase,';
  return [
    ...(security.denyPaths ?? []).map((path) => `:(${prefix}literal)${path}`),
    ...(security.denyGlobs ?? []).map((glob) => `:(${prefix}glob)${glob}`),
  ];
}

async function deniedWorkspacePaths(repoRoot, security) {
  const candidates = new Set(await workspacePaths(repoRoot));
  const pathspecs = securityPathspecs(security);
  if (pathspecs.length) {
    const { stdout } = await execFileSafe(
      'git',
      ['ls-files', '--cached', '--others', '--ignored', '--exclude-standard', '-z', '--', ...pathspecs],
      { cwd: repoRoot, maxCaptureChars: MAX_GIT_LIST_OUTPUT, maxResultChars: MAX_GIT_LIST_OUTPUT, requireComplete: true },
    );
    for (const path of stdout.split('\0').filter(Boolean)) candidates.add(path);
  }
  // Exact denied paths may name filesystem entries that Git does not enumerate
  // (for example an ignored directory). Include them when they exist.
  for (const path of security.denyPaths ?? []) {
    try {
      await withWorkspaceEntry(repoRoot, path, {}, (target) => lstat(target));
      candidates.add(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return [...candidates]
    .filter((path) => evaluateSecurityPath(path, security).denied)
    .sort();
}

async function captureFilesystemEntry(repoRoot, path) {
  return withWorkspaceEntry(repoRoot, path, {}, async (target) => {
    try {
      const st = await lstat(target);
      if (st.isSymbolicLink()) {
        const linkTarget = await readlink(target);
        return { type: 'symlink', target: linkTarget, fingerprint: `symlink:${linkTarget}` };
      }
      if (st.isFile()) {
        // Opening with O_NOFOLLOW prevents a swapped-in final symlink from
        // redirecting a capture to another filesystem location.
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data, mode;
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) throw new Error(`Denied path changed type during capture: ${path}`);
          data = await handle.readFile(); mode = opened.mode;
        } finally { await handle.close(); }
        const hash = createHash('sha256').update(data).digest('hex');
        return { type: 'file', data, mode, fingerprint: `file:${mode}:${hash}` };
      }
      return { type: 'other', mode: st.mode, fingerprint: `other:${st.mode}` };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  });
}

/**
 * Capture security-denied paths separately from the normal workspace snapshot.
 * Git's standard status/diff APIs intentionally omit ignored files, but ignored
 * secrets such as `.env` must still participate in the orchestrator's write
 * boundary and restoration policy.
 */
export async function captureDeniedPathBaseline(repoRoot, security) {
  const baseline = new Map();
  for (const path of await deniedWorkspacePaths(repoRoot, security)) {
    const entry = await captureFilesystemEntry(repoRoot, path);
    if (entry) baseline.set(path, entry);
  }
  return baseline;
}

export function changedDeniedPathsBetweenBaselines(before, after) {
  const keys = new Set([...(before?.keys?.() ?? []), ...(after?.keys?.() ?? [])]);
  return [...keys].filter((path) => {
    const previous = before?.get?.(path)?.fingerprint ?? 'missing';
    const current = after?.get?.(path)?.fingerprint ?? 'missing';
    return previous !== current;
  }).sort();
}

export async function restoreDeniedPaths(repoRoot, changedPaths, security, baseline) {
  const restored = [];
  for (const path of changedPaths) {
    const decision = evaluateSecurityPath(path, security);
    if (!decision.denied) continue;
    const previous = baseline.get(path);
    if (previous?.type === 'other') {
      throw new Error(`Cannot safely restore non-file denied path: ${path}`);
    }
    await withWorkspaceEntry(repoRoot, path, { createParents: Boolean(previous) }, async (target) => {
      // Never recurse through a changed leaf. Only files and links are safe
      // restore targets; directory replacements require manual intervention.
      let existing;
      try { existing = await lstat(target); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (existing?.isDirectory()) throw new Error(`Cannot safely replace denied directory: ${path}`);
      await rm(target, { force: true });
      if (previous?.type === 'file') {
        const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, previous.mode & 0o777);
        try {
          await handle.writeFile(previous.data);
          await handle.chmod(previous.mode);
        } finally { await handle.close(); }
      } else if (previous?.type === 'symlink') {
        await symlink(previous.target, target);
      }
    });
    restored.push(path);
  }
  return restored;
}

export async function resolveCommitReviewTarget(repoRoot, revision) {
  const sourceCommit = await resolveCommitRevision(repoRoot, revision);
  const metadata = await commitMetadata(repoRoot, sourceCommit);
  return {
    type: 'commit',
    requestedRevision: String(revision).trim(),
    sourceCommit,
    sourceParents: metadata.parents,
    subject: metadata.subject,
    author: metadata.author,
    authoredAt: metadata.authoredAt,
  };
}
