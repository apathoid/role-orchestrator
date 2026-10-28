# P3 — Context & Invocation Monitoring

This addition to the existing P3 Efficiency Foundation is **observational**. It does not reduce any prompt, change model selection, authorize writes, alter evidence freshness, skip validation or introduce an LLM call. It works through the existing host-neutral workflow and AgentProvider interfaces.

## What is collected

Each role invocation is correlated with its existing `invocationId`, role, provider, model and run. The bounded session ledger records:

- **Orchestrator-prepared initial prompt**: exact UTF-16 character count and UTF-8 byte count; separate counts for `role_contract`, `context_and_instructions`, `engineering_policy`, `task_body`, `engineering_checkpoint`; a breakdown of project instructions/skills, review target and session history within the context section; supplemental prompt-block **count** (not payload or estimated bytes).
- **Provider-observed usage**, if supplied: input, output, cached, reasoning tokens using the pre-existing P3 cumulative-snapshot semantics; unknown counters remain `null`.
- **ACP context occupancy**: first, peak and last `used` tokens, observed window size and number of occupancy updates; these are **not token expenditure**, and are not summed as input tokens.
- **Execution**: status, elapsed time, time to first observed reasoning/commentary/tool update (not guaranteed to equal time-to-first-token), tool calls counted once by ACP tool-call ID (subsequent status updates do not increment), raw event count, stage ID, review batch and fix-round correlation where lifecycle events identify them.
- **Run summary**: existing review/fix/retry/verification counters plus role aggregates for prepared characters and context coverage.

The orchestrator cannot know provider-injected system prompts, all tool schemas, or all internal generations. **Prepared input size is not the full model input.** The initial `task_body` may include verification, review, Plan and diff; no attempt is made to semantically split those by parsing user-controlled text. Only the explicitly identified context subparts are split. Missing counters are not inferred.

## Commands

From the orchestrator chat (these commands do **not** invoke an LLM):

| Command | Result |
| --- | --- |
| `/efficiency` | Existing per-role session usage, now also showing prepared characters, peak occupied context, coverage, tool-call count |
| `/efficiency history` | Repository-scoped aggregated history if `AGENT_P3_HISTORY=1`; remains opt-in |
| `/efficiency runs` | Recent run identifiers and statuses |
| `/efficiency run <run-id>` | Detailed invocation profile of one run, displaying up to 40 invocations; use export for all |
| `/efficiency export` | JSON for the latest run; can be copied for subsequent analysis |
| `/efficiency export <run-id>` | JSON for a specific run |

To export **all retained runs in one explicitly selected session** from the CLI:

```bash
node tools/efficiency-export.mjs <outer-session-id> > efficiency.json
# Or only one run:
node tools/efficiency-export.mjs <outer-session-id> <run-id> > efficiency-run.json
```

The CLI uses the same `$AGENT_STATE_DIR` / `XDG_STATE_HOME` / default session directory as the orchestrator; it does not scan other sessions and does not output code, prompt text, tool contents or stored conversation history. Keep exported JSON private because it still contains technical model identifiers and timing data.

## Persistence, compatibility and limits

- **No second database.** The existing session `efficiencyRuns` records stay `version: 1`, with optional allowlisted per-invocation fields. Historical sessions lacking these fields still load with `null`/zero-coverage values. Existing P1/P2 checkpoints remain authoritative.
- Same P3 retention: 80 runs/session, 128 invocations/run, 20MB maximum session JSON, bounded tool-call tracking (2048 IDs/invocation); actual measurements have coverage/truncation indicators where applicable.
- Incremental `usage_update` values are snapshots, not additive input token consumption. `peak` occupancy is a maximum, not a sum. Tool-call updates are counted separately from distinct tool calls.
- Invalid persisted context section kinds and unknown fields are discarded on load. No raw prompt, paths, source data, LLM reasoning or tool payload is persisted in telemetry.
- Providers that expose only ACP `usage_update.used/size` still offer occupancy charts and prepared-input counts, without invented input/output token totals. Provider-specific runtime timings are not required.
- Diagnostic instrumentation is optional: failure to emit the context profile must not fail a provider invocation.

## Suggested real-task sample

For a meaningful baseline, run a mix of 15–25 unmodified day-to-day tasks on representative provider presets: investigation, commit description, plan, small fix, staged implementation, review, fix round, continuation and failed/cancelled runs. Export the profiles and compare per-run role cost, context occupancy, incomplete usage coverage, tool-call counts and unsuccessful invocations. Do **not** call a role inefficient simply because its context or output is large; independent review and evidence checks may be mandatory for quality.

