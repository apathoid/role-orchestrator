# Semantic routing finalization — technical report

**Date:** 2026-10-27. **Exact input:** `role-orchestrator-semantic-hardening-2026-10-27.zip`. **Readiness:** NOT PRODUCTION-READY. This is a targeted regression closure and fail-closed hardening, not a new migration.

## Executive summary

The original `workflow-unstructured` failure was reproduced. After correcting the production Router fallback and migrating old Router mocks to Typed Task Specification v1, the **entire** unstructured workflow test passes under Node v24.11.1. Semantic intent/completion, evaluation suite, execution service, implementation continuity, runtime and local headless fixture checks also pass. The project's full `npm test` still cannot finish: `npm ci --offline` cannot obtain `zod@4.6.5`; `@agentclientprotocol/sdk` is absent and `test:generic-acp` fails. Real model classification remains unmeasured (56 provider crashes) and Zed was not available; no production-ready claim is supported.

## Baseline, root causes and code changes

1. **HIGH production defect:** `src/workflow.mjs` synthesized a task from `modeOverride='change'` or `planOnly` when the Router returned no `task`. Host constraints were being used as a substitute for semantic interpretation. Now the nested `task` is required for every new Router response; missing task produces `intent_unresolved` / `missing_task_spec`, with no coder or planner. Existing `task.version=1` remains unchanged.
2. **Legacy regression test:** `test/workflow-unstructured.mjs` expected `result.route.classification` from an invalid mock Router output, plus text-parsed Review plan, lexical continuation and reconciliation approval. Updated typed fixtures and expected error contracts, **not** a language fallback; retained strict evidence/coverage, no-duplicate-work, and error assertions. Whole test now passes.
3. **Test coverage gap:** `test/evaluation/effect-aware-hardening.mjs` simulated a Router without typed `task`, so the required effectful read-only rejection was unreachable. Fixed mock to supply v1 task; preexisting strong assertion now passes.
4. **Evaluation runner correctness:** `tools/semantic-evaluate.mjs` now reads provider-neutral structured output metadata, validates both nested task and typed top-level route consistency, records provider/contract error details, emits `null` rather than invented false-negative classifications for absent responses, and computes accuracies over valid outputs. It does not manufacture a real model or replace ACP SDK.

## Additional standalone regressions discovered and remediated

An additional **12-target** focused audit run on Node 24 found four legacy tests outside the originally listed failing workflow. `review-work-plan` and `review-reliability` still passed free-form Git selection strings to a typed-only resolver. `implementation-stages` expected the older generic rejection code rather than the validated continuation-specific error. `skill-workflow-integration` lacked a typed Router task and expected skill instructions to override semantic classification. These were fixed by migrating the **tests**, without changing the corresponding production resolver or routing policy. Full reruns of all four pass. The Review reliability scenario exercised **12 distinct units**, **7 reviewer invocations**, budget hard limits, and HEAD drift.

Evidence: `audit-review-work-plan.log`, `audit-implementation-stages.log`, `audit-skill-workflow-integration.log`, `migrate-review-work-plan-1.log`, `migrate-review-reliability-2.log`, `migrate-implementation-stages-1.log`, `migrate-skill-workflow-integration-2.log`.

## Architecture and contracts

```
Trusted host command signals -> Existing Router -> validated `task.version=1`
-> typed route consistency -> scoped Git/Plan/Review resolution
-> existing permission, checkpoint and quality gates -> workflow -> verified status
```

The changed production code **does not** add a Router, scheduler, lexical parser or alternate authorization policy. It removes a privilege-relevant synthetic-intent fallback. Version remains 1; the only new compatibility constraint in this pass is that host `modeOverride`/`planOnly` **cannot** rescue Router outputs without a nested task. Skill, repository, checkpoint and tool content are not trusted authorization signals. Deterministic JSON extraction, Git/path parsing, slash protocol, validation and policy boundaries are retained.

## Review, Git scope and persistence

The hardened baseline already contains typed Git selectors including explicit `union`, Review `constraints.reviewChecks`, frozen Review work plan, saved Plan digest and identity checks, and read-only legacy Review checkpoint diagnostics. No unrelated production rewrites were attempted. Existing semantics are exercised with real temporary Git repos within semantic tests and local workflow fixtures; live first-parent, drift, restart and ACP-backed session integration still require the supplied guide.

Direct callers of `execution-service` already use typed post-Router Plan selection; this pass does not change that API. External integrations still using lexical plan selection must migrate. Persisted checkpoints were **not** rewritten, and automatic legacy resume without validated intent remains intentionally denied.

## Environment recovery and complete verification

