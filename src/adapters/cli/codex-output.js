import { constants } from 'node:buffer';
import { capturePrefix } from '../capture-prefix.js';
import { createCodexExecution } from './codex-execution.js';
import { startCliProcess } from './owned-process.js';

/** @import {OutputStream} from './owned-process.js' */
/** @typedef {{maxFrameBytes: number, maxStdoutBytes: number, maxStderrBytes: number}} OutputLimits */
/** @typedef {Record<string, unknown> & {type: string}} CodexEnvelope */
/** @typedef {'FRAME_LIMIT' | 'INVALID_UTF8' | 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'INCOMPLETE_FRAME' | 'STDOUT_LIMIT' | 'STDERR_LIMIT' | 'EVIDENCE_LIMIT'} OutputIssue */
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
 * @param {(event: CodexEnvelope, line: number) => void} [onFrame]
 */
export function createCodexOutputCapture(limits = defaultLimits, onFrame) {
  const { maxFrameBytes, maxStdoutBytes, maxStderrBytes } = limits;
  for (const [name, value] of Object.entries({ maxFrameBytes, maxStdoutBytes, maxStderrBytes })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > constants.MAX_LENGTH) {
      throw new RangeError(name + ' must be a positive, supported byte limit');
    }
  }

  const captures = { stdout: capturePrefix(maxStdoutBytes), stderr: capturePrefix(maxStderrBytes) };
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const execution = createCodexExecution();
  // Only one wire frame is buffered, independent of raw capture exhaustion.
  const pending = Buffer.allocUnsafe(maxFrameBytes);
  let length = 0, oversized = false;
  /** @type {Map<OutputIssue, OutputDiagnostic>} */
  const issues = new Map();
  let line = 1;


  /** @param {OutputIssue} reason */
  function report(reason) {
    const previous = issues.get(reason);
    if (previous) {
      previous.count++;
      return;
    }
    issues.set(reason, reason === 'STDERR_LIMIT' || reason === 'STDOUT_LIMIT'
      ? { code: 'OUTPUT_TRUNCATED', stream: reason === 'STDERR_LIMIT' ? 'stderr' : 'stdout', reason, count: 1 }
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
    execution.accept(line,event,bytes.length);
    if (onFrame) {
      try { onFrame(structuredClone(event),line); } catch { /* Delivery cannot change capture. */ }
    }
  }

  return {
    /** @param {OutputStream} stream @param {Buffer} chunk */
    write(stream, chunk) {
      captures[stream].append(chunk);
      if (stream !== 'stdout') return;
      let offset = 0;
      while(offset < chunk.length) {
        const lf = chunk.indexOf(10,offset);
        const end = lf < 0 ? chunk.length : lf;
        const count = end-offset;
        if (!oversized) {
          if (length+count > maxFrameBytes) oversized=true;
          else { chunk.copy(pending,length,offset,end);length+=count; }
        }
        if(lf < 0) break;
        if(oversized) report('FRAME_LIMIT');
        else readFrame(pending.subarray(0,length));
        length=0;oversized=false;line++;
        offset=lf+1;
      }
    },

    /** Finalize once, after the process closes both streams. */
    finish() {
      const stdout = captures.stdout.result();
      const stderr = captures.stderr.result();
      if (oversized) report('FRAME_LIMIT');
      else if (length > 0) report('INCOMPLETE_FRAME');
      if (stdout.truncated) report('STDOUT_LIMIT');
      if (stderr.truncated) report('STDERR_LIMIT');
      const facts=execution.finish();
      const diagnostics=[...issues.values()];
      if(facts.omitted) diagnostics.push({code:'OUTPUT_TRUNCATED',stream:'stdout',reason:'EVIDENCE_LIMIT',count:facts.omitted,firstLine:facts.firstOmittedLine});
      return { stdout, stderr, execution:facts, diagnostics };
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
 * @param {{timeoutMs: number | null, signal: AbortSignal, limits?: OutputLimits, onFrame?: (event: CodexEnvelope, line: number) => void}} options
 */
export function startCodexProcess(launch, { timeoutMs, signal, limits, onFrame }) {
  const output = createCodexOutputCapture(limits, onFrame);
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
