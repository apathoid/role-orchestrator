# C21 — Model-facing Information Clarity

**Status: implementation candidate on approved branch; exact-final-SHA engineering and native acceptance UNVERIFIED.** See [STATUS](STATUS.md) for checkpoints and evidence.
**Approved working branch:** `feature/controller-intent-deferred-admission`.
**Source/review baseline A:** `5b6e55ccdd9ce2fba4a5dfdcb3d53dcd4b87ff55`, [CI #45563489787](https://github.com/apathoid/role-orchestrator/actions/runs/45563489787) SUCCESS on this exact SHA. Prior C19–C20-R implementation checkpoint `c86d3e5e47bffc7bb7eb4ff42763865b360faae5` / [CI #45488863848](https://github.com/apathoid/role-orchestrator/actions/runs/45488863848) is historical engineering evidence, not C21 verification. The commit introducing this plan is the planning HEAD; record its actual SHA and actual implementation baseline before edits. No master merge. This is the sole approved C21 scope; supersedes earlier proposals under the name Evidence Usability & Controller Efficiency.

## 1. Purpose and evidence boundary

Improve the clarity, fidelity and accessibility of information Role Orchestrator (RO) delivers to models. Optimize the interaction with RO, **not model behavior or task strategy**. Preserve model-first orchestration, transparent real workspace, provider independence, and existing lifecycle.

Operator-supplied analysis of a native run on 25 November 2026 (private debug(5).zip; exact executed build and raw logs not independently established in this planning commit) reported OpenCode ACP / local-medium / llama.cpp:
- one Controller invocation, no Workers, nine native tool calls, 37 observations, zero rejected decisions;
- 23 observations existed at evidence discovery; first page returned 12 and exposed nextCursor, but model did not continue. Some cited refs existed yet did not support the associated requirements; no demonstrated pagination defect;
- some result events lacked a title available earlier in the same tool call;
- model repeated the submitted answer before native turn end (about 20 seconds reported); no proven transport defect;
- unrelated experimental_image_generate call with placeholder argument; provider reported background launch, actual image result and root cause unconfirmed;
- RO prompt 23,311 bytes; sampled peak context 22,974 / 65,536 tokens; about 5,330 generated tokens, 186 seconds Operation duration. Token metrics are server-level, attribution assumes no concurrent llama.cpp workload; cache/load and sampling affect comparison.

These are observations from one reported experiment, not a controlled A/B, universal model failure, proven integration bug, or C19–C20-R native PASS. Do not commit private archives, prompts, credentials, project contents or provider dumps. Use sanitized fixtures and operator-authorized native environment. Keep previous native obligations open unless actually verified.

## 2. Non-negotiable boundaries

Apply [AGENTS](../../AGENTS.md), [reasoning contract](../../.agents/REASONING.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [EXECUTION](../EXECUTION.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [DECISIONS](../DECISIONS.md), [C17](C17_CONTROLLER_CONTEXT_AND_DECISION_RELIABILITY.md), [C18/R](C18_CONTROLLER_INTENT_AND_DEFERRED_ADMISSION.md), [C18N/R](C18N_LIVE_EVIDENCE_DISCOVERY_AND_RELIABLE_CORRECTION.md), [C19/R](C19_MODEL_FACING_EVIDENCE_AND_ANSWER.md), [C20/R](C20_OPTIONAL_INVOCATION_DEADLINE_AND_RESOURCE_DEFAULTS.md), [STATUS](STATUS.md), [implementation plan](IMPLEMENTATION_PLAN.md), [native procedure](NATIVE_ACCEPTANCE.md) and [acceptance matrix](../../tests/ACCEPTANCE_MATRIX.md). Read applicable .agents/engineering/ instructions. JS ESM/JSDoc/checkJs, Node 24, existing Nix/CI.

- Model owns interpretation, strategy, tools/skills, project discovery, decomposition, delegation, verification, relevance/sufficiency, Findings, Assessment and when to finish. Host owns technical contracts, authority, attribution, identity, correlation, access, coordination and lifecycle. Provider adapters own native protocol semantics. Roles describe responsibility, not mandatory stages.
- No new required workflow, Host task classifier, forced retrieval, review or delegation, tool preference or quantity rule, semantic evidence selection/ranking/validation, freshness gate, Host summary/compaction, or automatic answer rewriting. Preserve direct-answer path and exact user-facing result.
- No artificial workspace, filesystem mediation, Git/checkout precondition, isolation, mandatory script/skill registration, native subagent/tool suppression, or provider-specific logic in Core. Preserve user-selected provider policies and actual authority. Native discovery remains native.
- No second registry, store, scheduler, or durable writer. Do not invent a universal native tool ontology. Preserve original observations, canonical refs, scope, provenance, completeness, receipt identity and duplicate/conflict semantics.
- Preserve C18 Deferred Decision Admission, last-wins replacement, technical advisory preflight, ability to continue native work, cancellation and existing recovery. No new external effect tracker, classification, monitor, recovery mechanism, or changed unknown-effect contract.
- Preserve C20 defaults (5/null/null) and trusted configurable limits, C20-R independent result/history capture, existing transport/cleanup and explicit cancellation. No new cumulative quotas, startup/tool/idle/execution timers, watchdog, polling or liveness policy.
- Explicitly excluded: investigate/fix model, OpenCode, llama.cpp or chat templates internally; disable native image tool; investigate process daemon unavailable or normal teardown classification; placeholder, repeated-call, temporary-file or economy instructions; optimize number of tool calls/tokens/time; mandatory new evidence filters/order/limit, default page increase, fixed prompt reduction. No provider config change.
- The following steps govern engineering, not runtime. If a requirement is already satisfied, record evidence and do not rewrite it for checklist compliance. Correct observed regressions in their owning step and repeat affected checks.

## 3. C21.0 — Baseline and ownership inventory

Verify actual branch, HEAD, worktree, relevant exact-SHA CI, and preserve unrelated user changes. GitHub baseline above is not a claim about the user's uncommitted tree. Start from current accepted source; reconcile any intervening changes. Inspect relevant production paths and tests, not a new full architecture audit.

Inventory:
- ACP provider event handling and existing mergeToolCall/identity state in src/adapters/acp/provider.js; other adapters only for their own actual metadata.
- src/core/observation.js, ports, decoder/persistence; src/application/orchestrator.js, evidence-identity.js, live-evidence.js, native-metadata.js; historical context list/fetch and metadata projections.
- Actual MCP bridge tool registration, namespaces/aliases, schemas and wire response; Controller prompt renderers, delivery selection, intent/legacy references, context/catalog/WorkMap and authority.
- Existing proposal registration, advisory warnings and native completion barrier, text/legacy and Worker shared paths.
- Tests from C17–C20-R, actual ACP SDK fixtures, measurement scripts, exact mandatory CI.

Record owner/source/lifetime, data and size bounds, relevant actual functions and existing coverage. Capture sanitized representative model-facing request, list/fetch responses and schemas (including transport envelopes) for before/after comparison, using existing passive diagnostics or fixtures. Distinguish measured from reported metrics, source capture from projection, and exact-build fixture from real provider run. Do not introduce persistent prompt logging. Add targeted RED fixtures where a reproducible contract defect exists; prompt fixtures show delivered contract, not model compliance. Baseline A uses actual pinned SHA/config; if historical native inputs unavailable mark comparability UNVERIFIED.

**Exit:** baseline inventory, known limitations, reproducible fixtures where feasible, affected owners/paths/tests and actual SHA recorded; no forced runtime work.

## 4. C21.1 — Native integration: RO boundary only

Question: does incorrect RO integration contribute to incorrect native tool selection or execution? Examine only actual RO-owned paths involved in the reported image call. Check RO tool definitions and alias/collision behavior, MCP parameter/result serialization and dispatch, ACP event identity/attribution, whether RO issues or forwards any relevant request, and the actual Controller/evidence instructions and returned data (if available). A received event is not evidence that RO initiated the tool. If RO does not construct the provider's native tool definitions or parse that provider's model response, document that boundary; do not inspect or repair its internals.

Use existing logs/diagnostic facilities or bounded sanitized deterministic fixtures. No permanent extra logging, provider-specific rules, new permissions, filtering or guidance against placeholder calls. Do not run an unrelated side-effecting tool to reproduce the incident.

**Exit:** supported RO defect fixed at its owner with targeted regression; or verified paths and no defect found documented; or missing evidence explicitly UNVERIFIED with tested boundary. None of these requires determining the external cause. Avoid claiming absence of a defect from insufficient evidence. No changes to unknown effects or teardown.

## 5. C21.2 — Native metadata: existing adapter knowledge, immutable observations

Confirmed design issue: ACP tool_call/tool_call_update can carry sparse updates. Current adapter maintains merged tool identity for existing consumers while publishing native metadata mainly from the current update. Use actual current code to establish behavior. Example: prior title and kind known, new update reports only status. The latter should be identifiable without model reconstructing prior events.

### 5.1 Owner and source

Use existing invocation/session-scoped adapter state if reliable, not an additional tool registry, index, history search, application reconstruction, or enrichment service. Adapter extracts and correlates only native protocol fields. Application/Core validates and presents the accepted optional record generically. Preserve raw received payload, original capture completeness, source/providerRef, canonical observation identity and technical provenance. A provider-relayed title is not Host proof of the command actually run.

Illustrative optional representation (actual types/names chosen minimally after inspection):

```json
{"native":{"eventKind":"tool_call_update","nativeToolCallId":"call-123","title":"git show HEAD","kind":"execute","status":"completed","inheritedFields":["title","kind"]}}
```

- Current event kind, native ID and status describe the actual current event only. Never inherit status, result, exit code, rawInput, content, success or semantic description. Inherit only available identification metadata (title/kind/name if actually supported and appropriate), from a reliably identified same call. No invented fields or normalization of native strings. Respect protocol distinction between missing, null/cleared and present values; do not blindly use nullish fallback if explicit clear means something different.
- Attribute inherited fields explicitly; do not imply a prior field was reported anew. Missing/unreliable ID, absent state, incomplete retention or ambiguous correlation means omit optional enrichment. Never reject otherwise acceptable observation just because optional metadata is missing/invalid. Do not widen identity scope across invocations, sessions or providers.
- Snapshot at acceptance; no retroactive mutation when a later update arrives; no backfill/migration or additional observation solely for enrichment. Reuse existing observation decoder, persistence and live/historical projection; old records and adapters without metadata remain legal.
- Preserve identical-repeat vs conflicting-report semantics: an earlier equivalent source report redelivered after adapter state changes must not become a conflict solely because enrichment changed, or mutate its original accepted record. Preserve detection of actual conflicting reports. Inspect identity boundaries; native toolCallId identifies a call, not all updates as one event. Distinct legitimate updates remain distinct; no new provider replay/dedup protocol or heuristic matching.
- Preserve existing capture limits, cleanup and C20-R independent result capture. Do not retain extra unbounded identity or content beyond current lifecycle/limits.

### 5.2 Projection and resource safety

Bound optional metadata before expensive serialization under existing C19 projections. Preserve canonical refs, source, completeness, essential prior provenance and positional gap/omission behavior, existing raw fetch capacity and exact accepted payload. An inherited value and its attribution must be represented together or omitted truthfully; never display the inherited value without its marker because only the value fits. If both do not fit, omit through existing bounded mechanism; preserve existing omission limitations rather than inventing evidence. Distinguish absent native field from projection omission where contract permits. Apply this to live list/fetch and appropriate committed/historical projections, not merely one display path. No unbounded repetition of shell titles/heredocs; no additional copies of raw tool results.

### 5.3 Checks and exit

Production-path ACP SDK fixtures for sparse updates, updated/explicitly cleared fields where supported, inherited attribution, parallel calls, reuse of ID across scopes, absent/unreliable identity, duplicate vs actual conflict, late event/immutability, long escaped/Unicode title and byte-boundary paired omission, history overflow/identity-only state, original payload and stable ref through list/fetch and committed reopen. Verify no regressions in other adapters and old metadata-less records; do not force uniform status vocabulary or metadata availability. Measure incremental encoded sizes and representative costs if relevant.

**Exit:** clearer identification through existing adapter state, faithful immutable records, bounded attribution-preserving projection, C19/C20-R guarantees and no new owner.

## 6. C21.3 — Evidence presentation first; optional API extension

After C21.2, examine the actual serialized tool descriptions, schemas and responses seen by the model, not only JS objects. Improve existing presentation before considering new options. Compare same input and actual MCP response fixtures; consider live and historical views only where they represent the same contract.

Questions:
- Can the model identify a ref, source, native call and reported event/status? Are provider-reported title and actual observed payload distinguished?
- Can it correlate a record with data already seen during native work, even when multiple updates have similar title/status? Examine technical payload availability, format, size or artifact indicators only if already cheaply known and useful. Do not mandate new fields, parse raw bodies, infer meaning, classify content, generate summaries/excerpts semantically or duplicate raw results. No universal result detector.
- Are capture completeness, directory field omissions, response/page coverage, missing payload and access denial distinct? Complete capture is not tool success, full history or sufficient evidence. A page may be exhausted at the time of the request and later live records may appear; no nextCursor is not proof of future absence.
- Are cursor, nextCursor, resumeCursor, existing fetch ref/range/format and source-vs-chunk completeness clear? Make optional access easy to understand without mandating it.
- Can redundant metadata be removed from presentation without losing necessary information, authority, availability or identity? Keep existing access and raw contents; no eager history injection or requirement to fetch.

Preserve ordinary live list defaults and contracts: as of reviewed code, 12 entries/page, 24 KiB page, 1536 bytes/item, 16 KiB fetch chunk (verify actual values). Preserve append-only position, nextCursor for existing remaining entries, resumeCursor for subsequent live reads (including empty/exhausted); historical revision/index semantics unchanged. Preserve byte budgets/omission markers, progress across oversized records and access to later records. Do not raise defaults in C21 to mask size regressions.

**Decision after presentation improvements:** add no new list parameter unless a concrete unresolved usability problem justifies it and a simpler presentation cannot address it. No new parameters is a valid completed C21.3. Record why, actual cost/benefit and alternatives. If justified, select minimum of optional limit, newest-first order, source or literal native metadata filter; no nested predicates, ranking, semantic search, query language, universal ontology or automatic filtering. Existing calls and defaults work unchanged. Unknown native field does not match a filter; it does not imply failed tool. Match actual stored values, not clipped representation. Preserve scoped authorization, observation identity and omission/gap semantics.

If new traversal added: bind cursor to its query/order/scope with minimal stateless position and explicit incompatibility handling; do not use moving reverse offsets. New records must not duplicate/skip previously available matching entries mid-traversal; specify how to start a fresh traversal and preserve ordinary append/resume contract. Use existing ordered sequence, no server cursor sessions, materialized snapshots, new indexes/caches or full repeated sort; avoid quadratic repeated scans. Model-selected page size remains constrained by per-response byte budget, not cumulative access. Invalid query/cursor yields technical error, empty match is valid. Test only the extensions implemented (live append, empty, sparse matches, query mismatch, bounds, no lost accessible refs and scoped fetch).

**Exit:** concrete before/after model-facing examples, known ambiguities addressed, default 12/ordinary pagination and optional retrieval preserved, supported decision on any API additions, no semantic processing or new state. If presentation already satisfies an aspect, document rather than invent a change.

## 7. C21.4 — Evidence and Assessment contract

Audit existing descriptions across actual delivery paths before adding text. Explain only RO-specific semantics: observation/ref identity; provenance (provider-reported vs Host-observed vs model claim); source capture completeness vs projection/page/chunk availability; discovery/fetch scope and optionality; Findings/Assessment are model evaluation. Canonical ref identifies a recorded item in its authorized scope, not the truth of an arbitrary claim or guarantee that payload is available.

Possible compact wording, not a required extra prompt block:
> Observation references identify recorded information with its source and capture completeness, not the truth of a claim. Relevance and sufficiency for your findings or assessment are yours to evaluate. Discovery and retrieval are available when additional information is needed.

Use existing instruction owner; avoid duplicate guidance; integrate finally in C21.6. Do not impose minimum refs, preferred event types, mandatory fetch/list, pagination, review, re-check or a method of evaluating task requirements. A user request for evidence remains a user requirement, not a universal RO rule. Preserve C19 actual answer guidance and status semantics; admission remains technical only (including valid but semantically weak refs); do not make observationRefs newly mandatory or alter any existing decoder/gate. Advertise only available capabilities for each delivery path.

**Exit:** clearer technical contract without new semantic gate or strategy instruction. Verify actual delivered descriptions, optional no-retrieval path and existing invalid/out-of-scope ref rejection.

## 8. C21.5 — Native turn transport clarity

Inspect MCP ControllerIntent delivery and C18R/C20-R actual paths. A registered proposal is not final admission or end of native turn/Operation. Native completion barrier and existing replacement semantics remain. The user-facing result is finalAssessment.answer in the applicable final Intent, preserved exactly.

Possible wording for MCP only:
> In MCP delivery, finalAssessment.answer carries the user-facing result. Submitting a proposal does not end the native turn or establish final admission. You may continue native work or revise the proposal. When ending the turn, you do not need to repeat the submitted answer.

No command to stop after submit_decision, no finalization call, no time limit, no automatic cancellation/suppression of native tools/messages. Do not assume all transports can end without final text; advertise only actual support. Do not apply MCP-only wording to text Intent/legacy Decision, which rely on native text. Check normal final, supported empty final, continued tools, replacements (including advisory/invalid cases), native failure/cancel and exact final answer. If existing runtime works, only clarify contract; fix only confirmed own transport defect.

**Exit:** no false requirement to repeat answer; model decides when to end; both legitimate continuation and ordinary final remain supported. Existing native finality and admission unchanged.

**Checkpoint B:** record exact SHA after C21.1–5; collect comparable fixture outputs and available native comparisons before comprehensive prompt optimization. Native unavailability is UNVERIFIED, not a blocker to proceeding with engineering. No new provider requirements.

## 9. C21.6 — Comprehensive Controller prompt optimization (last planned contract-edit step)

After all previous model-facing changes, audit complete actual delivered Controller prompts (MCP, text Intent, legacy Decision) including dynamic sections and tool schemas/descriptions. Inspect shared instruction builders and ensure no regression in Worker paths. Optimize clarity and justification, not token targets. Do not remove role purpose or essential coordination semantics just because they influence behavior.

Classify substantial instructions by purpose:
1. technical/transport contract, trusted authority/safety, resource/lifecycle/recovery facts — preserve;
2. definition of role responsibility and model-owned coordination semantics — preserve;
3. prescription of particular task strategy/workflow (e.g., obligatory Explorer, mandatory verification/retrieval not required by user or established contract) — remove or replace with description of available capability where found unjustified. Do not invent deficiencies; do not weaken existing legitimate project/product contracts or user/role-specific instructions. If a proposed removal changes normative behavior, stop that removal and record the conflict for separate decision; no silent contract change.

Inspect objective, literal user turns and authority; Controller instructions; intent/Decision reference and actual transport schema; catalog/roles/profiles/capabilities; state, WorkMap, pending actions, dependencies, technical coverage, unknown effects, cancellation and recovery; context/evidence and final-answer guidance. Remove proven duplicates, outdated and contradictory wording, redundant representation; integrate previous clarifications into existing owner, not additive repetitive blocks. Retain all supported choices, required/optional fields, combinations, references, attribution, replacement, wait/continuation, Findings/Assessment and exact answer contract. Do not replace full necessary contract by illustrative examples. Avoid assuming a capability exists across transports merely because a tool schema describes it elsewhere.

Preserve user text, original ContextItem identity, literal objective, subsequent turns, order, authority and provenance. Deduplicate only proven multiple representations of the same source identity and identical content; same text in distinct user messages is not a duplicate. No semantic dedup/summary or replacement of inline objective with required retrieval. No narrowing of profiles/capabilities, conflation of supported/unsupported/unknown, hidden availability selection or difficult normalized cross-reference tables merely to save bytes. Keep technical facts and explicit omissions necessary for autonomous replanning. No new dynamic prompt optimizer, strategy classifier, instruction service or mandatory tool calls. Do not shift text into schemas just to claim prompt savings.

Compare same-fixture A/B/C actual total prompt and tool schema bytes, substantial instructions, intent reference, catalog, state, and user-context fidelity; tokens when available under same tokenizer/config. Report why each material change improves clarity, including removal decisions. No required percentage reduction; an increased prompt can be acceptable if justified. Use existing C17 same-contract benchmark semantics and preserve actual parser/framing/Worker invariants; do not alter tests to conceal regression.

**Exit:** full contract audit, clear owner for each changed instruction, preserved role responsibility and technical/user contracts, no new behavioral prescription, before/after breakdown and meaningful tests. Checkpoint C exact SHA after C21.6; later correction changes SHA and requires affected checks again.

## 10. C21.7 — Engineering regression and CI

Reuse existing tests/matrix; add focused tests during each step, not an independent framework or exhaustive duplicate suite. Prefer actual production paths/ACP SDK and real store reopen where relevant. Targeted coverage (only new tests where missing):
- M: sparse/current/clear/inherited identity, scope/parallel/missing identity, equivalent repeat after state changes vs real conflict, late event, old record, committed reopen, paired attribution/omission under byte and Unicode bounds, source completeness and existing fetch capacity, C20-R history overflow and independent current result.
- E: actual MCP list/fetch schemas and envelope, ordinary/empty/exhausted/resume live page, new live append, payload/metadata/response completeness distinctions, oversized records and subsequent access, closed and unauthorized scope, any implemented optional query parameters and stable traversal. No test of unimplemented extensions.
- A: optional evidence retrieval, technical ref checks, valid but semantically weak ref not a new rejection, MCP proposal with ordinary/empty final if supported, post-proposal native work, replacement, cancel/failure, text/legacy and exact final answer.
- P: original user turn identity and authority, all eligible profiles/capabilities, technical coverage/recovery/unknown effects, all actual delivery contracts and shared Worker paths; no forced workflow/retrieval. Contract assertions rather than brittle whole-prompt wording; preserve behavioral invariants when updating snapshots.
- Existing independent Workers, wait, clarification, replanning, cancellation, recovery, native skills/subagents, permissions, context, C20 optional deadline/unlimited cumulative invocation defaults, C20-R and CLI/ACP regressions must still pass; no new runtime semantics to satisfy tests.

Run existing full exact-SHA mandatory CI: Node24/checkJs, specification/import boundaries, foundation/core/contracts/integration/acceptance/root npm, applicable SDK/PTY and benchmark probes, Nix flake/package/install/systemPackages/release checks as configured in actual workflow. Record commands, actual exits, exact SHA and workflow links. Do not claim RED/GREEN or measurements not executed. Check mandatory CI on final code and separately on later documentation SHA. If unavailable/failed, distinguish implementation from regression UNVERIFIED/FAIL; do not label engineering PASS. Correct regressions at owner and rerun affected tests/full CI.

## 11. C21.8 — Native comparison (separate from engineering closure)

Use [existing native procedure](NATIVE_ACCEPTANCE.md) in authorized environment. Record exact SHAs A (before), B (after C21.5), C (after C21.6); collect checkpoint evidence at each when feasible. Comparable fixtures are required for technical comparison; real runs where available, not forced or simulated as native. A→B evaluates aggregate interface/contract change; B→C evaluates additional prompt changes. No causal claim about each individual edit or universal performance from a small sample. Record provider/model version, config, effective permissions, context, skill, cwd/target commit, cache/load and differences; never switch/reset user tree or change provider settings automatically.

N01: original operator task (use changed skill to describe latest commit; cite registered RO observations supporting investigation and checking description against skill requirements; optional retrieval). Use original target/skill only if accessible and authorized; otherwise document differences. Evaluate actual answer and skill compliance, native access, provenance and ref content relevance, accurate presentation and admission. Do not require a particular sequence, filter, no Workers, a fixed count of refs/tools, or no repeated answer. No need to reproduce image generation or test disabling tools.
Reuse existing native scenarios for direct no-evidence task, many observations/live pagination, native skills/scripts/subagents, complex delegation, uncertainty, post-proposal continuation/replacement, text/legacy and independent provider where available. Local-medium and an available cloud Controller are useful controls; no fixed number of repeats, models or provider-specific requirement. Test fixtures cover deterministic failures; do not steer real models to intentionally violate the contract.

Record diagnostic quantities (prompt/schema bytes, tokens with attribution, invocations, Workers, native/retrieval calls, rejected proposals, elapsed time) without target direction. Evaluate relevance and quality outside Host. More tools/time or repeated answer alone is not a defect. A technical loss/false attribution, inaccessible authorized ref, regression in transport or misleading RO presentation is RO's responsibility. A model may choose weak evidence even with correct interface; do not compensate by semantic gates. Reproducible degradation of ability to use existing RO capabilities after a changed interface/prompt is grounds to investigate that change and correct/revert it if causal; do not dismiss it solely because CI is green, or force behavior with new Host controls. If improvement not demonstrated, say so. Separate technical native compatibility, observed interaction quality and task quality; unavailable scenarios UNVERIFIED. Engineering closure does not imply native PASS.

## 12. Documentation, scope and Definition of Done

This document is the detailed planning authority; update existing normative docs/DECISIONS/CHANGELOG/matrix only where actual behavior or a substantial decision warrants it, per AGENTS. No duplicates, speculative feature docs or raw private data. Keep STATUS as operational checkpoint and record actual changes, exact SHAs, CI and native gaps. C21.0–C21.8 are engineering milestones; C21.1 may be independently investigated, C21.2 before C21.3 final extension decision, C21.6 after all preceding contract changes, C21.7–8 can require a return to relevant owner. No new runtime stages. Commit coherent groups; preserve baseline/compare points and no master merge.

Engineering completion:
- RO integration boundary examined with defect fixed, supported no-defect finding, or explicit UNVERIFIED limitation; no external investigation.
- Available identity metadata faithfully attributed, immutable, bounded and dedup-safe through existing adapter/observation paths; no extra owner, C19/C20-R preserved.
- Existing evidence presentation and transport clarified where needed; default 12 and ordinary pagination/scope preserved; decision on API additions justified, zero additions allowed.
- Existing technical admission, role autonomy, user text, capabilities, native work and replacement preserved; no new policies, gates, execution limits or provider assumptions.
- Full prompt audit after other contract edits, before/after fixtures and rationale; no quantitative savings requirement.
- Targeted and full regression/CI on exact final SHA with truthful status, applicable docs consistent. Native status independently recorded, including unfavorable results and UNVERIFIED gaps.

## 13. Executor handoff

Implement C21.0–C21.8 on the approved branch according to this plan. Start by reading project rules and actual source, establish baseline and tests; do not reopen excluded topics. Prefer the smallest complete change to existing owners. An already satisfied requirement may be closed with evidence, not unnecessary code. Record planning/implementation/final-doc SHAs, stage-level changes, RO-boundary findings and limitations, attribution/duplicate and byte-bound behavior, decision on evidence_list additions, changed/removed instruction rationale, A/B/C comparison, exact tests/CI, native results and remaining uncertainties. Do not declare unavailable checks PASS. No new architecture or master merge outside authorized C21 scope.
