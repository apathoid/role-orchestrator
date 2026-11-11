import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMcpBridge } from '../../src/adapters/mcp-bridge.js';

/** @param {string} url @param {number} id @param {string} name @param {unknown} args */
async function invoke(url, id, name, args) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { status: response.status, body: await response.json() };
}

/** @param {{body: {result?: {content: {text: string}[]}}}} response */
const value = response => JSON.parse(response.body.result?.content[0].text ?? 'null');

test('C12R.8.3 MCP call budget preserves exact request identity and never replays completed effects', async () => {
  const stop = new AbortController();
  let executed = 0;
  const bridge = await startMcpBridge({
    signal: stop.signal,
    externalTools: {
      list: () => [{ id: 'echo', description: 'fixture', effect: 'read', inputSchema: { type: 'object' } }],
      async call(_name, args) { executed++; return { kind: 'available', args }; },
    },
  });
  try {
    for (let i = 1; i <= 64; i++) {
      const response = await invoke(bridge.url, i, 'echo', { n: i });
      assert.equal(response.status, 200);
      assert.deepEqual(value(response), { kind: 'available', args: { n: i } });
    }
    assert.equal(executed, 64);
    const duplicate = await invoke(bridge.url, 64, 'echo', { n: 64 });
    assert.deepEqual(value(duplicate), { kind: 'available', args: { n: 64 } });
    assert.equal(executed, 64);
    const conflict = await invoke(bridge.url, 64, 'echo', { n: 999 });
    assert.equal(conflict.body.error?.code, -32602);
    assert.equal(executed, 64);
    const overBudget = await invoke(bridge.url, 65, 'echo', { n: 65 });
    assert.deepEqual(value(overBudget), { kind: 'unavailable', reason: 'budget' });
    assert.equal(executed, 64);
  } finally {
    stop.abort();
    bridge.close();
  }
});

test('C12R.8.3 a concurrency peak is not a permanent rejected request or additional dispatch', async () => {
  const stop = new AbortController();
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let started = 0;
  const bridge = await startMcpBridge({
    signal: stop.signal,
    externalTools: {
      list: () => [{ id: 'hold', description: 'fixture', effect: 'read', inputSchema: { type: 'object' } }],
      async call() {
        started++;
        if (started === 4) reached.resolve(undefined);
        await release.promise;
        return { kind: 'available' };
      },
    },
  });
  try {
    const pending = Array.from({ length: 4 }, (_, i) => invoke(bridge.url, i + 1, 'hold', {}));
    await reached.promise;
    const peak = await invoke(bridge.url, 5, 'hold', {});
    assert.deepEqual(value(peak), { kind: 'unavailable', reason: 'budget' });
    assert.equal(started, 4);
    release.resolve(undefined);
    for (const response of await Promise.all(pending)) assert.deepEqual(value(response), { kind: 'available' });
    const retry = await invoke(bridge.url, 5, 'hold', {});
    assert.deepEqual(value(retry), { kind: 'available' });
    assert.equal(started, 5);
  } finally {
    release.resolve(undefined);
    stop.abort();
    bridge.close();
  }
});

test('C12R.8.3 oversized MCP request and response remain bounded without losing tool state', async () => {
  const stop = new AbortController();
  let executed = 0;
  const bridge = await startMcpBridge({
    signal: stop.signal,
    externalTools: {
      list: () => [{ id: 'large', description: 'fixture', effect: 'read', inputSchema: { type: 'object' } }],
      async call() { executed++; return { payload: 'x'.repeat(300 * 1024) }; },
    },
  });
  try {
    const oversize = await fetch(bridge.url, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'large', arguments: { payload: 'x'.repeat(33 * 1024) } } }) });
    assert.equal(oversize.status, 413);
    assert.equal(executed, 0);
    const response = await invoke(bridge.url, 2, 'large', {});
    assert.equal(response.status, 200);
    assert.deepEqual(value(response), { kind: 'unavailable', reason: 'budget' });
    assert.equal(executed, 1);
  } finally {
    stop.abort();
    bridge.close();
  }
});

