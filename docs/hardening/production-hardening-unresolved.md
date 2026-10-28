# Production Hardening — unresolved registry (2026-10-28)

**Readiness:** NOT PRODUCTION-READY. This document records confirmed implementation boundaries and evidence gaps; it is not a successful production acceptance report.

## Completed, with limited evidence

- Verification subprocess-group lifecycle cleanup on `feature/production-hardening-completion-20261028` (see `verification-process-groups.md`). Previously observed local targeted tests passed, but the full suite could not run with the available Node/dependencies.
- P0 fail-closed sandbox selector validation: only `read-only` and `workspace-write` are valid at the task-write policy, provider capability check and direct Generic ACP, Codex ACP, and Codex CLI entry points. Regression tests added. A valid mode label is **not** proof of host sandbox enforcement.

## Open — P0

- **Trusted write authorization and ACP enforcement:** model-interpreted Task Spec is not an unforgeable user grant. Provider-owned tools, subprocess descendants, symlinks, ignored files and concurrent edits are not isolated by a trusted per-path filesystem allowlist. Restricted write scopes still fail closed. See `../TASK-WRITE-BOUNDARY.md`.
- **Verification reliability/fix loop:** reproduce and classify the original live `INFRA_FAILURE`; validate cancellation, cleanup, stage retries and fix-loop outcomes in an environment with real provider processes.
- **Plan/checkpoints/resume/reconciliation:** exercise crash/restart, concurrent checkout drift, interrupted writes and no-repeat guarantees against real provider and filesystem behaviour.

## Open — P1/P2

- Universal test-coverage evidence and stronger provenance/freshness gates, including realistic mixed-language suites.
- ACP tool-event deduplication and bounded outward presentation; existing tool metrics do not enforce a native payload size limit.
- Context and Git evidence freshness, resource-efficiency benchmarking, cross-host architecture acceptance.
- Real ACP/Codex/Zed acceptance, security adversarial tests, and production-readiness signoff. Full locked-dependency `npm test` passed on CI run 40723554513 for commit 3e15a1a (separate live/host tests remain outstanding).

## CI Run #4 failure — regression fixture correction (2026-10-28)

