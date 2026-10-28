# Review Work Units and durable review checkpoints (v2)

## Architecture

This functionality applies to the **review workflow**, regardless of user command or active skill. Slash commands are *not* special-cased. The pre-existing universal Invocation Recovery Engine retries eligible **read-only invocations** according to its existing safety policy; Review Units govern work scheduling and durable progress between separate workflow runs. Change-workflow implementation checkpoints are unaffected.

- `src/review-scope.mjs`: read-only Git manifest for an explicit `base...head` / `base..head` range, a resolved historical single-parent commit, explicitly requested working-tree changes (including untracked files), or matching commit messages for an explicitly named ticket. Invalid/ambiguous targets remain *unverified*, never guessed. Commit and baseline OIDs are resolved before hashing. The current checkout state is also independently fingerprinted.
- `src/review-relationships.mjs`: optional bounded, read-only extraction of **relative static imports** from the selected immutable Git tree (or requested working tree), for **permitted paths only**. It records path-to-path scheduling hints, not source contents. Unsupported syntax, commits-by-key, deleted files, unavailable/oversized files, and inventories above the scan cap fall back to path-based grouping. Unresolved imports are not treated as verified dependencies. This is deliberately not a whole-program dependency analyzer.
- `src/review-work-plan.mjs`: deterministic Review Units with stable IDs (`CS1`, `CA1`, `F00001`…), each mapping to an original criterion or a bounded group of Git paths. Grouped paths include add/delete/rename metadata. Planner prose cannot redefine the source manifest. Changed files are grouped by subsystem and related implementation/test basename within the bounded Unit size. Cross-Unit static import relationships create explicit prerequisites and related-unit metadata; cyclic imports preserve the relationship but receive a deterministic, acyclic execution order. Criteria are associated with matching file groups when the path relationship is evident; otherwise their prerequisites conservatively include **all** changed file groups. Dependency-aware scheduling is re-evaluated after each batch, so an unchecked prerequisite blocks dependent work rather than allowing a misleading result. Source file Units are scheduled before their dependent criterion Units when a verifiable Git manifest exists. Full completion requires independently assigned criterion **and** file Units to be checked. The resolved Git source commits are included in the reviewer instructions, and movement of a referenced Git base is checked again before accepting a batch.
- `src/review-checkpoint.mjs`: persisted v2 evidence ledger, checkpointed by immutable Unit IDs rather than batch ordinal. A v1 checkpoint remains loadable, but is not automatically mapped into the new contract unless a future implementation can prove a lossless mapping.
- `src/workflow.mjs`: uses the existing generic role invocation and safety-aware recovery; schedules only pending Units for each new run, validates results before committing evidence, detects workspace drift before and after a batch, persists after successful batches and reports incomplete coverage without manufacturing `pass`.
- `src/efficiency/analytics.mjs`, `src/observability/execution-observer.mjs`: structured, path-free unit events and P3 counters. `/checkpoint` displays unit-based progress for v2.

## Scope and completeness guarantees

`reviewedPaths` alone is not sufficient. Each file Unit requires a complete set of exactly matching paths and a bounded `fileEvidence` record per assigned path with concrete inspection evidence; missing, duplicate, partial or out-of-scope paths prevent its verification. Criteria Units require their own evidence. These are **model-reported evidence records, not cryptographic proof** that source content was actually read. The orchestrator verifies assignment membership and completeness, not all semantic claims made by the model. Findings from otherwise incomplete batch responses are still preserved in the report. The final response must describe remaining gaps as incomplete rather than production-ready.

If the task identifies a branch without a comparison base, or merely asserts a changed-file count, the system cannot establish a verifiable Git range and therefore cannot declare full coverage. User-supplied expected file counts are compared against the independent Git manifest when it exists. References to an incidental historical SHA do not redefine scope. Disallowed files are never assigned to the reviewer and remain explicit incompleteness. For **renames and copies**, both `path` and `oldPath` are checked against the active security policy: if either side is denied, the whole change is excluded from assignments and relationship analysis, but counted as inaccessible. Very large diff inventories or unsupported merge-target semantics fail closed rather than silently truncating scope. Unsupported/unresolved scope produces a useful partial review and an explicit limitation.

## Limits and configuration

The optional `policy.reviewWork` configuration sets the per-invocation/per-run budgets:

```json
{
  "policy": {
    "reviewWork": {
      "maxFilesPerUnit": 4,
      "maxUnitsPerBatch": 2,
      "maxBatchesPerRun": 8
    }
  }
}
```

Ranges are `1..16` files/Unit, `1..8` Units/batch and `1..16` batches/run; default values are shown. At most 1024 Units are planned per scope. All omitted units and criteria remain explicit coverage gaps. Exceeding a *per-run* limit produces `review_incomplete` and a reusable checkpoint, rather than dropping the remaining scope. Only ready Units with verified prerequisites can enter the next batch. If a prerequisite is `blocked`/`not_checked`, its dependents remain pending and can be attempted on a future compatible run. Batch grouping can change without invalidating already verified Units; changing the Unit definition, task scope, Git base, checked-out files, security policy, or instructions makes the old checkpoint inapplicable.

One invocation is not repeated merely because a Unit was `blocked` or `not_checked`; those assignments remain pending for a later compatible run. `PROVIDER_CANCELLED` still uses the existing safe invocation-level retry policy. A stale or malformed checkpoint is rejected, never optimistically reused. If checkpoint persistence fails (including a bounded finding-ledger limit), the UI reports that it was **not saved** (and `checkpointDurable` is false); this does not falsely turn a completed read-only execution into a provider error.

## Structured trace / efficiency

Events: `review_plan_created`, `review_unit_started`, `review_unit_completed`, `review_unit_interrupted`, `review_checkpoint_persisted`, `review_continuation_ready`, `review_scope_invalidated`, plus backwards-compatible `review_batch_*` and `review_checkpoint_*` events. Trace contains bounded IDs, counts, and statuses only—no Git paths, prompts or tool outputs. P3 counters include `reviewUnitsTotal`, `reviewUnitsVerified`, `reviewUnitsPending`, `reviewUnitsResumed` and `reviewWorkRepeated` (observed retries within one run). Old persisted P3 rows normalize these new counters to zero.

## Verification

- `node test/review-work-plan.mjs`: Git range and ticket manifests, historical commits, worktree paths, scope uncertainty, subsystem/test grouping, real relative-import graph, cyclic edges, blocked prerequisites, checkpoint tamper/drift, policy exclusions and efficiency telemetry.
- `node test/workflow-unstructured.mjs`: fake-provider integration, 65-file review split across two workflow runs, safe reuse after batch regrouping, invalidation after base-ref changes (including movement during an active reviewer turn), blocked imported prerequisites, denial of both sides of renamed paths, incomplete file-specific evidence, and interruption/recovery regression cases.
- `node test/session-store.mjs`, `node test/config.mjs`: version-2 persistence and limits.
- `npm run test:p2`, `npm run test:p3`, `npm run test:monitoring`, `npm run test:invocation-recovery`, `npm run test:security` for cross-feature regression.

**External verification boundary:** The test environment has no authenticated live Codex/Generic ACP session. Real-provider behavior, including the original long-running reviewer cancellation, must still be observed in a supported Node.js environment with installed dependencies. This is an integration-verification limitation, not a claim of production-ready ACP resilience.
