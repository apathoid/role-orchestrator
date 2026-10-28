# Lazy provider isolation and real-adapter headless validation

Base: `role-orchestrator-runtime-refactor.zip` supplied in the previous turn.

## Implemented

- `src/models.mjs` no longer statically imports any provider implementation.
- `src/providers/lazy-provider.mjs` provides an on-demand provider wrapper. It defers import and process setup until preparing, invoking, or discovering models from the selected provider. Unused providers can be closed without importing them, and a single loading promise prevents duplicate imports for concurrent requests.
- `src/providers/capabilities.mjs` gives synchronous capability previews without ACP SDK. Concrete providers reuse these functions instead of duplicating declarations. The generic ACP provider continues to combine declarative capabilities with upstream initialize/handshake capabilities.
- Existing `resolveRole()` stays synchronous, so route previews, inline role assignments, presets, and session materialization retain their existing API. Unsupported adapter errors remain explicit.
- No changes to persistent session schema, workflow routing, security policies, Plan semantics, staged checkpoints, cancellation provenance, provider tool events, or ACP presentation.
- Documented the host-neutral invocation contract. Standard MCP server descriptors and content blocks are *provider protocol concepts*, not editor-specific APIs; the ACP adapter converts external requests at its boundary.

## Verification performed (this environment)

- PASS: `npm run check`.
- PASS: **31** test files executed individually, including `role-presets-runtime`, the new lazy-provider isolation test, and the new real-adapter headless integration test. No tests that actually executed failed.
- BLOCKED (missing `@agentclientprotocol/sdk`): `test/codex-acp-cancellation.mjs`, `test/generic-acp.mjs`, `test/provider-progress.mjs`, `test/smoke.mjs`. These are **not** recorded as passed.
- The real-adapter headless integration test calls the production `createOrchestratorRuntime()`, `runWorkflow()`, and `CodexCliProvider` with the local deterministic `test/fake-codex.mjs` process. It tests Plan → Change → disk restore → saved-plan reuse/continuation → Investigation, the edited repository content, persistent transcript, role progress events and read/write sandbox distinctions, with unused ACP adapters in the configuration.
- NOT VERIFIED: live Zed interoperability and real Codex ACP or Codex CLI service operation. The fake CLI exercises the adapter's process protocol but is not a real model service.
- Environment Node version was **v22.16.0**, below the package's declared minimum **22.20.0**. Re-run the suite on a supported Node runtime with installed dependencies before shipping.

## Reproduction

```sh
npm ci
npm test
# Focused, SDK-free:
npm run test:lazy-providers
npm run test:headless-real-provider
```

Follow the live ACP/Zed checks already documented in `HOST-NEUTRAL-IMPLEMENTATION-RESULTS.md`. This release does not change the public ACP wire protocol or UI integration.
