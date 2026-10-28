# P2 Hardening & Completion — Engineering Report

## Scope and baseline

This follow-up is based exclusively on the **previously produced P2 source archive** (`role-orchestrator-P2.zip`), not on older pre-host-neutral versions. The new patch is relative to that P2 archive. Original providers, task/Plan/checkpoint owners, cancellation provenance, implementation/review continuation, scope-aware fixes, persistence and P1 Observability are retained.

## Delivered code

| Layer / file | Follow-up |
|---|---|
| `src/schemas.mjs`, `src/implementation-stages.mjs`, `src/roles.mjs` | Optional Plan `acceptanceReviews` and independent review `sourceAnchors`, including schema validation and digest compatibility with legacy Plans |
| `src/quality-state.mjs` | Safe source-excerpt verification with per-file freshness and explicit proof methods; conservative observed-test-backed finding resolution; structured revalidation targets; state-bound checkout reconciliation gates and approval reconciliation |
| `src/quality-view.mjs` | Distinguish observed command proof vs source-anchored review; show targeted recovery recommendations |
| `src/workflow.mjs` | Consume two-phase recovery preflight before writable stages and carry saved evidence/findings into resumed review; attach checkout gates to existing reconciliation; preserve existing full verification |
| `src/execution-service.mjs` | Bind read-only recovery and reconciliation decision callbacks, persist checkout decisions atomically with task reconciliation state |
| `test/evaluation/p2-completion.mjs`, `package.json` | Deterministic tests of source attestations, mismatches, freshness, genuine configured command execution, finding closure/replay, proposal ID separation, revoked freshness, refusal and approval |

## Architectural and security decisions

- **No new checkpoint database.** All additional records are stored in the existing implementation task's versioned `quality` object.
- **No fake process provenance.** A source excerpt is inspected by code, but the model's conclusion about its *meaning* is a `supported` static review, never `observed` execution. The Evidence Matrix exposes which method yielded acceptance.
- **No silent remediation grant.** Findings remain separate from authorization. Reconciliation approval requires a real host user choice, preserved state binding and the original Plan reconciliation checks.
- **No false freshness.** Exact file hashes are used for static review and conservative checkout identity for configured verification; unknown evidence cannot silently become fresh.
- **No premature automatic repair.** Only previously observed failing verification re-run successfully under the strict conditions described in `docs/P2-QUALITY-RECOVERY.md` can auto-resolve a confirmed finding.

## Verification actually performed

- `npm run check`: **PASS**.
- `npm run test:evaluation`: **PASS**, including P1 and both P2 suites.
- `npm test`: **INCOMPLETE**. Executed suites passed until `test:generic-acp`, then stopped with `ERR_MODULE_NOT_FOUND` for `@agentclientprotocol/sdk`.
- Additional 24 test targets after that point: **21 PASS, 0 assertion failures, 3 BLOCKED** (`test:codex-acp-cancellation`, `test:provider-progress`, `smoke`; ACP SDK unavailable).
- Installed Node: `v22.16.0` (project declares `>=22.20.0`); no `node_modules` in the source archive. **A live Zed/ACP integration run was not performed.**

## Outstanding P2 completion criteria

1. **Automatic dependency-closed targeted test execution** has **not** been completed. The recovery proposal now selects granular revalidation targets, but final workflow intentionally keeps the configured full suite. A correct selective runner requires a trustworthy per-command dependency closure or an explicit user-audited contract; model-guessed dependencies would risk a false pass.
2. **Production ACP/Zed validation** remains unverified because the supplied environment lacks the declared SDK dependencies and required Node version. Native commands, real provider cancellation, restart and permission interop must be tested in that environment.
3. Static semantic correctness is ultimately a reviewer judgment. Excerpt checking validates provenance/freshness, **not behavior**; tests are still mandatory wherever acceptance depends on executable behavior.
4. Generalized structured gates for risk acceptance beyond checkout reconciliation and remediation scope are not automatically generated. Workflow must not interpret such gates as permission to bypass mandatory verification or security.

**Release assessment:** substantial P2 hardening delivered, deterministic checks pass; full P2 acceptance is **not yet established**. No claim of production readiness is made without the missing end-to-end verification and safe selective-execution contract.