test('C12R.8R.1 a genuine bounded ToolPort preserves read/write/unknown receipts before MCP rendering', async () => {
  const { compileExternalTool, createExternalToolPort } = await import('../../src/application/configuration/external-tools.js');
  const stop = new AbortController();
  const receipts = [];
  let called = 0, serial = 0;
  const definitions = await Promise.all(['read', 'write', 'unknown'].map(async kind => {
    const tool = await compileExternalTool({
      id: kind, description: 'Fixture ' + kind, resource: 'fixture:' + kind,
      effect: kind === 'read' ? 'read' : 'write', inputSchema: { type: 'object' },
      async invoke() {
        called++;
        if (kind === 'unknown') throw new Error('unknown effect');
        return 'x'.repeat(300 * 1024);
      },
    });
    assert.ok(tool);
    return [kind, tool];
  }));
  const externalTools = createExternalToolPort(new Map(definitions)).bind({
    operationId: 'op', attemptId: 'attempt', signal: stop.signal, isActive: () => !stop.signal.aborted,
    permissions: { async request() { return { kind: 'selected', option: 'allow' }; } },
    newId: () => 'call-' + ++serial, maxBytes: 64 * 1024,
    receive(toolId, receipt) { receipts.push({ toolId, receipt }); return 'evidence:' + receipt.callId; },
  });
  const bridge = await startMcpBridge({ signal: stop.signal, externalTools });
  try {
    for (const [n, kind, status, effect] of [
      [1, 'read', 'truncated', 'none'], [2, 'write', 'truncated', 'possible'],
      [3, 'unknown', 'failed', 'unknown'],
    ]) {
      const response = await invoke(bridge.url, n, kind, {});
      assert.equal(response.status, 200);
      assert.equal(response.body.result.isError, undefined);
      assert.deepEqual(value(response), { status, effect, callId: 'call-' + n, ref: 'evidence:call-' + n });
      assert.equal(receipts[n - 1].receipt.status, status);
      assert.equal(receipts[n - 1].receipt.effect, effect);
      assert.equal(receipts[n - 1].receipt.output, undefined);
    }
    assert.equal(called, 3);
    assert.deepEqual(value(await invoke(bridge.url, 2, 'write', {})),
      { status: 'truncated', effect: 'possible', callId: 'call-2', ref: 'evidence:call-2' });
    assert.equal((await invoke(bridge.url, 2, 'write', { changed: true })).body.error.code, -32602);
    assert.equal(called, 3);
    assert.equal(receipts.length, 3);
  } finally {
    stop.abort();
    bridge.close();
  }
});

test('C12R.8R.1 oversized valid AttemptTools results keep effect/status/ref without pretending output delivery succeeded', async () => {
  const stop = new AbortController();
  const originals = [];
  let executed = 0;
  const bridge = await startMcpBridge({
    signal: stop.signal,
    externalTools: {
      list: () => [],
      async call(name) {
        executed++;
        const original = Object.freeze({
          status: name === 'unknown' ? 'unknown' : 'completed',
          effect: name === 'write' ? 'possible' : name === 'unknown' ? 'unknown' : 'none',
          callId: 'tool-call-' + executed, ref: 'evidence:' + executed,
          output: 'x'.repeat(300 * 1024),
        });
        originals.push(original);
        return original;
      },
    },
  });
  try {
    for (const [id, name, status, effect] of [
      [1, 'read', 'completed', 'none'], [2, 'write', 'completed', 'possible'],
      [3, 'unknown', 'unknown', 'unknown'],
    ]) {
      const response = await invoke(bridge.url, id, name, {});
      assert.equal(response.status, 200);
      assert.equal(response.body.result.isError, true);
      assert.deepEqual(value(response), {
        status, effect, callId: 'tool-call-' + id, ref: 'evidence:' + id,
        outputUnavailableReason: 'budget',
      });
    }
    const replay = await invoke(bridge.url, 2, 'write', {});
    assert.equal(replay.body.result.isError, true);
    assert.equal(value(replay).effect, 'possible');
    assert.equal((await invoke(bridge.url, 2, 'write', { different: true })).body.error.code, -32602);
    assert.equal(executed, 3);
    assert.equal(originals.length, 3);
    for (const item of originals) assert.equal(item.output.length, 300 * 1024);
  } finally {
    stop.abort();
    bridge.close();
  }
});

