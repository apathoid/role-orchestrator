import assert from 'node:assert/strict';
import { captureAcpSessionUpdate, acpToolEventCaptureStatus } from '../src/providers/acp/notification-state.mjs';

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
// Diagnostic capture cannot retain arbitrary, provider-controlled tool payloads.
// Presentation callbacks still receive the original update independently.
const bounded = { notificationsReceived:0, finalChunksReceived:0, finalText:'',
    unphasedText:'', usage:null, toolEvents:[] };
const sample = {sessionUpdate:'tool_call_update',toolCallId:'first',status:'completed'};
captureAcpSessionUpdate(bounded,sample);
assert.equal(bounded.toolEvents[0],sample);
const huge = {sessionUpdate:'tool_call_update',toolCallId:'huge',
    content:[{type:'content',content:{type:'text',text:'X'.repeat(100000)}}]};
captureAcpSessionUpdate(bounded,huge);
assert.equal(bounded.toolEvents.some(x=>x.toolCallId==='huge'),false,
    'huge provider output must not be retained in the diagnostic event list');
for (let i=0;i<300;i++) captureAcpSessionUpdate(bounded,{
    sessionUpdate:'tool_call_update',toolCallId:`tool-${i}`,status:'in_progress'
});
let retention=acpToolEventCaptureStatus(bounded);
assert.equal(retention.received,302);
assert.equal(retention.retained,256);
assert.equal(retention.omitted,46);
assert.equal(retention.complete,false);
assert.equal(bounded.toolEvents.at(-1).toolCallId,'tool-299');
assert.equal(bounded.toolEvents[0].toolCallId,'tool-44');
assert(bounded.toolEventsBytes <= 1_048_576);
const fresh = { toolEvents:[] };
assert.equal(acpToolEventCaptureStatus(fresh).complete,true);
console.log('acp-notification-state: PASS');
