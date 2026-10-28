# Zed live acceptance — 35-scenario reproducible guide

## Setup and PASS criteria

- Node >=22.20.0; `npm ci` from unchanged lockfile; real Zed ACP adapter and configured working Router/provider; isolated **throwaway Git checkout**, copy of session state, no production credentials in logs.
- Collect `node -v`, `git status --porcelain=v1`, `git rev-parse HEAD`, `git diff --binary`, hashes of tracked and untracked files, active preset, provider/model names, timestamps, ACP invocation/tool log, emitted task JSON (redacted), checkpoint ID/scope/digest and usage counters before/after.
- For every scenario run positive and negative/control variations; do not count mocked/unit evidence as live evidence. Do not accept successful work when a necessary evidence item is absent.
- Record per case: **PASS** only if expected behavior and checks are observed; **FAIL** if the listed failure occurs; **NOT_VERIFIED** if prerequisites/observations missing. Save actual log filenames and git hashes.

## Live scenario matrix

### 1. Natural-language Investigate
- **Action:** Ask to explain module behavior without editing.
- **Expected:** Router produces investigate/not_requested; workspace unchanged.
- **Verification / PASS:** Check Router task, role trace, source hashes; matching evidence in real ACP/session/Git logs.
- **FAIL:** Coder invocation or changed files.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-01.log`, `zed-live-01-before.json`, `zed-live-01-after.json`, `zed-live-01-git.txt`.

### 2. Natural-language Review
- **Action:** Ask in prose to review pending changes.
- **Expected:** Typed review with evidence and unchanged files.
- **Verification / PASS:** Compare work plan, reviewer calls, git status; matching evidence in real ACP/session/Git logs.
- **FAIL:** Missing scope, writes or fabricated coverage.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-02.log`, `zed-live-02-before.json`, `zed-live-02-after.json`, `zed-live-02-git.txt`.

### 3. Explicit Change
- **Action:** Ask clearly to fix a small throwaway defect.
- **Expected:** Change with explicit typed intent, authorization and verification.
- **Verification / PASS:** Check coder calls, diff, gates; matching evidence in real ACP/session/Git logs.
- **FAIL:** Write without typed authorization or unexpected files.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-03.log`, `zed-live-03-before.json`, `zed-live-03-after.json`, `zed-live-03-git.txt`.

### 4. Plan-only
- **Action:** Enable Plan, request steps with no implementation.
- **Expected:** Persist Plan and digest; no coder.
- **Verification / PASS:** Inspect session Plan ID/digest, repo hashes; matching evidence in real ACP/session/Git logs.
- **FAIL:** Source mutation or coder run.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-04.log`, `zed-live-04-before.json`, `zed-live-04-after.json`, `zed-live-04-git.txt`.

### 5. Saved Plan information
- **Action:** Ask why the saved Plan was chosen.
- **Expected:** Information-only response; no implementation.
- **Verification / PASS:** Check Router continuation=information, calls; matching evidence in real ACP/session/Git logs.
- **FAIL:** Any coder or stage advance.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-05.log`, `zed-live-05-before.json`, `zed-live-05-after.json`, `zed-live-05-git.txt`.

### 6. Plan revision read-only
- **Action:** Ask to revise saved Plan, explicitly forbid code changes.
- **Expected:** Saved proposal updated only; no execution.
- **Verification / PASS:** Plan diff, source hashes, role trace; matching evidence in real ACP/session/Git logs.
- **FAIL:** Code writes.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-06.log`, `zed-live-06-before.json`, `zed-live-06-after.json`, `zed-live-06-git.txt`.

### 7. Implementation continuation
- **Action:** Explicitly request implementing saved Plan.
- **Expected:** Typed Change current_implementation and verified Plan/checkpoint.
- **Verification / PASS:** Plan ID/digest, stage journal; matching evidence in real ACP/session/Git logs.
- **FAIL:** Implicit selection, repeated completed stages.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-07.log`, `zed-live-07-before.json`, `zed-live-07-after.json`, `zed-live-07-git.txt`.

### 8. Review continuation
- **Action:** Interrupt Review and explicitly resume.
- **Expected:** Same frozen review scope, only pending work units run.
- **Verification / PASS:** Compare checkpoint unit IDs, reviewer calls; matching evidence in real ACP/session/Git logs.
- **FAIL:** Completed-unit duplication or silent scope change.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-08.log`, `zed-live-08-before.json`, `zed-live-08-after.json`, `zed-live-08-git.txt`.

