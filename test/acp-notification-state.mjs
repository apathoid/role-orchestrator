import assert from 'node:assert/strict';
import { captureAcpSessionUpdate } from '../src/providers/acp/notification-state.mjs';

const state = {
    notificationsReceived: 0, finalChunksReceived: 0, finalText: '', unphasedText: '',
    usage: null, toolEvents: [],
};
const capture = (update) => captureAcpSessionUpdate(state, update, {
    phaseOf: (value) => value?._meta?.codex?.phase ?? null,
    usageOf: (value) => ({ contextUsedTokens: value.used }),
});

// The actual ACP final text is synchronously available even while host-side
// presentation callbacks are blocked on promises. No timers or arbitrary
// delivery deadlines are needed to make the model result durable.
let finishProgress;
const slowProgress = new Promise((resolve) => { finishProgress = resolve; });
const progress = slowProgress.then(() => { });
capture({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking...' }, _meta: { codex: { phase: 'commentary' } } });
capture({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"mode":"change"' }, _meta: { codex: { phase: 'final_answer' } } });
capture({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '}' }, _meta: { codex: { phase: 'final_answer' } } });
assert.deepEqual(JSON.parse(state.finalText), { mode: 'change' });
assert.equal(state.notificationsReceived, 3);
assert.equal(state.finalChunksReceived, 2);
assert.equal(state.unphasedText, '');
finishProgress();
await progress;

capture({ sessionUpdate: 'usage_update', used: 1300 });
capture({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' });
assert.equal(state.usage.contextUsedTokens, 1300);
assert.equal(state.toolEvents[0].toolCallId, 'x');

const unphased = { notificationsReceived: 0, finalChunksReceived: 0, finalText: '', unphasedText: '', usage: null, toolEvents: [] };
captureAcpSessionUpdate(unphased, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"mode":"review"}' } });
assert.deepEqual(JSON.parse(unphased.unphasedText), { mode: 'review' });
assert.equal(unphased.finalChunksReceived, 0);
console.log('acp-notification-state: PASS');
