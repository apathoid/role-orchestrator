# Two-pass audit — Review-only efficiency

## Pass 1: correctness, storage, safety

- Confirmed reviewer budget is recorded after a validated Review Checkpoint and cannot be reset by normal `/review-resume` on an unchanged operation. Added integration coverage with a budget raised from one to two calls and then exhausted again.
- Confirmed CAS readback is bound to operationId, scopeKey, sourceKey; observed verification metadata is never accepted from the model. Added complete input-closure fingerprints so Git/source identity alone is insufficient for test reuse. If inputs or environment differ, execution is required again.
- Found and addressed parent-objects-directory symlink substitution on Evidence Store reads; child `O_NOFOLLOW` alone was insufficient.
- Added safe object cleanup after manifest publication, preserving active referenced objects and refusing arbitrary object filenames.
- Confirmed host finding adjudication cannot merge differences in explicitly distinct reproduction keys and requires a trusted witness set. Model-only claims are rejected.

## Pass 2: workflow integration, privacy, performance

- Verified only Review dispatch uses the new batch-specific evidence handoff, review budget resume, bounded history and new verification reuse. Non-Review routes do not opt in automatically.
- Confirmed user-authoritative scope, active skill, project policies and Engineered Core instructions are still mandatory context; optional history trimming is opt-in and conservatively disabled for historical references.
- Verified outputs render one record per independently reconciled finding. Original distinct findings are retained in Review checkpoint; the presentation layer cannot close previously unchecked Units.
- Added P3-only aggregate metrics without user text, file names, command lines or evidence bodies.
- Regressions: check, Review Work Plan, scope, continuity, efficiency, security, new review-completion and P1–P3 evaluation suite passed. No production live ACP run and no measured subscription quota savings in this environment.

## Outstanding independent validation

1. Repeat the real 28% vs 3% Review benchmark with identical Git snapshot and model settings, independently adjudicate findings and compare precision/recall/coverage and elapsed/token/quota cost.
2. Validate bounded historical context and optional verification caching with a real provider and trusted closure manifests before enabling them in production.
3. Supply a genuinely independent trusted host adjudicator for ambiguous semantic duplicates if automatic semantic merging is required; a reviewer agreeing with itself is not such proof.
4. Revisit cross-process CAS garbage-collection races if the same persisted Review Operation is intentionally written by multiple independent server processes. The current in-process lock serializes writes within one orchestrator process, and failed/missing mirror is harmless to authoritative completion.
