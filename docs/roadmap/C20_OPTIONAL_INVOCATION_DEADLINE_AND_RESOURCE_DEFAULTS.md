# C20 — Optional Invocation Deadline & Resource Defaults

**Status:** PLANNED, approved revised scope; implementation and native acceptance UNVERIFIED. **Working branch:** `feature/controller-intent-deferred-admission`. **Source/review baseline:** `2650d327b01eddd5ed2939263ef73b803381be11`; actual implementation baseline is the verified C19 head. Execute after [C19](C19_MODEL_FACING_EVIDENCE_AND_ANSWER.md), separately test and commit. No master merge.

**Superseding decision:** this plan replaces the previously discussed Activity-Based Invocation Lifetime proposal. The operator explicitly rejected idle/tool/startup/interaction/recovery execution timeouts, activity tracking and watchdogs. Do not implement those earlier proposals, even as optional features. No automatic detection of stalled models. The user may allow work to continue indefinitely, cancel explicitly or configure one hard invocation deadline. This is a conscious reliability/resource trade-off, not a claim that the provider cannot hang.

Read `AGENTS.md`, `.agents/REASONING.md`, applicable engineering instructions, [STATUS](STATUS.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md), [C19](C19_MODEL_FACING_EVIDENCE_AND_ANSWER.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [EXECUTION](../EXECUTION.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [DECISIONS](../DECISIONS.md), C16–C18N-R contracts and [native procedure](NATIVE_ACCEPTANCE.md). Verify current branch/worktree, preserve unrelated changes. JS ESM/JSDoc/checkJs, Node 24, existing Nix/CI. These are engineering checkpoints only.

## 1. Approved configuration and scope

Effective defaults:
```json
{
  "resources": {
    "maxConcurrentInvocations": 5,
    "maxInvocationsPerOperation": null,
    "invocationTimeoutMs": null
  }
}
```

All three remain configurable. The only configurable execution-time limit is the existing `invocationTimeoutMs`, now optional/nullable and disabled by default. It remains a hard duration limit of **one invocation**, not an Operation-wide deadline or a renewed idle deadline. No new timeout keys, including `invocationIdleTimeoutMs`, `invocationToolIdleTimeoutMs`, `providerStartupTimeoutMs`, `providerCleanupTimeoutMs`, `interactionTimeoutMs` or `recoveryTimeoutMs`.

Model/provider may work without a Host time limit during setup, model loading, initialization, prefill, reasoning, tools, skills, subagents, silent execution, user input, finalization and other legitimate activity. No dependence on event streaming or activity visibility. Explicit finite invocation deadline still limits that invocation under its existing meaning. The user's decision to cancel, real provider termination/error, existing authorization/resource/admission contracts and native provider policies remain effective. Do not suppress or override native provider timeout settings; RO cannot promise unlimited execution in third-party systems.

Preserve ActivityStream for presentation only, no liveness callback/capability, watchdog, polling, activity timestamps for cancellation, tool state machine, phase-tracking subsystem, scheduler, semantic cycle detector, memory counter by action count, automatic model switching or retry. No Host tool-effect classification or workspace gate. No new independent limit replacing the removed one.

### 1.1 Critical boundary: execution vs already-ended resource cleanup

Remove mandatory **execution/wait** deadlines imposed by RO, not every use of a timer. Existing technical cancellation grace, post-exit stdio drain, post-exchange session teardown, and bounded reception of incomplete HTTP requests/headers may remain strictly for their current technical ownership. They must not cap an accepted MCP tool's execution, active model or native setup before a real cancellation/completion boundary. Keep existing provider-native policies untouched. No new configurable cleanup/startup/recovery deadline.

Logical cancellation must not wait indefinitely for a misbehaving provider to acknowledge physical cleanup. Never mark unconfirmed detachment as success or free its occupied slot. Reuse existing undetached/late-cleanup mechanics, not a background monitor. Minimal existing post-stop/post-completion technical grace may be retained/decoupled if required for safe local teardown; justify its purpose, scope and actual value in report. Do not use it to interrupt live authorized execution or add a new execution deadline. A genuinely stuck provider may occupy a slot until actual detachment or the existing shutdown/restart boundary; document what is and is not provable.

## 2. C20.0 — Source/resource/timer audit and RED fixtures

Trace all effective config and execution limits through config schema, decode, trusted user/project/launch resolution, application composition, Operation/ResumeAuthority, resourceSnapshot and reservation, provider ports, owned processes, permissions/interactions, UI/ACP protocol, recovery, close/shutdown and durable decoding.

Verified review anchors at baseline:
- `src/application/configuration/resolve-config.js`: defaults 2 / 40 / 180000; finite decoder; project can only reduce resources; resolver currently uses nullish coalescing for override.
- `src/core/operation.js`: positive safe integer Limits.maxInvocations/maxConcurrentInvocations, numeric remaining, charging and reservation.
- `src/application/orchestrator.js:498–509` recovery timer; `594–598` invocation timer/deadline; `966` interaction binding; `1036` provider timeout; `1126–1158` cleanup race tied to invocationTimeoutMs.
- `src/core/ports.js` Invocation.timeoutMs and pending interaction deadline; `src/application/interactions.js` independent broker timeout option, Math.min/remaining, deadlineAt, schedule; all constructor/caller/consumer sites.
- `src/adapters/acp/provider.js:155–158` independent process timer with non-aborted owner signal; `307–311` abort callback returns before active/sessionId exists; `482–505` native end_turn/finalization; `544` post-exchange close grace; ACP close waits call.result.
- `src/adapters/cli/codex-provider.js` and `src/adapters/cli/owned-process.js:130–132` independent process timer, exit drain and process group cleanup.
- MCP HTTP transport, host/UI and all other adapters/fixtures: inventory all setTimeout, AbortSignal.timeout, timers, explicit wait/timeout settings, cleanup, retry and resource gates. Do not assume every timer is an execution timeout. Record actual owner, source of setting, when timer starts and stops, observed effect and proposed remove/retain reason. Include runtime defaults and independent explicit broker timers, not just references to invocationTimeoutMs.

**RED:** missing resource fields currently produce finite defaults; null rejected; >40 otherwise admissible sequential invocations rejected; active and silent invocation beyond old deadline killed; indefinite pending interaction unsupported; owned process static timeout; recovery timer; cancellation during ACP initialize/session setup (potential existing defect), cancellation during close/finalization/unknown outcome. Reproduce with deterministic fixtures, not real minute/hour sleeps.

### 2.1 Capture and long-operation audit (review P2.7/P2.8)

Inventory actual cumulative capture, output and proposal budgets, context transport limits, history materialization, Operation snapshots, attempt/receipt/diagnostic retention and memory. ACP accumulation can truncate native output and affect text/Worker final-result delivery (MCP Intent may still admit an independently captured declaration). Check Codex CLI/other delivery paths. Distinguish provider limits, per-message safety, legitimate retained evidence, ordinary MCP active correlation, and arbitrary count ceilings already removed. Explicitly test a long native event sequence with final answer after capture pressure in each applicable delivery path.

Do not delete all byte/memory limits or promise unlimited retention. If a reproducible Host capture mechanism loses a valid final result during prolonged execution, identify owner and consequences, implement only a small contract-preserving fix if justified and in scope (otherwise document an explicit separate blocking/residual issue and plan). Do not create a new archive/summary/compaction subsystem, hide truncation, fabricate output or use another mandatory gate. Report whether duration freedom is delivered separately from ability to return a complete result. No assertion that all long runs are supported if actual delivery remains limited.

**Exit:** reviewed timer and resource inventory, actual RED evidence and smallest chosen implementation. No production workflow changes.

## 3. C20.1 — Nullable configuration and defaults

Set effective defaults exactly as section 1. Update existing v1 user schema, JSDoc/decode-config, resolver, project/launch validation, configuration examples and all construction sites. Positive safe integer for concurrency; `maxInvocationsPerOperation` accepts positive safe integer or explicit null. `invocationTimeoutMs` accepts null or integer 1..2147483647 ms (Node timer bound); no overflow, zero, negative, fraction, NaN, unsafe values or Infinity. Do not use maximum integer or Infinity as substitute for disabled. Missing field means inherit/default; explicit null means disabled. User-supplied finite values keep original meaning; no silent reset of prior explicit limits.

Preserve trusted precedence. Project preferences may only narrow existing trusted envelope: finite narrows null; smaller/equal finite narrows finite; null cannot expand a finite trusted ceiling; null over null is legal. Trusted launch override retains existing authority. Distinguish field absence from explicit null (do not use `??` in a way that loses it). Do not introduce a new configuration policy engine or automatically expand project authority. Explicitly define where config is read and how it applies to existing vs new/resumed invocations under current configuration binding.

Test all user/project/launch combinations including missing/null/finite and invalid values, both nullable fields, finite concurrency, Node timer upper bound and explicit existing config. Verify generated/schema/config example consistency.

## 4. C20.2 — Unlimited cumulative invocation limit

Modify existing `Limits.maxInvocations`, resourceSnapshot and every consumer to support explicit nullable unlimited. Preferred representation `maxInvocations: number | null`, `remaining: number | null` (null means unlimited; model-facing contract should say so explicitly). No fabricated huge numeric resource. Retain actual charged, active, usage and unknown-usage counts, reservation/identity semantics and finite budget behavior. Preserve trusted ResumeAuthority/limits and existing legal v1 finite saved operations; do not retroactively widen finite persisted authority when defaults change. Support the new value through existing decoder, writer, reopen, inspect, status, CLI/ACP, model context and continuation paths. No parallel migration/persistence subsystem; no new compatibility schema solely for this change.

Default concurrent cap becomes 5 in existing scope(s), not five mandatory Workers. Keep existing global/per-operation accounting, reservation and undetached slot ownership, wait and wake-up semantics. Test 5 simultaneous admissible invocations and reaction to a sixth, actual user override, cleanup-pending slot retention, late detachment and restart. Verify >40 sequential legitimate invocations on one Operation with unlimited limit; finite explicit limit still rejects at correct boundary. Use genuine model-authored valid decisions/fixtures, not circumventing correction or authority rules.

Do not remove independent control-proposal/Decision-recovery identity and technical caps blindly; list remaining constraints and their owner/purpose. No replacement cumulative action limit. Keep C18N-R ordinary MCP active-only accounting and no blind replay.

## 5. C20.3 — Single optional hard invocation deadline

Application's existing invocation lifetime owns hard cancellation. Null: do not schedule a hard timer, create an infinite numeric deadline, or pass null into a Node timer. Finite: preserve original start boundary/overall invocation duration including preparation, setup, native execution, user wait and pending finalization while invocation is active; not renewed by activity, interactions or tools. No separate full-duration restart in adapter or cleanup/recovery. At expiry use existing abort/cancellation and DEADLINE_EXCEEDED provenance, preserve dispatch certainty, accepted observations, unknown outcomes, proposal closure and authority. Do not call a deadline cancellation success. Natural trusted completion still goes through existing authoritative admission, no premature promotion.

Use existing injected monotonic Clock/schedule and AbortSignal wiring; keep one timer if configured, clear on terminal/cancel/exception. Preserve user/shutdown/provider cancellation causes and actual event ordering for near-simultaneous end_turn/submit/deadline. Avoid new lifecycle machine. Define exact behavior of optional deadline at result receipt and cleanup boundary: no new execution budget after the original one, post-stop housekeeping does not restart it. No idle tracking whatsoever. Make explicit whether an Invocation timeout field is still needed for external provider contract; prefer existing signal as authoritative owner for built-in adapters, nullable remaining technical metadata if retained, never independently schedule another hard budget. Audit all ProviderPort callers and fixtures, do not silently break explicit finite deadline.

**Exit:** no Host runtime deadline unless explicitly configured; a configured finite deadline still reliably interrupts the invocation once, with truthful reason.

## 6. C20.4 — Remove dependent execution timers in adapters

ACP: remove mandatory owned-process lifetime timeout; allow silent initialize/session.new/setModel/setConfig/prompt, prefill, native tools and subagents to continue. Do not add readiness/liveness signals or provider-specific startup limits. Preserve typed ACP SDK protocol, capability negotiation, permission/interaction routing, original output/metadata capture, MCP proposal finalization and close semantics. Existing adapter may use native cancellation after explicit abort; no native-policy override.

Codex CLI: remove independent static execution timer from built-in provider path, use owner signal; ensure owned process can operate without execution timeout. If the lower-level process utility still supports finite timeout for a direct independent consumer, justify actual caller and ensure production invocation has one owner, never a hidden mandatory deadline. Audit all other providers/launchers and tests. Preserve actual process group ownership, errors, exit, native result/capture diagnostics and cleanup. No automatic restart.

MCP/tool runtime: remove only timers that cap accepted execution or waiting by duration. HTTP request/header receive and post-close mechanics are transport protections, not tool duration budgets; verify accepted long-running request is not cut off by them. Preserve existing size/active-concurrency/authority and control finality. Do not alter provider-native commands, scripts, skills or subagents to enforce RO time limits. No artificial heartbeat or activity monitor.

**Exit:** no hidden static timer kills a healthy permitted invocation/accepted tool merely because time passes; silent/final-only provider remains legal.

## 7. C20.5 — Bounded-by-authority waiting, cancellation, teardown and recovery

This is the key risk area. Reuse existing owners and lifecycle; no new configurable timeout or cleanup scheduler.

### 7.1 Interactions and permissions

Remove independent RO-imposed interaction deadline (including broker timeout option and all runtime call sites, or retire that option with clear contract). No timer for indefinite waiting. If hard deadline is configured, it is the only inherited time limit while invocation is active; interaction is interrupted by existing abort signal, not a fresh independent timer. Represent missing deadlineAt explicitly (optional or null, consistently across ports, codecs, UI/CLI/ACP clients); do not serialize Infinity or construct an invalid date. Do not invent a displayed deadline. Keep interaction identity, authorization, exact response semantics, pending/answered/closed, cancellation, provider-request abort, multi-interaction routing and late-response rejection. Permission waiting remains governed by actual user/provider responses and cancellation, not timer. Indefinite user wait may occupy its real slot; no artificial release or model replay.

### 7.2 Cancellation before, during and after native execution

**Confirmed source risk, not yet proven runtime failure:** ACP abort handler returns if `!active || !sessionId` while owned process can already exist and be awaiting initialization/session negotiation. The current static owned-process timer can incidentally terminate this case. Once removed, cancellation must work without that fallback. Reproduce with an actual ACP SDK child fixture that never answers initialize/session.new/setting negotiation. Also cancel before spawn/open, during pending native prompt, long tool, permission/elicitation, after native end_turn but before proposal finalization, during session close, and late provider open. Include a provider that ignores cancellation, a real process that can be killed and a noncooperative close fixture. Do not wait for a future arbitrary execution timeout.

Minimal correction: handle abort even without active native session; when session is available use existing native cancel protocol as appropriate, otherwise cancel/close the owned connection/process with current ownership guarantees. Cancellation may occur between process creation and handler registration, or during setup; observe already-aborted signals, avoid lost races/double cleanup. Preserve existing post-cancel grace escalation and after-exit drain only for owned resources. Do not indiscriminately kill external processes or pretend provider-specific remote effects are canceled. Bound local waiting after the stop decision using existing teardown mechanics, not a new task timeout.

### 7.3 Cleanup and slot ownership

Current orchestration close race uses `invocationTimeoutMs` independently. Remove that dependency; null must not mean a logically canceled Operation or shutdown waits forever on an unresolved provider close/open. Do not just await detached indefinitely or mark it successful. Preserve actual lifecycle semantics for natural completion and cancellation, including:
- close already-owned provider session, also clean a late successful open, release logical authority immediately on stop;
- existing `undetached` tracking, cleanup-pending observation, precise unconfirmed/failure reason, slot held until actual detachment, late cleanup observation and release/wake-up exactly once;
- existing post-stop technical grace if necessary (no new execution timer/config field); preferably use existing close/detach mechanisms and asynchronous completion rather than indefinite logical join. Keep one owner of cleanup and no second journal or monitor;
- race-safe registration of pending detachment vs early/late resolution; no lost release or false capacity; failure/rejection explicitly represented; local group/process errors not reclassified as proven remote cleanup;
- cancel/close/shutdown usable with hard deadline disabled, even when provider ignores abort or opens late. Preserve exact cancellation source and existing persistence/restart guarantees; do not assert a permanently unresponsive third-party resource has been freed.

After real completion/cancel, technical grace must not discard an already accepted result or resurrect a closed proposal. Natural end_turn does not itself bypass existing C18R registration barrier and admission. Distinguish result receipt, authoritative commit, logical stop and physical detachment with existing events; no new state machine.

### 7.4 Recovery

Remove independent mandatory timer in `recoverAttempts`; do not introduce recoveryTimeoutMs or retry loop. Keep existing trusted status lookup semantics, unknown result, actual provider capability, accepted late facts, and user/shutdown cancellation (race an abortable wait even when provider ignores signal). Recovery not automatically a new invocation or an excuse for blind replay. If no deadline is configured and a provider never replies, lookup can remain pending until user cancellation; be explicit about behavior and avoid holding shared serialization/authority locks over an external wait. A finite hard invocation deadline applies only to the invocation it owns, not a fresh recovery deadline. No guarantee of recovery of opaque tools or external effects. Test orphan/restart, unknown status, late status, cancellation during lookup and unaffected independent allowed work under existing contracts.

**Exit:** logical cancellation and existing recovery remain usable without runtime timeout; uncertain effects/detachment stay uncertain. No added startup/tool/interaction/recovery watchdog.

## 8. C20.6 — Regressions, scale and inspection

Use existing injectable clock/schedule and controlled promises/ACP SDK subprocess fixtures, not real-minute waits in CI. Test all changes through production composition when applicable.

Required matrix:
- Default resources 5/null/null; all valid/invalid nullable config and trusted precedence; old explicit finite values and saved Operation limits; new nullable operation snapshot round-trip/reopen/resume.
- No scheduled invocation timer for null; silent and streaming provider continue beyond former duration; silent startup/prefill/native tool/subagent, final-only provider and no ActivityStream subscribers; long user waiting/accepted MCP tool; no new callback/capability required.
- Configured finite hard deadline with active or silent provider; actual start boundary, upper bound, reason, no reset/duplicate timeout, abort and cleanup. Race user cancel, deadline, native end_turn and pending MCP submission; no double admission or automatic replay.
- Cancellation during all boundaries in 7.2, including nonresponsive initialization, nonresponsive provider and late open, cancellation while awaiting permission/elicitation or recovery, user response/late events, cleanup-pending with slot retained, eventual confirmed release exactly once, shutdown/close and existing process/PTY behavior. Test logical completion without falsely claiming physical detachment.
- >40 invocations on same Operation and finite-limit counterpart; 5 concurrent slots and override; independent Workers, waiting, cancellations, retries/unknown and undetached; no new action quota.
- Real long-duration fixture produces a final answer after many native events/receipts; check capture limit behavior separately for MCP Intent, text/legacy and Worker where applicable, actual completeness and diagnostic truth. Retain C18N/R ordinary-call, live evidence, preflight and proposal identity/finality tests; C19 metadata/answer tests.
- Measure representative longer operations (several sizes, substantially above former 40 attempts and ordinary call limits); actual snapshot/journal/commit/context costs, observation/receipt retention, process heap and diagnostic growth. Distinguish retained legitimate evidence from transport cache and measure before/after if changed. Do not claim constant memory/unbounded retention. No new artificial cumulative cap to mask observed costs. Fix only verified local problems within scope; document remaining bottlenecks and follow-ups.

Audit final timer inventory against approved scope, including host constructors, adapter transport and protocol responses, no hidden execution timer. Report retained technical timers with concrete reason, start/stop boundary and existing ownership. Tests that use synthetic timeouts to bound test execution are not product limits. Do not treat genuine provider-native timeout as RO failure without attribution.

## 9. C20.7 — Native acceptance and engineering closure

Run [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md) with pinned build/config/model/workspace and permissions. At least a long legitimate active or silent native invocation beyond former default/explicit 10-minute scenario (no artificially forced workflow), a genuinely long tool/native session setup or silent provider when available, indefinite user interaction with resumed response, user cancellation including startup, and configured finite hard deadline. Include OpenCode ACP local model and another available provider/Codex CLI; distinguish SDK/PTY fixtures from real models and operator cancellation from provider-native limits. Use synthetic shortened explicit deadline for controlled faults; absence of real long runs is UNVERIFIED. Do not require a model to intentionally get stuck. Record duration, final result quality, event/outcome, cancellation provenance, detachment/slots and actual memory/capture gaps. Native tools and subagents remain independently available.

Run full exact-SHA mandatory Node24/checkJs/foundation/core/contract/integration/ACP SDK/root npm/PTY/Nix flake/package/outside-checkout install/NixOS systemPackages/release checks. Preserve C16–C19 and C18R finality/cancellation regressions. Record actual commands/exit codes/jobs, exact code and final documentation SHA; do not infer PASS for later commits. Update only applicable normative docs/contracts/config examples, decisions, acceptance matrix, CHANGELOG, STATUS and roadmap. No premature shipped behavior claims. Native PASS/FAIL/UNVERIFIED separately.

## 10. Acceptance and executor handoff

- [ ] Exactly approved three resource defaults and configurable override; finite old config and trusted limits preserved; nullable values handled throughout state, context and presentation.
- [ ] No RO-imposed execution/startup/tool/interaction/recovery deadline unless the single optional hard invocation deadline applies. No idle/watchdog/liveness subsystem, no hidden static child-process deadline, no new timeout settings.
- [ ] User cancellation works independently of deadline, including ACP setup and noncooperative provider; no false physical cleanup, no lost slot/late observation, no indefinite logical join on unresolved cleanup.
- [ ] Existing technical post-stop/transport timers retained only with concrete justification; no native timeout policy changed.
- [ ] Unlimited cumulative invocation budget does not weaken concurrent limit/authority, durable identity, C18R finality or no-blind-replay.
- [ ] Long-operation/capture audit and scale measurements, explicit limitations, no new artificial caps or broad storage rearchitecture.
- [ ] Exact-SHA CI, honest separate real-native status; no master merge.

Executor report: baseline/final SHA, actual config precedence and persisted limit semantics, complete before/after timer inventory (remove/retain owner and boundary), cancellation/recovery/cleanup races and results including ACP initialization, finality and slot guarantees, RED/GREEN and scale/capture findings, all remaining control/data bounds and provider limitations, exact-SHA CI and native evidence or UNVERIFIED. If inability to preserve safe cancellation/cleanup or deliver valid results is found, report it explicitly rather than claiming unconditional support. No automatic replay of unknown effects, no extra scheduler.

**Design summary:** RO controls authority and owns its resources; the model and native provider own execution. The absence of events is never grounds to stop permitted work. With deadlines disabled, the user accepts potentially indefinite waits and must cancel when necessary; RO must still truthfully and correctly settle its own lifecycle.

## C20-R follow-up — independent ACP current result capture

Baseline engineering CI passed at e092712f (37/37 steps). Review confirmed text/legacy/Worker failure after ACP aggregate history overflow, even with valid native end_turn. Correct within the existing adapter: bounded independent current message text, preserved native boundaries and finality, explicit history/result omissions, bounded identity retention, no new timeout or store. Verify actual SDK RED/GREEN and scale probe; native acceptance separately UNVERIFIED. See STATUS for exact SHA and results.
