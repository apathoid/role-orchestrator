# P3 Context Monitoring — Implementation & Two Audit Passes

## Scope

Baseline: `role-orchestrator-context-monitoring.zip` created from `role-orchestrator(7).zip`. This is a provider-neutral monitoring enhancement only, **not** context optimization or a change to routing, Engineering Core, permission semantics, P2 quality, role prompts or verification.

## I1 — Composition & correlation

- Added exact known-source, non-overlapping `taskBody` sizes without regex-parsing untrusted prompt text; anything ambiguous remains `other`.
- Added provider-adapter boundary measurements for generic ACP, Codex ACP and Codex CLI. These do not claim to measure hidden internal model instructions.
- Propagated invocation IDs to reasoning/commentary/native updates and introduced explicit diagnostic execution scopes for routing, exploration, planning, investigation, review batches, staged implementation, fix rounds and response.
- Preserved old run schema/version and compatibility of previously persisted runs.

## I2 — Timeline & first activity

- Bounded occupancy timeline: monotonic elapsed time, used/window tokens, nearby tool ordinal, explicit truncation and dropped observations.
- Added first reasoning, commentary, answer, tool-call and any-activity observations, distinguished from exact TTFT.
- Generic and Codex ACP forward non-textual first-activity **signals**, without persisting original model output.

## I3 — Usage & persistence

- Provider-neutral `usage-observations.mjs` supports cumulative/final/delta/occupancy, request IDs, deduplication, partial coverage, conflicting scopes and bounded accumulation.
- Context occupancy is never used as a proxy for token expenditure. Missing provider metrics remain unknown.
- Telemetry cannot displace Plan/checkpoint/P2 quality: session storage drops oldest optional telemetry when needed and preserves existing atomic/canonical write guards.

## I4 — Reporting & tests

- `/efficiency run <id>` now reports initial body composition, adapter boundary, coverage, timeline length and activity.
- Export remains JSON through existing P3 commands and `tools/efficiency-export.mjs`, without new databases or background tasks.
- Added `test/evaluation/p3-monitoring-hardening.mjs`; original monitoring test and P1/P2/P3 Evaluation Harness remain compatible.

## Audit pass 1 — correctness/architecture

Findings and remediations:

1. **Unbounded optional metrics relative to canonical session**: bounded timeline plus telemetry-only cap and 20MB total-state fallback; no mutation of authoritative task records.
2. **Usage scopes would otherwise be conflated**: created explicit observation semantics, deduplicated deltas/finals and partial coverage for missing counters.
3. **Tool-event and fix-round misattribution**: invocation scopes and ID propagation; stage/review legacy fallback is distinct from explicit scope.
4. **Missing first-answer signal on buffered ACP output**: added provider-neutral answer activity that does not require rendering the content.

## Audit pass 2 — adversarial/privacy/integration

Findings and remediations:

1. **Provider supplemental block counts were measured before capability filtering**: moved profile event after the actual block selection in both ACP adapters; CLI reports no unsupported supplemental blocks.
2. **High-volume unique usage scope IDs could grow state**: capped usage scope and delta-ID tracking; oversized/incomplete observations remain unknown, not an invented total.
3. **Persistence of manipulated nested telemetry**: allowlisted provider boundary, timeline, scope and task-body measurements, with source content never retained.
4. **Reported totals might include incomplete request coverage**: totals now require values from every observed independent scope. Nested session/turn/request combinations cannot be naively added.
5. **Optional monitoring events could perturb P1 trace or model execution**: provider/profile/activity metadata stays outside P1 presentation and optional event emission is failure-isolated.

## Verification environment

- `npm run check`: PASS.
- `npm run test:evaluation`: PASS, including new hardening suite.
- `npm run test:monitoring`: PASS.
- `npm test`: blocked at `test:generic-acp` because `@agentclientprotocol/sdk` is not installed in this sandbox (`node_modules` absent). All preceding suites passed. Node in this sandbox is 22.16.0; package requires >=22.20.0. Re-run `npm ci && npm test` in an environment with proper dependencies and Node runtime before marking production deployment fully verified.

## Explicit limitations

This monitor does not independently obtain OpenCode/llama.cpp exact input and output token counters through generic ACP; these remain unknown when not reported. It cannot assign token growth to a specific tool with causal certainty, nor infer whether a large context was unnecessary. Evaluate actual real-task exports before choosing lossless optimization work.
