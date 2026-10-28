# Provider-neutral architecture

## Universal Agent Provider Contract

The orchestration core resolves `Role -> Profile -> Provider -> Model`. A provider exposes:

- `capabilities()` — normalized capability declaration.
- `listModels()` — optional configured/discovered model catalog.
- `invoke(request)` — one invocation-scoped role execution.
- `cancel(invocationId)` — optional explicit cancellation hook.
- `close()` — runtime/process cleanup.

`AgentInvocationRequest` is provider-neutral. The current implementation passes role/profile/model metadata, workspace root and enforced mode, normalized conversation content blocks, task plan, structured-output schema, MCP servers, cancellation signal and opaque `providerOptions`. The core never interprets `providerOptions`.

## Provider-neutral Engineering Core

Engineering decisions are also part of orchestration core rather than provider adapters. `policy/engineering/` is the source of truth and `src/engineering-policy.mjs` assembles role-specific policy context. Planner/coder/reviewer/finalValidator receive the same provider-neutral decision model regardless of which provider/model executes the role; project instructions and skills remain repository-specific overlays.

For planner-backed work, the structured plan includes an `engineeringFrame` that applies the core to the current repository: current owner, existing abstractions, general mechanism, specific policy, target placement, state/resource ownership, contract risks, explicit avoid-list, and uncertainties. The frame is advisory evidence for coder/reviewer, not an authority, and low-tier workflows that skip planning do not fabricate one.

## Normalized events

Providers report `reasoning`, `commentary`, `final_text`, `content_block`, `tool_call`, `tool_result`, `plan_update`, `permission_request`, `progress`, `provider_state`, `warning`, `error`, and `usage`. Existing Codex adapters normalize Codex phases/config updates before workflow code sees them.

## Capabilities

Capabilities distinguish text/media, native plan, reasoning/commentary streams, permission callbacks, enforced read-only/write workspace modes, model/reasoning configurability, MCP transports, resume support and structured-output strategy. Required capability mismatches fail closed. In particular, a provider that cannot enforce read-only cannot run a read-only role, and image/resource context is never silently dropped by the registry.

## Error model

Provider-facing failures normalize to: `AUTH_ERROR`, `RATE_LIMIT`, `MODEL_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `CONTEXT_LIMIT`, `PROVIDER_CRASH`, `TIMEOUT`, `CANCELLED`, `INVALID_REQUEST`. Native details remain on the cause/diagnostics path rather than driving workflow branching.

## Adapters

- `codex-acp`: existing Codex ACP integration, now behind normalized capabilities/events and opaque provider state.
- `codex-cli`: existing CLI integration behind the same contract.
- `acp-agent`: generic ACP subprocess adapter for arbitrary ACP-compatible agents. It requires explicit `workspaceModes.readOnly` and `workspaceModes.write` IDs so security boundaries are configuration-backed and fail closed.

Claude can be connected through the external `claude-agent-acp` runtime with the generic `acp-agent` adapter; no Claude branch is needed in workflow. Local or third-party coding agents can use the same path if they expose ACP. An OpenAI-compatible inference endpoint alone is not treated as a coding agent.

## Configuration

Canonical provider configuration uses `adapter`; legacy `type` remains accepted as a compatibility alias.

```json
{
  "providers": {
    "some-acp-agent": {
      "adapter": "acp-agent",
      "command": "some-agent-acp",
      "args": [],
      "workspaceModes": {
        "readOnly": "read-only",
        "write": "agent"
      },
      "idleTimeoutMs": 600000,
      "turnDeadlineMs": 2700000,
      "modelConfigId": "model",
      "reasoningConfigId": "reasoning_effort",
      "envAllowlist": []
    }
  },
  "profiles": {
    "worker": {
      "provider": "some-acp-agent",
      "model": "model-id",
      "reasoningEffort": "high",
      "providerOptions": {}
    }
  }
}
```

Legacy `codex-acp` and `codex-cli` configs continue to load. Persisted outer sessions remain compatible; Codex-native outer UI state is retained as a compatibility/presentation concern and is translated to opaque provider state at the workflow boundary.

### ACP turn timing

ACP adapters use activity-aware timing with two independent limits. `idleTimeoutMs` is refreshed by every native session update, including reasoning/commentary, plan, tool, usage, provider-state and future data-plane updates. `turnDeadlineMs` is an absolute per-prompt-turn ceiling and is never refreshed. User-facing permission waits pause only the idle watchdog, not the absolute deadline. The bundled subscription defaults are 10 minutes idle and 45 minutes absolute.

Both fields may be set at provider or profile level; profile values win. The legacy `timeoutMs` field remains accepted. When it is the only timing option, it supplies both values to preserve the previous fixed-timeout semantics. This timing behavior lives in the ACP provider layer and does not filter or suppress reasoning summaries; those summaries remain presentation/progress events and also prove liveness.

### Cancellation provenance

Cancellation is a separate control-plane concept from timing. Outer aborts are propagated through `AbortSignal.reason` with stable reason codes instead of anonymous `AbortError("Operation aborted.")` values:

- `CLIENT_REQUEST_CANCELLED` — the outer ACP prompt request was cancelled by the client;
- `SESSION_CANCELLED` — the client sent `agent.session.cancel`;
- `SUPERSEDED_BY_NEW_TURN` — a newer prompt replaced the active or pending turn for the same outer session.

These are expected cancellations and return ACP `stopReason=cancelled` rather than being presented as task failures. The reason is preserved through workflow, repository subprocess cancellation and provider normalization.

By contrast, an inner provider returning `stopReason=cancelled` while the outer signal remains active is an unexpected provider-side termination. ACP adapters normalize it to `CANCELLED` with diagnostic reason `PROVIDER_CANCELLED`, mark it retryable, and surface it as a failure with provider/profile/role/inner-session metadata. Core workflow never infers user cancellation from an inner provider's `cancelled` result alone.

## Security/process isolation

ACP subprocesses receive a minimal environment plus an explicit `envAllowlist`; secrets are not inherited wholesale. Generic ACP and Codex ACP use argument arrays rather than shell command strings. Read-only enforcement is capability-checked before invocation. Provider process groups are terminated during shutdown where supported.

## Remaining weak spots

The generic ACP adapter has not been smoke-tested against a real third-party runtime in this environment. `claude-agent-acp`, Claude Code, and Codex executables were not installed here, so subscription-backed real-runtime flows are **architecturally supported but not runtime-verified**. The outer ACP server still exposes legacy Codex-native controls for backward-compatible Zed sessions; those controls no longer leak into workflow semantics, but a future UI-neutral control registry would remove the remaining Codex naming from the outer presentation/session layer.
