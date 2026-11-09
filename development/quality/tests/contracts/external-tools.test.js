import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileExternalTool, createExternalToolPort } from '../../../../src/application/configuration/external-tools.js';

function bind(overrides = {}) {
  const stop = new AbortController();
  const receipts = [];
  let serial = 0;
  let calls = 0;
  let prompts = 0;
  const tool = compileExternalTool({
    id: 'example', description: 'Example tool', resource: 'resource:example', effect: 'write',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } },
      required: ['name'], additionalProperties: false },
    async invoke(input, scope) {
      calls++;
      return overrides.invoke ? overrides.invoke(input, scope) : input.name;
    },
    cancel: overrides.cancel,
  });
  assert.ok(tool);
  const bound = createExternalToolPort(new Map([['example', tool]])).bind({
    operationId: 'operation', attemptId: 'attempt', signal: stop.signal, isActive: () => !stop.signal.aborted,
    permissions: { async request(request) {
      prompts++;
      assert.equal(request.resource, 'resource:example');
      return { kind: 'selected', option: overrides.deny ? 'deny' : 'allow' };
    } },
    newId: () => String(++serial), maxBytes: 64,
    receive(toolId, receipt) { receipts.push({ toolId, receipt }); return 'ref:' + receipt.callId; },
  });
  return { bound, stop, receipts, get calls() { return calls; }, get prompts() { return prompts; } };
}

test('external tool rejects schema failures before requesting permissions or invoking', async () => {
  const fixture = bind({ deny: true });
  assert.deepEqual(await fixture.bound.call('example', { name: 3 }),
    { status: 'invalid_input', effect: 'none', callId: '1', ref: 'ref:1' });
  assert.equal(fixture.prompts, 0);
  assert.deepEqual(await fixture.bound.call('example', { name: 'okay' }),
    { status: 'denied', effect: 'none', callId: '2', ref: 'ref:2' });
  assert.equal(fixture.prompts, 1);
  assert.equal(fixture.calls, 0);
});

test('external output is bounded and correlated with its actual invocation', async () => {
  const fixture = bind();
  const results = await Promise.all([
    fixture.bound.call('example', { name: 'x'.repeat(200) }), fixture.bound.call('example', { name: 'short' }),
  ]);
  assert.deepEqual(results, [
    { status: 'truncated', effect: 'possible', callId: '1', ref: 'ref:1' },
    { status: 'completed', effect: 'possible', callId: '2', ref: 'ref:2', output: 'short' },
  ]);
  assert.deepEqual(fixture.receipts[1], { toolId: 'example', receipt: {
    status: 'completed', effect: 'possible', callId: '2', toolId: 'example', attemptId: 'attempt', output: 'short',
  } });
});

test('deadline preserves unknown effect and cancels only the correlated tool call', async () => {
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const late = Promise.withResolvers();
  const fixture = bind({
    invoke(input, scope) { started.resolve(scope); return late.promise; },
    cancel(scope) { stopped.resolve(scope); },
  });
  const result = fixture.bound.call('example', { name: 'start' });
  const scope = await started.promise;
  fixture.stop.abort('deadline');
  assert.equal(await stopped.promise, scope);
  assert.deepEqual(await result, { status: 'unknown', effect: 'unknown', callId: '1', ref: 'ref:1' });
  assert.deepEqual(await fixture.bound.call('example', { name: 'late' }), { status: 'closed', effect: 'none' });
  late.resolve('late');
  assert.equal(fixture.receipts.length, 1);
  assert.equal(fixture.calls, 1);
});
