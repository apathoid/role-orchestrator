# Semantic Intent Resolution — technical implementation and audit report

**Date:** 2026-10-27  
**Base:** `role-orchestrator-review-reliability-2026-10-27.zip` (unchanged copy outside tree)  
**Status:** **PARTIAL / EXPERIMENTAL, NOT production-ready**  
**Verification:** deterministic subset PASS; full suite FAIL/blocked; real LLM evaluation and Zed live checks **NOT_VERIFIED**.

## 1. Summary

Implemented a first-cut versioned semantic task contract inside the existing Router workflow and moved Git scope selection, review requirements, and persisted operation selection into typed, independently validated inputs. No new mandatory LLM role or scheduler was added. The implementation avoids automatic dangerous natural-language fallback when the Router omits a valid task specification. This is **not a completed architectural migration**: several legacy semantic parsers and test dependencies remain.

A schema-valid Router answer is **not proof of a true semantic interpretation**. For ordinary natural-language Change requests the LLM must correctly distinguish explicit edits from questions; no deterministic schema alone can prove that a sentence requested an edit. Human confirmation or trusted UI intent signals are possible stronger safeguards, but blanket Change confirmation was not added because it would violate current product behavior. The residual false-positive write risk must be measured with a live model before deployment.

## 2. Original semantic decision registry and migration

| Component / location | Original decision / input | Classification | Migration / remaining guarantees |
|---|---|---|---|
| `src/workflow.mjs` Router role | mode, risk, write-intent from LLM | Semantic | Extended with `task.version=1` and typed interpretation. Validated before policy; operation conflict fails closed. |
| `src/routing/consistency.mjs`, `validateRouteConsistency` | Natural-word consistency guard after Router | Semantic, conflicting authority | Typed validation path added; legacy lexical export remains for tests/callers; **migration incomplete**. |
| `src/workflow.mjs`, `routingPolicy` | Route and policy selection | Mostly deterministic policy; originally fed hybrid mode | Consumes classified typed route; keeps hard role/read-only policy. |
| `src/review-scope.mjs`, `resolveReviewScope` | Commit counts, branches, ranges, working tree extracted from text | Semantic + Git facts mixed | Typed selector input added and used in migrated workflow; shell Git calls still deterministic. Legacy string API remains (**not removed**). |
| `src/context.mjs`, `inferReviewTarget` | Lexically extract requested commit from natural text | Semantic | **Still present**, including `/review` argument interpretation, needs removal or protocol isolation. |
| `src/context.mjs`, `parseSlashInvocation` | Parse `/change`, `/review`, `/review-commit`, `/skill`, named skill references | Mixed protocol and semantic | Genuine slash protocol preserved. `namedSkillInvocation` remains linguistic and must migrate to Router; **incomplete**. |
| `src/review-continuity.mjs`, `isReviewContinuationRequest` | Infer review continuation from text | Semantic | New continuation uses typed Router result, review checkpoint ID/checkout validation; legacy API remains. |
| `src/implementation-stages.mjs`, `implementationPlanIntent`, `isReadOnlyUserRequest`, `isBareImplementationContinuation` | Detect saved plan references and questions | Semantic | Production execution path stops calling `resolvePlan` before Router. **Legacy test adapter** and reconciliation helpers still call old functions. |
| `src/execution-service.mjs`, `resolvePlan` | Choose existing Plan before routing | Semantic, early side effect | Production `runWorkflow` delegates choice to post-Router typed callback; legacy injected-workflow adapter still calls old parser. |
| `src/workflow.mjs`, plan continuation fast path | Bypass Router on recognized saved checkpoint | State optimization, permission sensitive | Old opt-in bypass retained for trusted direct caller; production newly selected natural continuation goes through Router. Authorization guard added for passed-in Plans. |
| `src/workflow.mjs`, reconciliation-only expressions | Decide approval/continuation by text | Semantic/confirmation protocol mixed | **Not fully migrated**. Affects special reconciliation commands; must be replaced with structured host decisions and typed status. |
| `src/review-efficiency.mjs`, `chooseReviewStrategy` | Risk/depth/cost strategy, text-derived review checklist | Mixed policy and semantic | Typed requirements accepted; existing scheduler, budget and feasibility preserved. Legacy checklist text interpretation remains in compatibility logic. |
| `src/review-efficiency.mjs`, `reviewExcludedPaths` | Exclusions by linguistic phrase | Semantic | Typed excludedPaths passed from Router to migrated path. Legacy export preserved. |
| `src/review-coverage.mjs` | Derive review checklist/obligations from text | Semantic obligations | **Still present**; review intent refactor not exhaustive. Must be examined for authoritative overrides. |
| `src/execution/instruction-projection.mjs` / `src/routing/context.mjs` | Instruction projection and minimal Router context | Deterministic context construction | Existing manifest policy retained; no separate RAG/index. |
| `src/providers/*`, structured output | Parse JSON / ACP result | Protocol parsing / contract checking | Existing provider-neutral structured output and strict validator reused. No provider-specific syntax required. |
| `src/implementation-tasks.mjs`, review checkpoint, Git SHA | Persist/verify task IDs, plan digest, checkpoint, scope | Deterministic state/fact validation | Kept, with typed continuation selection and plan validation before session mutation. |
| `src/security.mjs`, budgets, read-only sandbox | Enforce permissions and constraints | Deterministic security | Kept. Legacy eval cannot prove semantic truth of explicitness; see risks. |

