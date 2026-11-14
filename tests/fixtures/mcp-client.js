import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

export async function retrieveContext(url, invocation) {
  let next = 0;
  async function rpc(method, params, id = ++next) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.id, id);
    assert.ok(reply.result, JSON.stringify(reply));
    return reply.result;
  }
  async function call(name, args = {}, id) {
    const result = await rpc('tools/call', { name, arguments: args }, id);
    return JSON.parse(result.content[0].text);
  }
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  const listing = await rpc('tools/list');
  assert.ok(listing.tools.some(tool => tool.name === 'context_fetch'));
  const items = [];
  let cursor;
  do {
    const page = await call('context_list', cursor === undefined ? {} : { cursor });
    assert.equal(page.kind, 'available');
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const seed = items.find(item => item.providerRef === 'seed');
  const artifact = items.find(item => typeof item.ref === 'string' && item.ref.startsWith('artifact:'));
  assert.ok(seed && artifact);
  assert.ok(!invocation.context.some(item => item.ref === seed.ref && item.value === 'retrievable-evidence'));
  const found = await call('context_fetch', { ref: seed.ref });
  assert.equal(found.kind, 'available');
  assert.equal(found.item.value, 'retrievable-evidence');
  assert.deepEqual(await call('context_fetch', { ref: seed.ref, sourceOperationId: 'foreign' }),
    { kind: 'unavailable', reason: 'denied' });
  assert.deepEqual(await call('context_fetch', { ref: artifact.ref }), { kind: 'unavailable', reason: 'budget' });
  const refs = [found.item.ref];
  if (listing.tools.some(tool => tool.name === 'echo_text')) {
    const [external, replay] = await Promise.all([
      call('echo_text', { text: 'from live MCP' }, 'stable-tool-call'),
      call('echo_text', { text: 'from live MCP' }, 'stable-tool-call'),
    ]);
    assert.deepEqual(replay, external);
    assert.equal(external.status, 'completed');
    assert.equal(external.output, 'from live MCP');
    refs.push(external.ref);
  }
  await writeFile('mcp-url', url);
  const { operationId, attemptId, profileId, context } = invocation;
  return {
    schemaVersion: 1, operationId, decisionId: attemptId + '-decision',
    contextCursor: context.find(item => item.ref === 'host:invocation-context').value.contextCursor,
    additions: [], cancellations: [], finalAssessment: { author: profileId, overall: 'complete',
      requirements: [], observationRefs: refs, findingRefs: [],
      unresolvedQuestions: [], answer: found.item.value },
  };
}