- [GitHub Actions Run #4](https://github.com/apathoid/role-orchestrator/actions/runs/40714328536): **FAILURE** at `test/smoke.mjs` (`fix: expected hello world!, got hello world`). Earlier steps in the sequential `npm test` script passed; all later suites remained unexecuted for that run.
- Root cause in the simulated provider: `NEEDS_FIX` and `ESCALATE` findings omitted `origin`, `taskRelation`, `remediationScope` and concrete `evidence`. The current production fix-decision policy appropriately treated those claims as insufficient evidence, withholding automatic scope authorization.
- Commit [06b774d](https://github.com/apathoid/role-orchestrator/commit/06b774d87db719d5a4486fe68e96a619e2970000) updates the **test fixture** to validate its actual greeting-file state before emitting evidence-backed in-scope findings. Smoke tests additionally require exactly two coder invocations for both fix/escalation cases. Production fix authorization was not relaxed.
- [CI run for that commit](https://github.com/apathoid/role-orchestrator/actions/runs/40722510894): launched; **PASS not yet verified** at the time of this registry update. Its result must be checked before removing the CI blocker.
- `npm ci` also reported **one High-severity dependency advisory** in Run #4; package/advisory details and exploitability remain unverified. Do not silently run an unreviewed `npm audit fix`.

## CI Run #5–#7 — subsequent regression discoveries

- [Run 40722510894](https://github.com/apathoid/role-orchestrator/actions/runs/40722510894): **FAILURE**, `test:generic-acp` — direct `spawn` returned `EACCES` because the GitHub tree write for the previous test-fixture update accidentally changed `test/fake-codex-acp.mjs` from executable mode `100755` to `100644`. Fixed in [1f22062](https://github.com/apathoid/role-orchestrator/commit/1f220625d0680ed3dce56d6ccf37a6d09702b0ee) and verified as `100755` in the repository Git tree. This failure was introduced by publication, not production authorization logic.
- [Run 40722702040](https://github.com/apathoid/role-orchestrator/actions/runs/40722702040): **FAILURE** at smoke scenario `existing-node-modules`. Its `vitest` script is correctly classified `ENVIRONMENT_ERROR / INTERACTIVE_VERIFICATION` by the project's watch-mode guard. Fixed the test fixture to request finite `vitest run` in [b52f1f1](https://github.com/apathoid/role-orchestrator/commit/b52f1f108200aa5080cb48463f103b5cfcd41285), preserving its test for local binary resolution.
- [Run 40723075505](https://github.com/apathoid/role-orchestrator/actions/runs/40723075505): launched for `b52f1f1`; full-suite PASS **not yet verified** at this entry. Further failures must be processed separately.

## CI full-suite recovery — completed (2026-10-28)

- [Run 40723075505](https://github.com/apathoid/role-orchestrator/actions/runs/40723075505): **FAILURE** in `test/smoke.mjs` malformed-Router expectation. The workflow correctly returned `intent_unresolved / ROUTER_OUTPUT_UNSTRUCTURED`; the test still asserted `missing_task_spec`. Commit [3e15a1a](https://github.com/apathoid/role-orchestrator/commit/3e15a1aa8f8a33fe5c6945a4030e77fc3076e67b) updated the assertion to the typed error without relaxing Router's fail-closed behavior.
- [Run 40723554513](https://github.com/apathoid/role-orchestrator/actions/runs/40723554513): **SUCCESS** for `3e15a1aa8f8a33fe5c6945a4030e77fc3076e67b`. Full `npm test` passed with locked dependencies on the GitHub hosted Node 22 runner. This proves automated-suite completion for that exact code state only; it does **not** cover live provider acceptance, host-enforced filesystem isolation, adversarial concurrent writes, or unresolved P0/P1/P2 criteria.
- Subsequent documentation-only commits have their own head SHAs and CI runs; a green result must not be transferred automatically to those commits.

## Evidence policy

At the time of the original entry, no CI checks or live ACP execution were observed for this branch. CI Run #4 has since failed; see the correction above. Regression test additions are **not** execution evidence. Never claim production readiness from mocks or from static review alone. Keep the Draft PR open and unmerged.

## CI continuation (2026-10-28)

- Added `.github/workflows/ci.yml` to run the full locked-dependency test suite with Node.js 22, explicit >=22.20 engine validation, read-only workflow token, and a job timeout.
- Verified publication of the workflow file and branch HEAD via GitHub API. CI Run #4 failed in the smoke suite. The new fix-commit run is pending; full-suite CI remains **NOT_VERIFIED** until a completed successful run provides evidence.
- CI alone cannot establish host-enforced ACP filesystem write isolation, live Zed integration or full production readiness. These P0/P1/P2 requirements remain open.

## Continuation — pre-invocation Task Spec validation (2026-10-28)

- Defense in depth: revalidate current and persisted Task Specs at the provider pre-write boundary. Reject malformed, incomplete, unauthorized or ambiguous current write intent before a writable invocation; retain optional absent saved Plans and the existing refusal of restricted write scopes. Negative regression cases cover malformed exclusions, conflicting target and ambiguous intent.
- This does **not** establish trusted user authorization or host-enforced filesystem isolation. A valid Router Task Spec is model-derived data, and the legacy unrestricted `NO_PER_PATH_ENFORCEMENT` path remains exposed to provider-owned writes. P0 trusted authorization/enforcement remains **OPEN**.
- **Verification of this continuation:** new GitHub Actions run for the resulting SHA must be checked; do not transfer earlier green CI evidence. Live host/provider tests remain unexecuted. **Readiness: NOT PRODUCTION-READY.**

## ACP presentation and deduplication continuation (2026-10-28)

- [aa7f57c](https://github.com/apathoid/role-orchestrator/commit/aa7f57c1b8f25ebfca08a46e0717312fb5a33ba4): bound the **outer ACP tool-card presentation** while retaining tool status, exit code and beginning/tail of diagnostic text. Oversized diff blocks are explicitly omitted rather than presented as valid partial patches. Added deterministic assertions for failure tails, command inputs, diff handling and content item caps. [Push CI 40735394287](https://github.com/apathoid/role-orchestrator/actions/runs/40735394287) and [PR CI 40735404120](https://github.com/apathoid/role-orchestrator/actions/runs/40735404120): **SUCCESS for exactly aa7f57c**.
- [ff52f32](https://github.com/apathoid/role-orchestrator/commit/ff52f323e1eea485cdd9798c4fbffefc0635344c): suppress repeated outer ACP tool payloads in the same invocation, prevent a delayed nonterminal status from reopening a terminal tool, preserve new diagnostic content, and bound permission **card presentation** without altering the actual permission request. Added deterministic duplicate, late-status and new-evidence cases. [Push CI 40736126807](https://github.com/apathoid/role-orchestrator/actions/runs/40736126807) and [PR CI 40736136835](https://github.com/apathoid/role-orchestrator/actions/runs/40736136835) were **IN_PROGRESS** at the time of this entry; check final conclusions.
- These are not a bound on all ACP wire traffic, provider memory usage, accumulated final messages, reasoning streams, or a security boundary. The deduplication cache is transient and per outer turn; out-of-order content updates still need live v1/v2 acceptance and further work. **P1-2 and P1-3 remain partially implemented / NOT VERIFIED for production**.
- No filesystem permission capability has been established. P0-1/P0-2 stay OPEN. Original live INFRA_FAILURE, host enforcement, crash/resume live tests, and real provider acceptance remain unverified. **Production readiness: NOT PRODUCTION-READY.**

## Bounded ACP diagnostic retention (2026-10-28)

- [c0fbce4](https://github.com/apathoid/role-orchestrator/commit/c0fbce4772cd55aac33849a4de4bb8d6ffeb3a6c): bound synchronous Codex ACP tool-event diagnostic retention to 256 recent events, 1 MiB aggregate serialized payload and 64 KiB per event; record omitted counts and expose an explicit `complete` witness to reconciliation and provider metadata. Added deterministic tests for oversized events and retention overflow.
- The underlying ACP notification delivery and permission decisions remain unchanged. This limits a diagnostic copy, **not** the full provider wire stream, final-text accumulation or retained UI presentation queue. Missing diagnostics must not be represented as complete evidence. The work is only PARTIALLY VERIFIED until full CI for its SHA and live ACP acceptance are observed. P1-2/P1-3 remain OPEN for full production acceptance.
- Security P0-1/P0-2 and original live INFRA_FAILURE remain OPEN. **NOT PRODUCTION-READY**.

## Security path canonicalization (2026-10-28)

- [5faa443](https://github.com/apathoid/role-orchestrator/commit/5faa443157ba8d94fbf115df0eda887cb2c1dedb): the semantic Task Spec validator rejects noncanonical path selectors/exclusions (dot, empty/repeated segments, .git with case variations); post-write task-scope auditing also rejects malformed exclusions/changed paths and conservatively case-folds exclusions for security comparison. Shared security config rejects drive-prefixed Windows paths. Added deterministic negative and regression assertions in `test/prewrite-boundary.mjs` and `test/security.mjs`.
- These are validation and **post-write detection** guarantees, not trusted user authorization or pre-write filesystem enforcement. The legacy unrestricted write path is not a certified sandbox. Live symlink/rename/concurrency/provider tests remain missing. P0-1/P0-2 still OPEN; **NOT PRODUCTION-READY**.
- CI [push 40739185997](https://github.com/apathoid/role-orchestrator/actions/runs/40739185997) and [PR 40739195036](https://github.com/apathoid/role-orchestrator/actions/runs/40739195036) were IN_PROGRESS when observed; do not infer PASS.

## Verification input witness safety (2026-10-28)

- [1c5f939](https://github.com/apathoid/role-orchestrator/commit/1c5f939ad64e289f88138b303b1dbc1a6ae1107a) replaces path-based parent lstat/open checks with the existing Linux directory-FD-pinned, no-symlink workspace reader. It rejects ambiguous paths, hardlinked files and changed file metadata across reads before issuing a content witness. On unsupported platforms or unprovable file safety, witness results remain unknown and are not valid cache evidence.
- Added adversarial deterministic tests in `test/execution-verification-cache.mjs` for malformed closure paths, parent/final symlinks, hardlinks, and a valid ordinary file. These tests verify the witness policy, **not** full concurrent rename/TOCTOU isolation under real hostile processes.
- [Push CI 40740101423](https://github.com/apathoid/role-orchestrator/actions/runs/40740101423) and [PR CI 40740111458](https://github.com/apathoid/role-orchestrator/actions/runs/40740111458) started for the implementation SHA; results must be checked. Live providers, cross-platform host enforcement and the original INFRA_FAILURE remain OPEN.
- P0 trusted user authorization and provider-owned filesystem enforcement remain unavailable. **Production Readiness: NOT PRODUCTION-READY.**

## Operator-approved universal verification (2026-10-28)

- [cc2a751](https://github.com/apathoid/role-orchestrator/commit/cc2a75144ecb0f4fbcf36447f206948868c67afa): remove test-framework and command-name regex heuristics from verification selection and execution. The review workflow now passes only the intersection of trusted configured verification commands and operator-approved safeCommands to scheduling. Executor requires exact approval, never executes model/skill-provided commands, and treats changed-input process PASS as unverified evidence while preserving the observed command status. Deterministic tests cover custom commands, unapproved commands and invalidated input evidence.
- This does not certify arbitrary approved command safety: the host/operator still owns approval and command effects. Review auto-execution remains subject to its existing workspace-mutation safeguards. Live provider/host acceptance and the original INFRA_FAILURE remain open. P1-1/P1-4 partial; **NOT PRODUCTION-READY**.
- The CI runs for cc2a751 and subsequent documentation SHA must be checked before marking this change VERIFIED.
