# Durable implementation tasks and safe continuation

## Why

Previously, a staged Change could save an `implementationCheckpoint` without
saving the Plan that produced it. A subsequent independent Change would also
receive that unrelated checkpoint and fail validation. Plan mode overwrote the
one stored Plan/checkpoint pair. Those behaviors could strand completed stages
and block unrelated tasks in the same persistent chat.

## Ownership and persistence

The host-neutral execution service owns the implementation task catalog.
Each task has a stable `taskId`, original `planId`, durable Plan, independent
checkpoint, reconciliation proposal, and provenance. The session stores
`implementationTasks[]` and `activeImplementationTaskId`. The legacy
`implementationPlan`, `implementationCheckpoint`, and
`implementationReconciliation` fields are synchronized compatibility aliases
for the active task. The session store still uses atomic session JSON writes.

The real workflow calls `onImplementationPlan` **before preparation or any
writable coder stage**. Failure to persist the Plan fails closed before edits.
The checkpoint callback refuses a missing Plan or mismatched `planId` and
cannot silently replace another task's checkpoint.

Independent requests receive **no** saved Plan/checkpoint/reconciliation,
regardless of the current unfinished task. A new structured Change or Plan
is stored as a new task, preserving previous task state. Explicit continuation
selects the active Plan, or an archived Plan by ID, before workflow execution.
The core also discards orphan checkpoint inputs when no authoritative Plan is
selected. Question/read-only requests never activate an implementation Plan.

A legacy session with a Plan and matching checkpoint is adopted unchanged.
An existing checkpoint with **no Plan**, or a mismatched Plan ID, is retained
as a diagnostic orphan; a Plan is never fabricated from incomplete stage data.
The original source and tests are unaffected. If the original Plan cannot be
recovered from another backup/session, use a read-only repository audit to
form a new Plan for the remaining work.

## User-facing commands

`/plans` lists stored tasks without invoking a model or modifying the repository.
The current active task and unfinished/completed stages remain visible through
`/checkpoint`. To continue the active task use `Продолжи реализацию плана`,
or `Продолжай` if it has an unfinished implementation checkpoint. To select a
particular previous task use `Продолжи реализацию плана <plan-id>` (or task ID).
Specifying the full ID avoids ambiguity.

Before resuming an old task after other changes, the existing repository
reconciliation validates checkout drift and may require additional evidence,
user confirmation or an updated plan. Archiving a checkpoint does not imply
its assumptions remain valid. Completed stages are never silently replayed.

## Saved Plan intent versus ordinary Change

A read-only investigator may present a useful textual plan in the chat, but
it is **not** a durable structured implementation Plan and is not listed by
`/plans`. A follow-up such as `Внеси необходимые изменения и закончи реализацию
задачи` must therefore start a new Change, whose actual structured Plan is
saved before any coder edits. The words `реализация` / `implementation` alone
never select a saved Plan.

Saved Plan selection is separate from the general user request to change code:

- Explicit requests such as `Продолжи реализацию плана`, `Реализуй предыдущий
  план`, `Implement saved plan` or `Согласуй текущее состояние checkout`
  select a saved task and report a clear error if none exists.
- Context-dependent commands such as `Реализуй план` or `Continue
  implementation` select the active Plan if one is available; without one they
  enter ordinary new-Change routing rather than inventing a checkpoint.
- New tasks, including requests based on a previous read-only audit, never
  inherit an unrelated saved checkpoint. Read-only questions never enable
  write access. Explicit `/review` and `/investigate` remain authoritative.

Intent classification is deterministic and host/provider-neutral; the router
still decides whether an ordinary user turn has explicit write authorization.
The existing project and task history is not rewritten by this migration.

## Recovery of invalid stage evidence

An `invalid_stage_evidence` interruption now stores the exact bounded issues
and changed paths in `checkpoint.interruption` in addition to the preserved
completed-stage prefix and workspace fingerprint. The next coder turn sees the
interrupted-stage instructions and must inspect the existing changes. If they
already satisfy all assigned S-IDs, it may return truthful `already_satisfied`
rows with evidence. This does **not** bypass structural validation,
verification, Git drift or review; a stage is only completed after those gates.

## Limits and compatibility

This is a lightweight task archive, **not** full independent branching or
multi-checkout Task Workspaces. Different tasks still share the user's real
working tree. Up to 100 tasks are retained in a session; the system refuses a
new Plan once full instead of silently deleting older work. Native ACP
presentation, existing provider abstraction, session lifecycle and P1
observability remain unchanged.

Regression coverage: `test/implementation-task-continuity.mjs` exercises
archiving, independent Change, restart, selecting the old Plan and failure
rollback; `test/evaluation/implementation-plan-durability.mjs` executes the
real workflow with fake providers through an interrupted I2 and resume.

## Non-mutating stage evidence and reviewer cancellation

The last implementation stage may be verification or analysis of code already
written by previous stages. It is not required to produce an artificial file
change. A structured coder result may mark a non-mutating step `implemented`
with `proofKind: verification` and an explicit `checks` list containing the
actual command, `passed`/`failed`/`unavailable` outcome and evidence for each
check. An analysis-only step can use `proofKind: analysis`. A stage marked
`already_satisfied` remains valid only when its requirements genuinely hold.
`proofKind: change` without an observed change is not accepted. Failed or
unavailable checks prevent stage completion, regardless of the reported status.
These reports are model-provided evidence, **not** independent proof that a
command ran; configured verification and independent review remain authoritative
for global acceptance. The saved completed-stage prefix is unchanged.

For an unexpected, provider-origin `PROVIDER_CANCELLED` during a read-only
review/final-validation invocation, the workflow makes at most **one** new
invocation with the same evidence, only if the outer signal is active, no
outgoing ACP cancellation was recorded and the workspace fingerprint has not
changed. There is no retry for coder, tool/timeouts, user cancellation,
supersession, write-mode operations, or other provider errors. The inner ACP
adapter creates a new invocation-scoped session for the retry.

After two such cancellations, or if the repository changes during review,
the workflow returns `review_interrupted`, **not** a successful review or raw
provider exception. A staged checkpoint keeps its completed stages and records,
with an `integration_review` interruption marker. If a reviewer finished before a later validator cancellation, its bounded review evidence is retained as diagnostic context but does not certify acceptance. A subsequent explicit Plan
continuation (or contextual `Продолжай` for this active interrupted task) revalidates checkout state, skips completed coder stages and
repeats required verification/review. The review is never assumed to have
passed. Read-only `/checkpoint`, live ACP progress, and execution trace include
bounded diagnostic codes and reasons without persisting raw tool outputs.
