# Role Orchestrator — Semantic Intent Completion & Production Hardening: technical report

**Date:** 2026-10-27  | **Source:** `role-orchestrator-semantic-intent-experimental-2026-10-27.zip`  | **Overall:** **PARTIAL HARDENING — NOT PRODUCTION-READY**.

## Executive summary

A substantial, locally tested follow-on implementation migrates the primary routing, target/Plan-selection, review obligations and reconciliation boundaries toward a single model-generated, strictly validated Typed Task Specification. The experimental source was *not replaced* by the pre-migration reliability archive. The old project is comparison evidence only. Work is **not** represented as complete: full suite is blocked by missing SDK, a large legacy workflow test is still failing, no real LLM successfully answered the evaluation corpus, and no Zed live test was possible. Security properties proven with mock providers are not proof of classification precision in deployed models.

## Confirmed baseline findings and root causes

1. `execution-service`: injected callers selected saved Plans from prompt text prior to Router, creating a divergent continuation authority.
2. `context`, `review-scope`, `implementation-stages`, `review-continuity`: lexical helper APIs recognized selected phrases or Git targets instead of consuming typed intent.
3. `review-coverage` and `review-efficiency`: user-review obligations and exclusions could be extracted from natural-language strings independent of Router.
4. `implementation-reconciliation`: approval/continuation logic depended on text rather than a recorded host decision and validated intent.
5. `workflow`: missing/invalid nested task could be reported as a successful read-only response instead of the uncompleted requested operation.
6. Git selector combinations were not modeled as explicit unions; partial resolution could underrepresent the user's intended scope.
7. Some historical fixtures expected the old text-driven API and used invalid mock Plan digests.

## Dependency map and architecture

`Host protocol` -> `existing Router (one semantic authority)` -> `schemas.routing + validateTaskSpec + route consistency` -> `typed Git/Plan/skill/review resolvers` -> `routingPolicy and permissions` -> `existing workflow, stages, scheduler, quality gates` -> `durable task/checkpoint and monitoring`. The original task prompt remains available for the final executing agent and audit but is not a separate authorization or scope resolver. Protocol slash parsers, Git ref resolution, schemas, and security guards remain deterministic.

Before the patch, direct service adapters and several downstream modules accepted natural-language inputs and made their own intent decisions. After the patch, principal entry points consume validated `task.version=1`; direct injected callers must use the typed saved-Plan callback. This is a targeted migration rather than an independent scheduler or Router rewrite.

## Typed Intent Contract changes

Still `task.version=1`. Added optional `task.skillName`, `constraints.reviewChecks[]` (`step`/`acceptance`), `constraints.expectedFileCount`, selector `union` containing 2–4 independent valid selectors, and `continuation.mode=reconcile`. Outer Router structured output requires `task` rather than accepting it as optional. Invalid or missing task returns `intent_unresolved`. A top-level read-only `investigate` and nested `operation=plan` are reconciled deterministically because the top-level enum has no Plan member. Changes are backward compatible for correctly shaped v1 tasks but introduce intentional stricter failure for older Router implementations that omit `task`.

## Git scope architecture

No free-form model-generated git commands. The resolver uses enumerated typed selectors, Git ref verification, real commit SHAs, first-parent traversal, per-commit changeset provenance, sorted file inventory and scope/manifest fingerprints. Composite `union` returns unresolved if *any* member fails. Mixed staged/unstaged, commit/staged and invalid-component scenarios were executed in a temporary repository. Shell parsing and regex interpretation of user requests have been removed from the main resolver.

## Continuation, saved Plan and checkpoints

`execution-service` passes stored plan metadata, never preselects on natural-language substrings. Only structured post-Router continuation requests invoke deterministic selection, with plan digest, repo identity and checkpoint identity gates. New information/plan discussion does not activate a saved Plan. Existing repository state and completed stages are preserved by unchanged persistence machinery. Review checkpoint resume without validated stored task intent is denied rather than reconstructed from the old prompt. Legacy checkpoint diagnostics remain possible. This intentional compatibility limitation is recorded in migration notes.

## Authorization and security

Typed output is interpretation, not granted privilege. Explicit host slash controls are trusted protocol inputs. The existing read-only/write sandbox, security policy, checkpoints and quality gates remain outside the model's control. Reconciliation approval now requires a recorded structured host decision (`accept_checkout`); the same words in ordinary user prose cannot grant permission. An invalid provider response cannot silently count a requested Review or Change as done. **Unverified:** the chance of a *schema-valid but semantically wrong* Change output from a live model; this remains a release blocker until measured.

## Review strategy and obligations

User checks and file counts derive from typed `constraints`, not a second text parser; planner checks and mandatory technical work units still flow through deterministic review coverage. `chooseReviewStrategy` remains core policy and is not delegated to Router. Review evidence, frozen scope, quality gates, and budgets retain their existing checks. Extra reviewer invocations and lifetime budget continuity have extensive deterministic coverage but have not been verified in a real Zed session.