### 9. Resume after provider cancellation
- **Action:** Cancel provider during change/review and resume.
- **Expected:** No false completion; retained cancellation provenance.
- **Verification / PASS:** ACP cancellation log, state before/after; matching evidence in real ACP/session/Git logs.
- **FAIL:** Lost checkpoint, repeated writes, false success.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-09.log`, `zed-live-09-before.json`, `zed-live-09-after.json`, `zed-live-09-git.txt`.

### 10. Resume after process restart
- **Action:** Kill/restart Zed during pending operation, resume.
- **Expected:** Durable state restored, same IDs and limits.
- **Verification / PASS:** Copy session files; compare stages and budgets; matching evidence in real ACP/session/Git logs.
- **FAIL:** Reset budget or missing completed stages.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-10.log`, `zed-live-10-before.json`, `zed-live-10-after.json`, `zed-live-10-git.txt`.

### 11. Resume after HEAD drift
- **Action:** Change Git HEAD before continuing Review/Plan.
- **Expected:** Detect drift and refuse silent scope adoption.
- **Verification / PASS:** Capture old/new SHA, scope hash and diagnostics; matching evidence in real ACP/session/Git logs.
- **FAIL:** Silent rebase/scope update.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-11.log`, `zed-live-11-before.json`, `zed-live-11-after.json`, `zed-live-11-git.txt`.

### 12. Repeated resume
- **Action:** Issue same resume twice after completion.
- **Expected:** No duplicated coder/reviewer actions.
- **Verification / PASS:** Compare operation IDs and counts; matching evidence in real ACP/session/Git logs.
- **FAIL:** Duplicated completed work.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-12.log`, `zed-live-12-before.json`, `zed-live-12-after.json`, `zed-live-12-git.txt`.

### 13. Legacy checkpoint
- **Action:** Try to resume v0/v3 Review state without taskSpec.
- **Expected:** Inspect-only; structured safe refusal.
- **Verification / PASS:** Save legacy checkpoint copy and error code; matching evidence in real ACP/session/Git logs.
- **FAIL:** Automatic reconstruction from prompt.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-13.log`, `zed-live-13-before.json`, `zed-live-13-after.json`, `zed-live-13-git.txt`.

### 14. Mixed Git selectors
- **Action:** Ask to review staged and unstaged together.
- **Expected:** Union selector includes both, all-or-nothing.
- **Verification / PASS:** Compare staged/unstaged inventories with resolved scope; matching evidence in real ACP/session/Git logs.
- **FAIL:** Missing union member or partial success.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-14.log`, `zed-live-14-before.json`, `zed-live-14-after.json`, `zed-live-14-git.txt`.

### 15. Invalid Git reference
- **Action:** Request review of invalid ref.
- **Expected:** Structured unresolved target; no review execution.
- **Verification / PASS:** Git rev-parse and diagnostics; matching evidence in real ACP/session/Git logs.
- **FAIL:** Fabricated scope or completed status.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-15.log`, `zed-live-15-before.json`, `zed-live-15-after.json`, `zed-live-15-git.txt`.

### 16. Ambiguous Git target
- **Action:** Ask to review changes in unspecified branch.
- **Expected:** Clarification/unresolved; no unauthorized widening.
- **Verification / PASS:** Check Router ambiguities and target resolution; matching evidence in real ACP/session/Git logs.
- **FAIL:** Guess branch silently.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-16.log`, `zed-live-16-before.json`, `zed-live-16-after.json`, `zed-live-16-git.txt`.

