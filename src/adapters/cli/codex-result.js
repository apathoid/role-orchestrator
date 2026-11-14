import { parseDecisionText } from '../invocation-prompt.js';

/** @import {ProviderPort, ProviderResult} from '../../core/ports.js' */
/** @import {Outcome, ReasonCode} from '../../core/contracts.js' */
/** @import {AdapterObservation} from '../../core/observation.js' */
/** @typedef {Awaited<ReturnType<typeof import('./codex-output.js').startCodexProcess>['finished']>} CodexResult */

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string, unknown>} */ (value) : undefined;

/** @param {unknown} value */
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

/** @param {string} attemptId @param {ReasonCode} code @returns {ProviderResult} */
export function unstartedCodexResult(attemptId, code) {
  return {
    dispatchCertainty: 'not_sent',
    outcome: {
      schemaVersion: 1, attemptId, terminal: code === 'CANCELLED' ? 'cancelled' : 'failed', effect: 'none',
      diagnostics: [{ code, ref: undefined }], outputRefs: [],
      usage: { inputTokens: null, outputTokens: null, cost: null },
    },
  };
}

/**
 * Interpret only the documented transport facts. The coordinator validates
 * the Decision itself and owns both correction and semantic assessment.
 * @param {CodexResult} result
 * @param {{attemptId: string, kind: 'controller' | 'delegate'}} request
 * @param {Parameters<ProviderPort['invoke']>[2]} observe
 * @returns {ProviderResult}
 */
