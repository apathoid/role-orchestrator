# Staged evidence and read-only review resilience

Base: `role-orchestrator-plan-intent-routing-fix-source.zip` (P1 + Plan Continuity).

## Changes

1. Stage evidence is evaluated against the **actual stage delta**. A stage can
   have a successful `proofKind: verification` with non-empty structured
   `checks` even if it makes no new file changes. `proofKind: analysis` also
   describes legitimate non-mutating investigation. Code-change claims still
   require an observed changed path, unless a step honestly reports
   `already_satisfied`. A check with `failed` or `unavailable` outcome cannot
   be marked complete, regardless of the model's reported status. Existing
   saved plan and checkpoint formats are unchanged.
2. Distinct interruption codes distinguish `verification_failed`,
   `verification_unavailable`, `invalid_stage_evidence`, and Git drift.
   Actual check problems remain in `checkpoint.interruption.problems` and are
   visible in the immediate ACP event, `/checkpoint` and the final incomplete
   status. No automatic stage re-run occurs.
3. An unexpected `PROVIDER_CANCELLED` during the change workflow's
   *independent read-only* reviewer or finalValidator may retry exactly once,
   using a new invocation-scoped provider session. Retry is forbidden if the
   outer signal was aborted, an outgoing inner ACP cancel was recorded, the
   checkout fingerprint changed, or the failure is any other type. Coders,
   completed stages, write operations and configured verification are not
   automatically rerun by the retry helper.
4. If review still cannot complete, the workflow returns
   `review_interrupted` as an ordinary structured incomplete result rather
   than propagating a raw provider error. The staged checkpoint and completed
   stage prefix remain intact, and the independent review and acceptance gate
   remain incomplete. Safe typed cancellation provenance is retained without
   raw prompts or outputs. Any previous reviewer result in the current run is
   also retained as evidence if later final validation is interrupted.
5. ACP, CLI reporter and P1 observability recognize the new retry and
   interruption events; `/checkpoint` shows bounded interruption reasons.

## Invariants

- No silent successful review or acceptance status after provider cancellation.
- No automatic retries of the mutating coder or of stages whose checkpoint is
  durable.
- No automatic rebaseline if the checkout changed unexpectedly during review.
- The proof provided by a model is **not independent confirmation** of command
  execution. Configured verification and independent review remain required.
- Existing provider adapters, host-neutral architecture, saved session shapes
  and security policies are unchanged.

## Test coverage

The real staged workflow tests now include an I2 with no new file changes and
structured passing check results, a failing check that blocks I2, a read-only
reviewer cancellation followed by a successful fresh invocation, and a
second-cancellation path yielding `review_interrupted` with an intact completed
checkpoint and explicit continuation using the saved Plan. Legacy evidence
fixtures were adapted to state when an actual change was observed.

Real Zed ACP integration and the precise upstream reason that produces
`stopReason=cancelled` remain outside the deterministic fake-provider test.
