# Invocation recovery contract

## Scope and architecture

A skill (including a skill invoked with `/review-code`) supplies context and instructions; it never controls retry. `workflow.mjs` uses the same `call()` wrapper for every role, mode, and skill. That wrapper captures the source-checkout and protected-path witnesses and invokes the provider via `invokeWithRecovery()` in `src/recovery/invocation-recovery.mjs`.

There are **two independent decisions**:

1. **Error retryability:** only an unexpected provider-origin `PROVIDER_CANCELLED` is considered by this initial policy. Outer cancellation, local timeouts, rate limits, other errors and outbound `session/cancel` messages do not authorize an automatic replay.
2. **Operation replay safety:** the role invocation must be `sandboxMode: 'read-only'`, not publish the final user-facing answer, not expose MCP servers or resource links, use only observed `read/search/think` tool kinds, and preserve the initial checkout/protected-path fingerprints. Partial tool updates with a known `toolCallId` inherit the earlier safe kind; an unknown initial kind, explicit kind removal/change, malformed ID, or unknown event is unsafe. Native data-plane updates (including unknown future types) are treated as potentially published user content and block replay. The provider must supply a new invocation-scoped session for the next attempt.

The wrapper allows **at most two attempts total**; only the failed logical invocation is repeated. The original failure is retained as an observed event. The engine never retries coders or verification commands, restores files, overwrites editor changes, silently re-runs a whole pipeline, or switches models. When a retry is rejected or exhausted, the owning workflow applies its existing incomplete/checkpoint behavior.

A read-only sandbox does **not** prove that all external effects are impossible. Therefore external tool access and unknown kinds block automatic replay, rather than being guessed safe. Missing Git baseline also forbids replay. Native answer chunks already published through ACP prevent replay, including when `presentToUser` is false.

## ACP error precedence

Codex ACP now gives a typed non-warning structured `sessionFailure` precedence over provider `stopReason=cancelled` unless an authoritative *local* timeout caused cancellation. Generic ACP keeps its provider-neutral cancellation/timing classification. Structured `AgentProviderError` carries `origin`, `expected`, and `timeoutKind` when available; recovery decisions use canonical cancellation provenance, never parsing error-message text.

No automatic backoff for `RATE_LIMIT`, no fallback to another provider and no background session resumption are introduced.

## Trace and efficiency

Events: `invocation_retry_scheduled`, `invocation_retry_started`, `invocation_retry_skipped`, `invocation_recovered`, `invocation_recovery_exhausted`, `invocation_recovery_cancelled`. Events include a bounded opaque `operationId`, `attempt`, `attempts`, and an enumerated reason. `role_start` events carry the same `executionScope.operationId` on each attempt while retaining their unique `invocationId`.

P3 counters: `retries` (actual retry launches), `recoveredOperations`, `exhaustedOperations`, `retrySuppressed`, `recoveryElapsedMs`. All are allowlisted in persisted session statistics, with zero defaults for historical v1 entries. A persisted role error also has an optional bounded ACP diagnostic projection: update count, last known update type, milliseconds since last activity, number of outbound cancel requests, and their fixed-category reasons/status. No prompt, tool argument/output, inner session ID, file path, or arbitrary upstream error text enters trace. The original native ACP stream is unchanged.

Standalone review workflows now persist verified Review Units in checkpoint v2 (see `docs/REVIEW-WORK-UNITS.md`), rather than relying on ordinal batch completion. If no review batch completes, `review.verdict` is `unknown`, **not** `pass`. Aggregated P3 outcomes cannot show `pass` while review coverage is incomplete.

## Tests and limitations

- `node test/invocation-recovery.mjs`: successful retry, correlation, denied replay, drift, outbound cancellation, exhaustion, telemetry privacy and counters.
- `node test/workflow-unstructured.mjs`: ordinary standalone review, interrupted reviews, change workflow review checkpoint/resume, verification and implementation isolation.
- `node test/evaluation/execution-observability.mjs`, `node test/evaluation/p3-efficiency.mjs`, `node test/session-store.mjs`: trace, P3 and persistence.

Real Codex/Generic ACP integration additionally requires npm dependencies and a live provider runtime. The pure and fake-provider tests do not prove that a real provider will stop cancelling turns, or that all real provider tool updates carry useful kinds. Recovery events are best-effort: logging or client progress delivery failures must not change the invocation's result. `invocation_retry_started` is recorded after the second invocation is actually entered; aborting while a retry is only scheduled is reported as cancellation, not exhaustion. A provider that emits unknown kinds will safely suppress retries; `/trace` makes this observable.
