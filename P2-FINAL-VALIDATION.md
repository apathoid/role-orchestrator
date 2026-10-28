# P2 Completion & Final Validation

**Baseline:** `role-orchestrator-P2-hardening.zip` (the last user-supplied P2
implementation). All new changes remain inside the existing task/Plan,
checkpoint, workflow and provider-agnostic Quality State owners.

## Changes in this pass

1. **Strict Evidence Matrix.** For command-bound criteria, require observed
   passing results for *all* Plan-declared checks in one run and independent
   review referencing those exact commands. Preserve failure/contradiction,
   unavailability and stale states; prevent cross-run synthetic PASS.
2. **Actual targeted diagnostics.** The read-only recovery assessment supplies
   stale checks; a whitelist-based selector executes only an eligible subset
   of locally configured commands during continuation of incomplete work.
   Results are observed, persisted and shared with the coder. The complete
   mandatory verifier still runs before the final verdict.
3. **Risk Decision Gates.** Persist explicit state-bound acknowledgement of
   independently corroborated nonblocking out-of-scope findings. This does not
   turn outstanding findings into resolved ones or bypass write permissions.
   Gate identity includes the exact affected finding identities.
4. **Findings lifecycle.** Escalate severity without silent downgrades; require
   substantiating evidence for explicit `resolved` transitions, while retaining
   stricter conditions for automated close/reopen.
5. **Continuation repair.** Allow bare explicit continuation of
   `integration_incomplete` checkpoints. Include the exact explicitly approved
   finding set in a resumed fixer's instructions.
6. **Read-only presentation.** Display separately risk acknowledged and not
   fixed, plus existing evidence/recovery/decision views.

## Responsibility boundaries

| Component | Owner / change |
| --- | --- |
| `quality-state.mjs` | All-of evidence adjudication, findings, state-bound decisions |
| `repo.mjs` | Command allowlist, targeted subset runner; built-in Git check |
| `workflow.mjs` | Authorized recovery preflight, targeted diagnostic and full final suite |
| `execution-service.mjs` | Atomic task save, explicit continuation of integration-incomplete state |
| `quality-view.mjs` | Read-only acknowledgement presentation |
| `test/evaluation/` | Deterministic quality and interrupted-workflow integration tests |

No alternate checkpoint/Plan database, provider-specific execution dependency,
implicit user approval, unbounded retry, private model reasoning storage,
or automatic rollback was introduced.

## Actual test results

- `npm run check` — **PASS**.
- `npm run test:evaluation` — **PASS** (P1 and P2, including real headless
  host-neutral workflow continuation with targeted recovery and full check).
- 36 additional `test:*` scripts attempted: **33 PASS**, **3 BLOCKED**
  (`test:provider-progress`, `test:generic-acp`,
  `test:codex-acp-cancellation`) by missing
  `@agentclientprotocol/sdk` dependency.
- `npm test` — **BLOCKED** at `test:generic-acp` after all preceding scripts
  passed (same missing dependency).
- `npm run smoke` — **BLOCKED** when the subscription provider tried to import
  the missing ACP SDK; no production provider test was completed.
- Node installed: **22.16.0**, while the project declares **>=22.20.0**.
  Attempts to resolve the SDK through npm failed due to DNS `EAI_AGAIN`.
- Real Zed ↔ ACP end-to-end, real provider cancel/restart and host permission
  interop — **NOT EXECUTED** in this environment.

**Status:** P2 implementation and available deterministic contract tests are
complete in this deliverable. Production-level end-to-end validation cannot
truthfully be claimed without the actual ACP environment. Final release
acceptance should remain pending until those named tests run successfully.

## Safe production validation

```bash
# Use Node >=22.20.0 with access to your configured npm registry.
npm ci
npm test
```

Then validate Zed/ACP slash commands `/evidence`, `/findings`, `/recovery`,
`/decisions` and `/decide`, including stale-choice refusal, remote cancellation,
process restart, Git drift/rebase and unchanged completed stages. Compare
against the deterministic harness; do not interpret a failed/missing SDK test
as evidence of code correctness or incorrectness.