## Measured verification

Environment: Linux container, Node `v22.16.0` (**below package requirement >=22.20.0**), Git CLI available. Attempts at `npm ci` failed/hung; offline dependency resolution lacks `zod@4.6.5`. Full ACP SDK was absent. Full terminal logs, including failed rounds, are packaged separately.

| Command / scenario | Status | Evidence |
|---|---|---|
| `npm run check` | PASS | `final-check2.log`, exit 0 |
| `find src test tools -name '*.mjs' ... node --check` | PASS | `syntax-all.log`, exit 0 |
| `git diff --check` | PASS | `git-diff-check.log`, exit 0 |
| `npm run test:semantic-intent` | PASS | `final-semantic-intent.log`, exit 0 (including new `semantic-completion`) |
| `npm run test:evaluation` | PASS | `evaluation-suite-4.log`, exit 0 |
| `node test/execution-service.mjs` | PASS | `execution-service-1.log` |
| `node test/implementation-task-continuity.mjs` | PASS | `implementation-task-continuity-3.log` |
| `node test/orchestrator-runtime.mjs` | PASS | `orchestrator-runtime-1.log` |
| `node test/headless-real-provider.mjs` | PASS | `final-headless.log`; production Codex CLI adapter + local protocol stub, not a live provider |
| `npm test` | ENVIRONMENT_BLOCKED | `npm-test-5.log`: missing `@agentclientprotocol/sdk` at `test:generic-acp` |
| `node test/workflow-unstructured.mjs` | FAIL | `workflow-unstructured-2.log`: old fixture expects a usable route from an internally inconsistent Router mock |
| Real LLM corpus, 56 fixtures | NOT_VERIFIED | `semantic-live-final2.json`: 0 validated outputs; 56 `provider_crash`; no accuracy inference possible |
| Zed live session / ACP Codex / second external provider | NOT_VERIFIED | No Zed host, credentials, or working live provider in this environment |

## Three audit passes

**Audit A — Semantic Authority & Security:** lexical skills/Plan/Git decision points were identified and migrated; adversarial typed cases run. Historical slash-protocol parsing remains, intentionally. **Open:** live false-positive write authorization cannot be ruled out; this is a **blocking high-confidence gap**, not a confirmed exploitable defect. Static scan in `audit-a-semantic-authority.txt`. Outcome: `NOT_VERIFIED` for complete architecture / live safety.

**Audit B — State, Resume & Architecture:** headless saved-Plan selection, restart, cancellation supersession, Plan digest, scoped Review unit accounting and evaluation test suite run; state machine remains independent of host. **Open:** full legacy direct workflow coverage, legacy checkpoint reactivation, live restart with Zed and all provider paths are not exhaustively confirmed. Static scan in `audit-b-state.txt`. Outcome: `PARTIAL`.

**Audit C — Regression, Adversarial & Operational:** full-suite attempts, malformed Router handling, new Git union tests, headless provider fixture and 56-case evaluation attempted; provider crashes correctly not scored as classification failures. **Open:** supported Node + SDK unavailable; `workflow-unstructured` contains old semantics; live model and Zed missing. Static scan in `audit-c-operational.txt`. Outcome: `NOT VERIFIED/FAIL` for full rollout.

Audits are three separate review *perspectives*, not independent external assessments. They cannot be called PASS while the gaps above exist.

## Regression/compatibility and residual risks

See `role-orchestrator-semantic-regression-comparison-2026-10-27.md`, `role-orchestrator-semantic-legacy-cleanup-2026-10-27.md`, and `role-orchestrator-semantic-migration-notes-2026-10-27.md`. No provider-specific native structured output was added. Some direct helper APIs now intentionally reject untyped natural language, and older checkpoints with no typed Review intent cannot auto-resume. `test/workflow-unstructured.mjs` remains a **confirmed open regression/test-contract mismatch**, requiring a full scenario-by-scenario migration and successful replay before release.

## Reproduce and rollout gates

```sh
node --version   # >= 22.20.0
npm ci           # use lockfile, do not rewrite dependencies
npm run check
npm test
npm run test:semantic-intent
npm run test:evaluation
node tools/semantic-evaluate.mjs "$PWD" test/evaluation/semantic-intent-corpus.json --run > semantic-live.json
```

Capture per-provider error details in a secured environment; do not count `NOT_VERIFIED` as accuracy zero. Review **all 56 cases**, especially any false-positive Change authorization. Verify all scenarios from the accompanying Zed guide and confirm no duplicate completed units/budget resets. Re-run a new three-pass audit against a green full suite. **Until then: NO PRODUCTION ROLLOUT.**

## Deliverables

Patch applies relative to experimental project root using `patch -p1`; a dry run is performed during artifact creation. Full archive includes the new corpus, tests and README changes, and original ZIP remains byte-identical. A separate file manifest enumerates added/modified/mode-changed paths. Full test logs include failed and successful attempts rather than being collapsed to a summary.
