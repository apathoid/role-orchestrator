# P1/P2 remediation — implementation and validation report

**Basis:** `role-orchestrator-P2-final.zip` and the subsequent P1/P2 audit/remediation plan (October 2026). The original P1 project specification was not part of the supplied archive; P1 is assessed against its documented contracts and deterministic harness.

## Implemented changes

| Finding | Changes | Deterministic validation |
|---|---|---|
| F-01 — false `fresh` | Git-only fingerprints are partial dependency witnesses: matching checkout returns `unknown`, changed checkout returns `stale`. Trusted command input closures are opt-in and include ignored files by content hash. Input metadata is bounded/validated. | Ignored `runtime.flag` changes a previously verified command to `revalidation_required`; an unspecified dependency set never yields verified. |
| F-02 — false static `verified` | Source excerpts remain grounded, but semantic acceptance is `supported`/`source_attested_not_semantically_verified`, never `verified` without executed proof. Manual finding resolution also rejects static review alone. | `authorized = false` excerpt and erroneous positive review do not produce a semantic PASS. |
| F-03 — finding identity | Stable UUID with semantic identity based on path+contractId+reproductionKey when grounded; conservative exact-evidence fallback; possible-duplicate hints; optional schema fields; subject-specific decision-state fingerprint. | Paraphrases with same contract and scenario match; distinct reproduction scenarios remain separate; changes to unrelated findings do not revoke acceptance, changes to subject findings do. |
| F-04 — missing trace events | Recovery, targeted revalidation and quality revision event kinds added to P1 observer allowlist, with structured count/status-only data and ExecutionView projections. | Events are persisted and replayed without raw commands or secrets. |
| F-05 — unsafe prose | Central redaction/truncation at new Quality evidence/finding/decision writes, normalized dependency objects and defensive sanitization in legacy read-only views. | Known token/password/bearer examples are absent from new stored Quality and legacy read-only views. |
| F-06 — quality in subscriptions | Unified runtime quality projection for current snapshot, `subscribeExecution` and `watchExecution`; revision notifications after atomic persistence, serialized callbacks and latest-run checks. Historical views stay historical. | Live subscriber and watch snapshots agree on the current revision; historical view has no present quality overlay. |
| R-01 — capacity | Safe limited compaction of superseded, unreferenced, unverified stage role claims; referenced and verified evidence protected; explicit `QUALITY_CAPACITY_EXCEEDED` on unsafe overflow. | 800+ observations compact safely; open-finding proof is retained; protected overflow fails explicitly. |
| R-02 — dependency closure | Full configured final verification preserved. Targeted recovery remains advisory/read-only and cannot skip mandatory tests. | Existing staged-resumption and targeted-revalidation evaluations pass. |

## Security/architectural decisions

- No new task/Plan/checkpoint database, scheduler or provider dependency was introduced.
- Only the host-side execution service reads `AGENT_VERIFY_INPUT_CLOSURES`. It is an **operator assertion of complete file inputs**, not a model instruction. Without it, a verification result can be observed yet cannot be asserted durably `fresh`. This intentionally reduces false passes at the cost of more `not_verified` cases.
- File manifest closure must not be asserted for commands depending on untracked environment state, external services, user secrets or unknown dynamic inputs. There is no universal dynamic-dependency proof facility.
- Finding metadata supplied by a model cannot independently prove that two semantic scenarios are identical. Strict identity plus non-merging ambiguity is safer than fuzzy coalescing. Known secret-pattern redaction is defense in depth, **not** a guarantee of detecting every arbitrary secret.
- Quality remains task-owned. Observability is best-effort and never becomes authoritative. Existing `version:1` Quality State and P1 traces load without forced upgrading of legacy model claims. Legacy approvals without the new subject-state key retain earlier Plan/checkout protections; sensitive approvals should be reissued where subject-state binding is required.

## Test results

Environment: Node.js **22.16.0**, npm 10.9.2. Project requires Node.js **>=22.20.0**.

- `npm run check`: **PASS**.
- `npm run test:evaluation`: **PASS**, nine suites, including the new independent audit regressions F-01–F-06 and R-01.
- 33 additional individually invoked non-ACP test commands: **PASS**.
- `npm test`: **BLOCKED** at `test:generic-acp` because `@agentclientprotocol/sdk` is not installed.
- `test:provider-progress`, `test:generic-acp`, `test:codex-acp-cancellation` and `smoke`: **BLOCKED** by missing ACP SDK or dependencies. `test:headless-real-provider` was not attempted. `npm ci` was attempted but timed out without completing; Node engine mismatch was also reported.
- Real Zed/ACP native presentation, live provider permissions, cancellations/reconnections and restart integration: **NOT TESTED** in this environment.

## P2 acceptance matrix (20 original criteria)

| # | Status | Basis / limitations |
|---|---|---|
| 1 | PASS (code) | Core and Quality remain host/provider neutral; live host unverified. |
| 2 | PASS | Plan, tasks and checkpoints remain authoritative. |
| 3 | PASS (contract) | Source, assessment and dependency state explicit; only trusted closure yields durable fresh. |
| 4 | PASS | Model check reports are not observed commands. |
| 5 | PASS (contract) | Criteria link to evidence; partial source attestation is not semantic verification. |
| 6 | PASS (deterministic) | Findings persist through role ingestion and saved sessions. |
| 7 | PASS (deterministic) | Scope/verdict cannot silently erase findings. |
| 8 | PASS (negative tests) | Changed relevant ignored input invalidates trusted evidence. |
| 9 | PASS (negative tests) | Unknown closure never becomes fresh automatically. |
| 10 | PASS (deterministic) | Saved stages reused, targeted diagnostics and restart tests. |
| 11 | PASS (deterministic) | Checkout reconciliation remains required. |
| 12 | PASS (deterministic) | Stale binding/subject-state gate invalidated. |
| 13 | PASS (contract) | Provider output cannot grant user approval. |
| 14 | PASS (deterministic) | Failing and unavailable checks remain distinct. |
| 15 | PASS (deterministic) | Existing typed provider/environment errors preserved; live provider unverified. |
| 16 | PASS (deterministic) | Read-only views do not execute roles or mutate workspaces. |
| 17 | PASS (deterministic) | Legacy session records load; no trust promotion. |
| 18 | BLOCKED (live) | P1 replay/event regressions pass; actual ACP native presentation was not tested. |
| 19 | PASS (deterministic) | Nine deterministic evaluation suites incl. negative cases. |
| 20 | PASS | This report records test results and genuine limits. |

**Release assessment:** P1/P2 audit findings have dedicated implementations and regression tests, but this environment does not establish live ACP/Zed integration correctness. Do not describe this delivery as production-ready until full SDK-dependent tests and live acceptance pass.

## Handoff instructions

1. In a Node >=22.20.0 environment run `npm ci`, `npm run check`, `npm test`, `npm run test:evaluation`.
2. Run actual Zed/ACP scenarios: plan/stream/diff presentation, unknown capabilities, read-only P2 views, two independent tasks, scope/risk/reconciliation gates, provider/client cancellation, process restart and Git drift.
3. Inspect observed coverage and approval traces without exposing model messages/credentials. Verify that repository input closure declarations are truly complete before enabling trusted `verified` carry-over.
