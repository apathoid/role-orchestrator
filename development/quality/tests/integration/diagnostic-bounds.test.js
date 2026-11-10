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
  assert.equal(bounded.context.length, 128);
  assert.equal(bounded.omitted, 1372);
  assert.equal(bounded.context[0].unavailableReason, 'missing');
});

test('C11.7 handoff explicitly reports omitted selected references without fabricated success', () => {
  const operation = createOperation('op', decodeRequest(request()).value,
    'authority', { maxInvocations: 2, maxConcurrentInvocations: 1 });
  const refs = Array.from({ length: 1000 }, (_, i) => 'missing:' + i);
  const context = handoffContext(operation, refs, 1024);
  assert.ok(context.length <= 129);
  assert.equal(context[0].completeness, 'unavailable');
  assert.equal(context.at(-1).ref, 'host:context-budget');
  assert.equal(context.at(-1).value.omitted, 872);
  assert.equal(context.at(-1).value.selected, 1000);
});

test('C11.7 enormous optional output is excerpted or unavailable, never promoted to complete', () => {
  const record = { ref: 'large', source: 'provider_reported', completeness: 'complete',
    value: 'z'.repeat(4_000_000) };
  const result = compactContext([record], 256, false);
  assert.ok(result.excerpted === 1 || result.omitted === 1);
  assert.ok(result.context.every(item => item.completeness !== 'complete'));
  assert.ok(Buffer.byteLength(JSON.stringify(result.context)) <= 256);
});
