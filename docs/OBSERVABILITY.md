# P1: Host-neutral execution observability and evaluation

## Architecture and ownership

The **workflow** remains the owner of routing, authorization, reviews, and task outcomes. The **session/checkpoint store** remains the sole authority for resumable implementation and review progress. The new observation layer records *what happened*; it neither executes roles nor grants additional permissions.

`createOrchestratorRuntime()` owns outer run identity, the turn queue, and normalized event delivery. `src/observability/execution-observer.mjs` provides run-level correlation, a redacted JSONL trace, `ExecutionView` projection, restart replay, and read-only inspection. `execution-diagnostics.mjs` maps typed errors to cause, provenance and next steps. Host adapters format the views; provider adapters only produce their existing progress events.

```
Runtime / CLI
   | existing workflow / role events
   +----> Native host reporter (ACP streaming, native tool/diff/plan updates)
   |
   +----> ExecutionObserver (in-memory projection + bounded, asynchronous JSONL)
              |                  |
              +--> read-only API +--> optional host presentation / eval harness
```

The observer intentionally does **not** store source snippets, prompts, raw tool output, diff contents, thought summaries, attachment bytes or arbitrary error messages. Only explicitly allowlisted, size-limited fields are persisted. Events use version 1, session ID, run ID, monotonic sequence, event ID and timestamp. Role starts/completions/cancellations share their `invocationId`; workspace reconciliation decisions are represented by separate events. Provider-specific errors can be classified with explicit codes (e.g. `WORKSPACE_UNSTABLE`, not `PROVIDER_CRASH`).

## API

From a host-neutral runtime instance:

```js
await runtime.getExecutionView(sessionId, runId /* optional */);
await runtime.getExecutionTrace(sessionId, { runId, limit: 50 });
const unsubscribe = runtime.subscribeExecution(sessionId, (view) => {
  // In-process immutable ExecutionView snapshot (not an action or permission).
});
```

`getExecutionView` overlays authoritative session checkpoint data whenever available. A received `implementation_stage_done` event alone marks an observed stage **awaiting checkpoint confirmation**; it is not considered safely completed until its saved checkpoint confirms it. After a restart, a trace without a terminal run event is shown as `interrupted`, never as successful. Resuming implementation still uses the preexisting checkpoint/reconciliation machinery.

In the Zed ACP integration, the following commands return deterministic read-only information **without model calls**:

- `/status`: latest run lifecycle, result, phase, roles, checkpoints, verification and diagnostic details.
- `/trace [count]`: recent sanitized control events (up to 50).
- `/checkpoint`: saved implementation/review checkpoint summary.

The existing native ACP plan, diff, tool-call, reasoning/usage and final-answer streams remain unchanged. ACP v1 does not guarantee arbitrary embedded dashboard widgets: P1 provides a progressive-disclosure cockpit through native text and plan surfaces, plus the neutral API required by richer future hosts. A separate web dashboard is deliberately not required.

Headless runtimes have the same API. Stateless CLI runs also emit observations under a synthetic `cli-<uuid>` session identity but retain their original execution behavior and do **not** create a persistent ACP session.

## Retention, privacy and failures

Trace root: `${AGENT_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/role-orchestrator}/execution/<session>/<run>.jsonl` (actual default prefix follows the configured project name).

- Run event cap: 3,000 structured control events, plus one terminal event.
- Run size cap: 2 MB, with a clear `trace.degraded` signal if disk writes fail.
- Per-session retention: most recent 20 run files, 14-day age threshold (opportunistically pruned after successful terminal persistence).
- Directory permissions: 0700; file mode: 0600; symlinked trace directories and trace files are rejected. No follow-symlink reads.
- High-frequency content/tool/reasoning telemetry stays in its **native streaming channel** and is not persisted as raw diagnostic content. The run summary records a dropped-telemetry count and truncation flag.
- Control-event persistence is serialized per run, with important milestones flushed durably. Observation errors are surfaced diagnostically, not used to mutate task success state.
- Retention does not affect `sessions/` or the durable plan/checkpoint. Trace is not a recovery checkpoint or an audit-grade append-only ledger.

A completely durable, globally transactional log or cross-process live subscription is intentionally outside P1: these would require substantially more coordination than the existing single-process session runtime. If a diagnostic write fails, the saved authoritative checkpoint still governs safe continuation.

## Evaluation harness

Run:

```sh
npm run test:evaluation
```

The deterministic suite includes:

- Real host-neutral workflow with fake provider transport (no live model or ACP client).
- Invocation correlation, routing and read-only behavior.
- Real runtime session persistence, checkpoint overlay and restart replay.
- Cancellation/supersession provenance and prevention of false completion.
- Workspace drift/fix decision visibility, diagnostic attribution.
- Redaction of tool output, reasoning, file paths and error payloads from persisted traces.
- Trace retention, symlink safety and no extra model calls for inspection.

Future model-dependent evaluation should be opt-in, with pinned fixture repositories, measured variance and explicit cost controls; it must not gate deterministic CI.

## Extension rules

Add events at the actual mechanism's owner (workflow, execution service or provider boundary) and update the centralized allowlist and projector. Never make workflow decisions from the projection, never add host-only UI state to the workflow and never persist raw provider payloads by default. Maintain backwards-compatible versioned events. Keep tests of the real host-neutral runtime in addition to pure projection tests.

