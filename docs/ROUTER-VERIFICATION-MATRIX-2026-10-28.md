# Verification Matrix — 2026-10-28

Environment: Node 22.16.0, npm 10.9.2; the project expects Node >=22.20.0. ACP SDK was absent after `npm ci` failed.

| Exact command | Exit | Status | Captured log |
| --- | ---: | --- | --- |
| `npm run check` | 0 | PASS | `final-check.log` |
| `npm run test:semantic-intent` | 0 | PASS | `run-test-semantic-intent.log` |
| `npm run test:router-request-parity` | 0 | PASS | `run-test-router-request-parity.log` |
| `npm run test:router-context` | 0 | PASS | `run-test-router-context.log` |
| `npm run test:routing-quality` | 0 | PASS | `run-test-routing-quality.log` |
| `npm run test:routing-integration` | 0 | PASS | `run-test-routing-integration.log` |
| `npm run test:routing-regression` | 0 | PASS | `run-test-routing-regression.log` |
| `npm run test:semantic-evaluator-offline` | 0 | PASS | `run-test-semantic-evaluator-offline.log` |
| `npm run test:structured-output` | 0 | PASS | `run-test-structured-output.log` |
| `npm run test:monitoring` | 0 | PASS | `run-test-monitoring.log` |
| `npm run test:routing-quality-hardening` | 0 | PASS | `run-test-routing-quality-hardening.log` |
| `npm run test:prelive-security-failures` | 0 | PASS | `run-test-prelive-security-failures.log` |
| `npm run test:fake-router-contract` | 0 | PASS | `run-test-fake-router-contract.log` |
| `npm run test:workflow-unstructured` | 124 | NOT_VERIFIED (time limit) | `run-test-workflow-unstructured-limited.log` |
| `npm run test:generic-acp` | 1 | ENVIRONMENT_BLOCKED | `run-test-generic-acp.log` |
| `npm run test:evaluation` | — | NOT_VERIFIED independently (part of partial `npm test` runs) | `npm-test-pass*.log` |
| `npm run smoke` | 1 | ENVIRONMENT_BLOCKED | `run-smoke.log` |
| `npm test` | 1 | ENVIRONMENT_BLOCKED | `npm-test-pass1.log` |
| `npm test` | — | NOT_VERIFIED (time limit) | `npm-test-pass2.log` |
| `npm ci` | 1 | ENVIRONMENT_BLOCKED | `npm-ci.log` |

The two `npm test` attempts are *not* two successful executions. Run 1 failed at missing `@agentclientprotocol/sdk`; run 2 started but was interrupted before completion. No actual multi-provider ACP integration success is claimed.

Test logs are packaged separately. Missing or truncated log contents must not be inferred as passes.
