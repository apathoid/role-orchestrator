# P2: Evidence-Driven Execution & Smart Recovery

## Architectural owners

The **implementation task** (`src/implementation-tasks.mjs`) still owns the Plan, implementation checkpoint and reconciliation. The P2 `quality` object is **inside that same durable task**, not in the P1 event stream and not in a separate task database. The authoritative session JSON continues to be written atomically by `src/session-store.mjs`. `execution-service.mjs` is the only production path that coordinates task changes, checkpoint evidence, final evidence ingestion and decisions with session persistence. P1 execution events are diagnostic projections only.

`src/quality-state.mjs` is host/provider-neutral. It implements versioned task quality, evidence, findings, stale checking, state-bound decision gates and read-only recovery assessment. `src/quality-view.mjs` builds read-only Markdown from that state without providers; `src/acp.mjs` only advertises/render commands and forwards explicit user choices. The host never dictates truth or scheduler actions. Existing Engineering Core, checkpoint validation, scope fix decision, review continuation, security and timing remain in their original owners.

## Evidence provenance and acceptance

An `EvidenceRecord` links a subject (`A1` acceptance, stage, finding or verification command) to a claim, source kind, outcome, dependency binding and run identity. Direct results returned by `repo.runVerification`/`runWorkflowVerification` are `tool_execution` evidence; `stepResults` and reviewer `acceptanceResults` are **role_report** evidence, never independently executed checks. No raw command output is retained in quality state. A command's exit code/status must be observed for it to be eligible to pass or fail. Infrastructure/environment failures stay `unavailable`, not `TEST_FAILED`.

A command-bound criterion becomes **verified** only if all of the following hold:

1. The Plan declares the exact command in optional `acceptanceChecks` for that criterion ID (`A1`, `A2`, ...).
2. The orchestrator directly executed this configured command with a successful result.
3. The independent reviewer explicitly linked the criterion to this exact command in its acceptance report.
4. A trusted host/operator verification input closure was explicitly declared, its source fingerprints still match, and verification itself did not mutate the checkout.
5. All mandatory checks for this criterion passed in the **same observed run**, with no contradictory current failure.

Absent a binding, a role's report remains `supported` or `unverified`. This is an intentional conservative change from P1's model-reported acceptance. Plans without `acceptanceChecks` continue loading, but their criteria are not automatically upgraded. Static/source-review evidence can support engineering judgments without masquerading as a completed runtime check. Evidence Matrix is computed from stored records, never saved as a second checkpoint.

A code-level checker can only validate the result it measures: for example, a passing `git diff --check` does **not** demonstrate an API works. The Plan is required to specify a meaningful check; reviewer and human judgment still matter. No agent transport tool-stream events are elevated to trusted executions, since generic ACP providers do not give this core a universal, verified command-result boundary.

## Freshness

P2 supports two dependency strategies:

- Explicit paths, fingerprinted by current file contents, with validated repo-relative names and symlink refusal. Unrelated paths do not make these records stale; unknown/inaccessible dependencies are `unknown`.
- Conservative **checkout** identity for commands without a trusted complete input manifest: changes make the old result `stale`, while unchanged Git state remains **`unknown`**, never `fresh`. Ignored files, environment, dynamic dependencies and external services cannot be inferred from HEAD/status.

If verification changed the checkout, evidence freshness defaults to `unknown`. A change to the known checkout makes prior checkout-bound evidence `stale`; an unchanged checkout is not proof of freshness. Explicit input-file fingerprints include `.gitignore` files when declared. `freshnessOf` has no workspace mutations. Old sessions have no implied trusted freshness. Targeted revalidation requirements are exposed in the recovery projection; the existing workflow continues to run its configured verification suite rather than blindly skipping mandatory commands.

## Findings

