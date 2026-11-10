import { randomUUID } from 'node:crypto';
import { resourceSnapshot } from '../core/operation.js';

/** @import {Operation} from '../core/operation.js' */
/** @typedef {ReturnType<typeof import('../application/orchestrator.js').createOrchestrator>} Coordinator */
/** @typedef {Pick<Coordinator, 'submit' | 'resume' | 'inspect' | 'cancel'> & {configurationRef: string}} HostApi */
/** @typedef {{
 *   action: 'run' | 'resume' | 'inspect' | 'cancel' | 'trace' | 'export-diagnostics' | 'diagnose',
 *   requestId: string, operationId?: string, text?: string, cwd?: string, questionId?: string, cancellationSource?: 'client'
 * }} Command */

export class HostError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {HostApi} api @param {Command} command @param {(id: string) => void} [accepted] */
export async function dispatchCommand(api, command, accepted) {
  const { action, operationId, requestId, text, cwd, questionId, cancellationSource } = command;
  if (action === 'run') {
    if (!text?.trim()) throw new HostError('INVALID_ARGUMENT', 'A nonempty request is required');
    const submission = await api.submit({
      schemaVersion: 1, requestId, text, attachments: [], userConstraints: [],
      configurationRef: api.configurationRef, ...(cwd && { workspaceContext: { cwd } }),
    });
    accepted?.(submission.operation.operationId);
    return submission.completion;
  }
  if (!operationId) throw new HostError('INVALID_ARGUMENT', 'An operation id is required');
  if (action === 'resume') {
    if (text !== undefined && !text.trim()) throw new HostError('INVALID_ARGUMENT', 'Follow-up text is empty');
    const submission = await api.resume(operationId, text === undefined ? undefined : { requestId, text, questionId });
    accepted?.(submission.operation.operationId);
    return submission.completion;
  }
  if (action === 'cancel') return api.cancel(operationId, cancellationSource);
  const operation = await api.inspect(operationId);
  return action === 'trace' || action === 'export-diagnostics' ? operationTrace(operation) : operation;
}

/** @param {Operation} operation */
export function operationTrace(operation) {
  const limit = 256;
  const { events, operationId, revision } = operation;
  const start = Math.max(0, events.length - limit);
  const missing = [
    'model content', 'tool bodies', 'transient diagnostics',
    ...(start ? ['earlier journal events'] : []),
  ];
  const resources = resourceSnapshot(operation);
  const waiting = operation.waiting?.kind === 'technical'
    ? { kind: 'technical', code: operation.waiting.reason.code,
      attemptId: operation.waiting.reason.attemptId,
      actionId: operation.waiting.reason.actionId,
      dispatchCertainty: operation.waiting.reason.dispatchCertainty,
      effect: operation.waiting.reason.effect }
    : operation.waiting?.kind === 'question'
      ? { kind: 'question', questionId: operation.waiting.questionId } : undefined;
  return {
    schemaVersion: 1, operationId, revision, source: 'operation-journal', redacted: true,
    manifest: { schemaVersion: 1, format: 'operation-journal-json-v1',
      origin: 'durable-state', transientDiagnosticsIncluded: false,
      missing, truncatedEvents: start, eventCount: events.length },
    status: operation.status, waiting, resources,
    attempts: operation.attempts.map(attempt => ({
      attemptId: attempt.attemptId, actionId: attempt.actionId, status: attempt.status,
      profileId: attempt.route?.profileId, providerId: attempt.route?.providerId,
      dispatchCertainty: attempt.dispatchCertainty,
      effect: attempt.outcome?.effect ?? (attempt.status === 'dispatched' ? 'unknown' : undefined),
      terminal: attempt.outcome?.terminal,
      reasonCode: attempt.outcome?.diagnostics[0]?.code,
    })),
    omitted: missing, omittedEvents: start,
    events: events.slice(start).map((event, index) => ({
      sequence: start + index + 1, receivedAt: event.receivedAt, eventName: event.kind,
      attemptId: event.kind === 'attempt.outcome' ? event.outcome.attemptId : 'attemptId' in event ? event.attemptId : undefined,
      actionId: 'actionId' in event ? event.actionId : undefined,
      reasonCode: 'code' in event ? event.code : event.kind === 'operation.waiting' && event.waiting.kind === 'technical'
        ? event.waiting.reason.code : event.kind === 'attempt.outcome' ? event.outcome.diagnostics[0]?.code : undefined,
      source: event.kind === 'operation.cancelled' || event.kind === 'action.cancelled' ? event.source : undefined,
    })),
  };
}

/** @param {Operation} operation */
export function operationView(operation) {
  return {
    operationId: operation.operationId, status: operation.status, revision: operation.revision,
    waiting: operation.waiting, cancellation: operation.cancellation, assessment: operation.assessment,
    resources: resourceSnapshot(operation), attempts: operation.attempts.map(attempt => ({
      attemptId: attempt.attemptId, actionId: attempt.actionId, status: attempt.status, route: attempt.route,
      dispatchCertainty: attempt.dispatchCertainty, terminal: attempt.outcome?.terminal,
      effect: attempt.outcome?.effect ?? (attempt.status === 'dispatched' ? 'unknown' : undefined),
      diagnostics: attempt.outcome?.diagnostics, cancellation: attempt.cancellation,
    })),
    pendingDependencies: operation.events.flatMap(event => event.kind === 'controller.responded'
      ? (event.admissions ?? []).flatMap(item => item.kind === 'accepted' && item.action.dependsOn.length &&
        !operation.attempts.some(attempt => attempt.actionId === item.action.actionId)
        ? [{ actionId: item.action.actionId, dependsOn: item.action.dependsOn }] : []) : []),
  };
}

/** @param {unknown} error */
export function hostError(error) {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: error.message,
      path: 'path' in error && typeof error.path === 'string' ? error.path : undefined };
  }
  return { code: 'HOST_FAILURE', message: 'Host operation failed' };
}

export const newRequestId = randomUUID;