### Audit findings that motivated changes

1. Text was interpreted at several layers with inconsistent precedence.
2. A saved Plan could be selected before semantic route classification.
3. Scope syntax recognized particular spellings instead of meaning.
4. Route and later lexical consistency checks could contradict each other.
5. Typed continuation and per-task user constraints were absent.
6. Model-native evaluation corpus for intent was not present in the baseline.

## 3. New architecture, changed boundaries

```
trusted host command / saved metadata / project instruction manifest
     -> EXISTING Router invocation (LLM, read-only)
     -> versioned task specification / schema validation
     -> typed continuation + Git selector resolution + policy
     -> existing workflow, review scheduler, quality gates, roles
     -> persisted review evidence / plan checkpoint / budgets
```

`src/routing/task-spec.mjs` defines the first contract. It uses exact version, closed enums and fields. Important fields:

- `operation`: `investigate | review | change | plan`.
- `writeIntent`: `explicit | not_requested | ambiguous`.
- `target`: `none | git` with `recent_commits`, `commit`, `range`, `relative_ref`, `worktree`, `staged`, `unstaged`, `ticket_commits` typed selectors.
- `constraints`: `excludedPaths`, `reviewDepth`, `priorityAreas`, `resourcePreference`, `verification`.
- `continuation`: `new | current_review | current_implementation | saved_review | saved_implementation | information | revise_plan | ambiguous`, optional saved-operation ID.
- `ambiguities`: list of user-relevant uncertainty descriptions.

The task spec describes interpretation, not authority: no shell commands, arbitrary git argument vector, unlimited resource controls or raw execution DSL. `src/schemas.mjs` adds the nested contract to Router output. The top-level route and nested operation are reconciled; a conflict cannot become a Change in the ordinary natural-language path. Invalid/missing semantic output falls back to read-only rather than lexical inference. **Known limitation:** the nested property is optional at the outer schema for compatibility, so models might omit it and degrade the task to read-only.

The Router sees task text, a projected instruction context and a compact `savedOperationMetadata` array. Full repository contents are not necessary for ordinary intent classification. Roles receive the validated spec plus resolved targets. The original prompt is retained for execution roles, audit and presentation, **not used as the new review selector**.

## 4. Git scope

`resolveReviewScope` accepts typed selectors and resolves them against the real repository. `recent_commits(count)` uses first-parent Git traversal, requires enough history and computes per-commit changed-file inventories. SHA/range/relative selectors are independently resolved by Git. Git arguments are predefined by selector type; refs are validated and not treated as shell. Snapshot identities and existing review Work Plan checkpoints bind operations to a fixed scope; continuing after HEAD drift does not silently adopt the new HEAD. Staged/unstaged/worktree inventory is available. **Limit:** combinations of multiple independent selectors are not modeled as a union, and some existing implicit textual selector behaviors are only in the legacy API.

