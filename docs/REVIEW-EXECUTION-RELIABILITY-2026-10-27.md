# Review Execution Reliability — 27 October 2026

## Explicit segment versus durable Review Operation

`policy.reviewEfficiency.executionBudget.maxInvocations`, `maxElapsedMs`,
`maxInputTokens`, `maxOutputTokens` are **execution-segment** ceilings for an
explicit invocation of the review workflow. Reaching one pauses incomplete
coverage. A user must explicitly continue the saved review operation; continuation
begins a new segment with fresh segment allowance and never automatically loops.

The same budget also accepts optional cumulative hard ceilings:

```json
{
  "policy": {
    "reviewEfficiency": {
      "executionBudget": {
        "maxInvocations": 4,
        "maxOperationInvocations": 24
      }
    }
  }
}
```

`maxOperationInvocations`, `maxOperationElapsedMs`, `maxOperationInputTokens`,
`maxOperationOutputTokens` span **all segments** of the same operation.
Once introduced, a hard ceiling cannot be raised or deleted via a later
configuration; stricter settings are accepted and persisted. The limit of
24 in this example is illustrative, **not** a recommended default. Keep or
remove it according to the actual operator's cost policy.

Tokens are not inferred from prompt characters or context occupancy. If a
cumulative hard token budget is set and provider usage is not available,
execution pauses with `usage_unavailable` rather than assuming zero spend.
No hard limit is silently extended. `reviewBudget` checkpoint version 2 stores
both cumulative counters and the current segment. Version 1 snapshots can
be resumed conservatively, retaining accumulated invocations. No active
reviews are restarted without explicit user intent.

For workflow-wide (non-review) budgets, existing per-turn semantics are unchanged.

## Authoritative Git scope

`/review-code по последним 5-ти коммитам` and `review last 5 commits` select
five commits including current `HEAD`, walking the **first-parent history**.
Every commit is compared with its first parent; the root commit, if selected,
is compared with the empty tree. Count must be 1–128; insufficient history
is an error rather than silent widening. All selected commit hashes, parent
hashes, and changed paths become fixed, hashed checkpoint/plan inputs. A
changed `HEAD` invalidates continuation, even if the wording stays unchanged.

Other selectors include explicit ranges, explicit single commit targets,
`relative to <ref>` / `относительно <ref>` (merge-base with `HEAD`),
`working tree`, `staged`, and `unstaged`. A mutually contradictory mixed
selector is rejected (`ambiguous_git_scope`). Merge commits in explicit
single-commit or ticket matching mode **still require** explicit parent
selection, as before. Relative-history mode, by definition, walks the first
parent. The resolved changeset list and file manifest remain distinct.

The Git scope is resolved and verified in the host-neutral core, not accepted
merely from an Explorer/Reviewer narrative. Missing history, unsafe revisions,
changed repository state and inconsistent checkpoints fail closed.

## Scheduling and recovery

Feasibility emits a lower bound `ceil(pending Units / maxUnitsPerBatch)` and
explicitly compares the current segment allowance with an optional overall
hard limit. This is advisory: dependency constraints, failed batches and
quality-gate follow-ups can require additional invocations. Coverage is never
raised by the estimate. Completed Unit evidence is reused only through the
existing authenticated-to-workspace checkpoint. An interrupted batch with no
finished structured result **cannot** be declared checked.

The recovery engine's `tool_effects_unknown` guard is intentionally retained:
read-only **workspace** permission does not prove an unknown external `execute`
tool was side-effect-free. A provider-native cancelled turn after unsafe or
unclassified tool events must not be replayed blindly. The new test proves
safe **inter-invocation** continuation, not recovery of model thoughts or
unfinished intra-batch conclusions. Host/provider cancellation provenance
must be inspected in live ACP tests.

## Observability

The existing `/efficiency export` receives allowlisted counters:
`reviewExecutionSegments`, `reviewSegmentInvocations`,
`reviewOperationInvocations`, `reviewOperationHardLimitReached`,
`reviewSegmentBudgetExhausted`, `reviewSegmentFeasible`, and
`reviewContinuationRequired`. Unobserved fields remain `null` (not zero).
Per-provider input, output and cached tokens remain unknown if ACP does
not report them. Reviewer prompt bytes and characters cannot substitute
for provider token costs. The existing instruction projection remains
**digest-verified and operator-reviewed**; references and active skills are
not silently dropped to improve token metrics. The operator can use
`review:context-inventory` and an audited `.agents/role-orchestrator/review-context.json`
manifest for controlled reduction.

## Validation

`npm run test:review-reliability` exercises 12 file/criterion Units over a
first-parent five-commit scope, one simulated reviewer failure, repeated
explicit continuation, checkpoint persistence, no repeated checked Units,
immutable operation hard ceilings, HEAD drift rejection, legacy budget
migration, and privacy-preserving metrics. `npm run test:review-hardening`
includes this scenario. Real Zed/Codex provider cancellation and provider
usage are intentionally **NOT_VERIFIED** by deterministic fake tests.