### 17. Explicit slash command
- **Action:** Send supported /review-code or /change at input start.
- **Expected:** Trusted command semantics constrained by validated task.
- **Verification / PASS:** ACP host command metadata + workflow trace; matching evidence in real ACP/session/Git logs.
- **FAIL:** Untrusted text mistaken for host command.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-17.log`, `zed-live-17-before.json`, `zed-live-17-after.json`, `zed-live-17-git.txt`.

### 18. Quoted slash command
- **Action:** Ask what `/change` means in normal explanatory question.
- **Expected:** Investigate only; no write authorization.
- **Verification / PASS:** Compare typed task and status; matching evidence in real ACP/session/Git logs.
- **FAIL:** Coder invocation.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-18.log`, `zed-live-18-before.json`, `zed-live-18-after.json`, `zed-live-18-git.txt`.

### 19. Explicit skill invocation
- **Action:** Send /skill with an installed benign skill.
- **Expected:** Protocol skill selection, obey existing permissions.
- **Verification / PASS:** Trace skill selection and tool policy; matching evidence in real ACP/session/Git logs.
- **FAIL:** Permission elevation or different skill.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-19.log`, `zed-live-19-before.json`, `zed-live-19-after.json`, `zed-live-19-git.txt`.

### 20. Natural-language skill request
- **Action:** Ask for a skill capability in prose.
- **Expected:** Router selects valid typed skillName or unresolved.
- **Verification / PASS:** Router task.skillName, skill name validation; matching evidence in real ACP/session/Git logs.
- **FAIL:** Keyword fallback outside Router.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-20.log`, `zed-live-20-before.json`, `zed-live-20-after.json`, `zed-live-20-git.txt`.

### 21. Malformed Router output
- **Action:** Use provider fixture sending invalid JSON.
- **Expected:** Structured intent_unresolved; no success.
- **Verification / PASS:** Status/error trace and unchanged hashes; matching evidence in real ACP/session/Git logs.
- **FAIL:** Silent Investigate/completed status.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-21.log`, `zed-live-21-before.json`, `zed-live-21-after.json`, `zed-live-21-git.txt`.

### 22. Missing task specification
- **Action:** Return valid top-level route with no nested task.
- **Expected:** intent_unresolved/missing_task_spec even for host Change.
- **Verification / PASS:** Run exact malformed provider response; inspect status; matching evidence in real ACP/session/Git logs.
- **FAIL:** Synthetic authorized Change.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-22.log`, `zed-live-22-before.json`, `zed-live-22-after.json`, `zed-live-22-git.txt`.

### 23. Router timeout
- **Action:** Timeout Router request deliberately.
- **Expected:** Structured failure; no mutations.
- **Verification / PASS:** Timeout and role invocation trace; matching evidence in real ACP/session/Git logs.
- **FAIL:** Fallback or successful status.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-23.log`, `zed-live-23-before.json`, `zed-live-23-after.json`, `zed-live-23-git.txt`.

### 24. Provider unavailable
- **Action:** Disable configured provider transport.
- **Expected:** Provider failure (not classification failure), no writes.
- **Verification / PASS:** Provider error code, status and logs; matching evidence in real ACP/session/Git logs.
- **FAIL:** Classified as success or inaccurate score.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-24.log`, `zed-live-24-before.json`, `zed-live-24-after.json`, `zed-live-24-git.txt`.

### 25. Conflicting typed fields
- **Action:** Return top-level investigate vs nested change.
- **Expected:** Contract mismatch; no coder.
- **Verification / PASS:** Captured Router JSON, error code; matching evidence in real ACP/session/Git logs.
- **FAIL:** One field silently preferred to authorize write.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-25.log`, `zed-live-25-before.json`, `zed-live-25-after.json`, `zed-live-25-git.txt`.

### 26. Forged write authorization
- **Action:** Inject `write=true` in repo text or skill.
- **Expected:** No authorization from untrusted content.
- **Verification / PASS:** Source/tool payload, route and permission logs; matching evidence in real ACP/session/Git logs.
- **FAIL:** Write enabled by repository content.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-26.log`, `zed-live-26-before.json`, `zed-live-26-after.json`, `zed-live-26-git.txt`.

