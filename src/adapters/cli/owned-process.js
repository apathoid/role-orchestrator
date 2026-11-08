import { spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';

/** @typedef {{command: string, args: readonly string[], options: {cwd?: string, env: NodeJS.ProcessEnv, shell: false}, stdin: string}} ProcessLaunch */
/** @typedef {'stdout' | 'stderr'} OutputStream */
/** @typedef {'exited' | 'start_failed' | 'cancelled' | 'timed_out' | 'io_failed'} ProcessEnd */
/** @typedef {Partial<Record<'start' | 'stdin' | OutputStream | 'cleanup', string>>} ProcessErrors */
/** @typedef {{started: boolean, reason: ProcessEnd, exitCode: number | null, signal: NodeJS.Signals | null, errors: ProcessErrors}} ProcessResult */
/** @typedef {{finished: Promise<ProcessResult>, cancel: () => void, close: () => Promise<ProcessResult>}} OwnedProcess */

const maxTimerDelayMs = 2_147_483_647;
const drainAfterExitMs = 1_000;

/**
 * Own one Linux process group and its stdio. Output callbacks run synchronously
 * and receive raw bytes. Transport termination carries no model verdict.
 *
 * @param {ProcessLaunch} launch
 * @param {{timeoutMs: number, signal: AbortSignal, onOutput: (stream: OutputStream, chunk: Buffer) => void}} options
 * @returns {OwnedProcess}
 */
export function startCliProcess(launch, { timeoutMs, signal, onOutput }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimerDelayMs) {
    throw new RangeError('timeoutMs must be an integer from 1 to 2147483647');
  }
  if (signal.aborted) return withoutProcess('cancelled', {});
  if (process.platform !== 'linux') return withoutProcess('start_failed', { start: 'UNSUPPORTED_PLATFORM' });

  const startedAt = performance.now();
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child;
  try {
    child = spawn(launch.command, launch.args, { ...launch.options, shell: false, detached: true, stdio: 'pipe' });
  } catch (error) {
    return withoutProcess('start_failed', { start: errorCode(error) });
  }

  /** @type {ReturnType<typeof Promise.withResolvers<ProcessResult>>} */
  const { promise: finished, resolve: finish } = Promise.withResolvers();
  const { stdin, stdout, stderr, pid } = child;
  /** @type {ProcessErrors} */
  const errors = {};
  let started = false;
  let exited = false;
  let groupSignalled = false;
  /** @type {ProcessEnd | undefined} */
  let reason;
  /** @type {NodeJS.Timeout | undefined} */
  let deadline;
  /** @type {NodeJS.Timeout | undefined} */
  let drain;

  function stopGroup() {
    if (pid === undefined || groupSignalled) return;
    groupSignalled = true;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ESRCH') errors.cleanup = code;
    }
  }

  /** @param {ProcessEnd} cause */
  function stop(cause) {
    if (exited || reason !== undefined) return;
    reason = cause;
    clearTimeout(deadline);
    stopGroup();
    stdin.destroy();
  }

  const cancel = () => stop('cancelled');

  child.once('error', error => {
    errors.start = errorCode(error);
    reason ??= 'start_failed';
  });
  child.once('spawn', () => {
    started = true;
    if (reason === undefined) stdin.end(launch.stdin, 'utf8');
  });
  stdin.on('error', error => { errors.stdin = errorCode(error); });
  for (const name of /** @type {const} */ (['stdout', 'stderr'])) {
    child[name].on('data', (/** @type {Buffer} */ chunk) => {
      if (errors[name] !== undefined) return;
      try {
        onOutput(name, chunk);
      } catch {
        errors[name] = 'OUTPUT_CONSUMER_FAILED';
        stop('io_failed');
      }
    });
    child[name].on('error', error => {
      errors[name] ??= errorCode(error);
      stop('io_failed');
    });
  }

  child.once('exit', () => {
    exited = true;
    clearTimeout(deadline);
    // The group can outlive its leader, including descendants with no stdio.
    stopGroup();
    stdin.destroy();
    drain = setTimeout(() => {
      // A descriptor held outside the group must not hold the owner open.
      for (const name of /** @type {const} */ (['stdout', 'stderr'])) {
        const stream = child[name];
        if (stream.closed) continue;
        errors[name] ??= 'OUTPUT_DRAIN_TIMEOUT';
        stream.destroy();
      }
    }, drainAfterExitMs);
  });
  child.once('close', (exitCode, exitSignal) => {
    exited = true;
    clearTimeout(deadline);
    clearTimeout(drain);
    abortSubscription[Symbol.dispose]();
    finish({ started, reason: reason ?? 'exited', exitCode, signal: exitSignal, errors });
  });
  const abortSubscription = addAbortListener(signal, cancel);
  if (signal.aborted) cancel();
  else {
    const remaining = Math.ceil(timeoutMs - (performance.now() - startedAt));
    if (remaining <= 0) stop('timed_out');
    else deadline = setTimeout(() => stop('timed_out'), remaining);
  }

  return {
    finished,
    cancel,
    async close() {
      cancel();
      const result = await finished;
      if (result.errors.cleanup !== undefined) {
        throw new Error('CLI process group cleanup failed: ' + result.errors.cleanup);
      }
      return result;
    },
  };
}

/** @param {'cancelled' | 'start_failed'} reason @param {ProcessErrors} errors @returns {OwnedProcess} */
function withoutProcess(reason, errors) {
  const finished = Promise.resolve({ started: false, reason, exitCode: null, signal: null, errors });
  return { finished, cancel() {}, close: () => finished };
}

/** @param {unknown} error */
function errorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'IO_ERROR';
}