for (const first of ['history', 'external']) {
  test('C12R.8R.2 shared MCP budget across context_list/context_fetch and external tools (' + first + ' first)', async () => {
    const stop = new AbortController();
    let listed = 0, fetched = 0, tools = 0;
    const bridge = await startMcpBridge({
      signal: stop.signal,
      contextAccess: {
        list() { listed++; return { kind: 'available', items: [] }; },
        async fetch() { fetched++; return { kind: 'available',
          item: { ref: 'record', source: 'host_observed', completeness: 'complete', value: 'history' } }; },
        async captureArtifact() { return undefined; },
      },
      externalTools: {
        list: () => [{ id: 'echo', description: 'fixture', effect: 'read', inputSchema: { type: 'object' } }],
        async call() { tools++; return { status: 'completed', effect: 'none', callId: 'tool-' + tools }; },
      },
    });
    try {
      const steps = Array.from({ length: 64 }, (_, i) => {
        const fromHistory = first === 'history' ? i < 32 : i >= 32;
        return fromHistory
          ? (i % 2 === 0 ? { name: 'context_list', args: {} }
            : { name: 'context_fetch', args: { ref: 'record' } })
          : { name: 'echo', args: { index: i } };
      });
      for (const [i, { name, args }] of steps.entries()) {
        const response = await invoke(bridge.url, i + 1, name, args);
        assert.equal(response.status, 200);
        assert.notEqual(value(response).reason, 'budget');
      }
      assert.deepEqual([listed, fetched, tools], [16, 16, 32]);
      for (const name of ['echo', 'context_fetch', 'context_list']) {
        const blocked = await invoke(bridge.url, 65 + ['echo', 'context_fetch', 'context_list'].indexOf(name),
          name, name === 'context_fetch' ? { ref: 'record' } : {});
        assert.deepEqual(value(blocked), { kind: 'unavailable', reason: 'budget' });
      }
      assert.deepEqual([listed, fetched, tools], [16, 16, 32]);
      const previously = steps[63];
      const repeated = await invoke(bridge.url, 64, previously.name, previously.args);
      assert.equal(repeated.status, 200);
      assert.notEqual(value(repeated).reason, 'budget');
      const conflicting = await invoke(bridge.url, 64, 'echo', { conflicting: true });
      assert.equal(conflicting.body.error.code, -32602);
      const invalid = await fetch(bridge.url, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: { wrong: true }, method: 'tools/call',
          params: { name: 'echo', arguments: {} } }),
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual([listed, fetched, tools], [16, 16, 32]);
    } finally {
      stop.abort();
      bridge.close();
    }
  });
}

test('C12R.8R.2 cancellation returns unknown effect and preserves a late ToolReceipt without replay', async () => {
  const { compileExternalTool, createExternalToolPort } = await import('../../src/application/configuration/external-tools.js');
  const stop = new AbortController();
  const started = Promise.withResolvers();
  const settle = Promise.withResolvers();
  const receipts = [];
  let executed = 0, cancelled = 0;
  const registered = await compileExternalTool({
    id: 'write', description: 'Write fixture', resource: 'fixture:write', effect: 'write',
    inputSchema: { type: 'object' },
    async invoke() { executed++; started.resolve(undefined); return settle.promise; },
    cancel() { cancelled++; },
  });
  assert.ok(registered);
  const externalTools = createExternalToolPort(new Map([['write', registered]])).bind({
    attemptId: 'attempt', operationId: 'op', signal: stop.signal, isActive: () => !stop.signal.aborted,
    permissions: { async request() { return { kind: 'selected', option: 'allow' }; } },
    newId: () => 'call-1', maxBytes: 64 * 1024,
    receive(_id, receipt) { receipts.push(receipt); return 'receipt:' + receipts.length; },
  });
  const bridge = await startMcpBridge({ signal: stop.signal, externalTools });
  try {
    const pending = invoke(bridge.url, 1, 'write', {});
    await started.promise;
    stop.abort('cancel');
    const response = await pending;
    assert.deepEqual(value(response), { status: 'unknown', effect: 'unknown',
      callId: 'call-1', ref: 'receipt:1' });
    assert.equal(cancelled, 1);
    assert.equal(executed, 1);
    const rejected = await fetch(bridge.url, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'write', arguments: {} } }),
    });
    assert.equal(rejected.status, 410);
    settle.resolve('completed after cancellation');
    await new Promise(setImmediate);
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts.map(item => [item.status, item.effect, item.ref]), [
      ['unknown', 'unknown', undefined], ['completed', 'unknown', undefined],
    ]);
    assert.equal(receipts[1].late, true);
    assert.equal(executed, 1);
  } finally {
    settle.resolve(undefined);
    stop.abort();
    bridge.close();
  }
});