## P1 continuation: causal context, consistent snapshots and execution history

The event schema remains **v1** and is backward-readable: newly emitted events
carry an optional `correlation` object, while preexisting v1 traces without it
continue replaying unchanged. Correlation fields are derived only from actual
workflow observations:

- `invocationId`: the established inner invocation (never a fabricated new
  invocation for an explorer reconciliation turn).
- `parentId`: the attributable invocation or implementation stage, when known;
  omitted/null when multiple concurrently active invocations make attribution
  ambiguous.
- `stageId`: the observed implementation stage when known.
- `attempt`: the number of observed workspace reconciliation turns within the
  invocation, or the emitted fix-round index.
- `reasonCode`: a structured, sanitized causal class. Diagnostic evidence is
  **not** equivalent to raw model reasoning.

Sanitized `ExecutionView.activity` exposes role invocation, reconciliation and
fix-round counts. The live subscription publishes updates only for the latest
run: an older run's terminal event after supersession cannot overwrite the new
run in the UI. `watchExecution(sessionId, listener)` delivers an initial
snapshot plus live updates without the snapshot/subscription gap. Delivery is
at-most-once per `(runId, sequence)` to each watcher, with no reverse progress
within a run. Existing `subscribeExecution` is retained for compatibility.
Live subscriptions are **in-process**; use `getExecutionView` after host
reconnect or process restart.

Read-only session history APIs:

```js
const recent = await runtime.listExecutionRuns(sessionId, { limit: 10 });
const view = await runtime.getExecutionView(sessionId, recent[1].runId);
const events = await runtime.getExecutionTrace(sessionId, { runId: recent[1].runId, limit: 50 });
const unsubscribe = await runtime.watchExecution(sessionId, (view) => {
  // Initial snapshot and subsequent updates. Never executes a role.
});
```

**Historical views never overlay today's checkpoint onto an old run.** They
are explicitly marked `historicalSnapshot`. Current checkpoint remains the
only authority for safe implementation continuation.

ACP/Zed read-only commands now include `/runs`, `/status [run-id]`, and
`/trace [count] [run-id]`. Their text view adds causal turn/attempt information,
checkpoint-confirmed progress and a bounded summary of role activity. The
existing native ACP Plan, progress, diff and tool presentations remain intact;
there is deliberately no host-only UI object in the workflow. Custom embedded
interactive dashboard controls cannot be required by an ACP v1 client.

## Evaluation reporting and performance baseline

`npm run test:evaluation` includes real host-neutral workflow cases, a
replay/snapshot/causality/supersession scenario, and deterministic metric
assertions. The fixtures use fake providers and do not consume model credits.

```sh
npm run evaluation:report -- <session-id> [run-id]
npm run benchmark:observability
```

`evaluation:report` computes structured aggregate evidence only from sanitized
retained events (full bounded trace, not the UI's last 50 events): invocations,
completion pairs, Git reconciliation turns, observed fix rounds, failed
verifications, trace-sequence violations and elapsed time. A scenario can
compare numeric bounds with `compareExecutionBaseline` without inventing a
subjective quality score. The benchmark measures local event-publication
latency and duration through disk flush; its values are environment-specific,
not universal performance guarantees. No raw prompts, secrets or file content
are part of these reports.

**Remaining integration constraints:** Actual Zed runtime/native ACP UI and
live-model behavior must be exercised in a compatible Node.js environment with
SDK dependencies available. Cross-process push transport, OpenTelemetry export
and custom embedded dashboard UI are optional future adapters, not guarantees
of this host-neutral observability API.


## P2 quality activity and subscription consistency (October 22, 2026)

The observer v1 allowlist now includes `quality_recovery_assessed`, `quality_targeted_revalidation` and `quality_revision_changed`. Event payloads contain only bounded counts, disposition codes, task identifiers and revisions. Verification command strings, sensitive paths, source excerpts and raw output are deliberately absent. `ExecutionView.qualityActivity` exposes corresponding counters/status; existing v1 run files continue to replay unchanged.

`getExecutionView` and the live `subscribeExecution` / `watchExecution` interfaces use the same **current task** quality projection (revision, evidence count, open findings, pending decisions, read-only recovery assessment). A committed session quality change may update a subscriber independently of an unrelated provider event. Subscription callbacks are serialized and checked against the latest run; older terminal runs do not replace newer execution state. No P2 state is written into P1 event logs beyond a safe revision/invalidation event. A historical `getExecutionView(sessionId, runId)` never overlays the present task quality.

Quality revision notifications follow a successful atomic task save and are best-effort. The authoritative durable task remains the only source of truth. External workspace changes may require explicit refresh; there is no filesystem watcher and no guarantee of cross-process live broadcasts. Reconnect by obtaining a new `getExecutionView` snapshot.

### P1/P2 follow-up: durable verification attempts

P2 saves verification-attempt starts against the authoritative task before executing
commands, so a cancelled process or incomplete suite does not inherit a historical
PASS. Execution Trace remains diagnostic only; a missing event cannot change a saved
attempt. Read-only Quality views distinguish durable `verified` from temporary
`verified_current_run`, which is available only during the same workflow invocation.
See `docs/P2-QUALITY-RECOVERY.md` for details, input closures and legacy scrubbing.
