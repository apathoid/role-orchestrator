import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNdjsonSink } from '../../src/adapters/state/ndjson-diagnostics.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const event = n => ({
  schemaVersion: 1, eventId: String(n), receivedAt: n, sequence: n,
  level: 'info', component: 'fixture', eventName: 'test.event',
  operationId: 'op', reasonCode: 'OBSERVED',
});

test('C11.2 NDJSON rotation caps disk usage and maintains per-file JSON records', () =>
  withOwnedRun('C11-sink', async directory => {
    const sink = createNdjsonSink({ directory, maxFileBytes: 230, retainedFiles: 2 });
    for (let i = 0; i < 20; i++) sink.emit(event(i));
    await sink.flush();
    const files = (await readdir(directory)).filter(x => x.startsWith('diagnostics.ndjson'));
    assert.ok(files.length <= 3);
    for (const file of files) {
      const body = await readFile(join(directory, file), 'utf8');
      assert.ok(Buffer.byteLength(body) <= 230);
      for (const line of body.trim().split('\n')) assert.equal(JSON.parse(line).schemaVersion, 1);
    }
  }));

test('C11.2 overflow and slow writer do not block emit or hang flush', () =>
  withOwnedRun('C11-slow-sink', async directory => {
    const pending = Promise.withResolvers();
    const errors = [];
    const sink = createNdjsonSink({ directory, queueSize: 1, flushDeadlineMs: 5,
      stderr: { write: x => errors.push(x) }, writeLine: () => pending.promise });
    sink.emit(event(1));
    sink.emit(event(2));
    sink.emit(event(3));
    assert.ok(sink.stats().dropped >= 1);
    await sink.flush();
    assert.ok(errors.some(x => x.includes('dropped=')));
    pending.resolve();
  }));

test('C11.2 unavailable path and failed disk writer are isolated', () =>
  withOwnedRun('C11-disk-sink', async directory => {
    const errors = [];
    const sink = createNdjsonSink({ directory, stderr: { write: x => errors.push(x) },
      writeLine: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
    sink.emit(event(1));
    await sink.flush();
    assert.deepEqual(sink.stats(), { dropped: 0, failed: 1 });
    assert.ok(errors.length);
    const file = join(directory, 'unusable');
    await writeFile(file, 'regular file, not a directory');
    const invalid = createNdjsonSink({ directory: join(file, 'child'), stderr: { write: x => errors.push(x) } });
    invalid.emit(event(2));
    await invalid.flush();
    assert.equal(invalid.stats().failed, 1);
    assert.ok(errors.some(x => x.includes('failed=')));
  }));

test('C11 review P2-1: ten thousand disk failures produce bounded stderr and one final total', () =>
  withOwnedRun('C11-mass-error', async directory => {
    const lines = [];
    const sink = createNdjsonSink({ directory, queueSize: 10_100,
      stderr: { write: line => { lines.push(line); return true; } },
      writeLine: async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } });
    for (let i = 0; i < 10_000; i++) sink.emit(event(i));
    await sink.flush();
    await sink.flush();
    assert.deepEqual(sink.stats(), { dropped: 0, failed: 10_000 });
    assert.ok(lines.length <= 2, 'stderr lines must not scale with the failure count');
    assert.equal(lines.filter(line => line.includes('flush summary')).length, 1);
    assert.match(lines.at(-1), /failed=10000/);
  }));

test('C11 review P2-1: backpressured stderr does not accumulate further warnings', () =>
  withOwnedRun('C11-stderr-backpressure', async directory => {
    let writes = 0;
    const sink = createNdjsonSink({ directory, queueSize: 11,
      stderr: { write: () => { writes++; return false; } },
      writeLine: async () => { throw Error('disk full'); } });
    for (let i = 0; i < 10; i++) sink.emit(event(i));
    await sink.flush();
    assert.equal(writes, 1);
    assert.equal(sink.stats().failed, 10);
  }));
