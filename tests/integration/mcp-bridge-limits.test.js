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
