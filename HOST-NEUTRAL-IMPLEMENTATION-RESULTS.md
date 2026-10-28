# Host-neutral execution extraction — implementation results

## Changes from `role-orchestrator-host-agnostic.zip`

- Extracted host-neutral per-session turn serialization and cancellation provenance into `src/turn-coordinator.mjs`.
- Extracted execution continuity into `src/execution-service.mjs`: saved-plan selection, checkpoints, reconciliation, review continuation, provider lifecycle, durable transcript/history, attachment transaction/cleanup. No replacement of `runWorkflow` or rewrite of the existing checkpoint format.
- Introduced `src/orchestrator-runtime.mjs` as the reusable host API: `createSession`, `restoreSession`, `persistSession`, `runTurn`, `cancelSession`. An in-process mock host runs the same API as the ACP host without ACP SDK or Zed.
- Refactored `src/acp.mjs` to keep request parsing, permissions, native controls, UI presentation, event conversion, and ACP wire-level transport while delegating execution and cancellation to the runtime.
- Changed `src/providers/codex-acp.mjs` to forward raw tool events. `src/acp.mjs` now applies the existing display policy to each host-visible tool update; tool-call bridging still namespaces IDs, handles orphan updates and publishes permission subjects as needed. The host-specific policy no longer belongs to a model provider.
- Preserved `src/index.mjs` as a one-shot CLI and did not change it to automatically create persistent sessions. Other hosts may choose the new runtime API for persistent execution.
- No changes to existing state file version, role assignments, prompt routing, timing settings, Engineering Core, verification boundaries or provider architecture.

## Verification in this environment

- **PASS:** `npm run check` (syntax checks, including new modules/tests).
- **PASS:** 26 existing test files plus 2 new host-neutral tests (`test/execution-service.mjs` and `test/orchestrator-runtime.mjs`). The new tests validate Plan → Change → Resume → Review and durable state independently from Zed and the ACP SDK.
- **BLOCKED:** Five SDK-dependent test files (`smoke.mjs`, `codex-acp-cancellation.mjs`, `generic-acp.mjs`, `provider-progress.mjs`, `role-presets-runtime.mjs`) cannot run because `@agentclientprotocol/sdk` is absent. `npm ci --offline` failed because the local npm cache lacks `zod@4.6.5`; this is an environment limitation, **not** a test pass.
- **NOT VERIFIED:** Real ACP/Zed integration, including live provider permissions, model invocations, tool-call rendering and reconnect. No claim of a full interactive regression pass is made.
- Node in this container is `v22.16.0`, below the package's declared minimum `v22.20.0`; rerun with a supported runtime before release.

## Release verification on a configured workstation

Run `npm ci && npm test` under Node >=22.20.0. In an actual Zed ACP session, validate new/load/resume, Plan/Default, role presets/Fast mode, progress and tool-call updates, permission correlation, interrupted/resumed staged implementation, review, and all three cancellation origins. Neither static analysis nor the mock-host tests can substitute for real adapter/provider interoperability checks.

## Known architectural limits

- The one-shot CLI continues to call `runWorkflow` directly for backward compatibility. It doesn't expose an interactive session UI or automatic resume, but the complete persistent-session runtime is available to other hosts.
- ACP v1 UI projection remains an adapter-level responsibility, with existing presentation policy retained. Protocol upgrades should be handled within that adapter.
- Provider-specific native mode controls remain visible via ACP session configuration; they are a host/provider-bridging concern, not generic workflow policy.
- Existing nested instruction scope and configuration cache limitations from `HOST-NEUTRAL-ARCHITECTURE.md` remain unchanged.

## Addendum: lazy provider loading and real-adapter headless integration

- `src/models.mjs` uses `LazyProvider` instead of eagerly importing all implementations.
- `src/providers/capabilities.mjs` provides pure, synchronous capability declarations; provider classes reuse the same functions to prevent drift. The generic ACP provider still recomputes capabilities after `initialize`.
- `src/providers/lazy-provider.mjs` imports only the selected implementation when needed, retains the synchronous `resolveRole` contract, handles concurrent loads, and does not instantiate a provider on unused `close`.
- `test/lazy-providers.mjs` covers resolving mixed CLI/ACP configuration with ACP SDK absent, declared capabilities and model metadata, and optional bridge permissions.
- `test/headless-real-provider.mjs` performs Plan → Change → session restart → saved-plan continuation → Investigation using the production workflow, production Codex CLI provider and a local deterministic Codex CLI test process. It verifies file changes, persistence, semantic role events and read/write sandbox assignments without Zed or ACP SDK.
- These are additional focused tests, not proof of live ACP/Zed or real Codex service compatibility. Existing workflow/policy, session schema, and ACP host protocol are unchanged.
