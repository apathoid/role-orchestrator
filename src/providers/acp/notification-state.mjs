import { AgentProviderError } from '../errors.mjs';

// This is a bounded diagnostic cache, not the ACP event stream used for live
// presentation. Keep provenance when event snapshots are incomplete. The
// provider still receives and forwards the original notification unchanged.
const MAX_TOOL_EVENT_COUNT = 256;
const MAX_TOOL_EVENT_BYTES = 1_048_576;
const MAX_SINGLE_TOOL_EVENT_BYTES = 65_536;
// Independent of tool diagnostics: model-answer accumulation must not retain
// unbounded provider-controlled chunks (including structured responses).
export const ACP_ANSWER_CAPTURE_LIMIT = 1_048_576;

/** Synchronous, bounded data-plane capture. A partial answer is never valid evidence. */
export function captureAcpAnswerText(state, phase, text) {
    if (phase === 'commentary' || typeof text !== 'string' || !text) return;
    const field = phase === 'final_answer' ? 'finalText' : 'unphasedText';
    const used = (state.finalText?.length ?? 0) + (state.unphasedText?.length ?? 0);
    const available = Math.max(0, ACP_ANSWER_CAPTURE_LIMIT - used);
    if (text.length > available) {
        state.answerCaptureIncomplete = true;
        state.answerCaptureOmittedCharacters = (state.answerCaptureOmittedCharacters ?? 0) + text.length - available;
    }
    if (available) state[field] = (state[field] ?? '') + text.slice(0, available);
}

/** Call before parsing, reconciliation, or accepting a provider turn as complete. */
export function assertCompleteAcpAnswer(state) {
    if (!state.answerCaptureIncomplete) return;
    throw new AgentProviderError('PROVIDER_CRASH',
        'ACP answer exceeded the bounded response capture limit; incomplete output cannot be used for execution or structured parsing.', {
            retryable: false,
            diagnostics: {
                source: 'orchestrator', reason: 'ACP_ANSWER_CAPTURE_LIMIT',
                limitCharacters: ACP_ANSWER_CAPTURE_LIMIT,
                omittedCharacters: state.answerCaptureOmittedCharacters ?? 0,
                complete: false,
            },
        });
}

export const ACP_DEFERRED_PRESENTATION_LIMIT = 1_048_576;
// Deferred native media and metadata are not accounted for by text capture.
export function captureDeferredAcpUpdate(state, field, update) {
    if (state.deferredPresentationIncomplete) return;
    const size = eventSize(update);
    const used = state.deferredPresentationBytes ?? 0;
    if (!Number.isFinite(size) || size > ACP_DEFERRED_PRESENTATION_LIMIT - used) {
        state.deferredPresentationIncomplete = true;
        state.pendingFinalUpdates = [];
        state.pendingUnphasedUpdates = [];
        return;
    }
    state.deferredPresentationBytes = used + size;
    state[field].push(update);
}
export function assertCompleteDeferredAcpPresentation(state) {
    if (!state.deferredPresentationIncomplete) return;
    throw new AgentProviderError('PROVIDER_CRASH',
        'ACP deferred presentation exceeded its byte limit; incomplete output cannot be accepted.', {
            diagnostics: { source: 'orchestrator', reason: 'ACP_DEFERRED_PRESENTATION_LIMIT',
                limitBytes: ACP_DEFERRED_PRESENTATION_LIMIT, complete: false },
        });
}

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
            captureAcpAnswerText(state, 'final_answer', text);
            state.finalChunksReceived += 1;
        } else if (phase !== 'commentary') {
            captureAcpAnswerText(state, null, text);
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
