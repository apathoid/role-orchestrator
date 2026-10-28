# Role Orchestrator — targeted lifecycle hardening (2026-10-28)

## Baseline and scope

Sole source archive: `role-orchestrator(6).zip`. Review log `review-role-orchestrator(9)(1).md`, `resume(1).md` and the user's screenshot were evidence, not source code.

**Status: PARTIALLY IMPLEMENTED, NOT PRODUCTION-VALIDATED.** The original request includes ten substantial workstreams; this change set deliberately does not claim to complete all of them. The main proven defect addressed is that natural-language acceptance could not reach the existing state-bound reconciliation gate. Other workstreams need separate implementation and live evaluation.

## Confirmed and remediated

### P0: Natural-language reconciliation acceptance and resume

**Observed:** The current task-spec protocol allowed `continuation.mode=reconcile` but did not encode acceptance/rejection of a pending reconciliation. Workflow consumed `reconciliationDecision()` only after another pathway recorded a Decision Gate selection. Therefore repeating a natural-language confirmation could reproduce the same request. `/decide` could record the selection, but naturally did not execute a coder by itself.

**Change:** Added optional, typed `continuation.decision: accept_checkout | decline` to the Router schema and validator. The Router receives a bounded `pendingReconciliation` flag for saved operations and a precise contract: approval-only is read-only (`reconcile`), approval plus explicit implementation can use `current_implementation` / `saved_implementation`, and mere resume cannot mean consent. After selecting the Plan, the workflow sends the typed choice to the existing quality-state Decision Gate; the execution service looks up exactly one gate matching the saved proposal token/repo key, rechecks the current binding and persists via the existing atomic session transaction. Absent, stale, ambiguous or otherwise inapplicable gates fail closed. The existing `/decide` path and all tool permissions are unchanged. Reconciliation still verifies proposal, plan digest, stage prefix, checkout fingerprint and protected paths; it updates the baseline only after these checks. The code does **not** run a Coder on a read-only confirmation.

**New evidence:** `test/reconciliation-lifecycle.mjs` exercises accepted-only, accepted-and-continue, rejected, invalidated and previously accepted decisions with a persisted-proposal-shaped fixture. Original `test/implementation-reconciliation.mjs`, `test/semantic-intent.mjs`, `test/semantic-workflow.mjs`, `test/execution-service.mjs`, `test/prelive-state-restart.mjs` pass. Actual LLM interpretation of Russian confirmation in live Zed remains **NOT_VERIFIED**.

### P1: Duplicate FinalValidator after no-op fix round

**Observed:** The no-change fix branch always invoked a fresh FinalValidator even when an independent final validation had already run and the code/verification were unchanged.

**Change:** Reuse the existing independent final validation only if the full tracked repository fingerprint is unchanged (HEAD, branch, index, file hashes). Without previous validation or with drift, retain adjudication. No review findings or failing verification are suppressed; the previous verdict is carried to the existing scope-aware fix decision and conflict handling. `test/fix-decision.mjs` includes the reuse preflight cases. The prior metrics show a repeated 139.6-second validator, but *no comparable provider-side quota measurement* has been made after the change.

### P1: Verification subprocess cleanup

**Change:** `runVerificationCommand` launches commands in a process group on supported platforms so timeout/cancellation can signal children spawned by npm/Vitest/Jest, rather than only the package manager process. Existing timeout/effect-aware tests pass. Whether the real `npm run test` INFRA_FAILURE was caused by watch mode is **NOT_VERIFIED**; do not claim the root cause is resolved.

### Independent inherited regression: documented dependency mismatch

**Observed:** `test/documented-dependencies.mjs` failed: README said `@agentclientprotocol/sdk@2.0.2`, while the supplied `package.json` pins `2.1.0`. Corrected README; test now passes.

## Three focused audit passes (not independently executed by separate reviewers)

1. **Correctness/lifecycle:** checked typed task spec, saved-Plan selection, proposal matching, live gate binding, idempotent decision resolution and resume. Unit/integration tests pass. Persistent real Zed resume is not measured. No silent approval from a mere resume request is allowed.
2. **Resource efficiency:** isolated the no-op validator repeat and implemented evidence-sensitive reuse. Existing P3 context/ACP tool-event tests pass. No fresh live token/quota comparisons; direct model tool calls and overlapping external scripts are not deduplicated by this patch.
3. **Security/compatibility:** `test/security.mjs`, `test/prelive-security-failures.mjs`, `test/provider-contract.mjs`, presets/continuity and relevant routing tests pass. No bypass of host permissions, no Git resets or writes to the frontend project. Live ACP SDK integration cannot run here.

## Unresolved issues / limits

| Priority | Workstream | Status / limit |
|---|---|---|
| P0 | Review/scope/fix-round classification | Existing scope classification retained; broader systematic P0 redesign not implemented. Out-of-scope issue behavior in real `/test-it` needs new test fixtures and evaluation. |
| P1 | Compound verification/tool dedup | Not implemented. Agent-initiated `check-agent-code-change` plus constituent scripts may still run twice. |
| P1 | Git metadata drift attribution and invalidation | Existing safeguards retained; stronger attribution/caching not implemented. |
| P1 | Bounded ACP tool output and per-role context policies | Existing mechanisms retained; further optimization not implemented. |
| P1 | `/test-it` coverage matrix and evidence | Existing semantic Git union scope test passes; a full test coverage planner is not implemented. |
| P1/P2 | Token usage completeness / per-group cost attribution | Existing P3 telemetry retained; provider may not expose token usage. No verified percentage of saved quota. |
| P2 | Cross-role finding dedup and user reporting | Existing evidence model retained; further semantic dedup not implemented. |
| Test environment | Generic ACP SDK / full `npm test` | `@agentclientprotocol/sdk` not installed and Node 22.16.0 below required >=22.20.0. Generic ACP test fails with `ERR_MODULE_NOT_FOUND`; full suite is not demonstrated. |
| Live | Russian Router acceptance / Zed UI | Not tested against a real provider. |

## Test evidence and measurement

- `npm run check`: PASS.
- `test/reconciliation-lifecycle.mjs`: PASS.
- `test/implementation-reconciliation.mjs`, `test/fix-decision.mjs`, `test/semantic-intent.mjs`, `test/semantic-workflow.mjs`, `test/execution-service.mjs`, `test/prelive-state-restart.mjs`: PASS.
- Evaluation coverage: `npm test` reached and passed the `test:evaluation` suite before the first `npm test` stopped at a README dependency-version assertion (subsequently fixed).
- Additional security, provider-contract, role-presets, continuation, routing, review and verification-effect tests: PASS.
- `npm run test:generic-acp`: FAILED / ENVIRONMENT_ERROR (`ERR_MODULE_NOT_FOUND`).
- No live Codex usage totals available, no claim of production readiness.

The modified suite has a deterministic one-Router-call fixture for acceptance of an unchanged proposal. This is a local mock result, **not** proof that a live Router will reliably classify the natural-language confirmation or that limits will improve by any particular percentage.

## Required next live validation

On supported Node with installed ACP dependencies, run the full suite and test in Zed: create a saved Plan, externally modify a test/production file, obtain pending reconciliation, submit natural acceptance alone and acceptance+resume separately, repeat each after restart, try expired/changed gate, and verify no unauthorized code edits. Repeat the original `/test-it` case and collect the existing per-invocation P3 metrics to compare the same scenarios before/after.
