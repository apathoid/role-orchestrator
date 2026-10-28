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
- Full dependency-installed automated test run with supported Node.js, real ACP/Codex/Zed acceptance, security adversarial tests, and production-readiness signoff.

## Evidence policy

No CI checks or live ACP execution were observed for this branch at the time of this entry. Regression test additions are **not** execution evidence. Never claim production readiness from mocks or from static review alone. Keep the Draft PR open and unmerged.

## CI continuation (2026-10-28)

- Added `.github/workflows/ci.yml` to run the full locked-dependency test suite with Node.js 22, explicit >=22.20 engine validation, read-only workflow token, and a job timeout.
- Verified publication of the workflow file and branch HEAD via GitHub API. No passing CI run or test execution has been observed for this change; CI remains **NOT_VERIFIED** until a completed workflow run provides evidence.
- CI alone cannot establish host-enforced ACP filesystem write isolation, live Zed integration or full production readiness. These P0/P1/P2 requirements remain open.
