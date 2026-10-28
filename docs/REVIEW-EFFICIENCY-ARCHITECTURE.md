# Evidence-oriented review efficiency (2026-10-26)

## Scope and intent

The previously fixed review execution graph created one invocation per two file/criterion Units, fed repeated exploration/plan/evidence to every reviewer and invoked a responder even though the final report was rendered deterministically. This patch improves that implementation while keeping its coverage ledger, fail-closed safety semantics, and persisted checkpoint v3 compatible.

## Adaptive execution

`policy.reviewEfficiency.enabled` is `true` in the bundled configuration. Set it to `false` to restore the legacy review execution path without changing the core, providers, presets, implementation pipeline or stored checkpoints. Review efficiency is independent of the chosen model.

- A read-only Git preflight establishes the true source inventory. Explicit negative file instructions such as `exclude foo.ts` or `router-context.json ... учитывать ... ненужно` are enforced before work-unit construction. An exclusion also applies to historical rename paths. It cannot grant new access or bypass the security policy. The filtered manifest has a distinct checkpoint identity.
- A deterministic strategy resolver selects `focused` (resolved, at most 16 known files and normal risk), `standard` (resolved, at most 36 files), or `deep` (unresolved/partial scope, high-risk data/security, or larger inventory). Explicit `reviewEfficiency.forceDeep` forces deep mode. The policy may override `maxFilesPerUnit` and `maxUnitsPerBatch` (limits 16 and 8). Deeper review remains available and is not sacrificed to a token target.
- Focused reviews skip the separate Explorer and Planner roles: the reviewer has actual repository tools and still must inspect all assigned files. Standard skips the Planner but retains Explorer; deep retains existing stages and batch sizes.
- The scheduler may place a criterion and all of its prerequisite file units into one assignment. It requires **separate concrete evidence for each**; no criterion is marked checked automatically. Dependent results are rejected if their prerequisites were not actually verified during this or an earlier batch. The repository still validates the source/workspace for drift before/after each invocation.
- A completed Review Operation stays compatible with saved Work Plan v1 and checkpoint v3. The execution policy changes the schedule, not the immutable coverage requirements, Unit IDs or evidence proof. On resume it still restores the persisted plan.
- The review responder is bypassed when adaptive execution is active because the existing workflow discarded its prose. Findings, summary and code-specific suggested fixes are rendered from the review reports and finding ledger without an additional model invocation. Escalation to FinalValidator is **not** suppressed.
- Prior reviewer handoff now contains a capped, explicitly *model-reported* evidence graph and known finding hypotheses rather than cumulative verbose report bodies. The full source reports remain durable and model-reported evidence is never promoted to tool-verified proof.

The original isolated legacy review tests remain in the suite under a disabled adaptive policy, alongside new adaptive integration/contract tests. The static file-unit and criterion ledger remains version 1. A fully generalized cross-workflow Coverage/Evidence Graph, automated semantic duplicate arbitration, fine-grained model-independent risk estimation and adaptive cost accounting for Implementation are **not** fully built by this patch.

## P3 observability

Additional optional allowlisted counters: `reviewExecutionStrategy`, `reviewEstimatedInvocations` (a bounded *lower-bound estimate*, **not** actual calls avoided), `reviewScopeExcludedFiles`, `reviewRolesBypassed`, `reviewPriorEvidenceCharacters`. They never persist paths, prompts, file contents or individual reviewer reasoning. The existing usage counters remain `null` when providers do not expose usage. The actual 5-hour Codex quota is not inferable from these counters.

## Recommended validation

- `npm run check`
- `node test/review-efficiency.mjs`
- `node test/review-work-plan.mjs`
- `node test/review-operation-continuity.mjs`
- `node test/review-scope-hardening.mjs`
- `node test/workflow-unstructured.mjs`
- `npm run test:evaluation`
- Real ACP A/B run on identical Git revisions: compare independent, adjudicated blocker/major finding recall and precision, source coverage, elapsed time, invocation count and externally observed quota depletion. Do not accept fewer tokens in exchange for omitted required checks.
