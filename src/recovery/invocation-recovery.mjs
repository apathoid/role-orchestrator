// Provider- and workflow-independent bounded replay of one logical invocation.
// A retryable provider error does not imply the operation is safe to replay.
import { randomUUID } from 'node:crypto';
import { cancellationDetails, CANCELLATION_REASONS, throwIfAborted } from '../cancellation.mjs';

const SAFE_TOOL_KINDS = new Set(['read', 'search', 'think']);
const MAX_ATTEMPTS = 2;
const MAX_TRACKED_TOOLS = 2048;
const TOOL_UPDATES = new Set(['tool_call', 'tool_call_update', 'tool_call_content_chunk']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function replayAuthorized({ replaySafety, sandboxMode, presentToUser, mcpServers, promptBlocks } = {}) {
  // This must be checked at the common engine boundary, even if the workflow
  // caller has already evaluated the same constraints. Never trust a policy
  // label in place of the actual invocation permissions.
  return replaySafety === 'verified-read-only' && sandboxMode === 'read-only' &&
    presentToUser !== true && (mcpServers === undefined || (Array.isArray(mcpServers) && mcpServers.length === 0)) &&
    (promptBlocks === undefined || (Array.isArray(promptBlocks) && !promptBlocks.some(b => b?.type === 'resource_link')));
}

export function recoveryEligibility(error, { signal, replaySafety, sandboxMode, presentToUser, mcpServers, promptBlocks, observedUnsafeTool = false } = {}) {
  if (signal?.aborted) return 'outer_cancelled';
  const details = cancellationDetails(error);
  if (details?.reason !== CANCELLATION_REASONS.PROVIDER_CANCELLED ||
      details.source !== 'provider' || details.expected !== false || error?.retryable === false)
    return 'not_provider_cancellation';
  if (Number(details.diagnostics?.innerAcp?.outgoingCancelCount ?? details.diagnostics?.outgoingCancelCount ?? 0) > 0) return 'inner_cancel_sent';
  if (!replayAuthorized({ replaySafety, sandboxMode, presentToUser, mcpServers, promptBlocks }))
    return 'replay_not_authorized';
  if (observedUnsafeTool) return 'tool_effects_unknown';
  return null;
}

// Compatibility for callers inspecting a single self-contained observation.
// Partial ACP updates need the stateful observer below instead.
export function safeToolEvent(event) {
  if (event?.type === 'role_native_update') return false;
  if (event?.type !== 'role_tool_event') return true;
  const observation = event.toolObservation;
  const kind = observation && own(observation, 'kind') ? observation.kind : event.update?.kind;
  return SAFE_TOOL_KINDS.has(kind);
}

/** Tracks ACP tool kinds by tool ID within ONE attempt; never persists IDs. */
export function createReplayEffectObserver() {
  const toolKinds = new Map();
  let unsafe = false;
  function observe(event) {
    if (unsafe) return false;
    if (event?.type === 'role_native_update') {
      // Every role_native_update is a native data-plane event forwarded to the
      // host. Unknown future update types may contain user-facing content.
      unsafe = true;
    } else if (event?.type === 'role_tool_event') {
      const update = event.update;
      const observation = event.toolObservation;
      if (update && (!TOOL_UPDATES.has(update.sessionUpdate) ||
          (observation && typeof observation === 'object' &&
            (typeof update.toolCallId !== 'string' || observation.toolId !== update.toolCallId)))) {
        unsafe = true;
      } else if (observation !== null && observation !== undefined &&
          (typeof observation !== 'object' || Array.isArray(observation) ||
            (observation.type !== 'tool_observation' && (update || observation.type !== undefined)))) {
        unsafe = true;
      } else {
        const id = observation?.toolId ?? update?.toolCallId;
        const hasKind = observation ? own(observation, 'kind') : own(update ?? {}, 'kind');
        // A declared raw kind must not silently disappear from its normalized
        // observation. Never reinterpret a conflicting update as a safe patch.
        if (observation && update && own(update, 'kind') &&
            (!hasKind || observation.kind !== update.kind)) unsafe = true;
        const kind = observation && hasKind ? observation.kind : update?.kind;
        if (id === undefined || id === null) {
          // In-process fake/legacy providers can send a complete kind-only event.
          // Partial updates without an ID cannot inherit classifications.
          if (!hasKind || !SAFE_TOOL_KINDS.has(kind)) unsafe = true;
        } else if (typeof id !== 'string' || !id || id.length > 256) {
          unsafe = true;
        } else {
          const previous = toolKinds.get(id);
          if (hasKind) {
            if (!SAFE_TOOL_KINDS.has(kind) || (previous && previous !== kind)) unsafe = true;
            else if (!previous && toolKinds.size >= MAX_TRACKED_TOOLS) unsafe = true;
            else toolKinds.set(id, kind);
          } else if (!previous) {
            unsafe = true;
          }
        }
      }
    }
    return !unsafe;
  }
  return { observe, get safeToReplay() { return !unsafe; } };
}

function attachRecovery(error, recovery) {
  if (error && typeof error === 'object') {
    try { error.recovery = recovery; } catch { /* frozen provider error */ }
  }
}

/**
 * Each attempt owns a fresh inner provider session. The caller supplies a
 * checkout/protected-path witness, not permission to mutate/restore files.
 * Recovery events are best-effort observability/presentation: their delivery
 * must never change the outcome of an otherwise successful role invocation.
 */
export async function invokeWithRecovery({ invoke, role = null, options = {}, checkWorkspace, emit = async () => {}, maxAttempts = MAX_ATTEMPTS, replaySafety = 'none' }) {
  const operationId = randomUUID();
  let recoveryStartedAt = null;
  let startedAttempts = 0;
  const attempts = Math.max(1, Math.min(MAX_ATTEMPTS, Math.trunc(maxAttempts) || 1));
  const reporter = options.reporter;
  const safeEmit = async (event) => {
    try { await emit(event); } catch { /* Recovery telemetry/presentation is non-authoritative. */ }
  };
  const elapsed = () => recoveryStartedAt === null ? 0 : Math.max(0, Math.floor(performance.now() - recoveryStartedAt));
  const markOuterCancelled = async () => {
    if (recoveryStartedAt !== null) await safeEmit({ type: 'invocation_recovery_cancelled', operationId,
      attempt: startedAttempts, attempts, reason: 'outer_cancelled', recoveryElapsedMs: elapsed() });
  };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { throwIfAborted(options.signal); }
    catch (error) { await markOuterCancelled(); throw error; }
    const effects = createReplayEffectObserver();
    const report = async (event) => {
      effects.observe(event);
      await reporter?.(event);
    };
    const scope = { ...options.executionScope, operationId, attempt,
      ...(attempt > 1 ? { retryReason: 'unexpected_provider_cancellation' } : {}) };
    let value;
    try {
      // Invoke BEFORE reporting that a retry has started. The provider call is
      // initiated synchronously, so an abort while reporting cannot create a
      // phantom retry. Events do not participate in this try/catch.
      const inFlight = Promise.resolve(invoke({ ...options, reporter: report, executionScope: scope }));
      // Attach a rejection handler immediately: a slow event sink must not
      // trigger an unhandled rejection while the started event is delivered.
      void inFlight.catch(() => {});
      startedAttempts = attempt;
      if (attempt > 1) await safeEmit({ type: 'invocation_retry_started', operationId,
        attempt, attempts, reason: 'unexpected_provider_cancellation' });
      value = await inFlight;
    } catch (error) {
      const reason = recoveryEligibility(error, { ...options, replaySafety, observedUnsafeTool: !effects.safeToReplay });
      if (reason === 'outer_cancelled') {
        attachRecovery(error, { operationId, role, attempts: startedAttempts, reason });
        await markOuterCancelled();
        throw error;
      }
      if (reason !== null || attempt >= attempts) {
        const finalReason = reason ?? 'attempts_exhausted';
        if (attempt > 1 || cancellationDetails(error)?.reason === CANCELLATION_REASONS.PROVIDER_CANCELLED)
          attachRecovery(error, { operationId, role, attempts: startedAttempts, reason: finalReason });
        if (attempt > 1) await safeEmit({ type: 'invocation_recovery_exhausted', operationId,
          attempt, attempts, reason: finalReason, recoveryElapsedMs: elapsed() });
        else if (cancellationDetails(error)?.reason === CANCELLATION_REASONS.PROVIDER_CANCELLED ||
                 (error?.retryable === true && error?.code !== 'CANCELLED'))
          await safeEmit({ type: 'invocation_retry_skipped', operationId, attempt, attempts, reason: finalReason });
        throw error;
      }
      // A missing/failed Git witness cannot authorize a new provider session.
      let stable = false;
      try { stable = (await checkWorkspace?.()) === true; } catch { /* fail closed */ }
      if (options.signal?.aborted) {
        await markOuterCancelled();
        throwIfAborted(options.signal);
      }
      if (!stable) {
        await safeEmit({ type: 'invocation_retry_skipped', operationId, attempt, attempts, reason: 'workspace_changed' });
        attachRecovery(error, { operationId, role, attempts: startedAttempts, reason: 'workspace_changed' });
        throw error;
      }
      if (options.signal?.aborted) {
        await markOuterCancelled();
        throwIfAborted(options.signal);
      }
      recoveryStartedAt = performance.now();
      await safeEmit({ type: 'invocation_retry_scheduled', operationId, attempt: attempt + 1, attempts,
        reason: 'unexpected_provider_cancellation' });
      continue;
    }
    if (attempt > 1) await safeEmit({ type: 'invocation_recovered', operationId, attempt, attempts,
      recoveryElapsedMs: elapsed(), reason: 'unexpected_provider_cancellation' });
    return value;
  }
}
