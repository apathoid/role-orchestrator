import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerInstructions } from '../../src/application/controller-context.js';
import { retrievalDetail } from '../../src/adapters/mcp-bridge.js';

test('C12R.8 optional history inspection remains a Controller choice rather than a mandatory workflow', () => {
  const instructions = controllerInstructions.join('\n');
  assert.match(instructions, /choose whether to use historical list\/fetch/);
  assert.match(instructions, /do not enumerate history by default/);
  assert.doesNotMatch(instructions, /page through metadata/i);
  // A separate model-owned summary is not elevated to a tool observation.
  assert.match(instructions, /Model summaries are separate claims citing covered observation references/);
});

test('C12R.8 MCP advice advertises optional retrieval without disabling the tools or hiding missing evidence', () => {
  const enabled = retrievalDetail(true);
  assert.match(enabled, /Optional MCP context_list and context_fetch/);
  assert.match(enabled, /when useful/);
  assert.match(enabled, /material unavailable evidence/);
  assert.doesNotMatch(enabled, /Use MCP tools context_list and context_fetch/);
  const disabled = retrievalDetail(false);
  assert.match(disabled, /unavailable in this transport/);
  assert.match(disabled, /material missing evidence when relevant/);
});

test('C12R.8R.3 a direct Controller completion does not require historical MCP retrieval when tools are available', async () => {
  const { startMcpBridge } = await import('../../src/adapters/mcp-bridge.js');
  const { setup, final } = await import('../fixtures/application.js');
  const { request } = await import('../fixtures/core.js');
  let listCalls = 0, fetchCalls = 0;
  const { api, invocations } = setup({
    async respond(invocation) {
      assert.equal(invocation.kind, 'controller');
      assert.ok(invocation.contextAccess);
      const original = invocation.contextAccess;
      const bridge = await startMcpBridge({
        signal: invocation.signal,
        contextAccess: {
          list(cursor) { listCalls++; return original.list(cursor); },
          async fetch(ref, sourceOperationId) { fetchCalls++; return original.fetch(ref, sourceOperationId); },
          captureArtifact: original.captureArtifact,
        },
      });
      try {
        const response = await fetch(bridge.url, { method: 'POST',
          headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.deepEqual(data.result.tools.map(tool => tool.name), ['context_list', 'context_fetch']);
        return final(invocation);
      } finally {
        bridge.close();
      }
    },
  });
  try {
    const result = await (await api.submit(request())).completion;
    assert.equal(result.status, 'finished');
    assert.equal(result.assessment.answer, 'Direct answer');
    assert.equal(invocations.length, 1);
    assert.deepEqual([listCalls, fetchCalls], [0, 0]);
  } finally {
    await api.close();
  }
});

test('C12R.9 review: no-MCP advisory still exposes optional nextController history access',()=>{
  const disabled=retrievalDetail(false);
  assert.match(disabled,/nextController\.contextRequest/);
  assert.match(disabled,/byte offsets/);
  assert.match(disabled,/without MCP/);
  const enabled=retrievalDetail(true);
  assert.match(enabled,/nextOffset/);
  assert.match(enabled,/saved data/);
});
