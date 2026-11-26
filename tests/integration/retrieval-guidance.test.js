import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerInstructions } from '../../src/application/controller-context.js';
import { retrievalDetail } from '../../src/adapters/mcp-bridge.js';

test('C12R.8 optional history inspection remains a Controller choice rather than a mandatory workflow', () => {
  const instructions = controllerInstructions.join('\n');
  assert.match(instructions, /Retrieval of live observations, history and workMap is optional/);
  assert.doesNotMatch(instructions, /do not enumerate history by default/);
  assert.equal(instructions.match(/retrieval is optional|Retrieval of live observations, history and workMap is optional/g)?.length,1);
  assert.doesNotMatch(instructions, /page through metadata/i);
  // A separate model-owned summary is not elevated to a tool observation.
  assert.match(instructions, /Model summaries are separate claims citing covered observation references/);
});

test('C12R.8 MCP advice advertises optional retrieval without disabling the tools or hiding missing evidence', () => {
  const enabled = retrievalDetail(true);
  assert.match(enabled, /Optional MCP context_list and context_fetch/);
  assert.match(enabled, /when useful/);
  assert.match(controllerInstructions.join('\n'), /Explain material gaps/);
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
        const [list,fetchTool]=data.result.tools;
        assert.match(list.description,/nextCursor exactly/);
        assert.match(list.description,/cursor or use 0/);
        assert.match(fetchTool.description,/nextOffset/);
        assert.match(fetchTool.description,/saved UTF-8\/JSON or binary data/);
        assert.match(fetchTool.description,/does not restore missing source data/);
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
  assert.match(enabled,/retrieve scoped historical records/);
  assert.doesNotMatch(enabled,/nextOffset|nextCursor/);
  assert.match(retrievalDetail(true,{},'delegate'),/material unavailable evidence/);
  assert.doesNotMatch(retrievalDetail(true,{},'delegate'),/nextController/);
});

test('C21 advertises negotiated aliases and only the role-appropriate no-MCP path',async()=>{
  const {startMcpBridge}=await import('../../src/adapters/mcp-bridge.js');
  const {renderCodexPrompt}=await import('../../src/adapters/cli/codex-prompt.js');
  const {setup,final}=await import('../fixtures/application.js');
  const {request}=await import('../fixtures/core.js');
  const {api,respondErrors}=setup({async respond(invocation){
    const bridge=await startMcpBridge({...invocation,
      externalTools:{list:()=>['context_list','context_fetch','evidence_list','evidence_fetch'].map(id=>({
        id,description:'External fixture '+id,effect:'read',inputSchema:{type:'object'}})),
        async call(){return {status:'completed',effect:'none'}}}});
    try{
      const prompt=renderCodexPrompt(invocation,'fixture',true,undefined,bridge);
      assert.match(prompt,/Optional MCP role_orchestrator_context_list and role_orchestrator_context_fetch/);
      assert.doesNotMatch(prompt,/Optional MCP context_list and context_fetch/);
      if(bridge.evidenceListToolName){
        assert.ok(prompt.includes(bridge.evidenceListToolName+' and '+bridge.evidenceFetchToolName));
        assert.ok(prompt.includes(bridge.evidenceFetchToolName));
      }
      const worker=renderCodexPrompt({...invocation,kind:'delegate',instructions:[]},'fixture',false);
      assert.match(worker,/Historical context retrieval via MCP is unavailable/);
      assert.doesNotMatch(worker,/nextController\.contextRequest/);
      assert.doesNotMatch(retrievalDetail(false,{},'delegate'),/nextController/);
      return final(invocation);
    }finally{bridge.close()}
  }});
  try{
    const state=await(await api.submit(request())).completion;
    assert.equal(state.status,'finished',respondErrors.map(String).join('\n'));
  }finally{await api.close()}
});
