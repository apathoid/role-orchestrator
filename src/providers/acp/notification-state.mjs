// This is a bounded diagnostic cache, not the ACP event stream used for live
// presentation. Keep provenance when event snapshots are incomplete. The
// provider still receives and forwards the original notification unchanged.
const MAX_TOOL_EVENT_COUNT = 256;
const MAX_TOOL_EVENT_BYTES = 1_048_576;
const MAX_SINGLE_TOOL_EVENT_BYTES = 65_536;

function eventSize(value) {
    try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8'); }
    catch { return Infinity; }
}
function captureToolEventForDiagnostics(state, update) {
    state.toolEventsReceived = (state.toolEventsReceived ?? 0) + 1;
    state.toolEventsOmitted ??= 0;
    state.toolEventsBytes ??= 0;
    state.toolEventsSizes ??= [];

    const size = eventSize(update);
    if (size > MAX_SINGLE_TOOL_EVENT_BYTES) {
        state.toolEventsOmitted += 1;
        return;
    }
    // Retain recent events, including terminal status and failure diagnostics,
    // rather than an unbounded prefix of obsolete progress updates.
    while (state.toolEvents.length >= MAX_TOOL_EVENT_COUNT ||
            state.toolEventsBytes + size > MAX_TOOL_EVENT_BYTES) {
        if (!state.toolEvents.length) break;
        state.toolEvents.shift();
        state.toolEventsBytes -= state.toolEventsSizes.shift() ?? 0;
        state.toolEventsOmitted += 1;
    }
    state.toolEvents.push(update);
    state.toolEventsSizes.push(size);
    state.toolEventsBytes += size;
}

export function acpToolEventCaptureStatus(state) {
    const received = state.toolEventsReceived ?? state.toolEvents?.length ?? 0;
    const retained = state.toolEvents?.length ?? 0;
    const omitted = state.toolEventsOmitted ?? Math.max(0, received - retained);
    return {
        received, retained, omitted, complete: omitted === 0,
        retention: 'bounded_recent_diagnostics',
    };
}

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
        captureToolEventForDiagnostics(state, update);
    }
}