Findings are task-owned, with stable UUID, evidence ID references, strict contract+reproduction+path identity (falling back to an exact issue/evidence key, never severity/scope), optional possible-duplicate hints, severity, confidence, lifecycle (`candidate`, `confirmed`, `disputed`, `resolved`, `reopened`), reported sources and an append-only transition summary. Similar text alone is not used to merge issues across paths or differently classified contracts. A repeated finding reopens a resolved issue without losing its history. An observed failing command can confirm a finding **only** when the report cites that exact command. Marking a finding resolved requires saved evidence; a reviewer pass does not remove stored problems. `remediationAuthorization` is separate from correctness; findings do not grant repository writes.

## Smart Recovery

`assessRecovery` is **read-only**. It projects saved Plan/checkpoint identity, completed stages, next stage, evidence grouped by fresh/stale/unknown, findings, checkout drift and required actions. It retains legacy orphan diagnostics without creating a synthetic Plan. For drift it reuses the existing implementation reconciliation snapshot and path-diff mechanism; workflow (not quality) owns the decision to reconcile and proceed. A stage completed in the checkpoint stays completed; uncertain proof triggers required verification, not automatic recoding. Existing review cancellation handling and checkpoint continuation remain authoritative.

## Decision gates

A scope-approval request generates a task-owned gate with two explicit options, bound to the Plan, checkpoint identity/status/completed stage prefix and current checkout fingerprint. Only a real host-requested `/decide` can resolve it. Multiple pending gates require identifying the gate. Choice replay is idempotent against an unchanged binding; changed state invalidates the old choice. Approval is checked again by workflow **immediately before** scope-aware fix adjudication. No gate bypasses ACP tool permissions, repository security or the requirement for an explicit implementation continuation request. Provider reports/instructions are never user approval. Gates do not schedule or start a coder.

## Read-only interfaces

ACP exposes `/evidence`, `/findings`, `/recovery` and `/decisions` with no model invocation or file mutation; `/decide [gate-id] <option>` is an explicit, mutating *decision-record* action, **not** a tool execution. Current P1 `/status` overlays P2 counts/recovery status. Historical P1 run views are not replaced with today's mutable task quality.

## Compatibility and persistence

Unmodified v1 task/Plan/checkpoint data remain loadable; legacy quality is an empty read-only projection, not observed verification. Quality records have a 2 MB per-task budget, 800 records per collection, bounded prose and relative path dependency quotas; oversized/malformed quality or full sessions fail closed rather than silently erasing records. A session JSON write remains atomic and preserves unrelated tasks. Checkpoint evidence is persisted in the **same session operation** as that checkpoint to withstand process interruption. The original P1 diagnostic exporter remains optional and is not used as source of task state.

## Limits to validate in production

- Full semantic coverage of complex acceptance criteria cannot be proven merely from a model-generated Plan, command exit code or reviewer text. Without explicit meaningful verification bindings, criteria intentionally remain unverified.
- For generic ACP providers, there is no universal trusted record of arbitrary commands launched privately by an inner coder/reviewer; those remain role claims. Configured orchestrator verification commands do have observed results.
- Path-targeted *execution* of only affected tests is not automatically scheduled; the recovery proposal identifies revalidation needs, while the existing complete verifier remains the safe fallback.
- Automatic repair selection remains owned by existing workflow and security mechanisms; P2 provides state-bound approval and evidence, not a new scheduler or autonomous permissions system.
- ACP native commands and non-mocked provider end-to-end integration require installed ACP dependencies plus a compatible Node version. Check `package.json` for current runtime requirements.

## P2 completion additions (October 2026)

### Source-anchored acceptance (bounded static review)

The Plan may optionally carry `acceptanceReviews: [{ id: "A1", paths: ["src/contract.mjs"] }]`, aligned to every acceptance criterion, in addition to `acceptanceChecks`. For a criterion with **no declared commands**, an independent `implementationReview` can include `sourceAnchors: [{path, excerpt}]`, with an exact 12–300-character excerpt from every declared path. The core verifies these excerpts against ordinary, symlink-free in-repository source files, then records a `static_review` **supported** evidence row with per-file content hashes.

`evidenceMatrix.proofMethod` explicitly distinguishes `source_attested_not_semantically_verified` from `observed_command_with_review`. Source anchoring proves **only** that the quoted bytes existed in the inspected file, not that the reviewer interpreted them correctly. Such evidence returns `supported`, **never `verified`**; e.g. `authorized = false` cannot prove authentication succeeds. Invalid, missing, swapped, unsafe or stale anchors fail closed. Legacy Plans lacking these fields retain the original Plan ID/digest and do not get upgraded silently.

