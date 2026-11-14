import { eventFindings } from '../core/finding.js';

/** @import {ActivityNotice, ActivityEvent} from '../core/ports.js' */
/** @import {DiagnosticEvent} from '../core/diagnostics.js' */
/** @import {Event, Operation} from '../core/operation.js' */
/** @import {SessionUpdate} from '@agentclientprotocol/sdk' */
/** @typedef {'compact' | 'detailed' | 'debug'} PresentationMode */

/** Display only: preserve underlying payload and final answer. @param {string} text */
export function terminalText(text) {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : {};
}
/** @param {unknown} value */
const string = value => typeof value === 'string' ? value : undefined;
/** @param {ActivityEvent} event */
function nativeText(event) {
  const payload = object(event.payload);
  if (typeof event.payload === 'string') return event.payload;
  const content = object(payload.content), item = object(payload.item);
  if (content.type === 'text') return string(content.text);
  return string(item.text) ?? string(payload.text) ?? (event.kind === 'finding' ? string(payload.claim) : undefined);
}

/** @param {ActivityNotice} event @param {PresentationMode} mode */
export function formatActivity(event, mode) {
  if (event.kind === 'gap') return terminalText('[Activity gap] ' + event.droppedCount + ' notices dropped' +
    (event.attemptId ? ' attempt=' + event.attemptId : '') +
    (event.sequenceRange ? ' sequence=' + event.sequenceRange.first + '–' + event.sequenceRange.last : ''));
  const prefix = '[' + event.profileId + '/' + event.attemptId + '] ';
  const details = mode === 'debug' ? ' (' + [event.providerId, event.nativeKind, event.nativeId, 'seq=' + event.sequence].filter(Boolean).join(' ') + ')' : '';
  let body;
  if (event.kind === 'reasoning' || event.kind === 'user_message' || event.kind === 'finding') {
    const text = nativeText(event);
    if (text === undefined) return;
    body = (event.kind === 'reasoning' ? 'Thinking' : event.kind === 'finding' ? 'Reported finding' : 'Message') + details + ': ' + text;
  } else if (mode !== 'compact') {
    const payload = object(event.payload), item = object(payload.item);
    if (event.kind === 'tool') {
      const title = string(payload.title) ?? string(item.type) ?? event.nativeKind ?? 'native tool';
      const status = string(payload.status) ?? string(item.status);
      body = 'Tool ' + title + (status ? ' · ' + status : '') + details;
    } else if (event.kind === 'plan') {
      const entries = Array.isArray(payload.entries) ? payload.entries : item.items;
      if (!Array.isArray(entries)) return;
      body = 'Plan' + details + ':\n' + entries.map(entry => {
        const row = object(entry);
        return '- ' + (string(row.content) ?? string(row.text) ?? '') +
          (typeof row.status === 'string' ? ' [' + row.status + ']' : typeof row.completed === 'boolean' ? ' [' + (row.completed ? 'completed' : 'pending') + ']' : '');
      }).join('\n');
    }
  }
  return body === undefined ? undefined : terminalText(prefix + body);
}

const lifecycle = new Set(['operation.accepted', 'attempt.dispatched', 'attempt.outcome',
  'attempt.cancel_requested', 'operation.cancelled', 'operation.waiting', 'operation.finished',
  'operation.continued', 'operation.recovered', 'controller.invalid_proposal', 'action.rejected', 'action.deferred',
  'permission.requested', 'permission.resolved', 'permission.expired', 'interaction.requested', 'interaction.resolved']);

