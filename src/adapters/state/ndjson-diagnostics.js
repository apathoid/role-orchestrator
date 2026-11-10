import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** @import {DiagnosticEvent, DiagnosticPort} from '../../core/diagnostics.js' */

/**
 * The diagnostic sink is deliberately independent of the StateStore ledger:
 * no failure here can change a task outcome or reserve a task resource.
 * @param {{directory: string, maxFileBytes?: number, retainedFiles?: number, queueSize?: number,
 *   flushDeadlineMs?: number, stderr?: {write: (text: string) => unknown},
 *   writeLine?: (path: string, line: string) => Promise<void>}} options
 * @returns {DiagnosticPort & {stats: () => {dropped: number, failed: number}}}
 */
export function createNdjsonSink(options) {
  const { directory, maxFileBytes = 1_048_576, retainedFiles = 3,
    queueSize = 128, flushDeadlineMs = 1000, stderr = process.stderr,
    writeLine = (path, line) => appendFile(path, line, { mode: 0o600 }) } = options;
  for (const n of [maxFileBytes, retainedFiles, queueSize]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('Invalid diagnostic bound');
  }
  if (!Number.isFinite(flushDeadlineMs) || flushDeadlineMs < 0) throw new RangeError('Invalid flush deadline');
  const path = join(directory, 'diagnostics.ndjson');
  /** @type {DiagnosticEvent[]} */
  const pending = [];
  let dropped = 0, failed = 0, bytes = 0, initialized = false, stopped = false;
  /** @type {Promise<void> | undefined} */
  let worker;
  let lastReport = '';
  /** @param {string} message */
  function report(message) {
    if (lastReport === message) return;
    lastReport = message;
    try { stderr.write('DIAGNOSTICS: ' + message + '\n'); } catch { /* stderr is optional */ }
  }
  async function initialize() {
    if (initialized) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const current = await stat(path).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    bytes = current?.size ?? 0;
    initialized = true;
  }
  async function rotate() {
    await rm(path + '.' + retainedFiles, { force: true });
    for (let i = retainedFiles - 1; i >= 1; i--) {
      await rename(path + '.' + i, path + '.' + (i + 1)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await rename(path, path + '.1').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    bytes = 0;
  }
  async function drain() {
    while (pending.length) {
      const event = pending.shift();
      if (!event) continue;
      try {
        await initialize();
        const line = JSON.stringify(event) + '\n';
        const size = Buffer.byteLength(line);
        if (size > maxFileBytes) { dropped++; continue; }
        if (bytes + size > maxFileBytes) await rotate();
        await writeLine(path, line);
        bytes += size;
      } catch {
        failed++;
        report('write failed; dropped=' + dropped + ' failed=' + failed);
      }
    }
  }
  function start() {
    if (worker || !pending.length) return;
    worker = drain().finally(() => {
      worker = undefined;
      if (pending.length) start();
    });
  }
  return {
    emit(event) {
      if (stopped || pending.length >= queueSize) {
        dropped++;
        report('queue overflow or closed; dropped=' + dropped + ' failed=' + failed);
        return;
      }
      pending.push(event);
      start();
    },
    async flush() {
      stopped = true;
      if (!worker) {
        if (dropped || failed) report('flush summary dropped=' + dropped + ' failed=' + failed);
        return;
      }
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const complete = await Promise.race([worker.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), flushDeadlineMs); })]);
      if (timer) clearTimeout(timer);
      if (!complete) {
        dropped += pending.length;
        pending.length = 0;
        report('flush deadline exceeded; dropped=' + dropped + ' failed=' + failed);
      } else if (dropped || failed) report('flush summary dropped=' + dropped + ' failed=' + failed);
    },
    stats: () => ({ dropped, failed }),
  };
}
