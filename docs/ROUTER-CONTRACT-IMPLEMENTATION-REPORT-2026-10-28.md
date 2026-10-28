# Semantic Router Contract Reliability — Implementation Report

## Scope and base

Only the user-supplied `role-orchestrator-semantic-quality-routing-quality-fix-2026-10-28(1).zip` was used. Baseline SHA-256: `a9c20bacb6f65c7a94a3449abb5bfb7994e61adf54570b563149f4c78bd5663d`. Baseline had 342 regular files; no AGENTS.md was present in the archive. Environment: Linux, Node 22.16.0, npm 10.9.2, Git 2.47.3.

## Changes

1. `src/schemas.mjs`: unconditional mandatory Typed Task and top-level additional-properties check; title length matches JSON Schema.
2. `src/structured-output.mjs`: strict Router-only extraction (final channel > unphased fallback; no mixing or ambiguous fragment selection), explicit structural failure codes, sanitized diagnostics. Other role parsing remains tolerant.
3. ACP adapters: propagate parser diagnostics and provider completion status; generic ACP supports optional phase-separated commentary/final.
4. `src/workflow.mjs`: route diagnostic event, early machine-code attribution and fail-closed workflow validation. Existing authorization, continuation and routing semantics preserved.
5. `src/observability/execution-observer.mjs` and `src/routing/reporting.mjs`: privacy-allowlisted diagnostics and additional report distributions.
6. Regression tests added and connected to `npm test` through `test:structured-output` and `check`.

## Decision on recovery

No contract retry was added. The incident provides a sample of a validation failure but no structured provider output and no empirical improvement estimate. Automatic retry would consume budget and complicate cancellation/authorization while providing unproven benefit. This follows the plan's explicitly conditional recovery requirement.

## Verification and audits

See `ROUTER-INTEGRATION-AUDIT-2026-10-28.md`, `ROUTER-TYPED-CONTRACT-AUDIT-2026-10-28.md`, `ROUTER-ACP-AUDIT-2026-10-28.md`, and the verification matrix. Full npm test suite and ACP SDK integration are not verified in this environment. Test logs contain the exact command stdout/stderr and exit codes where available.

## User-visible behavior

A malformed Router output still returns `intent_unresolved` and does not run other agents. Later `/routing report` calls can distinguish missing task, malformed, incomplete, ambiguous and invalid JSON (when the adapter supplies the new metadata). Existing historical events continue to replay, but their root causes remain unknown where the old trace had only `missing`.
