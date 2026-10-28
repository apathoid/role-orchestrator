import assert from 'node:assert/strict';
import { captureAcpSessionUpdate, acpToolEventCaptureStatus, captureAcpAnswerText, assertCompleteAcpAnswer, ACP_ANSWER_CAPTURE_LIMIT, captureDeferredAcpUpdate, assertCompleteDeferredAcpPresentation, ACP_DEFERRED_PRESENTATION_LIMIT } from '../src/providers/acp/notification-state.mjs';

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

const answer = () => ({
    notificationsReceived: 0, finalChunksReceived: 0, finalText: '',
    unphasedText: '', toolEvents: [],
});
const exact = answer();
captureAcpSessionUpdate(exact, { sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'a'.repeat(ACP_ANSWER_CAPTURE_LIMIT) },
    _meta: { codex: { phase: 'final_answer' } } },
    { phaseOf: (u) => u?._meta?.codex?.phase });
assert.equal(exact.finalText.length, ACP_ANSWER_CAPTURE_LIMIT);
assert.doesNotThrow(() => assertCompleteAcpAnswer(exact));
captureAcpSessionUpdate(exact, { sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'tail' }, _meta: { codex: { phase: 'final_answer' } } },
    { phaseOf: (u) => u?._meta?.codex?.phase });
assert.equal(exact.finalText.length, ACP_ANSWER_CAPTURE_LIMIT);
assert.equal(exact.answerCaptureOmittedCharacters, 4);
assert.throws(() => assertCompleteAcpAnswer(exact), (error) => {
    assert.equal(error.code, 'PROVIDER_CRASH');
    assert.equal(error.diagnostics?.reason, 'ACP_ANSWER_CAPTURE_LIMIT');
    assert.equal(error.diagnostics?.complete, false);
    assert.equal(error.diagnostics?.omittedCharacters, 4);
    return true;
});
// A mixture of unphased and explicit final chunks shares one total budget.
const mixed = answer();
captureAcpAnswerText(mixed, null, 'u'.repeat(ACP_ANSWER_CAPTURE_LIMIT - 3));
captureAcpAnswerText(mixed, 'final_answer', 'FINAL');
captureAcpAnswerText(mixed, 'commentary', 'secret'.repeat(100000));
assert.equal(mixed.unphasedText.length, ACP_ANSWER_CAPTURE_LIMIT - 3);
assert.equal(mixed.finalText, 'FIN');
assert.equal(mixed.answerCaptureOmittedCharacters, 2);
assert.throws(() => assertCompleteAcpAnswer(mixed), { code: 'PROVIDER_CRASH' });
// A fresh turn starts with a clean capture witness, not the previous failure.
const restarted = answer();
captureAcpAnswerText(restarted, 'final_answer', '{"ok":true}');
assert.doesNotThrow(() => assertCompleteAcpAnswer(restarted));

const deferred = { pendingFinalUpdates: [], pendingUnphasedUpdates: [] };
captureDeferredAcpUpdate(deferred, 'pendingFinalUpdates', { content: { type:'text', text:'ok' } });
assert.equal(deferred.pendingFinalUpdates.length, 1);
assert.doesNotThrow(() => assertCompleteDeferredAcpPresentation(deferred));
captureDeferredAcpUpdate(deferred, 'pendingUnphasedUpdates',
    { content: { type:'text', text:'x'.repeat(ACP_DEFERRED_PRESENTATION_LIMIT) } });
assert.equal(deferred.deferredPresentationIncomplete, true);
assert.equal(deferred.pendingFinalUpdates.length, 0);
assert.equal(deferred.pendingUnphasedUpdates.length, 0);
assert.throws(() => assertCompleteDeferredAcpPresentation(deferred), (error) =>
    error.code === 'PROVIDER_CRASH' && error.diagnostics?.complete === false);
console.log('acp-notification-state: PASS');
