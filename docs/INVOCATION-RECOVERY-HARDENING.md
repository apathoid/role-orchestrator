# Invocation Recovery hardening (2026-10-25)

This patch extends `docs/INVOCATION-RECOVERY.md`. It does not add a skill-name or `/review-code` special case.

## Changes

- Classify ACP tool effects per attempt using `toolCallId` and normalized `toolObservation`. A partial `tool_call_update` or `tool_call_content_chunk` without `kind` inherits the last known safe classification for the same tool. An unknown initial classification, explicit removal/change, malformed ID, inconsistent raw/normalized observation, unknown tool type or observation beyond the bounded table prevents replay.
- A `role_native_update` is treated as potentially published data-plane output, including unknown future update types. It prevents replay. This is independent of whether the caller requested native presentation.
- Recovery-event delivery (`scheduled`, `started`, `recovered`, `skipped`, `exhausted`, `cancelled`) is best-effort. A logging/presentation error must not turn a successful provider response into failure or mask the actual provider error.
- `invocation_retry_started` is recorded only **after** the replacement invocation has actually been entered. A cancellation after scheduling but before entry creates `invocation_recovery_cancelled` rather than a phantom retry or an exhausted operation. Outbound cancellation inside an active retry is also distinguished from retry exhaustion.
- The Recovery Engine validates the actual `sandboxMode`, `mcpServers`, and `promptBlocks` again, even if the caller supplies `replaySafety: 'verified-read-only'`. Unverified effectful invocation permissions fail closed.
- Structured trace allows the new `invocation_recovery_cancelled` event. P3 accumulates its recovery duration but does not count the cancelled scheduled attempt as executed.

## Coverage

`test/invocation-recovery.mjs` includes partial ACP updates for v1/v2, real `normalizeAcpToolObservation()` integration, unknown/native content, kind replacement/removal, mismatched observation IDs/classifications, sandbox/MCP/resource-link mismatch, telemetry errors in every recovery phase, and cancellation on either side of invocation start.

Selected source/unit/workflow, P2, P3, security, observability and session-storage suites passed in the audit environment. For deployment validation, install dependencies and use the supported Node version (`>=22.20.0`), then run the full suite and exercise real Codex ACP and Generic ACP. Those integration suites could not run here because `@agentclientprotocol/sdk` was absent. No claim is made that this patch fixes the provider's underlying unexpected cancellation after ~212 seconds.

## Deliberate limits

The retry budget remains two attempts total. Mutating or externally effectful tools and unrecognized ACP events remain non-replayable. Review batch sizing and workflow checkpoint design are unchanged, because changing them is not necessary to correct the replay-safety and observability regressions.
