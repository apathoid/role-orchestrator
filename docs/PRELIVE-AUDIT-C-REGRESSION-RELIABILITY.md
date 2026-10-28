# Audit C — Regression, Provider Failures and Reliability

Independent scope: package targets, deterministic tests, integration tests, locked dependencies, provider errors, telemetry, production readiness. Full raw stdout/stderr, commands and exit codes are in the separate logs archive.

| ID | Severity | Root cause and reproduction | Expected vs actual | Fix or disposition | Test and log | Final status |
|---|---|---|---|---|---|---|
| C-PRE-01 | HIGH release gate / environment | `npm ci --offline` cannot obtain locked `zod@4.6.5`; online install hits timeout. | Expected exact locked install; unavailable. No SDK stub installed. | No lock/dependency changes; rerun in networked Node >=22.20 environment. | `baseline-npm_ci___offline___ignore_scripts___no_audit.log`, `dependency-install-online.log` | ENVIRONMENT_BLOCKED |
| C-PRE-02 | HIGH release gate / environment | Full `npm test` imports `@agentclientprotocol/sdk` not installed. | Expected entire suite continuous PASS; observed `ERR_MODULE_NOT_FOUND` at Generic ACP, repeated. | Environment recovery required, not a production patch. | `full-suite-1.log`, `full-suite-2.log` | ENVIRONMENT_BLOCKED |
| C-PRE-03 | MEDIUM / fixture | Fake Review smoke supplied missing `task`. | Expected Review coverage, got `intent_unresolved`. | Added typed Router mock. | `fix-fake-review-smoke.log` | FIXED / LOCAL PASS |
| C-PRE-04 | MEDIUM / evaluation | Previous evaluator mixed provider failure and semantic statistics and had incorrect production prompt parity. | Expected separate error categories and denominators; new offline tests assert usage, latency and invocations. | Shared request plus pure evaluator aggregator. | `semantic-offline.log`, `eval-metrics-postcheck.log` | FIXED / LOCAL PASS |
| C-PRE-05 | MEDIUM / runtime gap | Node present is `v22.16.0` but package requires `>=22.20.0`. | Tests may pass here without meeting supported engine minimum. | Rerun all tests on supported Node. | `runtime.txt` | ENVIRONMENT_BLOCKED |
| C-PRE-06 | MEDIUM evidence limit | ACP notification ordering, real provider restart, native host cancellation and performance are not exercised against production provider. | Cannot conclude production reliability from local fixtures. | Real ACP/Zed acceptance. | `docs/PRELIVE-ZED-LIVE-ACCEPTANCE.md` | NOT_VERIFIED |

No confirmed new production HIGH defect remains in executed local scenarios. This statement is bounded: blocked SDK-backed and real provider paths have no affirmative PASS.
