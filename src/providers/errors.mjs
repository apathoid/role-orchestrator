import { CANCELLATION_REASONS, cancellationDetails } from '../cancellation.mjs';

export const PROVIDER_ERROR_CODES = Object.freeze([
  'AUTH_ERROR', 'RATE_LIMIT', 'MODEL_UNAVAILABLE', 'CAPABILITY_UNSUPPORTED',
  'CONTEXT_LIMIT', 'PROVIDER_CRASH', 'WORKSPACE_UNSTABLE', 'TIMEOUT', 'CANCELLED', 'INVALID_REQUEST',
]);

const TIMEOUT_KINDS = new Set(['idle', 'deadline', 'preflight', 'invocation_deadline', 'session_close']);

export class AgentProviderError extends Error {
  constructor(code, message, { provider = null, retryable = false, cause = null, diagnostics = null, timeoutKind = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AgentProviderError';
    this.code = code;
    this.provider = provider;
    this.retryable = retryable;
    this.diagnostics = diagnostics;
    this.origin = typeof diagnostics?.source === 'string' ? diagnostics.source : 'provider';
    this.expected = diagnostics?.expected === true;
    this.timeoutKind = TIMEOUT_KINDS.has(timeoutKind) ? timeoutKind :
      TIMEOUT_KINDS.has(diagnostics?.innerAcp?.localTimeout?.kind) ? diagnostics.innerAcp.localTimeout.kind : null;
  }
}

export function normalizeProviderError(error, provider) {
  if (error instanceof AgentProviderError) return error;
  if (error?.name === 'AbortError') {
    const cancellation = cancellationDetails(error);
    return new AgentProviderError('CANCELLED', error.message || 'Operation cancelled.', {
      provider,
      cause: error,
      diagnostics: cancellation
        ? { ...cancellation.diagnostics, reason: cancellation.reason, source: cancellation.source, expected: cancellation.expected }
        : { reason: CANCELLATION_REASONS.ORCHESTRATOR_CANCELLED, source: 'orchestrator', expected: true },
    });
  }
  if (error?.code === 'CAPABILITY_UNSUPPORTED') return new AgentProviderError('CAPABILITY_UNSUPPORTED', error.message, { provider, cause: error });
  const text = String(error?.message ?? error ?? 'Provider failed.');
  if (/rate.?limit|too many requests|429/i.test(text)) return new AgentProviderError('RATE_LIMIT', text, { provider, retryable: true, cause: error });
  if (/context.*(limit|length)|too many tokens/i.test(text)) return new AgentProviderError('CONTEXT_LIMIT', text, { provider, cause: error });
  if (/model.*(not found|unavailable|not enabled|unsupported)/i.test(text)) return new AgentProviderError('MODEL_UNAVAILABLE', text, { provider, cause: error });
  if (/auth|login|credential|unauthori[sz]ed|forbidden/i.test(text)) return new AgentProviderError('AUTH_ERROR', text, { provider, cause: error });
  if (error?.code === 'ACP_INVOCATION_TIMEOUT' || TIMEOUT_KINDS.has(error?.timeoutKind) ||
    /timed? out|timeout|turn deadline/i.test(text)) return new AgentProviderError('TIMEOUT', text, { provider, retryable: true, cause: error, diagnostics: error?.diagnostics ?? null, timeoutKind: error?.timeoutKind });
  return new AgentProviderError('PROVIDER_CRASH', text, { provider, cause: error });
}

export function providerCancelledError({ provider, profileName, role, innerSessionId = null, elapsedMs = null, diagnostics = null } = {}) {
  const elapsed = Number.isFinite(elapsedMs) ? ` after ${(elapsedMs / 1000).toFixed(1)}s` : '';
  return new AgentProviderError(
    'CANCELLED',
    `Inner provider returned stopReason=cancelled${elapsed} while the outer orchestration remained active.`,
    {
      provider,
      retryable: true,
      diagnostics: {
        reason: CANCELLATION_REASONS.PROVIDER_CANCELLED,
        source: 'provider',
        expected: false,
        providerStopReason: 'cancelled',
        outerSignalAborted: false,
        ...(profileName ? { profileName } : {}),
        ...(role ? { role } : {}),
        ...(innerSessionId ? { innerSessionId } : {}),
        ...(Number.isFinite(elapsedMs) ? { elapsedMs } : {}),
        ...(diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics) ? { innerAcp: diagnostics } : {}),
      },
    },
  );
}
