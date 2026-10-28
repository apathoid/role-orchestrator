# Final verification matrix — 35 requested scenarios

**All scenarios:** real Zed/production ACP end-to-end = **NOT_VERIFIED**. Local evidence below is narrow and does not turn live status into PASS. Each scenario has positive and negative acceptance controls specified in `zed-live-acceptance.md`.

| # | Scenario | Local positive/negative evidence (scope limited) | Live E2E status |
|---|---|---|---|
| 1 | Natural-language Investigate | `node24-workflow.log`, `node24-semantic.log` (mock Router + read-only test) | **NOT_VERIFIED** |
| 2 | Natural-language Review | `node24-workflow.log`, `migrate-review-reliability-2.log` (mock reviewer, real temporary Git) | **NOT_VERIFIED** |
| 3 | Explicit Change | `node24-workflow.log` (fake coder) | **NOT_VERIFIED** |
| 4 | Plan-only | `node24-workflow.log`, `extra-implementation-task-continuity.log` (fake providers) | **NOT_VERIFIED** |
| 5 | Saved Plan information | `node24-semantic.log`, `extra-execution-service.log` (mock) | **NOT_VERIFIED** |
| 6 | Plan revision read-only | `node24-semantic.log` (mock) | **NOT_VERIFIED** |
| 7 | Implementation continuation | `extra-implementation-task-continuity.log`, `node24-workflow.log` (mock) | **NOT_VERIFIED** |
| 8 | Review continuation | `migrate-review-reliability-2.log`, `extra-orchestrator-runtime.log` (mock) | **NOT_VERIFIED** |
| 9 | Resume after provider cancellation | `migrate-review-reliability-2.log`, `node24-evaluation.log` (mock) | **NOT_VERIFIED** |
| 10 | Resume after process restart | `extra-implementation-task-continuity.log`, `node24-evaluation.log` (simulated restart) | **NOT_VERIFIED** |
| 11 | Resume after HEAD drift | `migrate-review-reliability-2.log`, `node24-semantic.log` (real temp Git; mock provider) | **NOT_VERIFIED** |
| 12 | Repeated resume | `migrate-review-reliability-2.log` (mock) | **NOT_VERIFIED** |
| 13 | Legacy checkpoint | `node24-semantic.log` (safe rejection) | **NOT_VERIFIED** |
| 14 | Mixed Git selectors | `node24-semantic.log` (real temp Git) | **NOT_VERIFIED** |
| 15 | Invalid Git reference | `node24-semantic.log`, `audit-review-scope-hardening.log` (real temp Git) | **NOT_VERIFIED** |
| 16 | Ambiguous Git target | `node24-semantic.log` (mock) | **NOT_VERIFIED** |
| 17 | Explicit slash command | `node24-workflow.log` (host slash fixture) | **NOT_VERIFIED** |
| 18 | Quoted slash command | `node24-semantic.log` (typed negative) | **NOT_VERIFIED** |
| 19 | Explicit skill invocation | `migrate-skill-workflow-integration-2.log` (fake registry, real temp repo) | **NOT_VERIFIED** |
| 20 | Natural-language skill request | `node24-semantic.log` (mock) | **NOT_VERIFIED** |
| 21 | Malformed Router output | `node24-workflow.log`, `node24-semantic.log` (malformed outputs) | **NOT_VERIFIED** |
| 22 | Missing task specification | `node24-workflow.log` (explicit host Change negative) | **NOT_VERIFIED** |
| 23 | Router timeout | `node24-evaluation.log` (timeout simulated) | **NOT_VERIFIED** |
| 24 | Provider unavailable | `node24-full.log`, `semantic-live-node24.json` (unavailable provider only) | **NOT_VERIFIED** |
| 25 | Conflicting typed fields | `node24-semantic.log`, `node24-workflow.log` (mock) | **NOT_VERIFIED** |
| 26 | Forged write authorization | `audit-security.log`, `node24-semantic.log` (mock security) | **NOT_VERIFIED** |
| 27 | Malicious repository instructions | `audit-security.log` (fixture) | **NOT_VERIFIED** |
| 28 | Read-only integrity | `audit-security.log`, `node24-evaluation.log` (fixture) | **NOT_VERIFIED** |
| 29 | Review Work Plan preservation | `migrate-review-reliability-2.log`, `audit-review-work-plan.log` before fixture repair | **NOT_VERIFIED** |
| 30 | Duplicate reviewer prevention | `migrate-review-reliability-2.log` (12 complete units, 7 invocations) | **NOT_VERIFIED** |
| 31 | Budget continuity | `migrate-review-reliability-2.log` (hard ceiling, fail-closed) | **NOT_VERIFIED** |
| 32 | Direct execution-service caller | `extra-execution-service.log` (injected direct caller) | **NOT_VERIFIED** |
| 33 | Production workflow | `extra-orchestrator-runtime.log`, `extra-headless-real-provider.log` (fake ACP endpoint) | **NOT_VERIFIED** |
| 34 | Provider-neutral structured output | `extra-headless-real-provider.log` (fake ACP; not actual alternative provider) | **NOT_VERIFIED** |
| 35 | Monitoring and usage metrics | `node24-evaluation.log` (deterministic telemetry; no live ACP transcript) | **NOT_VERIFIED** |

## How to close the matrix

Execute each case in real Zed using the acceptance guide, attach actual `zed-live-NN` logs and before/after state hashes. If a local mock was the only evidence, do not tick the live column. Real provider classification must be measured on the 56 original cases without excluding provider crashes.
