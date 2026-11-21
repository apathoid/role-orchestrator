# C17 — Controller Context Efficiency & Decision Reliability

**Status:** PLANNED — approved for implementation  
**Branch:** `feature/controller-reliability` (from master after merge of PR #3)  
**Planning baseline:** `d80638609d86da92e2a88d939fa09a90a1a3cfbf`  
**Priority:** P1 reliability/context/diagnostics; P2 terminal UX.  
**Owner:** implementation agent. Start at C17.0, continue through verification; do not merge into master.

## 1. Target and evidence

Improve the existing Controller interaction with RO: readable, faithful Invocation presentation; addressable recovery after a rejected Decision; elimination of proven duplicate inline data; passive diagnostics; precise native-form and compact terminal presentation. Preserve all existing model decisions, native capabilities, permissions and lifecycle guarantees. Success means that models can perform the user's task with less avoidable orchestration overhead, not merely return valid JSON.

Operator-supplied native observations (not reproduced by the planning agent): direct OpenCode returned a description in about 64 s; with RO and a 1024 KiB Controller history budget, 5 attempts/5 rejected Decisions ended in technical waiting after ~949 s; with 64 KiB, 2 rejected Decisions and a third attempt cancelled by the user after ~580 s. The two RO runs examined the same target commit, but are not a controlled statistical sample. The reported forms of failure include ordinary Markdown, prose preceding JSON, missing closing brace and structurally invalid fields. A completed-looking draft and the previous technical error were delivered in the next prompt, yet the model sometimes repeated its work. Sampled context usage did not establish native context exhaustion; compaction as a cause is unverified. Reduced budget changed payload sizes but did not eliminate INVALID_PROPOSAL. These are operator observations, not proof of their causes or of the quality of any draft.

Current code facts at the planning baseline: `renderInvocationPrompt()` concatenates a transport instruction and one serialized Invocation object. `decision-instructions.js` already contains the Decision v1 reference and one decoder-valid shape-only example. `decisionRecovery()` derives 5 identical / 10 total rejection counts from the Operation journal; `controllerContext()` supplies `host:decision-error`, existing history packing and model-selected refs. `ProviderResult.outputObservationRef` carries adapter-declared result identity; `acceptReply()` currently avoids a duplicate original string only with explicit identity, same-attempt provenance, outputRefs and equal bytes. The decoded structured output and original wire message are distinct representations. C16R established parser category, crash-gap, restart and independent Worker regression coverage; preserve it.

## 2. Non-negotiable architecture and scope

Read `AGENTS.md`, `.agents/REASONING.md`, applicable `.agents/engineering/`, STATUS, IMPLEMENTATION_PLAN, EXECUTION, CONTRACTS, CONTEXT_AND_RECOVERY, PROVIDERS_AND_CONFIGURATION, EXTENSIONS, DIAGNOSTICS, DECISIONS, C16/C16R and the acceptance matrix before modifications. Verify actual branch HEAD and required CI baseline. Follow repository JS ESM/Node 24/checkJs/Nix conventions.

- Model owns task meaning, current user intent, environment discovery, tools/skills, planning, delegation, evaluation, verification, evidence relevance, retry choices and all semantic content of Decision. A direct Controller answer is a complete path. No fixed runtime stages, mandatory retrieval/delegation/review/verification, host quality gates or inferred task types. The steps below are development checkpoints only.
- Host owns technical correlation, authority, budgets, journal, cancellation/recovery and truthful diagnostics. Existing parser, decoder and admission are authoritative. Keep Decision v1 schema, semantics, text framing, parser strictness and existing provider output contracts unchanged. No JSON repair, inferred extraction from prose/tool output, synthetic Assessment or automatic completion. No new transport, scheduler, independent recovery state or mandatory MCP.
- Native agents retain discovery/use of project instructions (including AGENTS.md), files, scripts, tools, skills, subagents, plans, thinking, questions and native permissions in their ordinary environment. No inventory/scanning/rewrite of native skills by Host, no registration requirement, no file proxy/runtime, isolation, Git prerequisite, freshness gate or automatic reconciliation. Host Catalog covers explicitly registered RO resources only; it is not the universe of model capabilities. Preserve existing materialized RO skill delivery and selected Worker scope.
- No special production paths keyed by model, provider name, role, skill, VCS, language or workflow. Protocol adaptations belong in adapters. Do not change native modes, tool policies, reasoning effort, default resource limits, provider configuration or permissions to improve measurements.
- Preserve C16/C16R current/historical user turns, exact rejection categories, 5/10 bounds, existing counters and reset rules, budgets, independent accepted Actions/Workers, unknown effects, no blind replay, and operation/attempt cancellation provenance. No active-operation steering or persistent native session change.
- No host-generated summaries/semantic compaction, ranking by relevance or evaluation of the previous answer. No new model invocations or required retrieval to deliver the improvements. Prefer existing owners/structures and the smallest coherent change.
- Keep private source material, actual prompts, secrets and diagnostic dumps out of source tree/CI. Use sanitized fixtures. Report observed/supported/hypothesis/unverified distinctly.

## C17.0 — Baseline and regression fixtures (P1)

Inspect actual code owners, including `src/adapters/invocation-prompt.js`, `src/application/decision-instructions.js`, `decision-recovery.js`, `controller-context.js`, `orchestrator.js`, `src/adapters/acp/provider.js`, other callers of the shared renderer, ProviderPort, ContextPort, state codec/reducer, production decoder/admission, CLI presentation and C16/C16R tests.

1. Record actual HEAD, installed versions and baseline mandatory checks. Establish owners, data identity, time of durability and cleanup on cancellation/failure. Do not assume planning baseline matches checkout.
2. Use original redacted operator logs only if available. Otherwise use deterministic synthetic examples clearly labeled as such; never commit private target code/evidence or claim fixtures are native. Reuse existing tests, add focused regression-first cases where behavior is missing; distinguish expected RED from fixture mistakes.
3. Exercise real parser/decoder/admission paths: valid object; Markdown only; prose before a valid object; broken JSON; non-object JSON; excessive depth; missing mandatory fields including requirement findingRefs; invalid refs/identity/coordination combinations; provider failure/no completed declared result. Strict text forms remain rejected. Diagnostic offline inspection of a malformed example is not production repair. Use actual admissible operation state for admission assertions; parsing PASS alone is insufficient.
4. Capture baseline actual rendered payload, source-field coverage, repetition/size, correlation and CLI transcripts with deterministic fixtures. Establish current/new turn and crash recovery baselines. Test assertions must not alter provider outcome (capture then assert outside fixture).

**Acceptance:** exact parser/decoder/admission boundaries established, reproducible tests and baseline data available, no change to runtime policy.

## C17.1 — Model-neutral Invocation presentation (P1)

Owner: existing shared text renderer and model-facing Decision reference, not a new core mechanism.

- Render Controller Invocation as readable categories instead of one undifferentiated JSON blob. Suggested categories: role/transport instructions; invocation identity; original user messages and constraints; orchestration context (catalog, workMap, budgets, observations with provenance); active technical correction when present; Decision v1 reference. Choose a concise order, not a reasoning sequence. Nontext plugin invocations are not forced through the text renderer.
- Preserve every previously delivered field, original string/value/type, context ref and ordering where meaningful, plus all existing authority and completeness metadata. Keep `Invocation.objective` as original Request.text; preserve literal initial/latest user ContextItems and chronological correlations; never synthesize an active objective or classify new intent. Presentation can reference the same data without duplicating large bodies. Do not change scope or materialization merely to reorganize text.
- Separate role/transport instructions from data and history. Render arbitrary strings/structured history using unambiguous escaping/framing so an embedded heading, delimiter or fake Decision cannot create a new structural section. This is a representation boundary, not a claim that formatting prevents prompt injection. Preserve legitimate native/user/skill instructions; no semantic filtering or reinterpretation. Host Catalog is explicitly labeled as RO-managed, not an exhaustive list of available native tools/skills. Existing RO skill metadata, id/version/status and text stay faithful.
- Include the Decision reference and shape-only example exactly once in each applicable Controller payload. Keep current strict final textual contract (one JSON object, no fences/prose); native progress/plan/thinking/tools are not the Decision. Explain the distinct scopes: if the model chooses a finalAssessment, its answer contains the requested user-facing format (Markdown, JSON, Unicode, etc.); the outer envelope is transport. Do not suggest that finalAssessment is mandatory or preferred. Preserve all legal choices/combinations and actual identity/contextCursor semantics. Keep the example decoder-valid, clearly illustrative and not an implied task plan. Do not add redundant examples or model-specific prompts.
- Keep Worker output and native interaction contracts unchanged. Verify all callers and tests that currently parse the old fixture prompt: update the test consumer to the new faithful projection, do not change production semantics or force model branches to satisfy fixtures.

**Regressions:** exact field/identity and provenance coverage, multiline/Unicode/empty/null/optional values as applicable, hostile section delimiters in history and skills, long user turns, Decision reference exactly once, active vs historical correction, all existing Decision paths, worker plain/structured output, RO skill materialization, native activity and attachments. No new task classifier or data mutations.

**Acceptance:** simpler readable representation, unchanged Invocation semantics and model choices; original parser/decoder/admission and Worker contracts pass.

## C17.2 — Addressable rejected Decision recovery (P1)

Owner: existing ProviderResult → Application handling → Operation journal → controller context. No new journal or correction loop.

### C17.2.1 Proven result correlation

Track the actual declared result while its adapter correlation is available. Reuse `outputObservationRef`, canonical observation refs, attempt identity, existing outputRefs and provenance. Inspect both malformed text and parsed structured outputs; distinguish raw wire text from parsed object, do not require string equality across representations or assume the last observed model message is final. Same-text independent reports are not identity proof.

Where a correlated original observation is retained, address it. Where the adapter has no original observation but the Application has materialized the declared result as its normal canonical observation, use that explicit identity and representation, not a guessed ref. Do not claim raw bytes exist for a structured result. If identity/ownership/completeness cannot be established, disclose unavailable/unknown; do not pick an arbitrary observation or correlate across attempts.

If necessary persist only an optional validated reference/representation metadata on the existing rejection event, written with its actual reason. Keep body solely in existing observation/artifact storage. Validate same-operation/same-attempt ownership at appropriate boundary; update existing event/snapshot codec and relevant type validation only as needed. Historical snapshots lacking metadata remain readable with honest unknown correlation, without migration/reconstruction. Scope mismatches, duplicate/inconsistent refs, late observations and unavailable sources cannot create trusted links. Journal remains sole durable state; no mutable recovery side index.

### C17.2.2 Addressable bounded delivery

Expose the active rejection's actual category/stage/path/expected, attempt and canonical output ref in existing `host:decision-error`/recovery projection. Distinguish stored body completeness, inline availability/omission/excerpt and retrieval capability; do not equate a missing inline body with lost evidence, or a retained ref with fetchable complete bytes. Use existing scoped ContextPort and existing non-MCP contextRequest where applicable. Respect disabled/unsupported MCP, fetch/capture limits, provenance and authority.

Prefer delivery of the explicitly correlated previous result through existing optional history packing after model-selected requested refs and existing required records. Preserve mandatory original user messages, restrictions, unknown effects and coordination data. Use ordinary bounded excerpt/omission semantics if budget insufficient. Do not create an exempt copy or raise budget, add retrieval calls or force history enumeration. Count bytes/omissions accurately, including any additional bounded metadata under existing budget contract; `controllerMaxBytes` is not the provider's full prompt/window limit. Keep one copy per proven identity; link to the original ref, even when the body is displayed elsewhere. Distinct representations/observations remain distinct unless technical equivalence is proven.

### C17.2.3 Corrective wording and lifecycle

Only when current correction is active, expose one readable technical section, e.g. “Previous declared result rejected: [stage, category, path, expected]. Original result: [ref/availability]. Historical results and observations may be used or reconsidered as needed. Return a valid Decision for this invocation.” Use existing contract definitions for bounded accurate error explanations; no new semantic error taxonomy. Do not claim previous work finished, correct or fresh, instruct reuse, prohibit rechecking, or require a finalAssessment. Full normal Invocation remains available.

Historical rejection remains historical after an accepted Decision or a new accepted user turn. Do not accidentally revive it due to restart or the same turn's rejection count; distinguish counting scope from active correction. Preserve the C16 thresholds, journal-derived counting, reset rules, reservation/budget behavior, local technical wait, independent accepted Workers and no blind replay. No additional dispatch, changes to admission or new recovery lifecycle.

**Regressions:** actual parser categories, schema/admission failure, raw-vs-parsed result, explicit/no/invalid ref, different attempts with equal messages, multiple intermediate messages, fallback canonical output, structured provider, truncated/omitted/unavailable body, very small budget, explicitly requested refs, retrieval enabled/disabled, no duplicate body, snapshot old/new, restart/crash after durable rejection before next reservation, accepted Decision after rejection, changed task after waiting, late result/cancel, independent Worker not_sent and unknown effect. Confirm provider failure does not count as bad Decision.

**Acceptance:** exact durable correlation where proven, honest availability otherwise; next model can use the result or choose another strategy within the existing cycle.

## C17.3 — Context efficiency and passive diagnostics (P1/P2)

### C17.3.1 Technical duplication only

Inspect actual payloads before/after C17.1/2: duplicate serialized contract, identical original result inline copies, repeated context metadata/tool observations. Reuse current identity and provenance mechanisms (`deduplicateInlineResults`, explicit original refs). Remove only proven redundant representations from the delivered payload; no semantic similarity, cross-attempt content-only collapsing, stale inference, deleting evidence or assuming native history contains earlier information. If a duplicate is omitted, retain appropriate ref/availability; original records remain available under existing scope/limits. Do not add caches, indexes or second storage without demonstrated need; unnecessary optimizations may be left unchanged with evidence.

### C17.3.2 Measurement

Use existing DiagnosticPort/diagnostics infrastructure, best-effort bounded and safe redaction. Record actual operation/attempt/profile correlation, context UTF-8 bytes and counts/omissions/excerpts, serialized adapter payload UTF-8 bytes/hash and major component sizes where measurable without extra unbounded copies, preparation/send facts and monotonic durations, actual rejection stage/category, and existing reported usage/session IDs/stop reason when available. Distinguish prepared payload vs submitted payload vs provider's internal context; bytes are not tokens and unknown usage is not zero. Capture native tool identities/counts and compaction events only if directly exposed by the currently implemented transport; no invented events or inference from thinking. Preserve provenance and timing semantics. No new required capability.

### C17.3.3 Opt-in capture

Provide a bounded optional capture of the actual adapter prompt (or an explicitly stated unavailable/partial capture) using existing diagnostic sink/config where feasible, sufficient for operator comparison; default OFF, trusted configuration only, no project permission escalation. If enabled, warn that arbitrary prompts may contain secrets; redact known sensitive fields/credentials per current diagnostic contract, distinguish raw hash/size from redacted stored representation. Do not claim perfect secret detection.

Store in protected user diagnostic directory, not project workspace; reuse rotation/retention/limits where appropriate, bound total pending writes/memory and per-record size, mark omitted/truncated/dropped bodies. Never log full prompts by default or put capture into ACP stdout, model history or task state. No blocking dispatch/provider streaming, no failure propagation into operation outcome, no unhandled promises or leaks on cancel/close. Use existing sink/drop reporting; avoid separate telemetry process or task log. Validate new trusted config only if necessary.

**Regressions:** diagnostics on/off gives equivalent dispatch/outcomes and native activity; actual UTF-8 vs byte hash/accounting, missing usage, config default/off/invalid, capture overflow/rotation/truncation/redaction, sink error/backpressure, parallel attempts/cancel, unchanged stdout/ACP/JSON, no secrets in fixture logs, disabled MCP. Demonstrate bounded overhead with same-input deterministic comparisons; no hard timing gate based on noisy wall-clock.

**Acceptance:** measurable overhead with truthful origin/availability, no runtime behavior change or semantic analysis. Do not change production context defaults (operator comparison uses 65536 only).

## C17.4 — Native and comparative acceptance (P1)

Prepare reproducible test instructions/commands using the installed RO package and available real agent/model/config. Diagnostics must be ready before comparisons. Run what is actually accessible and authorized; otherwise leave explicit UNVERIFIED with exact blocker and operator procedure. Do not send credentials/private workspace or prompts to CI. Status of this native work is independent from deterministic engineering PASS. Complete the agreed engineering scope even if native environment is unavailable.

Compare (A) native agent directly, (B) pre-change RO, (C) RO with presentation only, (D) RO with presentation + addressable recovery and diagnostics. Retain a reproducible checkpoint or equivalent documented builds for C/D; diagnostics must be equal or measured separately. For B–D use same `controllerMaxBytes: 65536`; fixed target commit/workspace contents, request/skill text, model/version, sampling, native mode, permissions, timeout, context window and other budgets. Separate session/cold/warm conditions as possible. Use >=3 independent runs per accessible variant for the main safe scenario, include failures/cancellation, report sample size/variability; not a statistical claim of universal improvement. Direct native is a content/time reference, not proof of RO coordination. Do not alter runtime behavior to make the comparison pass.

Use the operator's Ornith-1.5-35B-A3B/OpenCode ACP case if available, a smaller model and stronger control where possible; test another independent provider/transport when available. Names are test configurations only. Record exact model/agent/client versions; don't assume credentials/access.

| Scenario | Required observable |
|---|---|
| Direct simple answer | May finish with one Controller, no mandatory tools/Worker/review |
| Format-sensitive task (Markdown/JSON/Unicode/several sections) | Original user answer format preserved; valid unchanged Decision transport |
| Native repository skill (e.g. changed) | Independently discovers/uses native skill without RO registration; exact original constraints; fixed input for comparison |
| Non-Git directory, arbitrary project files/scripts/instructions | No Host assumptions, native environment discovery remains natural |
| Rejected Decision with prior result | Accurate addressability and correction, no forced reuse or repeat |
| Delegation, waits, results, native subagent | All paths remain accessible; model selects its own strategy, independent Workers unaffected |
| Native question and optional fields / clarification | Values, request identity, acknowledgement preserved |
| New connected or different task after finished/waiting | Literal chronology, no Host intent classification or stale correction |
| Cancel, timeout, provider failure and unknown effects | Truthful outcomes and no automatic replay |
| MCP disabled / provider without extra capabilities | Ordinary existing path works without forced retrieval |

For every applicable scenario distinguish capability-preservation contract fixtures from actual model behavior. Do not fail a model for choosing another valid strategy. For real runs record first-attempt acceptance, operation success/failure, rejection categories/counts, invocations, wall-clock elapsed/stop reason, bytes and reported tokens, native tool events where observable, content quality/requirements/skill compliance and evidence support; use comparable safe inputs and explicit outcome rubric outside runtime. Fewer calls/delegations alone do not mean improvement. Observe native thinking/plans/tools and user interaction without interpreting hidden thoughts. Compare quality and autonomy as well as performance. If material regression is reproduced, isolate and revise the in-scope presentation/recovery changes before claiming native PASS.

**Acceptance:** engineering tests verify boundaries; native measurements honestly demonstrate or leave unverified the effectiveness and absence of observed quality regression. Preserve all existing unresolved native obligations in STATUS.

## C17.6 — Native form optional-field UX (P2, independent)

Inspect `src/hosts/cli-form.js`, `cli-input.js`, `cli-input-view.js`, interaction broker, existing validation/PTY tests. Improve presentation of optional native text fields following a choice. Within the same question/card, display original field title/description and generic “Additional text (optional)” or equivalent if schema says it is optional; show explicit skip affordance. A genuine structured alternative may use the schema-provided semantics, never infer from key `other`, `confirmation` or ordering. Do not insert invented question content or preview.

Example only (model supplies actual text and choices):
```text
◆ Question · Controller #1
[original question]
1. [original option]
2. [original option]
Select an option: 1

Additional text (optional)
[original field title]
Enter text, or :skip to omit this field.
❯ :skip

✓ Response submitted
```
Only show submitted acknowledgement after broker confirmation. Preserve schema keys/types/options/constraints, field order/identity, required vs optional, absent vs empty string, and original values. No automatic default or answer; retain relevant :skip, :back, :details, pagination, cancel/decline, previously displayed choice and stale request protections, async validation, bounded details, orphan/reconnection and authority. No change to native payload, interaction lifecycle or model capabilities.

**Regressions:** choice plus optional string, required string, empty allowed vs rejected by schema, skip/back/default explicit selection, arbitrary field names, multiple fields, paginated choices, cancel during validation, stale request/ACK, attached client and real Linux PTY. Verify exact broker/native response, not just visual text.

**Acceptance:** original question is understandable, optional semantics explicit and response contract unchanged.

## C17.7 — Compact terminal outcome presentation (P2, independent)

Inspect `src/hosts/cli-presentation.js`, `presentation.js`, `cli.js`, `src/main/cli.js` and existing structured execution facts. Determine single owner of human TTY terminal summary across direct/attached CLI. Do not change ACP/native stream or other presentation contracts. Suppress only structurally redundant equivalent compact decorations already represented in summary; not a text-based dedup heuristic.

Examples when supported by actual facts:
```text
■ Operation cancelled · source=client
  3 Controller attempts · 0 Worker attempts
  Unknown effects/outcomes remain.
◇ Operation waiting · DEADLINE_EXCEEDED
  1 Controller attempt · 0 Worker attempts
  Unknown effects/outcomes remain.
```
Do not show unknown effects when absent or announce terminal state before confirmed. Preserve timely cancellation-in-progress notification if lengthy, and meaningful new late outcome, conflict, failure, unknown effect or changed status even after summary. Preserve original final model Markdown, truthful partial/unresolved Assessment (even with nonempty answer), all journal events and detailed/debug. No reducer/lifecycle/cancellation classification change. Maintain byte-exact redirected/machine/JSON stdout, exit codes, stdout/stderr separation and existing native question/permission handling.

**Regressions:** Ctrl+C active Controller, simultaneous Workers, waiting for user response, cancellation in progress, late report before/after summary, technical timeout and other wait reasons, finished/partial/unresolved, direct vs attached owner, repeat/disconnect, non-TTY/redirected stdout/JSON/exits, NO_COLOR. Use real Linux PTY and existing unit/integration tests. Check presentation does not change operation state or suppress a newly available fact.

**Acceptance:** one coherent compact summary per corresponding outcome, no redundant repeat; all significant transitions/outcomes remain visible.

## C17.8 — Engineering verification and documentation

Execution order: C17.0 → C17.1 → C17.2 → C17.3 → C17.4; keep minimum measurement available earlier. C17.6/7 can proceed independently; all applicable changes enter C17.8. Numbering retains original C17 scope identifiers (no C17.5 task). This is an implementation plan, not a runtime workflow. Do not stop at baseline or documentation; implement applicable scoped fixes and regressions.

Audit actual diff against baseline and AGENTS invariants. Verify ownership, lifecycle, bounded resource usage, preservation of scopes/provenance and source-of-truth, model choices and no native capability suppression. Include deterministic same-input overhead comparison (prompt bytes, copies, journal traversals, state writes, invocation count, native activity delivery; measure where applicable and document limitations). No new unbounded structures or avoidable full history passes; no semantic scoring gates. Verify all existing C12R–C16R and UX regressions.

Run mandatory repository CI/checks per current workflow: Node 24 and checkJs/noEmit, specification/import boundaries, foundation/core/contracts/integration/acceptance and full root npm suite; ACP SDK/history, Linux real PTY, established C15/C15R comparator probes; Nix flake check, locked package build, package removal/install outside checkout, NixOS evaluation, release/archive/checksum and lock verification. Record exact commands/exits/counts and mandatory GitHub Actions run at final HEAD. Don't inherit prior SHA PASS. If final docs include evidence from code checkpoint, verify final docs SHA independently and report without an endless docs-only cycle. No CI weakening or master merge.

Update existing docs by purpose only: this plan and IMPLEMENTATION_PLAN/STATUS; CONTEXT_AND_RECOVERY for confirmed recovery changes, PROVIDERS_AND_CONFIGURATION/DIAGNOSTICS for actual config/diagnostic contracts, DECISIONS for durable architectural choices, CHANGELOG for user-facing changes, existing tests/ACCEPTANCE_MATRIX.md (extend relevant A05/A06/A21/A24/A123–A125 and UX entries or add only genuinely new requirements); keep NATIVE_ACCEPTANCE procedure consistent if needed. Do not pre-mark unexecuted checks PASS, duplicate normative requirements or commit private captures.

Final handoff: exact HEAD and branch, scope delivered, technical decisions/evidence, regression paths/expected RED/actual GREEN, CI URL and exact SHA, native commands/versions/results or exact blockers, remaining limitations. Distinguish IMPLEMENTATION COMPLETE / ENGINEERING VERIFIED / NATIVE VERIFIED (or UNVERIFIED). If native testing reveals unresolved regression, state it separately; no false quality claims. Closure of engineering work requires all scoped fixes and mandatory checks; no out-of-scope runtime changes.
