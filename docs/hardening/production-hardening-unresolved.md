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
