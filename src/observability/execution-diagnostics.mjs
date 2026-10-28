// Stable and deliberately small diagnostic taxonomy. This classification is
// derived from typed errors, never by asking a model to reinterpret failures.
const SPECS = Object.freeze({
  WORKSPACE_UNSTABLE: {
    origin: 'workspace', severity: 'warning', retryable: true,
    summary: 'The checkout changed repeatedly while read-only results were being reconciled.',
    nextAction: 'Review the current Git state and retry when the repository is stable. Saved changes were not discarded.',
  },
  CLIENT_REQUEST_CANCELLED: { origin: 'workflow', severity: 'info', retryable: true,
    summary: 'The client cancelled the operation.', nextAction: 'Resume explicitly if needed.' },
  SUPERSEDED_BY_NEW_TURN: { origin: 'workflow', severity: 'info', retryable: true,
    summary: 'A newer request superseded this execution.', nextAction: 'Check the new execution before resuming.' },
  PROVIDER_CANCELLED: { origin: 'provider', severity: 'warning', retryable: true,
    summary: 'The inner provider cancelled an active invocation.', nextAction: 'Inspect provider diagnostics and retry if appropriate.' },
  TIMEOUT: { origin: 'provider', severity: 'warning', retryable: true,
    summary: 'An invocation exceeded its configured activity/deadline policy.', nextAction: 'Inspect timing diagnostics before retrying.' },
  RATE_LIMIT: { origin: 'provider', severity: 'warning', retryable: true,
    summary: 'A provider rate limit was reached.', nextAction: 'Retry after the provider allows more requests.' },
  PROVIDER_CRASH: { origin: 'provider', severity: 'error', retryable: false,
    summary: 'A provider invocation failed.', nextAction: 'Inspect the provider error before retrying.' },
  SESSION_PERSISTENCE_ERROR: { origin: 'persistence', severity: 'error', retryable: false,
    summary: 'The session could not be durably saved.', nextAction: 'Inspect the state directory and preserve workspace changes.' },
  EXECUTION_FAILED: { origin: 'workflow', severity: 'error', retryable: false,
    summary: 'Execution stopped before producing a verified result.', nextAction: 'Inspect the execution trace and saved checkpoint.' },
});

export function executionFailureDiagnostic(error, { cancelled = false } = {}) {
  let code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,72}$/.test(error.code) ? error.code : null;
  const reason = typeof error?.cancellationReason === 'string' ? error.cancellationReason :
    typeof error?.diagnostics?.reason === 'string' ? error.diagnostics.reason : null;
  if (cancelled) code = reason && /^[A-Z][A-Z0-9_]{1,72}$/.test(reason) ? reason : 'CLIENT_REQUEST_CANCELLED';
  else if (code === 'CANCELLED' && reason === 'PROVIDER_CANCELLED') code = reason;
  code ??= 'EXECUTION_FAILED';
  const spec = SPECS[code] ?? (error?.provider ? SPECS.PROVIDER_CRASH : SPECS.EXECUTION_FAILED);
  return { code, ...spec, reason };
}
