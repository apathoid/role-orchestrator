import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { boundaryViolations } from '../../scripts/check-boundaries.mjs';
import { root, withOwnedRun } from '../../scripts/owned-run.mjs';
import { emitDiagnostic, noopDiagnostics } from '../../../../src/main/index.js';

test('module boundaries reject actual imports and ignore vocabulary in comments', () => {
  const directory = resolve(import.meta.dirname, '../../fixtures/boundaries');
  assert.deepEqual(boundaryViolations(directory).sort(), [
    'core/invalid.js -> ../../../../STATUS.md',
    'core/invalid.js -> ../adapters/provider.js',
    'core/invalid.js -> node:fs',
  ]);
});

test('strict JavaScript checker detects the incompatible Clock result', () => {
  const result = spawnSync(process.execPath, [
    'node_modules/typescript/bin/tsc', '--pretty', 'false', '-p', 'quality/fixtures/types/jsconfig.json',
  ], { cwd: resolve(root, 'development'), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /fixtures\/types\/invalid\.js.*TS2322/);
  assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
});

test('diagnostics carry correlations and do not surface sink failure', async () => {
  const event = {
    schemaVersion: 1, eventId: 'event-1', receivedAt: 1234, sequence: 5, level: 'info',
    component: 'core', eventName: 'attempt.outcome', operationId: 'op-1', attemptId: 'attempt-2',
    actionId: 'action-3', decisionId: 'decision-4', reasonCode: 'COMPLETED',
  };
  const events = [];
  emitDiagnostic({ emit: value => events.push(value), flush() {} }, event);
  assert.deepEqual(events, [event]);
  assert.doesNotThrow(() => emitDiagnostic({ emit() { throw new Error('sink offline'); } }, event));
  emitDiagnostic({ async emit() { throw new Error('async sink offline'); } }, event);
  emitDiagnostic(noopDiagnostics, event);
  await new Promise(resolve => setImmediate(resolve));
});

test('failed owned fixture is cleaned without touching the enclosing run', async () => {
  await withOwnedRun('outer-fixture', async outer => {
    const marker = resolve(outer, 'marker');
    await writeFile(marker, '');
    let failedRun;
    await assert.rejects(withOwnedRun('failing-fixture', async (directory, run) => {
      failedRun = directory;
      await writeFile(resolve(directory, 'temporary'), '');
      const child = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 150 });
      assert.equal(child.error?.code, 'ETIMEDOUT');
      assert.equal(child.signal, 'SIGKILL');
      throw new Error('fixture failed');
    }), /fixture failed/);
    await assert.rejects(access(failedRun), { code: 'ENOENT' });
    await access(marker);
  });
});