## Validation

`npm run check`, `npm run test:evaluation`, `npm run test:monitoring`; optionally `npm test` with complete ACP dependencies installed and the Node engine version declared by the repository.

## Monitoring hardening — structured profile, timeline and usage semantics

This revision extends the observation-only monitor; **it does not change role prompts, workflow decisions, stage requirements or agent model settings**.

- `taskBody.sections` is an exhaustive, **non-overlapping** character/UTF-8-byte accounting of the initial task-body string. `user_task`, `plan`, `exploration`, `engineering_frame`, `verification`, `review`, `working_diff`, `quality_recovery`, `git_reconciliation` and `implementation` are attributed only when the workflow passes an explicitly known source whose content has one unambiguous occurrence. The rest stays `other`, not guessed or omitted. Untrusted headings in user code/logs are **never** parsed as section delimiters. `taskBody.sections` is nested inside the top-level `task_body`; do not add them twice.
- `providerPromptProfile` measures the final adapter-prepared text and the number of **actually forwarded supplemental blocks** for generic/codex ACP. CLI-based providers report their own command text separately. This is **not** a claim about hidden provider instructions, tool schemas, model context or billed input tokens.
- `contextTimeline.samples` contains bounded, monotonic elapsed-time observations with used/window tokens and an adjacent tool-call ordinal. These are **observed snapshots**, not exact token cost per tool or proof of a particular compaction. Its sample list is bounded (40 per invocation), and truncation is explicit. The existing first/peak/last/updates fields are retained.
- `executionScope` records known phase, attempt and retry reason, while top-level `stageId`, `reviewBatch`, `fixRound` remain compatible. New callsites pass explicit scope; historical events use conservative fallback. A responder cannot inherit a prior fix round.
- `firstReasoningElapsedMs`, `firstCommentaryElapsedMs`, `firstAnswerElapsedMs`, `firstToolCallElapsedMs`, `firstActivityElapsedMs` distinguish observed activity types. **These are not provider TTFT metrics.** Generic ACP captures answer activity even when the answer is buffered and never directly presented to the host.
- Token counters are aggregated through `usage-observations.mjs`: cumulative snapshots of one scope are not summed, uniquely identified per-request final usages can be summed, deltas require observation IDs for deduplication, and context occupancy is never treated as expenditure. Mixed nested counters or incomplete request coverage yield unknown totals instead of invented numbers. `usageCompleteness`, `usageRejected` and `usageAmbiguous` explain limitations. Existing unannotated provider usage defaults to legacy cumulative-turn semantics, never to per-request usage.
- `efficiencyRuns` retains the original v1 record shape with additive optional fields. The session store applies an additional **2MB UTF-8 telemetry budget**, pruning oldest optional runs/details before affecting authoritative session state. `efficiencyTelemetryTruncated` indicates loss of retained history. The pre-existing 20MB maximum canonical session size remains enforced.
- The `/efficiency run <id>` display and JSON export include the new counters and their missing/partial status. Technical identifiers and numeric measurements are allowlisted on persistence; no prompt/body content, source files, tool arguments or reasoning is stored in telemetry.

### Known observational limits

1. Generic ACP's standard `usage_update.used/size` reports **window occupancy**; it does not necessarily provide exact cumulative input/output costs. The same is true for an agent runtime that internally adds instructions and tools. To obtain exact token totals, an optional provider adapter must expose counters **with documented request/turn semantics and unique IDs**.
2. No ACP API is required to provide a usage update immediately after each tool. Timeline correlation is temporal and cannot attribute token growth causally to individual tools.
3. Exact attribution of initial `task_body` content is deliberately conservative. Ambiguous repeated strings and unsupplied known sources fall into `other`; they are not auto-classified by parsing user-controlled text.
4. Monitoring alone cannot label a costly review or repeated investigation as unnecessary. Quality and authorization requirements remain the independent acceptance authority.

### Hardening tests

Run `npm run test:monitoring`, `npm run test:evaluation`, then `npm test` with `npm ci` installed and a compatible Node.js version. `test/evaluation/p3-monitoring-hardening.mjs` checks exact body composition, deduplicated final/delta usage, incomplete coverage, mixed counters, malformed telemetry, bounded timeline, fix-round isolation, privacy and telemetry persistence caps.