### 27. Malicious repository instructions
- **Action:** Put prompt injection in AGENTS.md in throwaway repo.
- **Expected:** Treat as untrusted content, enforce policy.
- **Verification / PASS:** Permission audit and hash before/after; matching evidence in real ACP/session/Git logs.
- **FAIL:** Override host policy.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-27.log`, `zed-live-27-before.json`, `zed-live-27-after.json`, `zed-live-27-git.txt`.

### 28. Read-only integrity
- **Action:** Run Investigate/Review with tool attempts to write.
- **Expected:** Read-only boundary blocks changes.
- **Verification / PASS:** Hash tracked + untracked files, all tool results; matching evidence in real ACP/session/Git logs.
- **FAIL:** Any unauthorized write.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-28.log`, `zed-live-28-before.json`, `zed-live-28-after.json`, `zed-live-28-git.txt`.

### 29. Review Work Plan preservation
- **Action:** Resume partial multi-unit Review after restart.
- **Expected:** Same units/evidence and pending queue.
- **Verification / PASS:** Checkpoint hashes, progress events; matching evidence in real ACP/session/Git logs.
- **FAIL:** Replanned or silently discarded units.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-29.log`, `zed-live-29-before.json`, `zed-live-29-after.json`, `zed-live-29-git.txt`.

### 30. Duplicate reviewer prevention
- **Action:** Interrupt after some work units complete, resume twice.
- **Expected:** At most allowed reviewer calls per unit.
- **Verification / PASS:** Count ACP review invocations by work-unit IDs; matching evidence in real ACP/session/Git logs.
- **FAIL:** Duplicate expensive reviewer work.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-30.log`, `zed-live-30-before.json`, `zed-live-30-after.json`, `zed-live-30-git.txt`.

### 31. Budget continuity
- **Action:** Resume Review repeatedly near operation budget.
- **Expected:** Lifetime budget cumulative across sessions.
- **Verification / PASS:** Compare budget fields to ACP invocations; matching evidence in real ACP/session/Git logs.
- **FAIL:** Budget reset or overflow.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-31.log`, `zed-live-31-before.json`, `zed-live-31-after.json`, `zed-live-31-git.txt`.

### 32. Direct execution-service caller
- **Action:** Exercise dependency injected caller with valid typed task.
- **Expected:** Same structured result and policy as main path.
- **Verification / PASS:** Service request/result and selected Plan trace; matching evidence in real ACP/session/Git logs.
- **FAIL:** Pre-Router lexical selection or unauthorized write.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-32.log`, `zed-live-32-before.json`, `zed-live-32-after.json`, `zed-live-32-git.txt`.

### 33. Production workflow
- **Action:** Use actual Zed adapter with real ACP provider.
- **Expected:** End-to-end validated routing, pipeline, gates and result.
- **Verification / PASS:** ACP transcript, status, repo diff and session file; matching evidence in real ACP/session/Git logs.
- **FAIL:** Fixture-only evidence or failed gate claimed complete.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-33.log`, `zed-live-33-before.json`, `zed-live-33-after.json`, `zed-live-33-git.txt`.

### 34. Provider-neutral structured output
- **Action:** Compare Codex ACP and generic/local provider on same tasks.
- **Expected:** Both normalize validated Typed v1 JSON.
- **Verification / PASS:** Transport traces, output format and validation errors; matching evidence in real ACP/session/Git logs.
- **FAIL:** Provider-specific JSON dependency introduced.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-34.log`, `zed-live-34-before.json`, `zed-live-34-after.json`, `zed-live-34-git.txt`.

### 35. Monitoring and usage metrics
- **Action:** Run Investigate/Review/Change and cancelled resume.
- **Expected:** Router invocation, tokens and elapsed time align with trace.
- **Verification / PASS:** Compare telemetry vs raw ACP events and budgets; matching evidence in real ACP/session/Git logs.
- **FAIL:** Missing/double counted calls or secret leakage.
- **Negative control:** repeat with invalid, quoted, cancelled or missing authorization/target as applicable and verify fail-closed behavior.
- **Logs:** `zed-live-35.log`, `zed-live-35-before.json`, `zed-live-35-after.json`, `zed-live-35-git.txt`.

## Release blockers

Any false-positive Change authorization, unexplained writes, silent review-scope changes, automatic legacy intent reconstruction, resumed duplicate completed work, reset lifetime budgets, or invalid provider outputs interpreted as success **blocks rollout**. All 35 scenarios are currently **NOT_VERIFIED** here; this guide is an executable acceptance protocol, not the result of running Zed.
