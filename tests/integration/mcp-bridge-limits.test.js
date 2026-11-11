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
