import assert from 'node:assert/strict';
import {
  CANCELLATION_REASONS,
  abortWithReason,
  cancellationDetails,
  cancellationErrorFromSignal,
  cancellationUserMessage,
  diagnosticErrorMessage,
  isExpectedCancellation,
} from '../src/cancellation.mjs';
import { normalizeProviderError, providerCancelledError } from '../src/providers/errors.mjs';
import { execFileSafe } from '../src/repo.mjs';

const controller = new AbortController();
assert.equal(abortWithReason(
  controller,
  CANCELLATION_REASONS.SUPERSEDED_BY_NEW_TURN,
  { source: 'outer_session', diagnostics: { sessionId: 's1' } },
), true);
assert.equal(abortWithReason(controller, CANCELLATION_REASONS.SESSION_CANCELLED), false, 'first abort reason must remain authoritative');

const signalError = cancellationErrorFromSignal(controller.signal);
assert.equal(signalError.name, 'AbortError');
assert.equal(signalError.cancellationReason, CANCELLATION_REASONS.SUPERSEDED_BY_NEW_TURN);
assert.equal(cancellationDetails(signalError)?.source, 'outer_session');
assert.equal(isExpectedCancellation(signalError), true);
assert.match(cancellationUserMessage(signalError), /SUPERSEDED_BY_NEW_TURN/);

const normalized = normalizeProviderError(signalError, 'subscription');
assert.equal(normalized.code, 'CANCELLED');
assert.equal(normalized.diagnostics?.reason, CANCELLATION_REASONS.SUPERSEDED_BY_NEW_TURN);
assert.equal(normalized.diagnostics?.expected, true);
assert.equal(isExpectedCancellation(normalized), true, 'provider normalization must preserve expected cancellation provenance');

const providerCancelled = providerCancelledError({
  provider: 'subscription',
  profileName: 'strong',
  role: 'reviewerMedium',
  innerSessionId: 'inner-1',
  elapsedMs: 12_345,
});
assert.equal(providerCancelled.code, 'CANCELLED');
assert.equal(providerCancelled.retryable, true);
assert.equal(providerCancelled.diagnostics?.reason, CANCELLATION_REASONS.PROVIDER_CANCELLED);
assert.equal(providerCancelled.diagnostics?.source, 'provider');
assert.equal(providerCancelled.diagnostics?.expected, false);
assert.equal(providerCancelled.diagnostics?.providerStopReason, 'cancelled');
assert.equal(providerCancelled.diagnostics?.outerSignalAborted, false);
assert.equal(isExpectedCancellation(providerCancelled), false);
assert.match(diagnosticErrorMessage(providerCancelled), /^\[PROVIDER_CANCELLED\]/);
assert.match(diagnosticErrorMessage(providerCancelled), /reviewerMedium|outer orchestration/i);

const processController = new AbortController();
const processRun = execFileSafe(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], {
  timeoutMs: 5_000,
  signal: processController.signal,
});
setTimeout(() => abortWithReason(
  processController,
  CANCELLATION_REASONS.SESSION_CANCELLED,
  { source: 'session_cancel', diagnostics: { sessionId: 's2' } },
), 20);
await assert.rejects(processRun, (error) => {
  assert.equal(error.cancellationReason, CANCELLATION_REASONS.SESSION_CANCELLED);
  assert.equal(error.cancellationSource, 'session_cancel');
  return true;
});

console.log('cancellation: passed');
