export const CANCELLATION_REASONS = Object.freeze({
  CLIENT_REQUEST_CANCELLED: 'CLIENT_REQUEST_CANCELLED',
  SESSION_CANCELLED: 'SESSION_CANCELLED',
  SUPERSEDED_BY_NEW_TURN: 'SUPERSEDED_BY_NEW_TURN',
  ORCHESTRATOR_CANCELLED: 'ORCHESTRATOR_CANCELLED',
  PROVIDER_CANCELLED: 'PROVIDER_CANCELLED',
});

const DEFAULT_MESSAGES = Object.freeze({
  [CANCELLATION_REASONS.CLIENT_REQUEST_CANCELLED]: 'The outer ACP prompt request was cancelled by the client.',
  [CANCELLATION_REASONS.SESSION_CANCELLED]: 'The client sent agent.session.cancel for the current session.',
  [CANCELLATION_REASONS.SUPERSEDED_BY_NEW_TURN]: 'A newer prompt started in the same session while this task was still running.',
  [CANCELLATION_REASONS.ORCHESTRATOR_CANCELLED]: 'The orchestration run was cancelled.',
  [CANCELLATION_REASONS.PROVIDER_CANCELLED]: 'The inner provider cancelled its turn while the outer orchestration remained active.',
});

function cleanDiagnostics(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function cancellationMessage(reason, message = null) {
  const detail = String(message ?? DEFAULT_MESSAGES[reason] ?? DEFAULT_MESSAGES[CANCELLATION_REASONS.ORCHESTRATOR_CANCELLED]).trim();
  return detail.startsWith(`[${reason}]`) ? detail : `[${reason}] ${detail}`;
}

export class OrchestrationAbortError extends Error {
  constructor(reason = CANCELLATION_REASONS.ORCHESTRATOR_CANCELLED, message = null, {
    source = 'orchestrator', expected = true, diagnostics = null, cause = null,
  } = {}) {
    super(cancellationMessage(reason, message), cause ? { cause } : undefined);
    this.name = 'AbortError';
    this.code = 'CANCELLED';
    this.cancellationReason = reason;
    this.cancellationSource = source;
    this.expected = expected;
    this.diagnostics = {
      reason,
      source,
      expected,
      ...cleanDiagnostics(diagnostics),
    };
  }
}

export function createCancellationError(reason, options = {}) {
  return new OrchestrationAbortError(reason, options.message ?? null, options);
}

export function abortWithReason(controller, reason, options = {}) {
  if (!controller || controller.signal?.aborted) return false;
  controller.abort(createCancellationError(reason, options));
  return true;
}

export function cancellationDetails(error) {
  if (!error || typeof error !== 'object') return null;
  const diagnostics = cleanDiagnostics(error.diagnostics);
  const reason = error.cancellationReason ?? diagnostics.reason ?? null;
  const source = error.cancellationSource ?? diagnostics.source ?? null;
  const expected = typeof error.expected === 'boolean'
    ? error.expected
    : typeof diagnostics.expected === 'boolean'
      ? diagnostics.expected
      : error.name === 'AbortError';
  if (error.name !== 'AbortError' && error.code !== 'CANCELLED' && !reason) return null;
  return { reason, source, expected, diagnostics };
}

export function isCancellationError(error) {
  return cancellationDetails(error) !== null;
}

export function isExpectedCancellation(error) {
  return cancellationDetails(error)?.expected === true;
}

export function cancellationErrorFromSignal(signal, {
  fallbackReason = CANCELLATION_REASONS.ORCHESTRATOR_CANCELLED,
  source = 'orchestrator',
  message = null,
  diagnostics = null,
} = {}) {
  const reason = signal?.reason;
  if (reason instanceof Error && cancellationDetails(reason)?.reason) return reason;
  return createCancellationError(fallbackReason, {
    source,
    expected: true,
    message,
    diagnostics: {
      ...cleanDiagnostics(diagnostics),
      ...(reason === undefined ? {} : { upstreamAbortReasonType: reason?.constructor?.name ?? typeof reason }),
    },
    ...(reason instanceof Error ? { cause: reason } : {}),
  });
}

export function throwIfAborted(signal, options = {}) {
  if (signal?.aborted) throw cancellationErrorFromSignal(signal, options);
}

export function cancellationUserMessage(error) {
  const details = cancellationDetails(error);
  if (!details) return 'Task cancelled.';
  const reason = details.reason ?? CANCELLATION_REASONS.ORCHESTRATOR_CANCELLED;
  const raw = String(error?.message ?? '').replace(new RegExp(`^\\[${reason}\\]\\s*`), '').trim();
  const detail = raw || DEFAULT_MESSAGES[reason] || DEFAULT_MESSAGES[CANCELLATION_REASONS.ORCHESTRATOR_CANCELLED];
  return `Task cancelled [${reason}] — ${detail}`;
}

export function diagnosticCode(error) {
  const cancellation = cancellationDetails(error);
  if (cancellation?.reason) return cancellation.reason;
  return typeof error?.code === 'string' && error.code ? error.code : null;
}

export function diagnosticErrorMessage(error) {
  const message = String(error?.message ?? error ?? 'Unknown error');
  const code = diagnosticCode(error);
  if (!code || message.startsWith(`[${code}]`)) return message;
  return `[${code}] ${message}`;
}
