# Audit 1 — Architecture & Security (2026-10-28)

## Scope and evidence

Inspected `src/routing/{task-spec,request,semantic-evaluation,ground-truth,reporting,regression}.mjs`, `src/observability/execution-observer.mjs`, the Ground Truth CLI and Zed-oriented integration tests. Ran `test/routing-quality-hardening.mjs`, `test/routing-integration.mjs`, `test/evaluation/execution-observability.mjs`, `test/prelive-security-failures.mjs` (see collected verification logs). The Router request builder and authorization policy were not modified. Evaluation and reporting read already-produced data and cannot invoke or authorize an execution; the evaluator's real `--run` path is explicitly provider backed and separate from reporting. Offline regression CI does not instantiate a provider.

## Findings, root causes and remediation

| Severity | Finding / reproduction | Fix | Regression evidence | Status |
|---|---|---|---|---|
| HIGH | Free-form caller-controlled, identifier-shaped fields in diagnostic projection could be persisted as raw status/code/role/model identifiers. Adversarial injection into legacy events reproduced a leak. | Keep known typed categorical labels; hash unknown opaque values; enumerate provider errors and source fields; do not persist provider reason prose; hash possible model-generated step IDs. | `test/routing-quality-hardening.mjs` injected secrets through old and new event types and persisted/reloaded JSONL. | FIXED (tested local) |
| HIGH | Existing trace files with unsafe permissions were accepted for append/read. | Reject group/world-readable, multi-linked or non-owned trace files; preserve O_NOFOLLOW and 0600/0700. | `test/routing-quality.mjs` + storage negative cases. | FIXED (tested local) |
| MEDIUM | Captured Ground Truth lacked a strict link to originating diagnostic run. | Opt-in, constrained `capture` metadata; manual consent; candidate remains `unlabeled`, exclusive 0600 output; refuse symlink parents. | Candidate CLI regression, duplicate and privacy tests. | FIXED |
| MEDIUM | Untrusted failure codes could be assigned a provider label by default. | Explicit failure taxonomy and safe mapping; absence of provenance stays unknown. | Provider distribution tests. | FIXED |

## Invariants

- No new semantic parser or second evaluator introduced; `validateTaskSpec` remains selector authority.
- No changes to deterministic host write gate, authorization, trusted continuation or execution behavior.
- No route/report/ground-truth CLI invokes a provider. `--run` is intentionally different from `--offline` and is not used in CI.
- Raw task text exists only in explicitly supplied, operator-reviewed Ground Truth files, never routine traces.
- Event categorization/hashing is diagnostic-only; persisted IDs are stable for correlation, but some formerly literal display labels are now hashes.

## Limits

Host-neutral fake-provider tests cannot validate the real ACP SDK, Zed UI, or live cancellation; full `npm test` is blocked at missing `@agentclientprotocol/sdk` here. Symlink/permissions checks reduce local filesystem risk but do not constitute a formal proof against all adversarial concurrent filesystem races. Live provider and full production suite remain `NOT_VERIFIED`.
