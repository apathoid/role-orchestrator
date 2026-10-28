# Review-only Evidence-driven Efficiency — completion increment

**Scope:** Review workflow only. No execution-policy changes to Investigation, Planning, Implementation or Fix Round. Existing generic helpers (`ExecutionBudget`, CAS evidence, P3) gain backward-compatible APIs; their existing non-Review callers keep their behavior.

## Implemented and connected

1. **Review evidence handoff:** `src/review-evidence-runtime.mjs` selects model-reported prior Unit evidence relevant to assigned file paths, prerequisite Units and related Units. Completed IDs and unique known finding hypotheses remain visible; unrelated bulky evidence is omitted from the next prompt, not deleted from the authoritative Review Checkpoint. The reviewer is instructed to inspect primary source when needed. The handoff is bounded and reports omissions.
2. **Durable per-operation reviewer budget:** `ExecutionBudget.snapshot()/restore()` is used by Review after validation of checkpoint v3 and matching checkout/scope/security. Consumed reviewer invocations persist across `/review-resume`. Elapsed time accumulated is *active execution time*, not time a Review was paused. Unknown provider usage remains unknown; partial usage cannot trigger a token-based completion claim.
3. **Host-observed verification reuse:** `src/verification/executor.mjs` records positive command observations only when the configured verifier genuinely ran. A reusable observation requires successful exit, approved command, exact Review source/scope identity, and a complete, trusted `AGENT_VERIFY_INPUT_CLOSURES` manifest whose current path/environment fingerprints match. Missing manifests or unstable inputs forbid reuse. Failed/unavailable tests are not cached as passing. The cache is stored in the optional CAS mirror only after durable checkpoint publication and can never independently mark a Review Unit satisfied.
4. **CAS durability:** `src/evidence/store.mjs` stores bounded review-observed verification metadata without full outputs. A new manifest is committed atomically before safe cleanup of superseded hash-named objects. Reads refuse symlinks both on objects and the `objects/` parent. Damaged or mismatched mirrors never override the v3 checkpoint.
5. **Host-verified semantic reconciliation:** `runWorkflow` supports optional `onReviewFindingAdjudication({operationId,scopeKey,sourceKey,candidates,ledger})`. It must return verified witness digests and explicit equivalence decisions from a trusted independent host, not from untrusted model prose. Ambiguous findings are retained if no independent adjudicator is connected. No mandatory extra model invocation is added. The resulting *presentation* ledger is deduplicated, while the original observations remain durable.
6. **Opt-in bounded reviewer history:** `policy.reviewEfficiency.contextMode='bounded_history'` uses `src/review-context.mjs` to shorten only old, non-authoritative conversation history for reviewer invocation. Core, role, active skill, source scope and current task remain intact. Explicit references to earlier instructions disable truncation. Default mode is `legacy`; quality equivalence must be established before rollout. Both static and dynamic `roleSessionContext` are handled.
7. **P3 aggregate counters:** Review handoff unrelated-evidence omissions, targeted verification reuse and reviewer-history savings are stored as safe integer counters. No raw prompts or evidence bodies are exported.

## Configuration

```json
{
  "policy": {
    "reviewEfficiency": {
      "enabled": true,
      "contextMode": "legacy",
      "maxHistoryCharacters": 10000,
      "executionBudget": { "maxInvocations": 4 }
    },
    "evidence": { "persistentStore": true },
    "verificationEfficiency": { "autoExecute": false, "safeCommands": [] }
  }
}
```

This is a fragment, not a complete configuration. To enable reviewer history bounds deliberately, choose `contextMode='bounded_history'`. To enable verification, set `autoExecute=true`, supply exact host-approved command names in `safeCommands`, and separately configure allowed verifier commands and their complete input-closure declarations. Never treat missing closure evidence as a cache hit. Scope of budget: reviewer invocation count within one logical Review Operation, including resume; it is **not** a subscription or provider account quota manager.

## Trust and compatibility

- Review Checkpoint v3 remains the completion authority; CAS is advisory evidence persistence and verification cache.
- Only workflow/host witnesses can generate a `tool_observed` verification result. Model-reported JSON can never create a cache hit or elevate proof.
- Worktree/commit changes, changed scoped instructions or security policy invalidate reuse conservatively.
- Findings semantic adjudication without a trusted host is intentionally conservative; it reports possible duplicates rather than inventing independent equivalence.
- Legacy and non-Review paths, Engineering Core, P2 Quality State, P3 privacy, ACP presentation, skill precedence and cancellation behavior are retained.

## Verification and limitations

Automated: `npm run check`, `npm run test:review-efficiency`, `npm run test:review-operation-continuity`, `npm run test:review-work-plan`, `npm run test:review-scope-hardening`, `npm run test:review-completion`, `npm run test:security`, `npm run test:evaluation`. New cases verify budget continuity, host equivalence, source/input cache invalidation, observed-tool-only caching, per-batch context, CAS object GC and symlink refusals.

**Not established by offline tests:** equivalent defect recall and precision from a live GPT-6.1-Sol/Codex review, effect of bounded historical context on quality, semantic equivalence without an independent host verifier, automatic independent semantic adjudication, or actual 5-hour Codex quota savings. Do not call these live acceptance criteria passed until A/B comparisons on identical snapshots exist. `workflow-unstructured` is a historically long-running suite; it is not counted here as completed.
