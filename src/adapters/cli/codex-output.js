import { constants } from 'node:buffer';
import { capturePrefix } from '../capture-prefix.js';
import { startCliProcess } from './owned-process.js';

/** @import {OutputStream} from './owned-process.js' */
/** @typedef {{maxFrameBytes: number, maxStdoutBytes: number, maxStderrBytes: number}} OutputLimits */
/** @typedef {Record<string, unknown> & {type: string}} CodexEnvelope */
/** @typedef {'FRAME_LIMIT' | 'INVALID_UTF8' | 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'INCOMPLETE_FRAME' | 'STDOUT_LIMIT' | 'STDERR_LIMIT'} OutputIssue */
/** @typedef {{code: 'PROTOCOL_ERROR' | 'OUTPUT_TRUNCATED', stream: OutputStream, reason: OutputIssue, count: number, firstLine?: number}} OutputDiagnostic */

const defaultLimits = {
  maxFrameBytes: 256 * 1024,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
};

/**
 * Read the documented Codex JSONL transport. Event payloads remain attributed
 * to the provider for the caller to interpret. Diagnostics carry no raw text.
 * @param {OutputLimits} [limits]
 */
export function createCodexOutputCapture(limits = defaultLimits) {
  const { maxFrameBytes, maxStdoutBytes, maxStderrBytes } = limits;
  for (const [name, value] of Object.entries({ maxFrameBytes, maxStdoutBytes, maxStderrBytes })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > constants.MAX_LENGTH) {
      throw new RangeError(name + ' must be a positive, supported byte limit');
    }
  }

  const captures = { stdout: capturePrefix(maxStdoutBytes), stderr: capturePrefix(maxStderrBytes) };
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  /** @type {{line: number, event: CodexEnvelope}[]} */
  const frames = [];
  /** @type {Map<OutputIssue, OutputDiagnostic>} */
  const issues = new Map();
  let line = 1;
  let frameStart = 0;

  /** @param {OutputIssue} reason */
  function report(reason) {
    const previous = issues.get(reason);
    if (previous) {
      previous.count++;
      return;
    }
    issues.set(reason, reason === 'STDERR_LIMIT'
      ? { code: 'OUTPUT_TRUNCATED', stream: 'stderr', reason, count: 1 }
      : { code: 'PROTOCOL_ERROR', stream: 'stdout', reason, count: 1, firstLine: line });
  }

  /** @param {Buffer} bytes */
  function readFrame(bytes) {
    if (bytes.length > maxFrameBytes) return report('FRAME_LIMIT');
    let text;
    try { text = utf8.decode(bytes); }
    catch { return report('INVALID_UTF8'); }

    /** @type {unknown} */
    let event;
    try { event = JSON.parse(text); }
    catch { return report('INVALID_JSON'); }
    if (!isEnvelope(event)) return report('INVALID_ENVELOPE');
    frames.push({ line, event });
  }

  return {
    /** @param {OutputStream} stream @param {Buffer} chunk */
    write(stream, chunk) {
      const capture = captures[stream];
      const { length: before } = capture.view();
      capture.append(chunk);
      if (stream !== 'stdout') return;
      const bytes = capture.view();
      for (let lf = bytes.indexOf(0x0a, before); lf !== -1; lf = bytes.indexOf(0x0a, frameStart)) {
        readFrame(bytes.subarray(frameStart, lf));
        frameStart = lf + 1;
        line++;
      }
    },

    /** Finalize once, after the process closes both streams. */
    finish() {
      const stdout = captures.stdout.result();
      const stderr = captures.stderr.result();
      const tailLength = stdout.bytes.length - frameStart;
      if (tailLength > maxFrameBytes) report('FRAME_LIMIT');
      if (stdout.truncated) report('STDOUT_LIMIT');
      else if (tailLength > 0) report('INCOMPLETE_FRAME');
      if (stderr.truncated) report('STDERR_LIMIT');
      return { stdout, stderr, frames, diagnostics: [...issues.values()] };
    },
  };
}

/** @param {unknown} value @returns {value is CodexEnvelope} */
function isEnvelope(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.hasOwn(value, 'type') && 'type' in value && typeof value.type === 'string' && value.type.trim().length > 0;
}

/**
 * Collect bounded transport output for one owned Codex process.
 * @param {ReturnType<typeof import('./codex-launch.js').prepareCodexLaunch>} launch
 * @param {{timeoutMs: number, signal: AbortSignal, limits?: OutputLimits}} options
 */
export function startCodexProcess(launch, { timeoutMs, signal, limits }) {
  const output = createCodexOutputCapture(limits);
  const owned = startCliProcess(launch, { timeoutMs, signal, onOutput: output.write });
  const finished = owned.finished.then(result => ({ process: result, ...output.finish() }));
  return {
    finished,
    cancel: owned.cancel,
    async close() {
      await owned.close();
      return finished;
    },
  };
}
