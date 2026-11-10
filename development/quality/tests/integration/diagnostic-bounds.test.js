import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactContext } from '../../../../src/application/context-bundle.js';
import { handoffContext } from '../../../../src/application/handoff.js';
import { createOperation, decodeRequest } from '../../../../src/main/index.js';
import { request } from '../../fixtures/core.js';

test('C11.7 thousands of missing selected records remain bounded and report omissions', () => {
  const records = Array.from({ length: 1500 }, (_, i) =>
    ({ ref: 'missing:' + i, source: 'host_observed', completeness: 'unavailable', unavailableReason: 'missing' }));
  const bounded = compactContext(records, 1024, true);
  assert.ok(bounded.context.length <= 128);
  assert.ok(bounded.unrepresented > 0);
  assert.ok(bounded.omitted >= bounded.unrepresented);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.context)) <= 1024);
  assert.ok(bounded.context.every(item => item.completeness === 'unavailable'));
});

test('C11.7 handoff explicitly reports omitted selected references without fabricated success', () => {
  const operation = createOperation('op', decodeRequest(request()).value,
    'authority', { maxInvocations: 2, maxConcurrentInvocations: 1 });
  const refs = Array.from({ length: 1000 }, (_, i) => 'missing:' + i);
  const context = handoffContext(operation, refs, 1024);
  assert.ok(context.length <= 129);
  assert.ok(context.some(item => item.completeness === 'unavailable'));
  assert.equal(context.at(-1).ref, 'host:context-budget');
  assert.ok(context.at(-1).value.omitted > 872);
  assert.equal(context.at(-1).value.selected, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 1024);
});

test('C11.7 enormous optional output is excerpted or unavailable, never promoted to complete', () => {
  const record = { ref: 'large', source: 'provider_reported', completeness: 'complete',
    value: 'z'.repeat(4_000_000) };
  const result = compactContext([record], 256, false);
  assert.ok(result.excerpted === 1 || result.omitted === 1);
  assert.ok(result.context.every(item => item.completeness !== 'complete'));
  assert.ok(Buffer.byteLength(JSON.stringify(result.context)) <= 256);
});

test('C11 review P2-4: 128 missing 100 KiB refs never escape a 1 KiB byte budget', () => {
  const operation = createOperation('op', decodeRequest(request()).value,
    'authority', { maxInvocations: 2, maxConcurrentInvocations: 1 });
  const refs = Array.from({ length: 128 }, (_, index) => 'missing-' + index + '-' + 'x'.repeat(102_400));
  const result = handoffContext(operation, refs, 1024);
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized) <= 1024);
  assert.ok(!serialized.includes('x'.repeat(128)));
  assert.equal(result.at(-1).ref, 'host:context-budget');
  assert.equal(result.at(-1).value.selected, 128);
  assert.equal(result.at(-1).value.omitted, 128);
  assert.ok(result.every(item => item.completeness !== 'complete' || item.ref === 'host:context-budget'));
});

test('C11 review P2-4: marker sizes are charged, not added beyond the budget', () => {
  const selected = Array.from({ length: 20 }, (_, index) => ({
    ref: 'missing-' + index, source: 'host_observed', completeness: 'unavailable', unavailableReason: 'missing',
  }));
  const result = compactContext(selected, 512, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.context)) <= 512);
  assert.ok(result.unrepresented > 0);
  assert.ok(result.context.length < 20);
});

test('C11 review P2-4: long stored refs remain discoverable by ContextPort position', async () => {
  const { bindContextAccess } = await import('../../../../src/application/context-access.js');
  const longRef = 'ref-' + 'y'.repeat(60_000);
  const operation = createOperation('op', decodeRequest(request({ requestId: longRef })).value,
    'authority', { maxInvocations: 1, maxConcurrentInvocations: 1 });
  const context = bindContextAccess({
    state: operation, store: /** @type {any} */ ({}),
    maxBytes: 70_000, profileId: 'primary', attemptId: 'test',
    isActive: () => true, newId: () => 'id', now: Date.now, receive() {},
  });
  const page = context.list();
  assert.equal(page.kind, 'available');
  assert.deepEqual(page.items[0].ref, { revision: 0, index: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 8192);
  const detail = await context.fetch(page.items[0].ref);
  assert.equal(detail.kind, 'available');
  assert.equal(detail.item.ref, longRef);
});
