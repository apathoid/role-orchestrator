import assert from 'node:assert/strict';
import { createOuterToolCallBridge } from '../src/acp-tool-bridge.mjs';

const published = [];
const warnings = [];
const bridge = createOuterToolCallBridge({
  publish: async (update) => published.push(update),
  warn: (message) => warnings.push(message),
});
const send = (scope, type, id, extra = {}) => bridge({
  role: 'explorer', invocationId: scope,
  update: { sessionUpdate: type, toolCallId: id, ...extra },
});

await send('turn-a', 'tool_call_update', 'missing', { status: 'completed' });
assert.equal(published.length, 0, 'orphan updates must not reach Zed');
assert.equal(warnings.length, 1);
await send('turn-a', 'tool_call', 'id', { title: 'Read first file', kind: 'read' });
await send('turn-a', 'tool_call_update', 'id', { status: 'completed' });
await send('turn-b', 'tool_call', 'id', { title: 'Read another file', kind: 'read' });
await send('turn-b', 'tool_call_update', 'id', { status: 'failed' });
assert.equal(published.length, 4);
assert.equal(published[0].sessionUpdate, 'tool_call');
assert.equal(published[1].sessionUpdate, 'tool_call_update');
assert.equal(published[1].toolCallId, published[0].toolCallId);
assert.notEqual(published[0].toolCallId, published[2].toolCallId, 'inner sessions must not collide');
assert.equal(published[2].toolCallId, published[3].toolCallId);
assert.equal(published[0].title, 'Read first file');
assert.equal(published[3].status, 'failed');
await send('turn-a', 'tool_call', 'id', { title: 'Updated title' });
assert.equal(published.at(-1).sessionUpdate, 'tool_call_update', 'duplicate creates must not create cards');
await bridge({ invocationId: 'turn-x', update: { sessionUpdate: 'tool_call', title: 'No id' } });
assert.equal(warnings.length, 2);
assert.ok(published.every((x) => x.toolCallId !== 'id'));

// ACP v2-style first update with a title is a valid v1 creation source.
await send('turn-v2', 'tool_call_update', 'upsert-1', { title: 'Inspect code', kind: 'read' });
assert.equal(published.at(-1).sessionUpdate, 'tool_call');
await send('turn-v2', 'tool_call_update', 'upsert-1', { status: 'completed' });
assert.equal(published.at(-1).sessionUpdate, 'tool_call_update');

// Permissions must refer to the exact ID used by the public tool card.
const meta = { provider: 'subscription', innerSessionId: 'inner-123' };
const inner = { sessionId: 'inner-123', toolCall: { toolCallId: 'exec-1', title: 'Run a command', kind: 'execute' }, options: [] };
const mapped = await bridge.permission(inner, meta);
assert.equal(mapped.sessionId, 'inner-123', 'outer session rewrite belongs to the ACP agent boundary');
assert.equal(published.at(-1).sessionUpdate, 'tool_call');
assert.equal(mapped.toolCall.toolCallId, published.at(-1).toolCallId);
const again = await bridge.permission(inner, meta);
assert.equal(again.toolCall.toolCallId, mapped.toolCall.toolCallId);
assert.equal(published.filter((item) => item.toolCallId === mapped.toolCall.toolCallId).length, 1);
await bridge({ ...meta, update: { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed' } });
assert.equal(published.at(-1).toolCallId, mapped.toolCall.toolCallId);
assert.equal(published.at(-1).sessionUpdate, 'tool_call_update');
assert.equal(await bridge.permission({ toolCall: { toolCallId: 'missing' } }, {}), null);

// Concurrent arrivals must not overtake their creation.
await Promise.all([
  send('parallel', 'tool_call', 'f-1', { title: 'Read file' }),
  send('parallel', 'tool_call_update', 'f-1', { status: 'completed' }),
]);
assert.equal(published.at(-2).sessionUpdate, 'tool_call');
assert.equal(published.at(-1).sessionUpdate, 'tool_call_update');
// Reusing the same inner IDs on the next outer turn must not reuse Zed IDs.
const secondTurn = [];
const newBridge = createOuterToolCallBridge({ publish: async (update) => secondTurn.push(update) });
await newBridge({ ...meta, update: { sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'New turn' } });
assert.notEqual(secondTurn[0].toolCallId, mapped.toolCall.toolCallId);
// Identical ACP notifications are idempotent within a single inner session.
// A new inner session with the same tool ID still creates a distinct card.
const countBeforeDedup = published.length;
await send('turn-b', 'tool_call_update', 'id', { status: 'failed' });
assert.equal(published.length, countBeforeDedup, 'duplicate status payload not published twice');
await send('turn-b', 'tool_call_update', 'id', { status: 'in_progress' });
assert.equal(published.length, countBeforeDedup, 'delayed running status cannot reopen failed card');
await send('turn-b', 'tool_call_update', 'id', { status: 'failed', content: [
  { type:'content', content:{type:'text',text:'new error evidence'} },
] });
assert.equal(published.length, countBeforeDedup + 1, 'new failure content is not discarded');
assert.equal(published.at(-1).status, 'failed');
const initial = published.length;
await send('turn-new', 'tool_call', 'repeat', { title: 'Read', kind: 'read' });
await send('turn-new', 'tool_call', 'repeat', { title: 'Read', kind: 'read' });
assert.equal(published.length, initial + 1, 'duplicate create is not forwarded as redundant update');
await send('turn-new', 'tool_call_update', 'repeat', { status: 'completed' });
await send('turn-new', 'tool_call_update', 'repeat', { status: 'completed' });
assert.equal(published.length, initial + 2, 'duplicate terminal update is not forwarded');
await send('turn-new', 'tool_call_update', 'repeat', { status: 'completed', content: [
  { type:'content', content:{type:'text',text:'added evidence'} },
] });
assert.equal(published.length, initial + 3, 'different content with same status is material');
const secure = await bridge.permission({toolCall:{toolCallId:'oversize', title:'T'.repeat(10000)}},meta);
assert(secure.toolCall.toolCallId.includes('oversize'));
assert(published.at(-1).title.includes('ACP presentation truncated'), 'permission card bounded without changing actual permission input');
// A malicious provider must not grow the outer-card identity map without bound.
const overflowPublished = [];
const overflowWarnings = [];
const capped = createOuterToolCallBridge({
  publish: async (update) => overflowPublished.push(update),
  warn: (message) => overflowWarnings.push(message),
});
for (let i = 0; i < 4100; i++) {
  await capped({ invocationId:'capacity', update:{
    sessionUpdate:'tool_call', toolCallId:'id-'+i, title:'Read', kind:'read',
  } });
}
assert.equal(overflowPublished.length, 4096);
assert.equal(overflowWarnings.length, 1);
assert.equal(await capped.permission({toolCall:{toolCallId:'overflow',title:'Command'}},
  {invocationId:'capacity'}), null, 'permission cannot reference an unregistered card');
assert.equal(overflowPublished.length, 4096);
await capped({invocationId:'capacity',update:{
  sessionUpdate:'tool_call_update',toolCallId:'id-0',status:'completed',
}});
assert.equal(overflowPublished.length,4097,'existing tool cards still receive terminal updates');
const beforeInvalid = overflowPublished.length;
await capped({invocationId:'capacity',update:{
  sessionUpdate:'tool_call',toolCallId:'x'.repeat(300),title:'Bad ID',
}});
assert.equal(overflowPublished.length,beforeInvalid);
console.log('acp-tool-bridge: passed');
