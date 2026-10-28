# P2 Implementation Report — Evidence-Driven Execution & Smart Recovery

## Scope and ownership audit

Only the source archive attached to this task was used as the baseline. Original authorities were preserved: implementation task registry and aliases; stage/review checkpoints and Plan Continuity; verification classification and reconciliation; fix-decision; provider/cancellation/timing; P1 execution traces; ACP presentation. No Zed-only dependency was introduced into the core.

Changes by component:

| Component | Change / responsibility |
|---|---|
| `src/quality-state.mjs` (new) | Evidence records and matrix, provenance classification, dependency freshness, durable findings/lifecycle/dedup, recovery projection, gate creation/resolution and state-bound approval |
| `src/quality-view.mjs` (new) | Pure read-only Markdown projections for any host |
| `src/execution-service.mjs` | Persist quality with task/checkpoints; independently assess acceptance before workflow verdict; create and resolve gates with rollback |
| `src/workflow.mjs` | Run P2 assessment before final acceptance; require actual quality proof; collect verification-time workspace fingerprint; allow only state-bound explicit scope decisions |
| `src/implementation-stages.mjs`, `src/schemas.mjs`, `src/roles.mjs` | Optional Plan acceptance-check binding, backward-compatible digest for older Plans, planner guidance |
| `src/orchestrator-runtime.mjs`, `src/acp.mjs`, `src/acp-presentation.mjs` | Read-only quality status and commands; explicit `/decide` bridge |
| `src/session-store.mjs` | Validate stored task quality; bounded session payload while retaining atomic JSON save |
| `src/turn-coordinator.mjs` | Guard interactive gate updates against simultaneous workflows |
| `test/evaluation/p2-quality.mjs` (new) | End-to-end file/Git fixtures and targeted P2 invariants |
| `test/evaluation/implementation-plan-durability.mjs` | Preserve I2 resume assertion while checking independent, stricter acceptance |
| `package.json` | Add P2 verification/check steps |

## Semantics and migration

`quality` lives on the existing `implementationTasks[n]` entry; task `version: 1` stays unchanged, while quality uses its own `version: 1`. Existing checkpoints are neither overwritten by matrix records nor reset due to missing verification. Legacy sessions lacking P2 keys load normally. Stage evidence and checkpoint identity commit together; an interrupted process cannot produce a standalone completed P2 checkpoint. Independent tasks have independent findings and evidence. Repo reconciliation retains its existing authorization/security guarantees.

## Evaluation and known limits

- `npm run check`: **PASS**, including all P1 syntax tests and new P2 modules.
- `npm run test:evaluation`: **PASS** (P1 suites plus P2 deterministic quality evaluation).
- First full `npm test`: all executed suites **PASS** through `test:provider-contract`, then blocked on `test:generic-acp`: `ERR_MODULE_NOT_FOUND @agentclientprotocol/sdk` in this execution environment (no `node_modules` in input archive).
- A separate pass through 23 remaining script targets found **21 PASS**; `test:provider-progress` and `smoke` were blocked by the same missing ACP dependency, not by an assertion failure.
- Attempted `npm ci --ignore-scripts --prefer-offline`: unavailable in this environment (`npm error Exit handler never called`); installed Node v22.16.0 is also below the project-declared minimum v22.20.0. This is an environment limitation, not an assertion that the ACP tests passed.

No full live Zed/ACP-provider integration run was possible here. Coverage and remaining gaps are described in `docs/P2-QUALITY-RECOVERY.md`. Especially, arbitrary provider-internal tool calls still cannot be trusted without an adapter providing independently verifiable process-result provenance. Targeted revalidation is proposed/read-only; configured verification still runs as a complete suite on continuation. This preserves safety but is not the full optimization opportunity described in the P2 brief.
