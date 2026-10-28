# Role Orchestrator — implementation against the 2026-10-27 audit

Base: `role-orchestrator(5).zip`. The audit findings were raised against
`role-orchestrator(4).zip`, so this work also inspected the corresponding
production paths in the newer base. This document distinguishes code changes,
local test results, and validations that remain unavailable.

## Implementation ledger

| Finding | Change | Local verification |
|---|---|---|
| AUD-001 | New `workspace-fs-boundary.mjs` with Linux directory-descriptor anchoring and `O_NOFOLLOW` traversal. Denied-path captures and restorations use the anchored boundary; restored files use exclusive no-follow leaf opens; no recursive deletion of changed leaf directories. On unsupported platforms this path fails closed. | External symlink target remains unmodified; normal denied-file restore passes. |
| AUD-002 | Generic/Codex adapters wait for `startPromise` before considering an existing transport ready. Negotiated response is checked before publishing `initializeResponse`. | Mock ACP delayed handshake and 10 concurrent invocations. |
| AUD-003 | Generic adapter observes `ChildProcess.error` and early exit while negotiating, closes resources, and reports an initialization failure. | Mock ACP plus real `spawn(ENOENT)`. |
| AUD-004 | Failure during initialization tears down the transport and clears the ready state, enabling a fresh handshake on retry. | Mock ACP rejects the first initialize and accepts the second. |
| AUD-005 | `AcpInvocationGuard` is attached before the first awaited RPC; it covers provider startup, `session.new`, mode/config preflight and prompt interruption. Invocation deadline and preflight limits are separate from model idle/turn deadlines. | Mock hung `session.new` abort/timeout, direct guard tests. |
| AUD-006 | Reconciliation does not migrate scope-wide `risk_follow_up` or any empty-ID report as unit-local evidence. Reassessment is required after changed scope. | Direct reconcile regression test. |
| AUD-007 | Git capture now requests `requireComplete`. Truncation is machine-readable (`truncated`, `stdoutTruncated`, `stderrTruncated`) and strict consumers error instead of producing partial states. Streaming capture for repositories larger than the configured bound is an optional follow-on, not implemented here. | Explicit 150-character-over-30-limit regression, Git state tests. |
| AUD-008 | Project security merges retain a trusted base policy: project allows cannot override global denials. The explicit `AGENT_CONFIG` remains a trusted highest-authority override; exact denyPaths always win. | Security precedence and trusted override regressions. |
| AUD-009 | `session.close` now uses a bounded, best-effort deadline, with transport teardown if the remaining session is isolated. Cleanup does not mask primary invocation error. | Mock peer never answers close. |
| AUD-010 | README current dependency versions match `package.json`; consistency regression test added. | `test/documented-dependencies.mjs`. |
| AUD-011 | Persisted session writes use revision conflict detection plus mutually exclusive write locks. Linux uses a kernel `flock` held by an open descriptor, automatically released on process exit. Other platforms retain a conservative PID-lock fallback; full cross-platform crash recovery has not been verified. | Two independent processes read one revision; exactly one save succeeds and the other reports `SESSION_REVISION_CONFLICT`. |
| AUD-X01 | Persistent session store now accepts Review Checkpoint v4 and rejects unknown checkpoint versions instead of silently converting them to null. | v4/quality-state save→load round-trip and negative test. |

## Scope and design decisions

- Host/ACP boundaries remain outside the host-neutral workflow core.
- `TurnTimingGuard` retains existing idle/absolute turn semantics; the new
  invocation guard supervises preflight and abort without replacing them.
- An interrupted preflight RPC has no portable underlying ACP abort primitive:
  if a shared provider transport has other live sessions, it cannot be forcibly
  closed without affecting them. Local invocation completion is bounded but
  remote cleanup under this specific concurrent scenario requires live SDK tests.
- Review risk reports with empty `unitIds` cannot prove scope-independent
  validity; they are invalidated on reconciliation pending a more granular
  dependency/provenance contract.
- Oversized Git results fail closed rather than running with a partial snapshot.
- Session conflict detection is intentional: it does not merge concurrent
  transcripts or accept silent last-writer-wins.
- Linux session locking requires the `flock` executable available in PATH.
- The Linux anchored-filesystem boundary depends on `/proc/self/fd`; it must not
  be replaced by a plain `realpath` check followed by unsafe mutation.

## Local validation evidence

- `npm run check`: PASS (syntactic checks).
- `node test/security.mjs`: PASS.
- `node test/session-store.mjs`: PASS.
- `node test/review-operation-continuity.mjs`: PASS.
- `node test/acp-invocation-guard.mjs`: PASS.
- `node test/acp-lifecycle-hardening.mjs`: PASS using a **test-only mock SDK**.
- Direct non-SDK test traversal: 78 PASS, 0 FAIL, 8 skipped as ACP-dependent,
  standalone fixtures, runner or long diagnostic script.
- `npm ci --ignore-scripts --offline`: BLOCKED (`zod@4.6.5` was not in npm cache).
- `npm ci` online: did not complete successfully in the available environment.
- Available local Node.js: `22.16.0`; project requires `>=22.20.0`.

The missing live SDK means this is **not yet a fully verified ACP integration**.
Before declaring production readiness, run `npm ci`, `npm test` on a supported
Node version, then actual Codex ACP and generic ACP protocol tests with a live
host. Repeat cancellation/close/initialize concurrency cases against real ACP
SDK semantics, including multi-session shared transports and process cleanup.
