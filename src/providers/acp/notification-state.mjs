/**
 * Synchronous, provider-neutral capture of the state carried by ACP session
 * notifications. This must run in the notification callback before any async
 * host presentation work: session/prompt may resolve while progress delivery
 * is still pending. Provider-specific phase and usage decoding is injected.
 *
 * The caller owns per-session ordering, authorization, and lifecycle.
 */
export function captureAcpSessionUpdate(state, update, { phaseOf = () => null, usageOf = () => null } = {}) {
    state.notificationsReceived += 1;
    if (update.sessionUpdate === 'agent_message_chunk') {
        const text = update.content?.type === 'text' && typeof update.content.text === 'string'
            ? update.content.text : '';
        if (!text) return;
        const phase = phaseOf(update);
        if (phase === 'final_answer') {
            state.finalText += text;
            state.finalChunksReceived += 1;
        } else if (phase !== 'commentary') {
            state.unphasedText += text;
        }
        return;
    }
    if (update.sessionUpdate === 'usage_update') {
        const usage = usageOf(update);
        if (usage) state.usage = usage;
        return;
    }
    if (['tool_call', 'tool_call_update', 'tool_call_content_chunk'].includes(update.sessionUpdate)) {
        state.toolEvents.push(update);
    }
}