export function receiveCodexResult(result, { attemptId, kind }, observe) {
  const { process, stdout, stderr, frames, diagnostics } = result;
  /** @type {Outcome['outputRefs']} */
  const outputRefs = [];
  /** @type {Outcome['diagnostics']} */
  const permissionDiagnostics = [];
  /** @param {AdapterObservation} item */
  function publish(item) {
    const ref = observe(item);
    if (ref === undefined) return undefined;
    const kind = item.kind === 'agent_exit' ? 'agent_exit' :
      item.kind === 'provider_tool' && item.exitCode !== undefined ? 'tool_exit' : 'output';
    const source = item.kind === 'model' ? 'model_claim' :
      item.kind === 'agent_exit' || item.kind === 'host_transport' ? 'host_observed' : 'provider_reported';
    outputRefs.push({ ref, kind, source, providerRef: undefined });
    return ref;
  }

  let sent = false;
  /** @type {'turn.completed' | 'turn.failed' | undefined} */
  let terminal;
  /** @type {string | undefined} */
  let message;
  let messageRef;
  /** @type {Outcome['usage']} */
  const usage = { inputTokens: null, outputTokens: null, cost: null };
  let invalidSequence = false;
  /** @type {string | undefined} */
  let providerErrorRef;
  for (const { line, event } of frames) {
    const ref = 'codex-line-' + line;
    if (event.type === 'turn.started') {
      if (sent) invalidSequence = true;
      sent = true;
    } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      if (terminal) invalidSequence = true;
      terminal = event.type;
      sent = true;
      if (event.type === 'turn.completed') {
        const tokens = record(event.usage);
        const input = integer(tokens?.input_tokens);
        const output = integer(tokens?.output_tokens);
        if (input !== undefined && input >= 0) usage.inputTokens = input;
        if (output !== undefined && output >= 0) usage.outputTokens = output;
      }
    }

    if (event.type === 'error' || event.type === 'turn.failed') {
      const report = event.type === 'error' ? event.message : record(event.error)?.message;
      providerErrorRef = publish({ ref, kind: 'provider_report', sourceId: attemptId, completeness: 'complete',
        value: { type: event.type, message: typeof report === 'string' ? report : undefined } }) ?? providerErrorRef;
    }
    if (event.type !== 'item.completed') continue;
    const item = record(event.item);
    if (terminal || typeof item?.id !== 'string' || !item.id.trim() || typeof item.type !== 'string') {
      invalidSequence = true;
      continue;
    }
    if (item.type === 'agent_message') {
      if (typeof item.text !== 'string') {
        invalidSequence = true;
        continue;
      }
      message = item.text;
      messageRef = publish({ ref, kind: 'model', sourceId: item.id, completeness: 'complete', value: message });
    } else if (item.type === 'error' && typeof item.message === 'string') {
      publish({ ref, kind: 'provider_report', sourceId: item.id, completeness: 'complete',
        value: { type: item.type, message: item.message } });
    } else if (item.type === 'command_execution') {
      const declined = item.status === 'declined';
      const exitCode = declined ? undefined : integer(item.exit_code);
      const evidence = publish({
        ref, kind: 'provider_tool', sourceId: item.id, completeness: 'complete', exitCode,
        value: {
          command: typeof item.command === 'string' ? item.command : undefined,
          output: typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined,
          status: typeof item.status === 'string' ? item.status : undefined,
        },
      });
      if (declined) permissionDiagnostics.push({ code: 'PERMISSION_DENIED', ref: evidence });
    }
  }

  /** @type {ReasonCode | undefined} */
  let code;
  if (!process.started) code = process.reason === 'cancelled' ? 'CANCELLED' : 'PROVIDER_START_FAILED';
  else if (process.reason === 'cancelled') code = 'CANCELLED';
  else if (process.reason === 'timed_out') code = 'DEADLINE_EXCEEDED';
  else if (process.exitCode !== 0 || Object.keys(process.errors).length || terminal === 'turn.failed') code = 'PROVIDER_DISCONNECTED';
  else if (invalidSequence || diagnostics.some(item => item.code === 'PROTOCOL_ERROR') ||
    terminal !== 'turn.completed' || message === undefined) code = 'PROTOCOL_ERROR';

  if (code || diagnostics.length) {
    for (const [stream, output] of /** @type {const} */ ([['stdout', stdout], ['stderr', stderr]])) {
      if (output.bytes.length === 0 || (stream === 'stdout' && !code)) continue;
      const partial = output.truncated || process.errors[stream] !== undefined ||
        (stream === 'stdout' && diagnostics.some(item => item.reason === 'INCOMPLETE_FRAME'));
      publish({ ref: 'codex-' + stream, kind: 'provider_report', sourceId: attemptId,
        completeness: partial ? 'truncated' : 'complete',
        value: { text: output.bytes.toString('utf8'), receivedBytes: output.receivedBytes } });
    }
  }

  const processRef = publish({
    ref: 'codex-process', sourceId: attemptId, completeness: 'complete',
    ...(process.exitCode === null ? { kind: 'host_transport' } : { kind: 'agent_exit', exitCode: process.exitCode }),
    value: {
      started: process.started, reason: process.reason, signal: process.signal, errors: process.errors,
      diagnostics, invalidSequence, turn: terminal ?? null,
    },
  });

  if (!process.started && code) {
    const unstarted = unstartedCodexResult(attemptId, code);
    return { ...unstarted, outcome: { ...unstarted.outcome, outputRefs,
      diagnostics: [{ code, ref: processRef }] } };
  }
  const outcomeStatus = !code ? 'completed' : terminal === 'turn.failed' && !invalidSequence ? 'failed' : 'unknown';
  return {
    dispatchCertainty: sent ? 'sent' : 'unknown',
    outcome: {
      schemaVersion: 1, attemptId, terminal: outcomeStatus, effect: 'unknown',
      diagnostics: code ? [{ code, ref: providerErrorRef ?? processRef }, ...permissionDiagnostics] : permissionDiagnostics,
      outputRefs, usage,
    },
    ...(code || message === undefined ? { output: undefined } : kind === 'controller' ? parseDecisionText(message) : { output: message }),
    ...(!code && messageRef ? { outputObservationRef: messageRef } : {}),
  };
}