The LLM cannot attest that a mentioned SHA is a real object; only Git does. Invalid refs/error conditions fail closed. The evaluation corpus contains multilingual equivalents including `/review-code по последним 5-ти коммитам`, but its actual live-model interpretation remains **NOT_VERIFIED**.

## 5. Continuation and plan selection

The production execution service (for the actual `runWorkflow` function) no longer performs natural-language `resolvePlan()` before invoking Router. It supplies saved operation summaries; a validated `current_implementation` or `saved_implementation` intent triggers a deterministic plan lookup. Before session selection, the plan ID, digest, repository root and checkpoint identity are checked. The workflow revalidates saved plan identity and repository state. Typed `information` / `revise_plan` requests do not activate a Plan. For review continuation, saved operation identity, validated checkpoint, scope, work units and budget are reused.

**Limit:** direct injected-workflow adapters and certain reconciliation legacy paths still rely on `implementationPlanIntent` / regex. The migrated production path is safer, but a full old-API deprecation is outstanding. A new Plan artifact stores `taskSpec` metadata; legacy Plans without it remain readable but do not gain new permissions.

## 6. Strategy, budgets, provider neutrality, telemetry

Review strategy can receive typed depth and resource preference. Mandatory verification and coverage are enforced by the same deterministic scheduler and quality gates. Token economy is not evidence of permission to skip required review units. Existing role presets, provider adapters and host-neutral core were not replaced. A `semantic_intent_validation` reporter event captures version, operation, selector class, ambiguity count and accepted/missing/invalid status, **not a full user prompt**. Existing per-run Router invocations/usage accounting remains. No measured claim of reduced cost is made.

## 7. Baseline and modified verification

The **original** `npm test` failed in this container at `ERR_MODULE_NOT_FOUND` for `@agentclientprotocol/sdk`, after syntax checks. `npm ci` could not complete, and `npm ci --offline` failed with `ENOTCACHED` for `zod@4.6.5`. The container provides Node `22.16.0` while the project requires `>=22.20.0`. These are independent environment blockers; they do not imply the source passes.

After changes, `npm run check` completed. Isolated targeted tests passed: `semantic-intent`, `semantic-workflow`, `structured-output`, `review-scope-hardening`, `security`, `context`, `review-work-plan`, `review-stabilization`, `review-coverage`, `review-efficiency`, `review-quality-workflow`, `review-hardening-integration`, `review-hardening-retry-integration`, `review-reliability`, `implementation-stages`, `implementation-reconciliation`, `implementation-task-continuity`, `skill-routing-presentation`, and additionally the corrected `evaluation/verification-effects-stage` and `evaluation/implementation-plan-durability`. The full `test:evaluation` progressed further but stopped at `p3-continuation.mjs`, which expects the pre-migration direct Plan route. `test/workflow-unstructured.mjs` similarly fails on old implicit review/plan continuation. Full `npm test` therefore **FAIL / INCOMPLETE** and no complete regression pass can be claimed. Live LLM semantic evaluation **NOT_VERIFIED**. Zed UI / ACP provider integration **NOT_VERIFIED**.

Find exact captured commands, output and exit codes in the accompanying test-logs archive. Original and modified top-level logs are not directly comparable as green/failed totals because the dependency failure occurred earlier in the baseline suite.

## 8. Three additional audit passes (bounded, non-exhaustive)

### Audit A — Semantic and permission correctness

- Checked conflicting nested and top-level route output and forged explicit-Change fields in fake Router tests: FAIL-CLOSED (confirmed PASS).
- Checked read-only questions, explicit `/change`, planOnly and invalid typed selector validation: relevant targeted cases PASS.
- **Finding A1 (open):** `namedSkillInvocation`, `inferReviewTarget`, reconciliation confirmations, legacy route consistency still contain linguistic decisions. This violates complete Single Semantic Authority.
- **Finding A2 (open):** semantically incorrect but schema-valid explicit `change` is not independently detectable; current tests prove *contract enforcement*, not classifier correctness or absence of false-positive writes.