test('C12R.8R.2 closing an in-flight MCP bridge releases the transport without killing an independent bridge', { timeout: 5000 }, async () => {
  const firstStop = new AbortController();
  const secondStop = new AbortController();
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let firstCalls = 0, secondCalls = 0;
  const first = await startMcpBridge({
    signal: firstStop.signal,
    externalTools: { list: () => [], async call() {
      firstCalls++;
      started.resolve(undefined);
      return finish.promise;
    } },
  });
  const second = await startMcpBridge({
    signal: secondStop.signal,
    externalTools: { list: () => [], async call() {
      secondCalls++;
      return { status: 'completed', effect: 'none' };
    } },
  });
  try {
    const pending = invoke(first.url, 1, 'hold', {});
    await started.promise;
    first.close();
    await assert.rejects(pending);
    const independent = await invoke(second.url, 1, 'other', {});
    assert.equal(independent.status, 200);
    assert.deepEqual(value(independent), { status: 'completed', effect: 'none' });
    assert.deepEqual([firstCalls, secondCalls], [1, 1]);
    firstStop.abort();
    finish.resolve({ status: 'unknown', effect: 'unknown' });
    await new Promise(setImmediate);
    assert.deepEqual([firstCalls, secondCalls], [1, 1]);
  } finally {
    first.close();
    second.close();
    firstStop.abort();
    secondStop.abort();
    finish.resolve({ status: 'unknown', effect: 'unknown' });
  }
});

test('C12R.8R.1 an oversized MCP projection does not alter a durable tool receipt across reopen', async () => {
  const { createLocalStateStore } = await import('../../src/adapters/state/local-store.js');
  const { withOwnedRun } = await import('../../scripts/owned-run.mjs');
  const { setup, final } = await import('../fixtures/application.js');
  const { request } = await import('../fixtures/core.js');
  await withOwnedRun('C12R.8R-mcp-receipt', async directory => {
    const store = createLocalStateStore(directory);
    await store.open();
    let executions = 0;
    const output = 'z'.repeat(300 * 1024);
    const tools = {
      bind(scope) {
        return {
          list: () => [{ id: 'write', description: 'contract fixture', resource: 'fixture:write',
            effect: 'write', inputSchema: { type: 'object' } }],
          async call() {
            executions++;
            const callId = 'receipt-' + executions;
            const ref = scope.receive('write', { status: 'completed', effect: 'possible',
              callId, toolId: 'write', attemptId: scope.attemptId, output });
            return { status: 'completed', effect: 'possible', callId, ref, output };
          },
        };
      },
    };
    const { api } = setup({ store, tools, async respond(invocation) {
      const bridge = await startMcpBridge(invocation);
      try {
        const response = await invoke(bridge.url, 1, 'write', {});
        assert.equal(response.status, 200);
        assert.equal(response.body.result.isError, true);
        assert.deepEqual(value(response), { status: 'completed', effect: 'possible',
          callId: 'receipt-1', ref: 'host:tool:receipt-1', outputUnavailableReason: 'budget' });
        assert.deepEqual(value(await invoke(bridge.url, 1, 'write', {})), value(response));
      } finally {
        bridge.close();
      }
      return final(invocation);
    } });
    try {
      const finished = await (await api.submit(request())).completion;
      assert.equal(finished.status, 'finished');
      assert.equal(executions, 1);
      const pickReceipt = state => state.events.flatMap(event => event.observations ?? [])
        .find(item => item.ref === 'host:tool:receipt-1');
      const recorded = pickReceipt(finished);
      assert.ok(recorded);
      assert.equal(recorded.source, 'host_observed');
      assert.equal(recorded.value.status, 'completed');
      assert.equal(recorded.value.effect, 'possible');
      assert.equal(recorded.value.callId, 'receipt-1');
      assert.equal(recorded.value.output, output);
      assert.equal(recorded.value.outputUnavailableReason, undefined);
      await api.close();
      await store.close();
      await store.open();
      const reopened = await store.load(finished.operationId);
      const persisted = pickReceipt(reopened);
      assert.ok(persisted);
      assert.equal(persisted.ref, recorded.ref);
      assert.equal(persisted.source, recorded.source);
      assert.equal(persisted.completeness, recorded.completeness);
      assert.deepEqual(persisted.value, recorded.value);
      assert.equal(persisted.provenance.kind, recorded.provenance.kind);
      assert.equal(persisted.provenance.sourceId, recorded.provenance.sourceId);
      assert.equal(persisted.provenance.receivedAt, recorded.provenance.receivedAt);
      assert.equal(executions, 1);
    } finally {
      await api.close();
      await store.close();
    }
  });
});
