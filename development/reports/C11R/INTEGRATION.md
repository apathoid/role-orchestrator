# C11R — Integration evidence and native readiness

**Implementation stage:** C11R.11, 2026-11-10, branch `greenfield/model-first-core`. Synthetic fixtures are not native LLM acceptance.

## Reproducible automated coverage

| Acceptance | Test file / observable assertion | Evidence class |
|---|---|---|
| A44–A45 | `reasoning-effort.test.js`, `reasoning-config.test.js` — decoder, v1 schema, native omission/default, duplicate levels, per-model mapping | automated synthetic |
| A46 | `reasoning-delegation.test.js`, `reasoning-end-to-end.test.js` — independent workers/invalid level, different native efforts | automated synthetic |
| A47 | `reasoning-controller.test.js` — self-continuation with 0 workers, high→medium→high, one-shot defaults | automated synthetic |
| A48 | `reasoning-failure.test.js` — unsupported Controller level/default, no fallback, explicit resume; plugin negative | automated synthetic |
| A49 | `codex-launch.test.js`, `acp-provider.test.js` — launch argv, ACP selector/setConfigOption, no prompt on unsupported | CLI launch fixture / ACP protocol fixture |
| A50 | `acp-provider.test.js` — native omission, unsupported/ignored/rerouted value; `reasoning-end-to-end.test.js` plugin opt-in | protocol fixture |
| A51–A52 | `reasoning-snapshot.test.js`, `reasoning-recovery.test.js` — durable binding, file-backed CAS/reopen, changed mapping retry | synthetic and filesystem |
| A53 | `reasoning-diagnostics.test.js`, `reasoning-end-to-end.test.js`, existing `retry.test.js` / budget / diagnostics suites — trace, redaction, ledger | automated synthetic |
| A54 | Full project CI checks, Node 24 `npm test`, Nix/package checks; live-native matrix below | CI pending at stage creation |

Test paths relative to `development/quality/tests/{core,integration,contracts}/`. The cumulative successful CI evidence is added on closeout.

## Native probes / external contracts

| Requirement | Status | Interpretation |
|---|---|---|
| Codex CLI installed version and actual configured model | **UNVERIFIED** | No configured native Codex model available in this execution environment; argv fixture is not native provider ACK |
| ACP remote agent selector/capabilities and applied effort | **UNVERIFIED** | SDK-based fixture exercises the transport and setter, not a real remote agent |
| Zed ACP session and live Controller reasoning adaptation | **UNVERIFIED** | Requires configured native Zed session and credentials |
| Internal thinking depth, task quality, cost efficiency and real usage | **UNVERIFIED** | No live model observation; configuration and ACK do not prove internal reasoning |

No additional credentials were added to CI, and no anti-loop gate, second scheduler, workspace sandbox, or effort ranking was introduced.

## Baseline CI and release probes (before final joint rerun)

- Verified success for C11R.1–.10: [GitHub Actions run 42812645733](https://github.com/apathoid/role-orchestrator/actions/runs/42812645733). Node 24/Linux; `nix develop --no-update-lock-file --command npm --prefix development run check`, `test:foundation` (4/4), `test:core` (24/24), `test:contracts` (51/51), `test:integration` (203/203), `check:package`, `check:removal` all exit 0. Lockfile diff check exit 0.
- C11R.11–12 final joint CI outcome: **PENDING** in this document until the next verified run. Do not infer PASS from the previous HEAD.
- Native agent versions/model outputs/usage: **UNVERIFIED**. No live native probe was attempted from this interface; preserve this status for C12.