### Audit B — Architecture and compatibility

- Typed resolver, first-parent commit inventories, Git ref verification, HEAD drift, persisted review units: targeted tests PASS.
- Saved Plan selection moved post-Router in production, with plan digest and checkpoint validation prior to selection: tested in new fake-Router workflow and durable stage fixtures.
- **Finding B1 (open):** direct legacy APIs still interpret natural text and are not fully migrated/deprecated.
- **Finding B2 (open):** preservation of exact typed intent across all legacy checkpoint migrations and additional combined Git selectors has not been exhaustively proved.
- **Finding B3 (open):** legacy test suites expect no Router call for new natural-language continuation and fail under this contract; compatibility work is incomplete.

### Audit C — Adversarial and regression

- Invalid schemas/ref selectors, HEAD changes, missing checkpoints, malformed/missing Router output, review retry and no duplicate reviewer work: targeted tests PASS.
- **Finding C1 (open):** full suite did not pass; some tests require ACP SDK not present, while others fail due actual migration contract differences.
- **Finding C2 (open):** no real provider invocation, Router timeout simulation for this new schema, longitudinal token cost measurements or Zed process restart exercise.

**Verdict:** Three independent audit *perspectives* were applied and evidence is recorded, but they did not clear every criterion; open findings are **not** relabeled resolved. The three audits are not independently conducted external reviews.

## 9. Live semantic evaluation and Zed acceptance protocol

Prerequisites: Node >=22.20, install locked dependencies (`npm ci` with package registry access), real Git repo, valid provider configuration and credentials.

```
cd role-orchestrator
npm ci
npm run check
npm test
npm run test:semantic-intent
node tools/semantic-evaluate.mjs "$PWD" test/evaluation/semantic-intent-corpus.json --run > semantic-eval.json
```

Inspect `semantic-eval.json` for false positive write intent, selector/continuation accuracy and invalid outputs. **Treat any false-positive write as a deployment blocker.** The runner does not change files. It measures models, not Git resolution.

In Zed, validate `/review-code по последним 5-ти коммитам` against a real repo, compare selected first-parent SHAs and files with `git rev-list --first-parent --max-count=5 HEAD`, start a deep review and restart the editor, verify review units/checkpoint/budget continuation, move HEAD and confirm no silent target migration, ask why a Plan exists (no coder calls), then explicitly request saved implementation (must select the matching planId/checkpoint), test ambiguous requests and provider cancellation, verify read-only workspace file hashes on Investigate/Review and full final verification on Change. Repeat with a second non-Codex/local provider. Capture metadata, review Work Plan, stderr/ACP trace without secrets.

## 10. Migration and remaining work

No mandatory changes to user model presets/config JSON have been introduced. However, deployed models must be able to produce the extended typed Router output; missing `task` degrades to read-only, not an automatic review/change. Roll out behind a test-only/opt-in deployment until both semantic evaluation and old suite are green. Copy the original ZIP separately as the rollback baseline.

Required remaining implementation work before asserting completion:

1. Eliminate or isolate the authoritative natural-language decision paths (`namedSkillInvocation`, `inferReviewTarget`, reconciliation expression parsing, review obligations, legacy service adapter).
2. Migrate older fixtures and public helper APIs without removing genuine protocol parsers or weakening /change semantics.
3. Complete legacy review/implementation resume equivalence tests including budgets and process restart; add combined selectors or reject explicitly with ambiguity.
4. Measure real LLM classifier reliability and false positive write rates, then harden ambiguity handling.
5. Run complete suite using supported Node/dependencies and live Zed/Codex/local ACP checks; repeat independent adversarial audit and close findings.

## 11. Changed files and patch

The accompanying patch lists the exact added/changed/deleted paths relative to the untouched input ZIP. The full archive includes the implementation, corpus, tests and this report, but because of the open findings it is an **experimental candidate, not an accepted complete refactor**.
