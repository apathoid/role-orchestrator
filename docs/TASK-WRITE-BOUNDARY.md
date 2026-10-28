# Task-level write boundary (partial, fail-closed)

The semantic Router produces a **model-interpreted** Task Spec. It is not an
unforgeable user permission. An ACP `tool_call` update is telemetry, and a
`session/request_permission` message is optional provider behavior. Neither
intercepts all filesystem writes by an ACP agent. This project does not claim
an atomic provider-owned per-path enforcement layer.

The existing post-write audit still detects some visible changes and preserves
user edits. It does not guarantee prevention, isolation of ignored files, or
attribution of concurrent external mutations.

## Current execution contract

- `read-only` roles use the host/provider read-only mode but the guarantee is
  only as strong as the host and provider; the orchestrator reconciles visible
  workspace drift and checks protected paths.
- Before **preparation**, mutating agent turns, and subsequent provider calls,
  the change workflow checks the current typed Task Spec and any saved Plan
  restrictions. A missing or non-explicit change authorization fails closed.
- `tests_only`, `production_only`, or any nonempty `excludedPaths` restriction
  blocks writable execution **before** invoking potentially mutating commands.
  The error is `WRITE_AUTHORIZATION_BOUNDARY_UNAVAILABLE`.
- A legacy unrestricted change retains backwards compatibility with status
  `NO_PER_PATH_ENFORCEMENT`: it is not certified safe against unauthorized
  provider-originated writes, even if a protected-path post-write restoration
  policy exists.
- A newer unrestricted Task Spec cannot relax the restriction of a saved plan.
  User approval does not yet supply a verified sandbox to make restricted
  operations possible. Do not remove this guard merely to unblock a test task.

## Missing capability

To safely unblock path-scoped tasks, a trusted host must enforce a writable
allowlist with an independently verified filesystem boundary (or equivalent
isolation) covering the complete process tree, provider-owned tools, spawned
commands, verification, and resume. Check symlink escape, hard links,
rename/move, filesystem mounting, ignored files, process inheritance and
concurrent external edits. Provider declarations and natural-language prompts
are not acceptable security witnesses. ACP protocol integration and real Zed
acceptance tests are still required.

The explicit Git `files` selector is read-only inventory/evidence. It is
**not** an authorization allowlist. On Linux its content fingerprints use
pinned no-symlink parent directory handles. A missing file is recorded as
missing. On other hosts this selector may be unavailable rather than silently
perform an unsafe filesystem walk.
