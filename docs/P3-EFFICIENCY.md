# P3 — Efficiency Foundation (implementation notes)

This iteration adds bounded, privacy-minimal efficiency observations and conservative optimization hooks on the host-neutral runtime. It does **not** replace P1's trace or P2's evidence, plan, checkpoint, permission or recovery authority.

## Shipped

- `src/efficiency/analytics.mjs`: session-scoped run/invocation usage ledger with stable invocation IDs, bounded retention (80 runs, 128 invocations/run), observation coverage and deduplication. Streaming usage reports are treated as **snapshots**; they are not summed. ACP `usage_update.used` indicates occupied context, **not** billable token consumption, so it is not recorded as `totalTokens`. Incomplete Codex CLI usage fields remain unknown, not zero. Cached input is not added to input again. Missing counts remain null. Contradictory usage snapshots (such as cached input exceeding all input) are sanitized at the final observation and persisted-session boundaries. Summation beyond JavaScript safe-integer precision is reported as unknown with an overflow indicator, rather than as a precise token count. A reported aggregate is a known lower-bound observation, **not** an estimate of subscription quota or monetary cost.
- `src/session-store.mjs`: same atomic session persistence for efficiency records, schema allowlisting and legacy compatibility. Records never persist prompts, role outputs or code excerpts. Failed executions can retain partial usage and remain classified as failed/incomplete; final execution state is still authoritative elsewhere.
- `src/efficiency/history.mjs`: opt-in, repository-scoped cross-session read-only aggregation from existing session files; symlinks rejected, files/rows bounded, no second task database. Historical aggregate selects the most recently updated **matching-repository** sessions within bounded metadata inspection, so more active unrelated repositories do not evict relevant history; it is descriptive and may be biased by omitted sessions when the cap is reached. Metadata is normalized again when reading from disk.
- `src/acp.mjs`: `/efficiency` and `/efficiency history` commands without LLM calls. `getEfficiencyView()` and `getEfficiencyHistory()` are host-neutral runtime methods.
- `src/efficiency/context.mjs`: role-aware *historical* context compilation. Available only with an existing saved Plan and opt-in; authoritatively supplied task, Plan, Engineering Core, mandatory role policy and security remain unchanged. Unknown handoff fields force fallback to original Explorer report.
- `src/workflow.mjs`: opt-in saved-Plan deterministic router bypass (only after checkout reconciliation, Plan identity checks and checkpoint matching). Conservative high-tier route. Explorer, coder, independent review and mandatory verification are not omitted.
- `src/efficiency/optimization.mjs`: deterministic review impact and retry progress assessment; plan suggestions are advisory. On unknown impact, review stays full. Model escalation is recommendation-only and requires allowed alternatives/quality baseline.

## Controls

| Environment | Default | Effect |
|---|---|---|
| `AGENT_P3_HISTORY=1` | off | Enables cross-session historical aggregate endpoint (scoped to repository). |
| `AGENT_P3_CONTEXT=1` | off | Reduces only selected roles' historical dialogue during saved-Plan continuation, with manifest semantics. |
| `AGENT_P3_HANDOFF=1` | off | Uses structured Explorer handoff when schema known and within size bound; original report otherwise. |
| `AGENT_P3_CONTINUATION_FAST_PATH=1` | off | Allows deterministic router bypass for validated saved-Plan continuation; Explorer still runs. |

Basic session efficiency observations are enabled. Optional efficiency failures must not grant permissions or change completion verdicts.

## Correctness & fallback

- Never skip mandatory verification or independent review on incomplete impact information.
- Claims in Explorer handoff remain `model_report_unverified`, not P2 evidence.
- Reviewer may inspect any related source independently; reductions do not grant authority to reuse stale proof.
- Provider infrastructure failures do not imply an underperforming model and never independently trigger escalation.
- The same model invocation is counted once, regardless of multiple usage updates or persistence/replay. Saturation of the 80-run/128-invocation retention limits is surfaced as incomplete telemetry rather than presented as comprehensive usage.
- Context optimization is opt-in because a precise scope of all prior user constraints cannot always be reconstructed from historical text.

## Current exclusions / prerequisites for production acceptance

The *full proposed P3 roadmap* is **not** complete: a proven dependency graph for selective fix-round review and verified reduction of real usage costs are not available yet, and escalation does not automatically change assignments. These require empirical datasets, provider capabilities and end-to-end checks. This implementation deliberately retains full review on unknown impact rather than claiming an unsafe optimization.

Acceptance in actual Zed/ACP requires Node >=22.20, installed SDK dependencies and representative comparative tasks on the same checkout. The local regression harness tests host-neutral behavior; it cannot validate subscription quota savings or real ACP compatibility.

## Tests

`npm run check`, `npm run test:evaluation` (includes P3 tests), `npm run test:p3` (including `p3-hardening-audit.mjs` and `p3-stability-round2.mjs`). Specific evaluation tests cover streaming usage deduplication, unknown usage, session persistence/replay, cross-session opt-in history, privacy, malicious symlinks, canceled/failed usage recording, plan fast-path with real workflow, conservative context/handoff, review impact, escalation policy, P1/P2 regressions.

## Monitoring extension

See [`P3-CONTEXT-MONITORING.md`](P3-CONTEXT-MONITORING.md) for the no-model-call profiling of prompt sections, context occupancy snapshots, tool calls and per-run JSON export. This is observation-only; all P3 context optimization switches stay off by default.


See [P3 Measurement Completion](P3-MEASUREMENT-COMPLETION.md) for the extended monitoring contract, router context modes, provider limitations and safe rollout.
