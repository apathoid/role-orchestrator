import { randomUUID } from 'node:crypto';
import { journalReasonCode, pendingControllerReasoning, resourceSnapshot } from '../core/operation.js';
import { redactDiagnostic } from '../application/redact-diagnostic.js';

/** @import {Operation} from '../core/operation.js' */
/** @typedef {ReturnType<typeof import('../application/orchestrator.js').createOrchestrator>} Coordinator */
/** @typedef {Pick<Coordinator, 'submit' | 'resume' | 'inspect' | 'cancel'> & {configurationRef: string, trace?: (operationId: string) => Promise<ReturnType<typeof operationTrace>>}} HostApi */
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
  if (action === 'trace' || action === 'export-diagnostics') {
    // The runtime owns the trusted secret values. A synthetic HostApi may
    // still use the conservatively redacted, secret-unaware projection.
    return api.trace ? api.trace(operationId) : operationTrace(await api.inspect(operationId));
  }
  return api.inspect(operationId);
}

/** @param {Operation} operation @param {{secrets?: readonly string[]}} [redaction] */
export function operationTrace(operation, redaction = {}) {
  const limit = 256;
  const { events, operationId, revision } = operation;
  const start = Math.max(0, events.length - limit);
  const missing = [
    'model content', 'tool bodies', 'transient diagnostics',
    ...(start ? ['earlier journal events'] : []),
  ];
  const resources = resourceSnapshot(operation);
  const actionByAttempt = new Map(operation.attempts.map(attempt => [attempt.attemptId, attempt.actionId]));
  const decisions = new Map(events.flatMap(event => event.kind === 'controller.responded'
    ? [[event.decision.decisionId, event.decision]] : []));
  const actions = new Map(events.flatMap(event => event.kind === 'controller.responded'
    ? event.decision.additions.map(action => [action.actionId, action]) : []));
  /** @type {Map<string, import('../core/observation.js').Observation[]>} */
  const receipts = new Map();
  for (const event of events) {
    if (event.kind !== 'attempt.outcome') continue;
    const known = receipts.get(event.outcome.attemptId) ?? [];
    known.push(...(event.observations ?? []));
    receipts.set(event.outcome.attemptId, known);
  }
  const attemptStart = Math.max(0, operation.attempts.length - limit);
  const visibleAttempts = operation.attempts.slice(attemptStart);
  /** @param {Operation['attempts'][number]} attempt */
  function reasoningInfo(attempt) {
    const route = attempt.route;
    const selection = route?.reasoning;
    const controlling = attempt.reasoningDecisionId
      ? decisions.get(attempt.reasoningDecisionId)?.nextController : undefined;
    const requestedLevel = attempt.attemptId === attempt.actionId
      ? controlling?.reasoningLevel : actions.get(attempt.actionId)?.reasoningLevel;
    const acknowledged = (receipts.get(attempt.attemptId) ?? []).some(observation =>
      observation.providerRef === 'acp-reasoning-ack' &&
      observation.provenance?.kind === 'host_transport' &&
      observation.value && typeof observation.value === 'object' &&
      !Array.isArray(observation.value) &&
      'status' in observation.value && observation.value.status === 'config_option_confirmed');
    return {
      requestedLevel, source: selection?.mode === 'selectable' ? selection.selectionSource : undefined,
      effective: selection ?? 'not_recorded', configurationRef: route?.configurationRef,
      nativeConfigAcknowledgment: acknowledged ? 'adapter_confirmed' : 'not_recorded',
      submission: attempt.dispatchCertainty,
    };
  }
  const waiting = operation.waiting?.kind === 'technical'
    ? { kind: 'technical', code: operation.waiting.reason.code,
      attemptId: operation.waiting.reason.attemptId,
      actionId: operation.waiting.reason.actionId,
      dispatchCertainty: operation.waiting.reason.dispatchCertainty,
      effect: operation.waiting.reason.effect,
      profileId: operation.waiting.reason.profileId, reasoningLevel: operation.waiting.reason.reasoningLevel,
      availableLevels: operation.waiting.reason.availableLevels,
      reasoningCause: operation.waiting.reason.reasoningCause, resource: operation.waiting.reason.resource }
    : operation.waiting?.kind === 'question'
      ? { kind: 'question', questionId: operation.waiting.questionId } : undefined;
  const projection = {
    schemaVersion: 1, operationId, revision, source: 'operation-journal', redacted: true,
    manifest: { schemaVersion: 1, format: 'operation-journal-json-v1',
      origin: 'durable-state', transientDiagnosticsIncluded: false,
      missing, truncatedEvents: start, eventCount: events.length },
    status: operation.status, waiting, resources,
    controllerReasoning: { pending: pendingControllerReasoning(operation) ?? null,
      consumed: visibleAttempts.flatMap(attempt => attempt.reasoningDecisionId
        ? [{attemptId:attempt.attemptId, decisionId:attempt.reasoningDecisionId}] : []) },
    omittedAttempts: attemptStart,
    attempts: visibleAttempts.map(attempt => ({
      attemptId: attempt.attemptId, actionId: attempt.actionId, status: attempt.status,
      profileId: attempt.route?.profileId, providerId: attempt.route?.providerId,
      reasoning: reasoningInfo(attempt), dispatchCertainty: attempt.dispatchCertainty,
      effect: attempt.outcome?.effect ?? (attempt.status === 'dispatched' ? 'unknown' : undefined),
      terminal: attempt.outcome?.terminal,
      reasonCode: attempt.outcome?.diagnostics[0]?.code,
    })),
    omitted: missing, omittedEvents: start,
    events: events.slice(start).map((event, index) => {
      const attemptId = event.kind === 'attempt.outcome' ? event.outcome.attemptId :
        'attemptId' in event ? event.attemptId : undefined;
      return {
        sequence: start + index + 1, eventId: event.eventId, receivedAt: event.receivedAt,
        eventName: event.kind, reasonCode: journalReasonCode(event), attemptId,
        actionId: 'actionId' in event ? event.actionId : attemptId ? actionByAttempt.get(attemptId) : undefined,
        decisionId: event.kind === 'controller.responded' ? event.decision.decisionId :
          event.kind === 'controller.invalid_proposal' ? event.decisionId : undefined,
        ...(event.kind === 'controller.invalid_proposal' && {category:'contract', field: event.reason.path, expected: event.reason.expected}),
        ...((event.kind === 'action.rejected' || event.kind === 'action.deferred') &&
          {category: event.category, resource: event.resource}),
        source: event.kind === 'operation.cancelled' || event.kind === 'action.cancelled' ||
          event.kind === 'attempt.cancel_requested' ? event.source : undefined,
      };
    }),
  };
  // Every exported string (including model-chosen identifiers) passes through
  // the same known-secret projection as live events. Bodies stay excluded.
  return /** @type {typeof projection} */ (redactDiagnostic(projection, { secrets: redaction.secrets }));
}

/** @param {Operation} operation */
export function operationView(operation) {
  return {
    operationId: operation.operationId, status: operation.status, revision: operation.revision,
    pendingControllerReasoning: pendingControllerReasoning(operation) ?? null,
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