### Findings: observed remediation and regression

A previously confirmed/reopened finding is automatically marked `resolved` only when all the following are true: a previously failing **observed configured command** is repeated and observed passing in a different checkout, its reported affected source path is actually listed in the current workflow's changed paths, the full configured suite passed, independent reviewer and final validator both pass without reporting the finding, and the verification fingerprint is inspectable. A role-only `pass`, source review alone, arbitrary file change or unavailable test does not resolve it. A subsequent model report alone does **not** reopen a resolved finding. Only a newly recorded, relevant observed failure of its previously failing check after the successful repair evidence can establish `reopened` (and the transition history is retained).

These deliberately conservative conditions mean some fixes remain open until a trustworthy reproduction path, affected source localization or independent validation becomes available. They are not grounds for silently ignoring a confirmed issue.

### Recovery preflight and targeted suggestions

For a saved Plan continuation, the workflow calls a host-neutral, read-only recovery assessment **after** its existing checkout/reconciliation checks, immediately before any writable stage. It verifies that the checkout did not change during that assessment and stops on orphan/mismatched checkpoint blockers. The result is supplied to resumed coder/reviewer context with explicit stale/unknown limitations; saved completed stages are not replayed merely because quality evidence is stale.

`assessRecovery.revalidationTargets` offers typed suggestions for `reinspect_source`, `rerun_configured_verification` or `reassess_claim` for each stale/unknown record, bounded in size. These are *advisory*, not a new scheduler. The existing full mandatory verification still executes for final acceptance. There is not yet a proven dependency-closed safe optimization that skips unaffected mandatory commands. Supplying an unverified dependency graph and skipping checks based on it would violate the P2 correctness invariant.

### Reconciliation Decision Gate

The existing read-only reconciliation proposal remains the sole workflow authority; a `checkout_reconciliation` Decision Gate is now saved **in the same atomic task update** as the proposal. `/decide <gate-id> accept_checkout` records explicit user authorization for that **proposal token, saved Plan/checkpoint prefix and checkout fingerprint**. `/decide <gate-id> decline` rejects it. Approval is separately re-read by the workflow on subsequent explicit continuation and does not itself trigger a coder or bypass existing reconciliation security checks. A changed checkout or different proposal token invalidates reuse. Reconsidering a refusal requires a fresh explicit choice against exactly the unchanged binding; previous authorization cannot silently be undone. Legacy natural-language reconciliation confirmation remains supported for compatibility.

The `/recovery` read-only projection now exposes revalidation suggestions, while `/decisions` presents the proposal and its choices. No Zed-specific decision logic was introduced into the core.

## P2 final hardening: strict verification, targeted recovery and risk decisions

### All-of command acceptance and contradictory evidence

A command-bound criterion is verified only when **every** explicitly declared
`acceptanceChecks` command has a fresh, observed `PASS` from **the same run**,
and that run also contains an independent reviewer statement that cites every
command. An earlier run's successful command cannot fill a missing result from
another run. A later complete observed pass can supersede an earlier failure;
a later failure takes precedence over an earlier pass, and a later unavailable
or incomplete run cannot inherit verification. `conflict` is retained when the
reviewer asserts a pass against an observed failing command. `static_review`
remains eligible only for criteria without declared executable checks.

The acceptance matrix includes the current verification rows even when the
reviewer has not mentioned them, so failures and missing observations are
visible in read-only views. This is a criterion-level proof policy, not a
replacement for the workflow's mandatory end-of-turn verification and final
validation.

### Targeted recovery diagnostics

