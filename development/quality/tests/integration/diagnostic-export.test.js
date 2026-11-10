import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
import { writeDiagnosticExport } from '../../../../src/hosts/cli.js';
import { createOperation, applyEvent, decodeRequest } from '../../../../src/main/index.js';
import { operationTrace } from '../../../../src/hosts/commands.js';
import { request, outcome } from '../../fixtures/core.js';

const input = () => decodeRequest(request({ text: 'SECRET USER PROMPT' })).value;
function state(events) {
  let operation = createOperation('op', input(), 'authority',
    { maxInvocations: 5, maxConcurrentInvocations: 2 });
  for (const [i, event] of events.entries()) {
    const updated = applyEvent(operation, { operationId: 'op', eventId: String(i),
      receivedAt: i, ...event });
    assert.equal(updated.kind, 'applied');
    operation = updated.state;
  }
  return operation;
}
test('C11.4 trace manifest explains missing transient log, unknown and budget without bodies', () => {
  const operation = state([
    { kind: 'attempt.reserved', attemptId: 'a', actionId: 'worker' },
    { kind: 'attempt.dispatched', attemptId: 'a', route: {
      providerId: 'p', profileId: 'profile', model: 'model', configurationRef: 'cfg' } },
    { kind: 'attempt.outcome', outcome: outcome('a', { terminal: 'unknown', effect: 'unknown',
      diagnostics: [{ code: 'DEADLINE_EXCEEDED' }] }), dispatchCertainty: 'unknown' },
    { kind: 'operation.waiting', waiting: { kind: 'technical',
      reason: { code: 'DEADLINE_EXCEEDED', operationId: 'op', attemptId: 'a',
        actionId: 'worker', effect: 'unknown', dispatchCertainty: 'unknown' } } },
  ]);
  const result = operationTrace(operation);
  assert.equal(result.manifest.origin, 'durable-state');
  assert.equal(result.manifest.transientDiagnosticsIncluded, false);
  assert.equal(result.status, 'waiting');
  assert.equal(result.waiting.effect, 'unknown');
  assert.equal(result.resources.charged, 1);
  assert.equal(result.attempts[0].reasonCode, 'DEADLINE_EXCEEDED');
  assert.equal(result.attempts[0].profileId, 'profile');
  assert.ok(result.omitted.includes('transient diagnostics'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET USER PROMPT/);
});
test('C11.4 large journal is bounded with explicit omitted count and stable sequence', () => {
  const events = Array.from({ length: 300 }, (_, i) =>
    ({ kind: 'action.rejected', actionId: 'a' + i, code: 'PERMISSION_DENIED' }));
  const result = operationTrace(state(events));
  assert.equal(result.manifest.eventCount, 300);
  assert.equal(result.manifest.truncatedEvents, 44);
  assert.equal(result.events.length, 256);
  assert.equal(result.events[0].sequence, 45);
  assert.equal(result.events.at(-1).sequence, 300);
});

test('C11.4 failed partial write never publishes output and removes its temporary file', () =>
  withOwnedRun('C11-export-partial', async directory => {
    const output = join(directory, 'trace.json');
    await assert.rejects(writeDiagnosticExport(output, { status: 'test' },
      async handle => {
        await handle.writeFile('partial');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }), { code: 'ENOSPC' });
    await assert.rejects(readFile(output, 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), []);
  }));

test('C11.4 export never overwrites an existing path and publishes complete JSON', () =>
  withOwnedRun('C11-export-exclusive', async directory => {
    const output = join(directory, 'trace.json');
    await writeFile(output, 'original');
    await assert.rejects(writeDiagnosticExport(output, { replace: true }), { code: 'EEXIST' });
    assert.equal(await readFile(output, 'utf8'), 'original');
    assert.deepEqual(await readdir(directory), ['trace.json']);
    const other = join(directory, 'new.json');
    await writeDiagnosticExport(other, { manifest: { source: 'durable' } });
    assert.deepEqual(JSON.parse(await readFile(other, 'utf8')).manifest, { source: 'durable' });
  }));
