# P1 continuation — implementation and verification report

## Base

`role-orchestrator-p1-observability-source.zip` (host-neutral execution
observability and the first evaluation foundation). This patch does not change
workflow routing, provider APIs, permission handling, durable session format,
reconciliation policy, or implementation checkpoints.

## Delivered

- Version-1-compatible optional causal metadata on persisted execution events:
  invocation, parent, stage, attempt and structured reason code. Reconciliation
  turns remain attributed to an existing invocation, not new model calls.
- Snapshot-safe read-only `watchExecution` on the host-neutral runtime, with
  per-run monotonic deduplication. Old superseded runs cannot repaint the live
  execution view when their terminal event arrives later.
- Correct historical inspection: current saved checkpoints are *not* applied
  retroactively to old execution views. Read-only `listExecutionRuns` API.
- More informative ACP presentation: `/runs`, historical `/status [run-id]`,
  `/trace [count] [run-id]`, stage and activity totals, causal attempts,
  explicit fix decisions and bounded final limitation statuses. Existing native
  ACP Plan/diff/tool streaming remains unchanged.
- Expanded evaluation: real-runtime scenario baseline; correlation, history,
  snapshot/subscription and supersession regression; aggregate metrics and
  scenario-specific bounds; offline sanitized trace reporting and opt-in
  performance measurements.
- Trace data minimization, safe reason-code filtering and exact payload-size
  checks. Event schema remains backwards-compatible with previous v1 traces.

## Verification in available environment

- `npm run check`: passed.
- `npm run test:evaluation`: 5 suites passed (real workflow, observability,
  cancellation, P1 contracts, metrics).
- 30 additional independently runnable test scripts passed.
- `workflow-unstructured`: no conclusive result; exceeded the available
  per-suite time budget during the sequential test attempt.
- 4 ACP/provider test scripts plus smoke not executed successfully: required
  `@agentclientprotocol/sdk` unavailable. `npm ci` failed in the verification
  environment; local Node.js v22.16.0 is below project's requirement v22.20.0.
- Zed UI/manual streaming verification was not available. Benchmarks are
  machine-local observations, not universal performance guarantees.

## Scope of UI support

ACP v1 does not provide a guaranteed arbitrary embedded dashboard surface.
The delivered host UI is an enhanced **native ACP plan/progress stream** with
read-only inspector commands. Other rich UIs can subscribe to the same
host-neutral `ExecutionView`. There is no Zed-specific state owner in the core.
Cross-process push transport and a custom embedded web cockpit were deliberately
not introduced; they would be separate optional hosts rather than prerequisites
for the observation architecture.

## Limitations and follow-up

Control traces are bounded diagnostic histories, **not** an event-sourced
replacement for durable session checkpoints or a guaranteed audit ledger.
Provider-independent trace causal links only assert correlation the runtime
actually observed; they do not claim to reproduce hidden model reasoning.
In-process subscriptions require re-snapshotting after reconnect; no extra
model invocation occurs during inspection. Live model quality evaluations and
Zed end-to-end testing should be performed in a compatible integration
installation before declaring full environmental certification.