`planTargetedRevalidation` maps stale/unknown `tool_execution` evidence to
commands actually present in the current `AGENT_VERIFY_COMMANDS` (or the
repository's auto-detected verification suite). It never executes text from a
model or a persisted claim as an arbitrary shell command. The built-in
`git diff --check` is always included. An unknown/removed command or a request
for the entire suite falls back to the ordinary mandatory verifier.

For an **incomplete saved implementation stage**, the workflow performs a
bounded targeted read-only diagnostic when there is a proper subset of
configured commands to check. It records the actual results atomically with
task quality, includes them in the resumed coder's context and preserves the
prior stage checkpoint. Failed targeted diagnostics do not falsely classify an
unfinished stage as correct. Read-only diagnostics abort before coder execution
if they mutate the checkout or security-denied paths. **Final integration
always runs the complete configured verifier**: targeted diagnostics are not a
license to skip mandatory checks. Resumed read-only review does not repeat a
preflight test immediately before the same complete integration verifier.

There is deliberately no dependency-closure based skipping of mandatory tests:
the generic orchestration layer cannot prove arbitrary shell tests' complete
file/environment dependencies from a Plan or a model claim. A conservative
full run is the correct fallback until trustworthy per-check execution
capabilities become available.

### Findings and additional decisions

A finding reported by independent reviewer and final validator, with an
explicit validator `defect_confirmed` assessment, can become `confirmed` with
`confidence=supported`. This does **not** turn either role report into
`observed` execution. A confirmed finding can increase in severity with a
recorded transition; the system does not silently downgrade it. Explicit
manual `resolved` transitions require trustworthy passing observed verification
or source-anchored static review, and automated remediation requires the
stricter new-checkout/new-successful-command/independent-review conditions
already described above.

A nonblocking, out-of-scope, independently corroborated finding with passing
configured verification can generate a `risk_acceptance` Decision Gate.
`acknowledge_risk` records informed user acknowledgement, **not** correctness,
remediation or permission to write; `decline` retains the finding. The
acknowledgement is attached to exact finding identities and the current task,
checkpoint and checkout; changed state revokes applicability. `/findings`
labels accepted residual risk as **not fixed**. Other gate types still use the
same explicit, idempotent, state-bound `/decide` mechanism. Two different sets
of findings cannot reuse the same gate just because the number of findings and
checkout are equal.

A saved `integration_incomplete` checkpoint is a valid target for an explicit
bare continuation (for example, `Продолжай`) while unrelated questions remain
read-only. During a resumed scope-approved fix round, the coder receives the
exact approved finding set; these approvals do not bypass the host/tool write
permissions or security-denied paths.

### Verification boundaries

The deterministic P1+P2 harness includes multi-command rejection, fresh and
stale evidence, failing/unavailable tests, independent reviewer conflicts,
source-anchored inspection, finding severity/closure and risk lifecycle,
state-bound approvals and reconciliation, process-persisted recovery, targeted
subset execution and a real host-neutral interrupted-stage continuation.

Live Zed/ACP is still an external acceptance condition, not proven by these
fake-provider tests. Install all locked dependencies and use Node >=22.20.0,
then run `npm ci`, `npm test` and the real Zed/ACP cancellation/restart/
permission scenarios. Nothing in this document claims an integration test
that was not executed.


## P1/P2 audit remediation (October 22, 2026)

- **F-01 / R-02:** configured commands cannot be declared `fresh` from Git checkout alone. An optional trusted operator manifest `AGENT_VERIFY_INPUT_CLOSURES` supplies a *complete* input set per command. Omit it when closure cannot honestly be guaranteed. Example:

  ```sh
  export AGENT_VERIFY_INPUT_CLOSURES='{"node check.mjs":{"complete":true,"paths":["check.mjs","runtime.flag"]}}'
  ```

  `runtime.flag` can be Git-ignored; its contents are hashed. The operator is responsible for declaring all files that may influence the check; dependencies on external services or transient environment generally cannot be claimed complete by this mechanism. No role response, repository instruction, Plan or ACP transcript is accepted as a trusted input manifest. Without it, successful execution remains **observed**, but durable freshness is `unknown` and the acceptance matrix does not silently declare `verified`. Final mandatory verification is never skipped.
- **F-02:** static source attestation is `supported`, not semantic PASS. A deterministic command checker with trusted input closure is required for a durable `verified` acceptance. Legacy static evidence is not upgraded.
- **F-03:** findings now optionally carry `contractId` and `reproductionKey` through reviewer/finalValidator schema. The ID is stable across title, severity and scope changes. Without a sufficiently specific signature, records remain separate; possible duplicates can be signaled but never silently merged. Scope and risk gates have a subject-specific state key: changes to another finding do not revoke an unrelated approval, while changes to the approved finding invalidate it. Legacy approvals lacking this state key continue under their existing repository/Plan binding and should be reissued where subject-state protection is required.
- **F-05:** new Quality text is redacted and truncated before persistence; read-only projections additionally redact legacy prose. `dependencies` are normalized to bounded canonical records. Regex redaction cannot reliably detect arbitrary unknown secret formats, so the primary policy remains avoidance of raw tool output, secret values, commands and environment snapshots in durable quality. Existing legacy session JSON is not rewritten automatically; historical on-disk copies must be treated as sensitive.
- **R-01:** protected proofs and linked findings are never evicted to make room. Superseded, unreferenced, unverified stage-role reports may be compacted within the task's existing 800-record/2-MB limits. When this cannot free sufficient space, `QUALITY_CAPACITY_EXCEEDED` is explicit and transaction rollback preserves the session's prior state.

Run `npm run test:evaluation` for deterministic negative scenarios including ignored inputs, falsely favorable source citations, semantic finding identity, P1 tracing, live quality subscribers, privacy and capacity. Re-run all SDK-dependent tests on Node >=22.20.0 with installed dependencies before a production declaration.

## Follow-up remediation: Verification Attempts and snapshot integrity (October 22, 2026)

Each host-neutral configured verification suite now has a durable **attempt**, with an opaque
ID, phase (`mandatory_final` or `targeted`), safe check IDs, the required check set,
status and observation times. The start is saved against the active implementation task
*before* command execution. A crash/cancellation can leave a `started` attempt; this
is intentionally not success. A new incomplete attempt supersedes older positive
acceptance for the current verdict. Targeted attempts do **not** replace final mandatory
verification. Missing legacy attempt metadata never confers new trust.

The verifier captures declared inputs **before and after each command**, including
ignored/untracked files, using bounded ordinary-file reads and symlink-safe checks.
`AGENT_VERIFY_INPUT_CLOSURES` is a trusted operator-owned JSON mapping from full
configured verification command to `{ "complete": true, "paths": ["..."],
"environment": ["SAFE_NON_SECRET_VARIABLE"] }`. The environment list is optional;
secret-like variable names are rejected. Only nonsecret values are fingerprinted, not
stored raw. An operator must declare closure completeness truthfully; a script with
undeclared external/environment/dynamic dependencies cannot be proven complete by
Git metadata. A changed input during execution invalidates its PASS as proof of the
current checkout. Freshness is rechecked at matrix evaluation, preventing later
commands from silently changing earlier checks' known inputs.

**Current-run success is different from reusable proof.** Without a complete trusted
closure, the actual, completed mandatory attempt with an independent review and no
observed workspace mutation may receive `verified_current_run` *only at the same
workflow's final acceptance assessment*. It may contribute to that invocation's
`task_complete` decision. Read-only evidence views after restart cannot mint or reuse
that ephemeral confirmation: only demonstrably `fresh` stable evidence can become
long-term `verified`. Current-run results from a targeted or incomplete suite, or a
self-modifying complete-closure command, are ineligible. The full configured suite
still runs before final acceptance. For source-only criteria, source anchors remain
`supported`, not semantically `verified`.

Quality State stores opaque check IDs rather than raw command lines, and common URL
credentials, CLI flags and Authorization headers are sanitized in text fields. Redaction
is *defense in depth*, not a guarantee of detecting arbitrary unknown secrets; do not
place credentials in verifier command arguments or arbitrarily store stdout/stderr.
For legacy session files only, stop the orchestrator and run:

```sh
npm run quality:scrub -- /path/to/state/sessions/<session-id>.json
```

This explicitly replaces sanitized task Quality State atomically, with file mode 0600,
without creating a raw backup. It does **not** scrub chat history, tool logs, external
backups or unrelated storage; inspect those separately. Never run it against a session
being concurrently written. Old sessions without the new attempt fields remain loadable,
but legacy model claims are not upgraded to observed/fresh results.

Findings resolution now requires a new passing observation of the same check previously
recorded failing for the specific finding, a distinct run, an inspectably complete stable
input binding and a changed binding. Unrelated green checks cannot close the finding.
Previously invalidated Decision Gates get new IDs when reissued, without silently
reusing old approval. Observability remains a read-only projection of saved task state.

## Findings and decision lifecycle correction (N-01–N-03, October 2026)

- **State-bound reissue:** `proposeDecision` checks the *current* finding-subject digest before returning an existing pending or resolved gate. A changed finding invalidates an outdated gate and yields a new pending gate with a new ID, without transferring prior permission. Repeating a proposal against unchanged subjects remains idempotent. Legacy gates with named subjects but missing their subject-state digest cannot grant scope approval.
- **Conservative identity v3:** a finding UUID remains the authoritative stable ID. The deduplication signature now includes the normalized asserted violation and its witness as well as the contract, reproduction scenario and path. Sharing only a broad `contractId`, `reproductionKey` and file does **not** justify merging defects. Potential overlaps are retained as separate findings with `possibleDuplicateIds`. Original v2 records keep their stored identity and references; only exact original reports may be matched to such records, and no historical permissions are upgraded. A rephrased but genuinely identical defect may be left as a possible duplicate until corroborated; this is safer than losing a separate blocking issue.
- **Evidence-bound reopening:** repeated model prose is retained as report evidence, not an observed regression. Transition `resolved -> reopened` requires *new* tool-observed failing evidence for the previously failing check, recorded after the repair's observed PASS and from a different run. Direct state transitions enforce the same invariant; generic `resolved -> confirmed` cannot bypass it. Severity escalation from an unverified repeat of a resolved finding is suppressed.

The validation harness includes `test/evaluation/p1-p2-findings-gates.mjs`, exercising reissue after severity change, explicit refusal, persisted legacy decisions, non-merging findings with common scenario tags and post-restart proof-bound reopening. These rules do not grant new write permissions or make provider-reported commands trustworthy.

## Final proof-boundary hardening (C-01, C-02, G-01; October 22, 2026)

- **C-01 / whole-suite stability:** acceptance `verified` and `verified_current_run`
  require a completed mandatory verification attempt with `checkoutStable === true`.
  The workflow observes checkout changes across the verification suite, even
  when a command leaves its own declared input files untouched. Unstable final
  suites require revalidation; an omitted/unknown checkout-stability observation
  cannot be treated as stable. Observed PASS remains recorded but does not
  certify the final state.
- **C-02 / finding resolution:** direct `transitionFinding(task, id, 'resolved', ...)`
  is intentionally disallowed. Use `await resolveFinding(task, id, evidenceIds,
  repoRoot)`. The Quality State owner validates independently observed matching
  repair evidence **and** its freshness against the current checkout, including
  complete declared inputs. A check tied to an attempt must also be from a
  completed, checkout-stable attempt. Stale or unknown evidence cannot resolve
  the finding, even if the calling workflow neglects an extra check. Other
  lifecycle transitions remain synchronous.
- **G-01 / bounded protected read-only witness:** read-only role invocations
  and provider-cancellation retries now snapshot and recheck *configured
  security-denied paths* separately from Git, including ignored `.env` files.
  A mutation prevents acceptance or automatic retry, without attributing it
  to the provider or silently restoring possible user edits. This detects only
  explicitly configured denied paths/globs: it does not replace real provider
  sandbox enforcement or detect arbitrary unlisted ignored files. Test actual
  ACP provider read-only write denial before production acceptance.

The regression `test/evaluation/p1-p2-final-proof-boundaries.mjs` exercises a
real verifier modifying an unrelated tracked file, a multi-check invalidation,
stale/unknown finding resolution, creation/mutation of ignored denied files
and a fake provider modifying `.env` through the host-neutral workflow.