/** @param {DiagnosticEvent} event @param {PresentationMode} mode */
export function formatExecution(event, mode) {
  if (event.eventName === 'delivery.gap') return terminalText('[Execution gap] ' + event.details?.droppedCount + ' notices dropped');
  if (mode !== 'debug' && !lifecycle.has(event.eventName) && event.level !== 'error' && event.level !== 'warn') return;
  const identity = event.attemptId ? (event.actionId === event.attemptId ? 'Controller' : 'Attempt') + ' ' + event.attemptId
    : event.actionId ? 'Action ' + event.actionId : 'Operation ' + (event.operationId ?? '');
  const extra = mode === 'debug' ? ' event=' + event.eventId + ' seq=' + event.sequence + ' at=' + event.receivedAt : '';
  return terminalText('[' + identity + '] ' + event.eventName + ' · ' + event.reasonCode + extra);
}

/** @param {Event} event @param {PresentationMode} mode */
export function formatRecordedFindings(event, mode) {
  return (eventFindings(event) ?? []).map(finding => ({
    id: finding.findingId,
    text: terminalText('[Recorded finding ' + finding.findingId + ' · ' + finding.author + '] ' + finding.claim +
      ' — ' + finding.subject +
      (finding.uncertainties.length ? '\nUncertainty: ' + finding.uncertainties.join('; ') : '') +
      (mode !== 'compact' && finding.supports.length ? '\nSupports: ' + finding.supports.join(', ') : '') +
      (finding.supersedes ? '\nSupersedes: ' + finding.supersedes : '')),
  }));
}

/** @param {Operation} state @param {PresentationMode} mode */
export function formatOperation(state, mode) {
  const terminal = state.status === 'finished' ? state.assessment?.overall ?? 'finished' : state.status;
  const attempts = state.attempts.map(attempt => '  ' + (attempt.actionId === attempt.attemptId ? 'Controller' : attempt.actionId) +
    ' ' + attempt.attemptId + ' · ' + (attempt.route?.profileId ?? 'route unknown') +
    ' · ' + (attempt.outcome?.terminal ?? attempt.status) +
    (attempt.outcome ? ' · effect=' + attempt.outcome.effect : '') +
    (attempt.cancellation ? ' · cancellation=' + attempt.cancellation : '')).join('\n');
  return terminalText('[Operation ' + state.operationId + '] ' + terminal +
    (state.waiting?.kind === 'technical' ? ' · ' + state.waiting.reason.code : '') +
    ' · invocations ' + state.attempts.length + '/' + state.limits.maxInvocations +
    (mode === 'compact' || !attempts ? '' : '\n' + attempts));
}

/** Same mapping for tool updates and permission/elicitation references. @param {string} attemptId @param {string} nativeId */
export function scopedNativeId(attemptId, nativeId) {
  return JSON.stringify([attemptId, nativeId]);
}

/** Map only actual standard native updates, never fabricate a lifecycle tool or thought.
 * @param {ActivityNotice} event @param {PresentationMode} mode @param {boolean} controller @returns {SessionUpdate | undefined}
 */
export function acpActivity(event, mode, controller) {
  if (event.kind === 'gap') return;
  const payload = object(event.payload);
  const update = /** @type {SessionUpdate} */ (event.payload);
  if (event.kind === 'reasoning') {
    if (payload.sessionUpdate === 'agent_thought_chunk' && update.sessionUpdate === 'agent_thought_chunk') {
      return { ...update, ...(update.messageId == null ? {} : { messageId: scopedNativeId(event.attemptId, update.messageId) }) };
    }
    if (event.nativeKind === 'item.completed' && object(payload.item).type === 'reasoning') {
      const text = nativeText(event);
      if (text !== undefined) return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } };
    }
  }
  if (event.kind === 'user_message' && payload.sessionUpdate === 'agent_message_chunk' && update.sessionUpdate === 'agent_message_chunk') {
    return { ...update, ...(update.messageId == null ? {} : { messageId: scopedNativeId(event.attemptId, update.messageId) }) };
  }
  if (event.kind === 'tool' && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      typeof update.toolCallId === 'string') {
    return { ...update, toolCallId: scopedNativeId(event.attemptId, update.toolCallId) };
  }
  if (event.kind === 'plan' && mode !== 'compact' && controller && update.sessionUpdate === 'plan') return update;
}
