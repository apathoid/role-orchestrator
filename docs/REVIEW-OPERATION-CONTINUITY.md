# Review Operation Continuity — completion

## Purpose and semantics

Read-only reviews are now durable, session-scoped operations. An explicitly requested continuation (`Продолжи ревью`, `Continue review`, `/review-resume [operation-id]`) restores the saved review contract, bounded Review Work Plan, source task, selected skill and routing classification. It does **not** re-run Router, Explorer or Planner and does not interpret unrelated chat turns as continuation.

The checkpoint is version 3 and includes an immutable operation snapshot. Its `operation.id` is also the P3 cross-run group identity (`review:<uuid>`), separate from implementation tasks. Prior v1/v2 files remain readable; v2 can only be reused by the previous exact-task compatibility path, never guessed into a v3 operation. Initial v3 state is persisted before reviewer invocation when session persistence is available. Session Store retains its 20 MB state limit and checkpoint serialization adds a strict 1.5 MB bound without silent truncation.

Replay checks repoRoot, saved task binding, Git manifest/revision, allowed paths, instructions/skill/security scope, checkout fingerprint, original plan structure, evidence and unit prerequisites. Changes to only the number of units allowed per batch do not invalidate the original Work Plan. If verification fails, no prior evidence is reused for an explicit continuation.

An explicit `/review-reconcile merge-parent=N` command (1 <= N <= 16) runs a separate scope reconciliation. It verifies the old source scope and checkpoint, recalculates the new one, and reuses only unchanged independently evidenced *file* groups whose dependency closure remains valid. Criterion Units are rerun when the available Git scope changes. Incompatible reports and evidence are discarded, and events report reuse and invalidation. This is intentionally conservative: it may repeat more work to avoid an ungrounded pass.

## Findings and reporting

The review-only ledger is derived from persisted batch reports. It distinguishes a Finding from individual observations, exposes stable opaque `RF-…` IDs and per-batch occurrences, and retains multiple witnesses. Strong automatic merging requires grounded matching `contractId`/`reproductionKey`/path plus optional grounded failure/behavior descriptors. Weak prose/path matches remain separate *possible duplicates* rather than risk merging unrelated bugs. P2 `findingIdentity` and write authorization are unchanged.

Final findings are rendered deterministically from this ledger. Exact-substring checks against the responder's prose are no longer used, and each ledger Finding ID is rendered once. P3 `reviewFindingsReported` counts IDs in this authoritative generated section; `reviewFindingsReconciled` counts actual strong merges, not guesses. A provider that omits grounded structured identification may still generate multiple distinct records for one real defect: this is surfaced as uncertainty, not silently claimed to be deduplicated.

## Telemetry and caveats

P3 run records optionally include the allowlisted `reviewOperationId`, exact per-run `reviewBatches`, latest cumulative Unit counts, `reviewFindingsRaw`, `reviewFindingsUnique`, `reviewFindingsPotentialDuplicates`, `reviewFindingsReconciled`, and `reviewFindingsReported`. `executionGroupId=review:<uuid>` associates multiple sessions runs without confusing them with implementation tasks. The run record remains the unit for token and invocation accounting; never sum cumulative Unit counts across runs. Only opaque identifiers/counters go to telemetry and trace. Unknown token usage is null, not zero.

File evidence is still a model-reported source witness, **not** independent proof of deep file review. Actual Codex/Generic ACP integration and behavior under live provider cancellation are outside the local mock-provider test environment. Any saved v2 review cannot be transparently upgraded to the new explicit-continuation mechanism because it lacks a grounded persisted plan; start a new v3 review or invoke its old exact-task continuation path.

## Acceptance and checks

- `node test/workflow-unstructured.mjs` covers 28-unit multi-turn continuation (16+12), planner bypass, persisted findings and scope rejection.
- `node test/review-operation-continuity.mjs` covers explicit/accidental intent, conservative identity, report rendering, scope-reconciliation compatibility and P3 group projections.
- `node test/session-store.mjs` covers v1, v2 and v3 checkpoint round trips.
- Full evaluation and P2/P3/security suites retain their original contracts.