- Runtime found: **Node.js v24.11.1**, satisfying `engines.node >=22.20.0`; the default Node v22.16.0 does not satisfy it.
- `npm ci --offline`: fails because `zod@4.6.5` is not cached. Registry access not available; dependencies and lockfile left intact.
- `npm run check`: **PASS** (Node 24; `node24-check.log`).
- `node --check` all `src/`, `test/`, `tools/` mjs: **PASS** (Node 24; `node24-syntax.log`).
- `npm run test:semantic-intent`: **PASS** (Node 24; `node24-semantic.log`).
- `npm run test:evaluation`: **PASS** (Node 24; `node24-evaluation.log`). These tests use controlled fixtures/mocks; not live semantic model evaluation.
- `node test/workflow-unstructured.mjs`: **PASS** (Node 24; `node24-workflow.log`).
- Additional execution-service, implementation continuity, runtime and local headless fixture tests: **PASS** (see `extra-*.log`).
- Full `npm test`: **ENVIRONMENT_BLOCKED** (Node 24; `node24-full.log`), real ACP SDK unavailable.
- Full 56-case live semantic evaluation: **NOT_VERIFIED**, 0 validated outputs, 56 `provider_crash`; semantic precision/recall **undefined**, not zero percent.
- Real Zed, Codex ACP and alternate provider: **NOT_VERIFIED**; local fixture is not production transport.

## Authorization/security assessment

**Verified deterministically:** invalid Router task does not synthesize authorized writes; read-only negatives and reconciliation host decision fixtures pass; typed Git union and Review requirements tests pass. **Not verified live:** the model's propensity to misclassify *schema-valid* read-only user intent as explicit Change, malicious repository injection via actual provider, provider-specific output delivery, host sandbox effects, resumed operation behavior against production persistence. Any observed false-positive Change is a blocking finding.

## Semantic evaluation method / results

Corpus: original 56 entries at `test/evaluation/semantic-intent-corpus.json` (preserved). Command (with configured real provider): `node tools/semantic-evaluate.mjs "$PWD" test/evaluation/semantic-intent-corpus.json --run > semantic-live.json`. Output: accompanying finalized JSON (full per-case errors and aggregate). All 56 failed with `provider_crash`; no valid tasks, no measurable accuracy, FPR, recall or latency of actual successful model calls. Provider failure root cause could not be fully isolated from absent production ACP dependencies/executable and credentials; do not assume model misclassification.

## Three audit results

- **Audit A — Semantic Authority & Security:** A-001 confirmed and fixed, legacy test contract migrated; live false-positive authorization remains NOT_VERIFIED. See `audit-a-semantic-security.md`.
- **Audit B — State & Architecture:** direct and mocked continuation tests pass, legacy checkpoint remains fail-closed; real state persistence/restart, provider cancellation, host-specific behavior NOT_VERIFIED. See `audit-b-state-architecture.md`.
- **Audit C — Regression & Operational:** previously failing full workflow is PASS; full npm test environment-blocked, model and Zed unavailable. See `audit-c-regression-operations.md`.

These are three distinct internal audit passes with explicit findings registers, **not independent external certifications** and **not PASS** while release gates are open.

## Final 35-case verification matrix

The full scenario-by-scenario trace is in `verification-matrix.md`. **All live Zed checks are NOT_VERIFIED**, including scenarios that pass isolated real-Git or headless mock tests. A passing unit, integration fixture or headless protocol stub is recorded only as the corresponding level of evidence, never as live end-to-end proof.

## Remaining risks and release gates

**Blocking external validation:** install exact locked dependencies without altering lockfile; rerun complete suite; evaluate all 56 corpus prompts using actual configured Router provider; inspect every potentially false-positive Change; execute 35 Zed acceptance scenarios with actual Codex ACP and at least one Generic ACP/local or cloud provider as applicable; compare real invocation metrics, Git state, checkpoints and cumulative budgets. No user permission or config changes are mandatory for the patch alone, but the configured Router must emit v1 typed output.

## Five-dimensional readiness decision

| Dimension | Status |
|---|---|
| 1. Implementation complete | **PARTIAL / NOT CONFIRMED** — confirmed regression addressed, complete integration remains unproved |
| 2. Deterministic verification complete | **PARTIAL** — major suites PASS; full suite environment-blocked |
| 3. Real semantic evaluation | **NOT_VERIFIED** (56 provider crashes) |
| 4. Live Zed/provider integration | **NOT_VERIFIED** |
| 5. Production-ready | **NO** |

**Weak assumptions:** existing ACP runtime and host permission contracts were inspected/tested indirectly but cannot be certified from this environment; the absence of confirmed additional lexical routing in inspected files is not proof of global absence.
