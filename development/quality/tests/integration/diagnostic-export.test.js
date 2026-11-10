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

test('C11 review P2-2: all known-secret substrings are redacted in durable identifiers', () => {
  const secret = 'known-secret-xyz';
  const operation = state([
    { kind: 'attempt.reserved', attemptId: 'attempt-' + secret, actionId: 'action-' + secret },
    { kind: 'attempt.dispatched', attemptId: 'attempt-' + secret, route: {
      providerId: 'provider-' + secret, profileId: 'profile-' + secret, model: 'model', configurationRef: 'cfg' } },
    { kind: 'attempt.outcome', outcome: outcome('attempt-' + secret), dispatchCertainty: 'sent' },
    { kind: 'action.rejected', actionId: 'other-' + secret, code: 'PERMISSION_DENIED' },
  ]);
  const trace = operationTrace(operation, { secrets: [secret] });
  assert.equal(trace.redacted, true);
  const serialized = JSON.stringify(trace);
  assert.ok(!serialized.includes(secret));
  assert.ok(serialized.includes('action-[REDACTED]'));
  assert.equal(trace.attempts[0].attemptId, trace.events[0].attemptId);
  assert.equal(trace.attempts[0].actionId, trace.events[0].actionId);
  assert.equal(trace.events.at(-1).reasonCode, 'PERMISSION_DENIED');
});

test('C11 review P2-3: durable technical causes and IDs agree with reducer diagnostics', () => {
  let operation = createOperation('op', input(), 'authority',
    { maxInvocations: 5, maxConcurrentInvocations: 2 });
  const events = [
    { kind: 'attempt.reserved', attemptId: 'attempt-a', actionId: 'work-a' },
    { kind: 'attempt.dispatched', attemptId: 'attempt-a' },
    { kind: 'attempt.cancel_requested', attemptId: 'attempt-a', source: 'client' },
    { kind: 'attempt.outcome', outcome: outcome('attempt-a', {
      terminal: 'unknown', effect: 'unknown', diagnostics: [{ code: 'DEADLINE_EXCEEDED' }] }),
      dispatchCertainty: 'unknown' },
    { kind: 'operation.recovered', trusted: { authorityRef: 'authority', configurationRef: 'cfg',
      limits: { maxInvocations: 5, maxConcurrentInvocations: 2 } } },
    { kind: 'controller.responded', attemptId: 'attempt-a',
      decision: /** @type {any} */ ({ schemaVersion: 1, operationId: 'op', decisionId: 'd-1',
        contextCursor: 4, additions: [], cancellations: [] }) },
    { kind: 'operation.finished', assessment: /** @type {any} */ ({ author: 'primary', answer: 'Done' }) },
  ];
  const coreReasons = [];
  for (const [i, data] of events.entries()) {
    const result = applyEvent(operation, { operationId: 'op', eventId: 'event-' + i, receivedAt: i + 1, ...data });
    assert.equal(result.kind, 'applied', data.kind);
    operation = result.state;
    coreReasons.push(result.diagnostic.reasonCode);
  }
  const entries = operationTrace(operation).events;
  assert.deepEqual(entries.map(event => event.reasonCode), coreReasons);
  assert.deepEqual(entries.map(event => event.eventId), events.map((_, i) => 'event-' + i));
  assert.equal(entries[1].actionId, 'work-a');
  assert.equal(entries[2].actionId, 'work-a');
  assert.equal(entries[2].source, 'client');
  assert.equal(entries[4].reasonCode, 'RECOVERED');
  assert.equal(entries[5].decisionId, 'd-1');
  assert.equal(entries[6].reasonCode, 'ASSESSMENT_RECORDED');

  const cancelled = state([
    { kind: 'attempt.reserved', attemptId: 'b', actionId: 'work-b' },
    { kind: 'operation.cancelled', source: 'client' },
  ]);
  assert.equal(operationTrace(cancelled).events[1].reasonCode, 'CANCELLED');
});
