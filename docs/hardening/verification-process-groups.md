# Verification subprocess group cleanup (2026-10-28)

## Scope

This change addresses one independently identified subprocess-lifecycle defect. It does **not** establish the root cause of the original live `INFRA_FAILURE`, or complete production hardening.

## Defect and fix

`execFileSafe` used to stop signalling a subprocess when the direct child already had an exit code. With `killProcessGroup: true`, a successful wrapper can exit while a grandchild still holds stdout/stderr open. The `close` event waits for those streams, but timeout/cancellation would skip signalling the surviving process group. Verification could remain unresolved indefinitely.

The POSIX process-group termination path now attempts group signalling regardless of the wrapper's exit state. It retains the direct-child fallback if group signalling fails, performs SIGTERM-to-SIGKILL escalation once, and cancels the escalation timer when a subprocess has closed. A non-EPIPE stdin failure also terminates the process.

## Verification evidence

- `node test/execution-verification-completion.mjs`: **PASS** (includes wrapper-exits-first, descendant ignores SIGTERM, and cancellation regression cases).
- `node test/evaluation/effect-aware-hardening.mjs`: **PASS**.
- `npm run check`: **PASS**.
- `npm test`: **ENVIRONMENT_ERROR**, stops on `ERR_MODULE_NOT_FOUND` for `@agentclientprotocol/sdk`. The available Node.js version is `22.16.0`, while `package.json` requires `>=22.20.0`. This is not proof of a product test failure or a passing suite.

## Security/operational limits

POSIX process-group signalling only covers descendants that remain within the spawned group; processes explicitly escaping their group, daemonizing, or being managed by a separate host are not guaranteed to terminate. This fix does not provide provider-owned tool interception, per-path write authorization, or scope isolation. Validate further with real ACP providers and an enforced host sandbox.

## Publication

Published on the dedicated `feature/production-hardening-completion-20261028` branch. This is a partial, individually verified change; other production-hardening phases remain open.
