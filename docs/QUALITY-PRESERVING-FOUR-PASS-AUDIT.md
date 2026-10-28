# Four-pass audit report — Quality-Preserving Review

Source: `role-orchestrator-review-optimization-v2.zip`. Audit target: Q0–Q6 Review-only development. The four passes below were carried out as separate examinations followed by targeted changes and regression checks.

## Pass 1 — contract and correctness

* Audited risk formation, atomic structured assessment, path anchors, Work Plan separation and no silent model-to-tool evidence promotion.
* Found a risk could be prematurely closed before all its related Units were examined. Fixed `applyReviewRiskReport()` to require their actual checked evidence.
* Added contract tests for missing issue observations, short or invalid evidence, unknown IDs, negative/unsafe source refs, duplicates, and mode `off`/`observe`/`enforce` distinctions.
* Confirmed static risk path flags are questions, not machine-certified defects.

## Pass 2 — durability, lifecycle and resume

* Audited v3→v4 checkpoint migration, `risk_follow_up` report shape, records/report caps, shared budget continuity and interrupted execution.
* Fixed risk follow-up report validation for v4 when all regular Units had been checked. Risk-only follow-ups cannot re-certify Units.
* Added bounded handling of oversized risk source sets; unknown portions cannot result in PASS.
* Added workflow regression covering one-call closure, budget-paused completion, durable resume and narrowly scoped follow-up.

## Pass 3 — safety, provenance and architecture

* Audited tampering of risk states, scope/plan changes, untrusted model claims, repeated/contradictory statements, and P3 privacy.
* On v4 resume, independently reconstruct structural expected risk IDs/anchors from the Work Plan and persisted classification; reject incomplete/tampered ledgers. Closed risks require supporting original assessment in persisted reports.
* Unexpected conflicting model assessment changes a risk to `disputed` (only when source-anchored and supported); a later model response cannot silently decide that conflict. An independent trusted verification path remains a separate integration concern.
* P3 keeps bounded counters/status, never prompt text, source content, arbitrary user strings or self-certified token counts.

## Pass 4 — performance, regressions and release readiness

* Found and fixed a preexisting boundary problem: if the final required reviewer invocation exactly exhausted the budget, the next loop iteration incorrectly marked an otherwise fully completed review `incomplete`. The budget is now checked only **after** identifying real remaining work.
* Ran `npm run check`, `npm run test:review-quality-depth`, `node test/review-efficiency.mjs`, `node test/security.mjs`, `node test/review-operation-continuity.mjs`, `node test/review-work-plan.mjs`, `node test/evidence-driven-completion.mjs`, `npm run test:evaluation`, plus Review Scope, Config, Context and Skill integration tests — passed in the local environment. All new tests include expected negative outcomes.
* Full `npm test` could not finish: Node runtime is 22.16.0 whereas package requires >=22.20.0; npm dependencies are not bundled, `@agentclientprotocol/sdk` is missing, and `npm ci` could not complete in the available network environment. The legacy `workflow-unstructured` long-running script also did not produce a normal PASS under the command time limit. **Neither is counted as passing**.
* No live ACP/Codex/Quota A/B runs were available. Model-to-model quality improvement, number of real defects detected, true token cost and production behavior under a specific host cannot be asserted from offline tests.

## Residual external acceptance work

1. With Node >=22.20 and `npm ci` installed, run the entire native `npm test` suite, including the ACP provider tests and `workflow-unstructured` to normal completion.
2. Validate in real Zed ACP or generic ACP host that scoped output fields are accepted by active model/provider combinations, checkpoint durability works after process restart, and paths remain clickable.
3. Run repeated identical snapshots with independently verified issue fixtures and actual quota measurements using the existing evaluation suite.

**Code-level result:** the review-only mechanism is implemented and passes listed deterministic/integration regressions. **Full production-ready and economic-quality acceptance:** not independently demonstrated in this runtime.
