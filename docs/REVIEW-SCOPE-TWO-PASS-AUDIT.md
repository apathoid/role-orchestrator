# Review scope and P3 corrections — two audit passes

## Pass 1: Git correctness, coverage, checkpoints, security

Findings and actions:

1. The old `commits-by-key` path aborted its entire inventory on an ambiguous merge. The resolver now retains per-commit changesets, provides `resolved`/`partial`/`unresolved`, and never selects a merge parent without explicit direction. `merge-parent=N` and explicit range inputs are supported. Two-parent, octopus and repeated-file histories were exercised in actual temporary Git repositories.
2. A path modified after being renamed could lose the prohibited rename origin when entries were collapsed by destination. Every historical `oldPath` is now preserved and evaluated against the security policy; the entire unsafe entry is excluded from the assignment and remains unverified. A regression test reproduces the multi-commit scenario.
3. Partial inventories must not yield a verified file total. Scope, Unit, criterion and file coverage are separate; `files.total` remains null when complete scope is unknown. Completion requires all evidence and a resolved mandatory scope.
4. Review checkpoints v2 are not reconstructed from model claims. Plan keys include merge strategy and unresolved commit identity. Changes that cannot be proved compatible invalidate reuse (deliberately conservative).
5. When all Units finish but Git scope is still unresolved, `review_scope_resolution_required` is emitted instead of a false completion or silent no-op.

## Pass 2: P3, ACP metadata, findings, response and compatibility

Findings and actions:

1. `Review batch 1/8` mistakenly conflated executed batches and the configured maximum. UI and CLI label the limit explicitly; the progress projection independently reports actual batches, maximum batches, Units and scope.
2. Added a redacted `review_progress` trace event and optional P3 counters (`reviewBatchLimit`, `reviewScopeStatus`, `reviewScopeReason`, `reviewFilesTotal`, `reviewFilesKnown`, `reviewFilesVerified`, `reviewFindingsRaw`, `reviewFindingsUnique`, `reviewFindingsPotentialDuplicates`). Session Store allowlists the fields and keeps unknown file totals null. Existing records remain loadable.
3. Review-only finding reconciliation uses a strong stable structured key when available, without changing the global P2 Quality State identity. Uncertain duplicates stay separate. Missed finding descriptions in responder prose are appended deterministically.
4. Observed ACP execute calls do not prove test counts. Workflow verification remains the trusted disposition; without trusted numeric evidence, test counts are marked unknown and unsupported numeric claims in review prose are downgraded. Tool contents, paths and prompts are not exported as telemetry.
5. Historical commit review targets retain explicit `mergeParentIndex`; if a requested inventory remains unresolved, the underlying Git reason is preserved rather than replaced by a generic one.

## Evidence

Successful local commands (exit code 0):

- `npm run check`
- `npm run test:review-scope-hardening`
- `npm run test:review-work-plan`
- `node test/workflow-unstructured.mjs`
- `npm run test:review-coverage`
- `npm run test:session-store`
- `npm run test:security`
- `npm run test:invocation-recovery`
- `npm run test:p2`
- `npm run test:p3`
- `npm run test:monitoring`
- `npm run test:evaluation`

The consolidated sequential run was stopped by the tool timeout while running `workflow-unstructured`; that same test passed separately, and the other suites also passed separately. This was an execution-environment limit, not evidence of a product test failure.

Limitations: Test runtime provides Node 22.16.0 (project requires >=22.20.0). `@agentclientprotocol/sdk` was not installed, so real Codex/Generic ACP integration and provider-originated cancellation were **not tested**. Static import relationships remain heuristic, and Git merge resolution remains intentionally partial without an explicit parent/range; the tool cannot infer the user's intended merge semantics from a ticket number alone.
