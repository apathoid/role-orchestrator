# Role Orchestrator — Pre-Live Hardening technical report

**Date:** 2026-10-28. **Exclusive code baseline:** `role-orchestrator-semantic-finalized-2026-10-27.zip`; SHA-256 `347bb03ab43fd009db67a340374d1cd26d3670ec67c16a8a596d4c063a02c821`.

## Decision

**PARTIAL — deterministic hardening implemented, but not a certified completed pre-live release.** The changed local semantic/workflow/state tests pass on the available Node runtime; a full suite with the locked ACP SDK and the explicitly required Node version cannot be verified in this sandbox. Real semantic accuracy and Zed/provider live acceptance remain **NOT_VERIFIED**. The broader crash-consistency/external-side-effect matrix is not exhaustively exercised; no exactly-once claim is made.

## Architecture and implementation

1. `src/routing/request.mjs` is the single semantic request-construction and prompt-compilation component. `runWorkflow` and the semantic evaluation CLI use it for equivalent user task, mode/plan-only constraints, skill names, saved metadata, nested/project instructions, session history and router-context projection. The builder returns schema, prompt blocks, read-only sandbox and context telemetry; it never determines authorization or manages a provider lifecycle.
2. For a dynamic `roleSessionContext` callback, production now obtains the Router history **before** projecting the context. This avoids silently overwriting an optimized, digest-checked Router projection at invocation time. Non-router role behavior remains unchanged.
3. `src/routing/semantic-evaluation.mjs` separates valid semantic output, invalid typed contracts and provider failures. Offline fixture evaluation is available with `--offline`; it reports honest denominators, missing fixtures, per-case errors, invocations, usage and latency. Offline fixtures are tests of the evaluator, **not** measurements of real model accuracy. The original corpus of 56 cases and its expected results were preserved exactly.
4. Removed the statically unreachable `deterministicContinuation=false` bypass branch and unused `readOnlyRequest` constant. The real, explicit, typed Review restore branch is intact; semantic saved-Plan continuation remains Router-mediated.
5. Repaired `test/fake-review-smoke-contract.mjs`: fake Router now emits the required Typed Task v1. No production fallback or weakened production authorization checks were added.
6. Added integration/security checks: production Router request capture vs evaluator request, malicious project instructions and skill metadata, plan-only/host constraints, invalid typed output, provider crash/timeout, Git selector union, read-only source hashes, cross-process Plan/Review session restoration, checkpoint/digest validation, Git HEAD drift and two-writer optimistic concurrency.

## Evidence boundaries

| Domain | Actual evidence | Status |
|---|---|---|
| Shared production/evaluation prompt, schema and constraints | `test/router-request-parity.mjs` captures actual production Router request, compares builder | LOCAL PASS |
| Offline evaluator failure/metric semantics | `test/semantic-evaluator-offline.mjs` with 10 adversarial fixtures and missing fixture | LOCAL PASS |
| Typed routing and workflow | `test/semantic-intent.mjs`, `test/semantic-workflow.mjs`, `test/workflow-unstructured.mjs` | LOCAL PASS |
| Plan/Review persistence, identity, budgets | `test/prelive-state-restart.mjs` — actual filesystem state and separate Node processes | LOCAL PASS (bounded) |
| Concurrent writers | two independent session writers; one save and one `SESSION_REVISION_CONFLICT` | LOCAL PASS (optimistic serialization only) |
| Negative security and provider failures | `test/prelive-security-failures.mjs` + existing security tests | LOCAL PASS (fake providers) |
| Full installed ACP SDK integration | `npm ci --offline` missing `zod@4.6.5`; `npm ci` online timed out; `@agentclientprotocol/sdk` absent | ENVIRONMENT_BLOCKED |
| Node support contract | available `v22.16.0`, project requires `>=22.20.0` | NOT_VERIFIED on required Node |
| 56-case actual Router semantic classification | no live LLM provider configured | NOT_VERIFIED |
| Real Zed ACP / alternate providers | absent | NOT_VERIFIED |
| Crash during external mutable action; in-flight crash during atomic rename | no deterministic fault injection of true external action | NOT_VERIFIED |

## Why regression expectations changed

The old smoke-contract fake returned only top-level `mode/writeIntent` while the production contract requires `task.version=1`. Previously it incorrectly expected a successful Review. The mock now emits `emptyTaskSpec('review')`, retaining the original reviewer scope assertions; the production code was not changed to accept incomplete semantic output.

## Security and state invariants

Router/project/skill text is not permission. Mode override and plan-only constrain a *valid* typed semantic output, not a missing `task`. Saved Plan existence is not permission to write. Stale/mismatched persisted checkpoints and Git scope may not silently resume. Checkpoint identifiers/budgets are restored from disk without newly minted identifiers. Optimistic session revision conflicts cannot truthfully guarantee exactly-once arbitrary external effects.

## Repeatability

`npm run check`, `npm run test:semantic-intent`, `npm run test:evaluation`, `node test/workflow-unstructured.mjs`, `npm run test:router-request-parity`, `npm run test:semantic-evaluator-offline`, `npm run test:prelive-state-restart`, `npm run test:prelive-security-failures`, `npm run test:fake-review-smoke-contract`.

See the accompanying **full test logs** and `final-verification.tsv` for exact exit status of individual runs; no mock SDK was installed. For real dependencies use an environment with Node >=22.20.0, run `npm ci` unchanged and two uninterrupted `npm test` passes. For semantic accuracy, configure a real Router provider and run the unchanged 56-case corpus with `--run`.

## Limitations and open gates

- Real-provider classification FPR, accuracy, cancellation and ACP notification delivery remain unknown; all must be evaluated against the required live guides.
- The multi-process harness covers JSON persistence/optimistic concurrency, but does not prove all workflow-specific operation locks, crash windows, side-effect idempotency or repeated resume of arbitrary mutable tools.
- Some tests use isolated fake providers and therefore do not measure provider transport, real tool side effects or actual Zed UI behavior.
- No high-severity local implementation defect is *confirmed* by the executed checks; this is not evidence that none remain behind blocked/live paths.
