# C18N — Live Evidence Discovery, Reliable Controller Correction & Minimal MCP Bridge

**Status:** IMPLEMENTED; engineering CI PASS at `42293b6dc6ff7168888a83f07d31cef433f3178d`; real native UNVERIFIED. Any later documentation commit needs its own CI. **Branch:** `feature/controller-intent-deferred-admission`. **Planning HEAD:** `12b88248c8b59408b06d2ec1919498050bee19a9`. **Scope:** C18N.0–C18N.10. Implementation and native acceptance have **not** been performed by this planning change. Do not merge to master.

Related documents: [C18/C18R](C18_CONTROLLER_INTENT_AND_DEFERRED_ADMISSION.md), [STATUS](STATUS.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md), [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md), [CONTRACTS](../CONTRACTS.md), [EXECUTION](../EXECUTION.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [EXTENSIONS](../EXTENSIONS.md), [DECISIONS](../DECISIONS.md).



### Implementation record (after original planning)

The implementer verified the **requested starting branch HEAD** `45cc5219bbf26f37a3ca568044c8171307590bf2`. The original planning commit SHA above is historical and remains unchanged. The first implementation commit `5e32a739` and ACP SDK correction/checkJs commit `c48a25f` are recorded in [STATUS](STATUS.md). All C18N code, automated fixtures, Nix CI measurement and normative documentation are maintained on the **feature branch only**, without a master merge.

The accepted technical compromise is implemented: completed **ordinary** MCP requests no longer retain the old 64-call budget or a response cache; active same-ID correlation still exists, but late post-eviction same IDs can be new external executions. `submit_decision` request/lineage identity, deferred native finality, durable Decision/Worker recovery and no blind Host replay remain separate. Optional live captured evidence is a bounded read-only projection of existing current-attempt observations; optional advisory preflight runs only after proposal registration with a copied ref index, never as authoritative admission. Real model native/skill/subagent autonomy tests remain UNVERIFIED until operator-run comparisons. No host semantic effect classifier, scheduler, mandatory retrieval or workspace integrity gate was introduced.

[CI #45260312459](https://github.com/apathoid/role-orchestrator/actions/runs/45260312459) finished SUCCESS on `42293b6dc6ff7168888a83f07d31cef433f3178d` with Node 24.21.0, 29 foundation, 78 core, 534 integration, 15 PTY and all Nix/package/release checks; the ordinary 1000-call GC probe retained +4,143,856 bytes of JS heap in the synthetic HTTP fixture. Real-model native acceptance remains UNVERIFIED. Newer commits require separate exact-SHA CI; do not infer PASS from C18R or intermediate C18N runs.

## 1. Motivation and verified boundaries

Operator-supplied real OpenCode ACP / local `llamacpp/medium` run (`debug(1).zip`, not committed) used native skill `changed` and native tools to prepare an answer. Its MCP `submit_decision` received `proposal_pending`, but admission after `end_turn` rejected an unresolved `finalAssessment.requirements[].observationRefs`. A second Controller invocation attempted `replaces` with a previous invocation's `proposalRef`; the bridge correctly rejected the cross-invocation reference. The run ended in technical waiting after deadline. This is operator-supplied native **failure evidence**, not native PASS or proof of a universal model behavior. No new Host authorization/finality bug is established by that run.

Current code already provides:
- `src/application/evidence-identity.js`: `providerEvidenceRef(operationId,attemptId,providerRef)`, scoped alias rules;
- `src/application/orchestrator.js`: invocation-local `observations`, source correlation and conflicting native reports;
- `src/application/context-access.js`: historical ContextPort snapshot/list/fetch, not a live current-attempt directory;
- `src/core/finding.js`: `evidenceRefs`, `admitFindings` (mutates its temporary reference index), `checkAssessment`;
- `src/adapters/controller-proposals.js`: pending proposal lineage and registration-order finalization;
- `src/adapters/mcp-bridge.js`: MCP tools, `calls` Map, `maxToolCalls=64`, `maxDecisionCalls=128`, `maxConcurrentCalls=4`;
- `src/adapters/acp/provider.js`: native events, actual MCP capability negotiation, deferred Controller admission.

The gap is access to canonical references of **already accepted observations of the current native invocation**, plus timely **advisory** feedback on technical references. A related, independently approved simplification removes unnecessary accumulated ordinary MCP request-result caching and the fixed 64-call restriction, while preserving the Coordinator's own Decision/Action correctness.

## 2. Non-negotiable architecture

1. **Model owns semantics.** Strategy, tool/skill/subagent choice, interpretation and sufficiency of evidence, Findings, Assessment, correction, continuation and delegation remain model-owned. No Host inference from filenames, tool names, script text, Git state, provider activity or declared `effect`.
2. **Host owns only technical contracts.** Correlation, identity, provenance, scopes, declared trusted permissions, bounded retained resources, cancellation, lifecycle, durable journal and precise availability/uncertainty. Never add workspace isolation, Host source readers, an alternative skill runtime or forced checks.
3. **One source of observation truth.** Live discovery is a read-only view of accepted invocation-local observations. It is **not** another Observer, Event Journal, StateStore writer, capability inventory, complete execution trace or separate scheduling loop. Discovery itself does not manufacture task evidence.
4. **One authoritative admission.** `decodeControllerIntent`/materialization, existing `decodeDecision`, `admitFindings`/`checkAssessment` and Operation admission remain the final decision path. Preflight is advisory only.
5. **Deferred finality.** `submit_decision` registers proposals, never dispatches Actions or ends the native turn. Pending/invalid/conflicting submissions do not block unrelated native tools, files, skills, scripts, subagents or reasoning.
6. **No semantic effect classification.** RO must not determine whether an ordinary call is read-only, effectful, safe, useful or worth repeating. Keep truthful observed `Outcome.effect`/dispatch certainty and the prohibition on *Host-initiated blind replay* after unknown outcomes. A fresh model-initiated call is a new action.
7. **No promised exactly-once for arbitrary ordinary MCP calls.** Within a live request, correlation and bounded handling are required. After a completed ordinary request is evicted, a late same-ID delivery may be treated as a new transport request: this weaker guarantee is consciously accepted. It does not relax the identity/finality rules of the RO-owned `submit_decision`, durable `controller.responded` or Worker reservation/dispatch.
8. **No arbitrary cumulative call-count limits as model policy.** Bound actual input/output bytes, retained memory, concurrency, deadlines, authorization and cleanup. When a resource is exhausted, return a precise technical result, not a semantic assessment of model behavior.
9. **Provider-agnostic core.** ACP/OpenCode details belong to adapter; generic invocation evidence and ControllerIntent belong to application/ports; Core has no named-provider branches. No provider-native feature suppression.
10. **No fixed runtime workflow.** Discovery, retrieval, preflight and correction are optional; direct completion with empty `observationRefs` stays valid. C18N checkpoints are engineering stages only.

Before coding read `AGENTS.md`, `.agents/REASONING.md`, relevant `.agents/engineering/`, the current STATUS/IMPLEMENTATION_PLAN, C18, and applicable normative docs. Inspect actual branch HEAD/worktree; preserve uncommitted/other-agent edits, do not assume the planning SHA remains HEAD. Node 24, JS ESM/JSDoc/checkJs, Nix packaging. No master merge.

## 3. Technical design — data flow and ownership

```text
Provider-native tools / skills / subagents
  -> existing ProviderPort observation callback
  -> Orchestrator accepts/refuses/deduplicates native report
  -> canonical evidence:<hash> and invocation-local observation view
     |-> optional live list/fetch (read only, bounded)
     |-> optional technical preflight over a bounded snapshot
     |-> normal attempt.outcome journal commit (only at existing lifecycle point)
Model-owned ControllerIntent / submit_decision
  -> existing structural decode, pending proposal ordering/finality
  -> optional model-visible preflight feedback, not admission
  -> trusted native completion
  -> existing materialization + authoritative admission
  -> durable controller.responded, Action reservation/dispatch
```

Owners and lifetimes:
- Provider adapter owns normalization of its native events; it does not assign RO meaning or decide evidence relevance.
- Application/Orchestrator owns accepted current-attempt observations, stable refs, allowed scope, live read projection and bounded preflight view.
- MCP bridge owns current HTTP request handling, native tool discovery route and invoking the generic ports. It never reads project files or decides semantic relevance.
- Pending Controller registry owns RO proposals, `proposalRef` lineage, source request attribution, registration order, finalization and closure.
- Operation journal is the sole durable record. A live ref is an **identity**, not a durability promise: on successful journal commit it retains the same ID; cancellation, STORE_UNAVAILABLE, unknown outcome, late/failed capture retain existing truthfulness and lifecycle.
- Host-provided activity stream and captured observations differ: absence from discovery is **not** evidence that a native tool was not used or does not exist.

## 4. C18N.0 — Baseline, actual costs and RED fixtures

1. Map the real call graph from ACP native `tool_call`/`tool_call_update` to `receiveProviderObservation`, `providerEvidenceRef`, live buffer, `attempt.outcome`, `scopedEvidenceAliases` and `checkAssessment`. Distinguish native activity, published observation, output pointer, capture truncation and durable historical context.
2. Record fixed current bridge budgets (ordinary 64, control 128, concurrency 4, request/response sizes, Controller registry total byte cap), memory retention and C18R reused-JSON-RPC-ID behavior. Measure before changing.
3. RED: valid native observation already received but canonical ref not discoverable by current Controller. RED: unresolved reference accepted as structurally pending then rejected after `end_turn`. RED: new invocation reuses historical `proposalRef`. RED: 65th sequential ordinary MCP call rejected despite no active resource pressure. RED: repeated request IDs where ordinary vs RO control handling must differ for *protocol identity*, not semantics of the tool.
4. Capture a sanitized fixture representative of the operator trace; do not commit original private debug archive, model prompts, tokens or project source.
5. Record baseline exact SHA and actual test results (not guessed) in STATUS.

**Exit:** reproducible failing tests and exact ownership/resource map; no production behavior changes yet.

## 5. C18N.1 — Stable observation identity and bounded live view

1. Reuse canonical `providerEvidenceRef(operationId,attemptId,providerRef)`. Never mint a temporary discovery-only ID, never infer a ref from a path or a proposed model claim.
2. Project **accepted** current-attempt observations from existing `observations`/correlation data. If a lightweight lookup index is needed, derive it at acceptance, scoped to invocation, without another persistent writer; release on close.
3. Keep identity of duplicate equivalent native reports; detect conflicting provider-local identities with existing semantics. Distinct updates to the same native tool need not be one observation.
4. Report actual provenance, source, completeness and reported technical status; do not upgrade provider-reported completion to Host proof of task success.
5. Reuse existing late-event, cancellation and cleanup rules. Discoverable now ≠ guaranteed durable later. On confirmed durable commit the canonical ID remains unchanged.
6. No per-discovery StateStore commit, filesystem lookup, Git fingerprint or provider-native event rewriting.

**Tests/exit:** stable reference across accepted live observation and committed journal, equivalent duplicates, conflicting IDs, truncated capture, cancellation/unknown/store failures and no artificial durability claims.

## 6. C18N.2 — Optional live discovery and retrieval

Implement a simple, read-only invocation-scoped API. Choose the smallest clean route after inspecting existing ports:
- Prefer a dedicated `evidence_list` plus corresponding read-by-ref capability if extending historical `context_list` would require changing its cursor/snapshot semantics.
- Reuse existing ContextPort shapes/access rules, `context_fetch` payload bounding and naming when compatible, but **do not mix** moving live entries into historical `{revision,index}` traversal.

Live cursor contract:
- Stable, append-only accepted-observation order for this invocation, with an opaque or clearly scoped monotonically increasing cursor. New events do not reorder earlier pages.
- Pagination must neither skip nor duplicate accepted entries due to concurrent additions; a follow-up can continue to newly appended entries.
- A read sees a bounded snapshot of already accepted records. Empty, unavailable, truncated and budget-exhausted states are distinct.
- Direct fetch resolves canonical ref only in authorized current scope; return actual bounded body/metadata or exact unavailable reason. No synthesized summaries.
- Discovery result uses real reported native identity/status/location metadata only, if captured. Metadata helps model select a relevant observation without Host semantic scoring.
- The interface is a **captured evidence directory**, not an exhaustive inventory of actual native execution, capabilities or resources.
- No duplicate historical observation creation because the model called `evidence_list`. Existing diagnostic accounting of MCP transport is fine.

MCP interface must expose only successfully negotiated routes, handle collisions with external tools just like C18R `submit_decision`, and tell the model the **actual advertised name**. Collision handling must include pre-existing `context_list/context_fetch` names if touched; never silently shadow an external tool. Keep native tools/skills/subagents untouched. Text fallback/legacy remain operable without MCP discovery.

**Exit:** genuine ACP SDK native event → same-turn live list and fetch → later journal identity, plus concurrent event, pagination, capture-gap, scoped/closed and collision tests.

## 7. C18N.3 — General Controller-facing instruction

Use one short provider-neutral paragraph, not task-specific heuristics or examples of invalid filename/tool-ID references:

> Role Orchestrator records observations with scoped references and source provenance. When citing observations in Findings or Assessment, use available references from the orchestration context or optional observation discovery/retrieval capabilities. Retrieve details when useful and independently evaluate relevance, sufficiency and uncertainty. Retrieval is optional; do not invent unavailable references.

The transport-specific prompt layer may advertise available **actual** tool names and scopes; do not duplicate the general instruction or claim an unnegotiated capability. `observationRefs: []` remains structurally valid. No forced evidence retrieval or refusal based solely on lack of citations.

**Exit:** prompts remain concise across MCP/text/legacy and native tool availability is unaltered.

## 8. C18N.4 — Advisory reference preflight (not a second admission)

1. Structural ControllerIntent decoding remains existing authoritative input validation. A structurally valid proposal is registered in the existing order **before** optional preflight. Do not wait on slow tools/network, StateStore commits, file reads or future observations to register it.
2. Preflight reads a bounded technical snapshot: available committed history exposed to this invocation, accepted current observations, existing finding refs and any same-proposal findings where cheaply supportable.
3. For `admitFindings` use a **fresh temporary copy** of `EvidenceRefs`, because the existing function mutates the passed index. Do not update durable findings or change live/source indices. If full reuse would duplicate the admission pipeline, start narrowly with observation-ref existence and explain incomplete preflight coverage; do not build a second admission.
4. Return optional bounded `preflight` issues with accurate JSON path, observed availability and omission count. Distinguish structural `rejected`, `proposal_pending` with warnings, `preflight unavailable/unchecked` and authoritative `controller.invalid_proposal` after native completion. Do not label unchecked references as correct.
5. An absent ref at snapshot time can appear later, including from independent Worker completion; warning is provisional, never an automatic invalidation or admission veto. Final authority belongs to existing admission at the actual journal boundary.
6. Preflight failures/timeout may remove advisory feedback but **cannot revoke the structurally registered candidate**. Bound synchronous cost; do not turn an optional check into queued MCP tool execution or force a new Controller invocation. Avoid artificial extra tool quotas.

**Exit:** real MCP tool reply exposes addressable error before `end_turn`; same-turn corrected replacement succeeds; new observation arriving after warning is considered by final admission; no independent actions blocked or extra recovery budget consumed.

## 9. C18N.5 — Same-turn correction, finality and cross-invocation recovery

Preserve C18R registration-order explicit same-lineage last-wins, recoverable conflicts, observed invalid replacements, in-flight finalization barrier, close/abort and provenance. Discovery/preflight must never reorder or silently invalidate registered proposals. Native tools, skills, subagents and other MCP tools stay available after pending/invalid/conflicting proposal.

For a later Controller invocation, distinguish a **historical declared result** from a **current invocation proposalRef**. Historical body and exact rejection reference remain available through existing optional bounded context, without wholesale duplication or mandatory retrieval. Add generic guidance that `replaces` accepts only a `proposalRef` obtained in the current native invocation. No requirement to repeat or avoid past research; model chooses whether to revise or reconsider its result.

**Exit:** one correct first-turn finishing path for discovery → pending/warning → correction → `end_turn` → one authoritative admission; cross-turn invalid replaces stays addressable/correctable; cancellation/late/disconnect/unknown not promoted to success.

## 10. C18N.6 — Simplify ordinary MCP request accounting (approved deliberate trade-off)

**Decision:** stop using a cumulative count of successful **ordinary** `tools/call` as a Host model-action budget. The 64-call ceiling and its unbounded-for-long-turns completed-result cache are candidates for removal in this implementation, not merely for audit.

Required distinction:
- **Ordinary MCP requests** (external tools, context retrieval, evidence retrieval): retain only the state required to correlate/settle **currently active** requests. Release full request arguments, response Promises and results after completion. Do **not** retain the full history to recognize arbitrary late same-ID redelivery. If the same ID arrives *after* cleanup it may be processed as a new request; this is an explicitly accepted reduced transport guarantee, not claimed exactly-once. Identical simultaneous IDs may share one in-flight result; conflicting simultaneous IDs return a technical protocol error.
- **RO-owned `submit_decision`:** preserve the stronger existing Controller proposal identity, known-lineage replacement/conflict semantics, registration order, finalization and durable decision/dispatch guarantees. The C18R known rejected replacement on reused request ID must **not** silently admit an obsolete candidate. Retain only genuinely necessary control-plane identities/proposal metadata, not ordinary MCP bodies, and justify any accumulated technical bound from measured retained bytes or lineage requirements.
- **Durable RO Operation events:** preserve `controller.responded` idempotency, original attempt/content provenance, reservation/dispatch and crash-gap handling unchanged. This is not ordinary MCP replay caching.
- **No classification of external actions.** Same ordinary transport rule regardless of declared `effect`, tool name, input or actual consequences. No attempt to inspect workspace or external system to determine whether replay would be acceptable.
- **No Host automatic replay** after ambiguous outcome. A request independently initiated by the model remains permissible under existing authority.

Technical resource guarantees:
- Bound request and response bytes, active concurrent requests and retained in-flight memory; keep cancellation, authorization, close and native provider deadlines.
- Remove `maxToolCalls=64` once active-only request accounting is correct and tests establish bounded retained state across many sequential calls.
- Do not create a second service-specific count quota for discovery or a reserved number of calls for external tools.
- Review `maxDecisionCalls=128` and registry cumulative `maxPendingIntentBytes` separately. Prefer measured memory/CPU bounds and reclaim superseded payloads where safe; **never** remove a control bound by weakening proposal/finality guarantees. If 128 cannot safely be removed in this checkpoint, keep it as an explicitly documented remaining **technical** limit and record the blocking invariant and separate remediation. Do not claim all cumulative limits gone.
- Avoid introducing a new queue/scheduler or hanging the native agent when concurrency is full; bounded immediate technical feedback is acceptable if necessary. Do not enlarge existing hard limits blindly.

**Required RED/GREEN:** >64 sequential ordinary calls with released completed state and no spurious `budget` error; active duplicate same ID; active same-ID conflict; late completed same-ID redelivery permitted to run anew with explicitly documented limitation; large replies/413; high concurrency; cancellation; request failure; shutdown; RO control retransmit/replacement and C18R finality; bounded memory measurements for long sequential calls.

**Exit:** no artificial count limit on ordinary work; bounded actual live resources; reduced transport-level dedup scope is precisely documented; RO control and durable invariants unchanged.

## 11. C18N.7 — Native provenance and exact answer transport

Historical model/provider/Host observations remain distinguishable and addressable; prior native skill calls are historical facts, not proof of current skill availability. Do not create a Host-managed native skill catalog or claim a complete tool inventory.

Test `finalAssessment.answer` value from the **parsed incoming** MCP payload through Intent materialization, canonical Decision, durable `controller.responded` and final Assessment. Verify Unicode, Cyrillic, Markdown, backticks, escapes, multiline and large valid payload. Do not strip escaping, trim Markdown, check model-intended length from inaccessible thoughts or enforce user-task-specific character counts.

**Exit:** transport preserves the received string exactly; model-intended output is not a Host-verifiable property without a separate observed source.

## 12. C18N.8 — Contract/integration/fault coverage

Minimum cross-layer matrix (real application/bridge/ACP SDK, not hand-written duplicate coordinator):
- live native accepted observation, canonical identity and actual provenance;
- same tool multiple updates, equivalent duplicate and incompatible provider-local collision;
- live cursor concurrent append, pagination, read-by-ref, impossible/closed/foreign ref, capture truncation and retention/durability distinction;
- preflight unresolvable/known/ambiguous refs, findings temporary index, no mutation, unavailable preflight, later observation and parallel Worker completion;
- in-turn valid/invalid/corrected proposals, same-lineage explicit last-wins, unrelated conflict, reused control request ID, native `end_turn` racing a pending MCP request, cancellation/late events;
- general model instruction absent/available tool, alias collisions among built-ins and external tools;
- ordinary MCP 65+ and preferably hundreds of sequential calls without cumulative gate; active duplicates, post-completion redelivery, input/output byte pressure, concurrency, cancel and memory retention;
- legacy text/ControllerIntent text fallback, direct single-model answer with zero discovery calls;
- existing durable Decision, Worker unknown outcome, restart, no blind replay or lost-action duplication;
- provider-native tool/skill/subagent autonomy after warning and after proposal, ordinary mutable workspace, non-Git cwd;
- exact answer transport round trip.

Tests must not treat an incomplete native observation as proof of tool success or absence of captured observation as absence of provider capability.

**Exit:** all new RED fixtures GREEN and prior C16/C17/C17R/C18/C18R regressions preserved.

## 13. C18N.9 — Controlled real-native acceptance and measurement

On the operator's actual permitted environment repeat the native `changed` task, using pinned commit and same provider/model build, quantization, context size, effort, sampling, permissions, cwd, native skill configuration and invocation/resource settings. Compare historical C18R behavior against new C18N MCP and C18N text fallback where actually supported; include an independent provider/adapter when available.

Track independently:
1. **Technical:** real MCP tool selection, live canonical ref delivered and used, preflight result and correction before end_turn, final admission, durable provenance, actual missing/unknown outcomes.
2. **Model behavior:** relevant evidence selection, correct assessment, actual skill usage and user-task quality, unnecessary repeated native calls, mistaken references, string/Markdown length errors.
3. **Efficiency:** number of Controller invocations, accepted/rejected Decisions, tool calls (native vs MCP separately), proposal submissions, prompt bytes, latency and attributable usage. Do not attribute global llama.cpp server counters to a single operation without isolation.

Run repeat trials where feasible; a single success does not prove statistical performance. Also test skipping discovery, continuing native tools after warnings, late Worker observations, cancellation after live reference issuance, missing MCP capability, long ordinary MCP usage. No private prompt/model capture in Git. Native absence remains **UNVERIFIED**; native failure must not be relabeled as engineering pass.

**Exit:** controlled native evidence, or explicit UNVERIFIED plus reproducible operator instructions.

## 14. C18N.10 — Exact-SHA engineering closure, docs and executor handoff

Run actual required repository commands (check `package.json` and CI workflow first) under Node 24 / checkJs, root suites, ACP SDK, contract/integration/fault, Linux PTY, Nix flake/package/outside-checkout install and release check. Record actual exit codes, job links and exact implementation SHA. Never infer a PASS from an earlier SHA. Do not replace actual native acceptance with SDK fixtures.

Update affected normative documents **only upon implementation of behavior**: `docs/CONTRACTS.md`, `EXECUTION.md`, `CONTEXT_AND_RECOVERY.md`, `PROVIDERS_AND_CONFIGURATION.md`, `EXTENSIONS.md`, `DECISIONS.md` as needed; `tests/ACCEPTANCE_MATRIX.md`, `docs/roadmap/STATUS.md`, `IMPLEMENTATION_PLAN.md`, `NATIVE_ACCEPTANCE.md` and `CHANGELOG.md` for actual evidence. The present document is an approved **plan**, not an already-shipped product contract.

Executor report must state: actual HEAD and changed paths; architecture/owner and lifecycle matrix; choice of live API/cursor; how duplication of admission was avoided; exact ordinary vs control request-accounting guarantee; whether 128 control-call ceiling remains and why; test commands/exits; exact CI SHA; real native result or UNVERIFIED; residual risks and no master merge.

## 15. Acceptance checklist

- [ ] Real accepted live observation gets one stable canonical identity, preserving provenance and no false durability.
- [ ] Optional scoped live list/fetch exposes refs during the **same** invocation; historical context and cursors stay unchanged.
- [ ] Live pagination handles concurrent append without dropped/duplicated entries; no second observation store or journal.
- [ ] Discovery is not a native capability inventory, does not fabricate evidence or require direct tool usage to be mediated by RO.
- [ ] Model instructions are general; no filename/tool-call special cases or mandatory retrieval; empty `observationRefs` remains valid.
- [ ] Preflight is an optional bounded technical view, does not block registration, mutate reference indices or become authoritative admission.
- [ ] Corrected in-turn proposals admit once after trusted native completion; C18R finality/lineage/abort unchanged.
- [ ] Recovery separates historical Controller result and invocation-local `proposalRef` without forcing a strategy.
- [ ] Ordinary MCP completed request bodies do not accumulate; >64 sequential ordinary calls work without an arbitrary count cutoff.
- [ ] Weak deduplication of late, completed ordinary HTTP request IDs is documented; **no exactly-once promise** for arbitrary external tools.
- [ ] RO-owned `submit_decision` and durable Decisions/Actions retain their stronger original correctness; no semantic classification of effectful tools.
- [ ] Message/retained-memory/concurrency/timeout/authority remain technically bounded with precise errors.
- [ ] Native tools/skills/subagents and mutable workspace remain independent after discovery, warnings and pending proposals.
- [ ] Answer text is transmitted unchanged; no Host semantic validation or formatting.
- [ ] Full exact-SHA mandatory CI PASS; real native outcome separately PASS/FAIL/UNVERIFIED.

**Design summary:** RO provides trustworthy technical identities, scoped access and bounded advisory feedback; the model owns evidence interpretation and action strategy. Transport handles its live resources, not a cumulative quota of model decisions. Strong consistency is reserved for RO's own Decision/Action lifecycle.


## C18N-R — Corrective review implementation

The approved C18N-R follow-up corrects five concrete omissions without altering the C18N owner boundaries: a separate cumulative 32-call quota in the registered External ToolPort; repeated O(history + live observations) preflight scan; registration-time bans on valid built-in-colliding external IDs; missing live resume cursor after an exhausted snapshot; and a single oversized metadata record preventing directory traversal. RED evidence: [CI #45266076178](https://github.com/apathoid/role-orchestrator/actions/runs/45266076178), commit `1a53134dc3d44935a73645adc3ebdcfe3051a778`. Production fixes: `295499174be7f4475dc14b59bfa6c7b5bbe3e427`, [CI #45266687474](https://github.com/apathoid/role-orchestrator/actions/runs/45266687474) SUCCESS. Full corrective performance/native disposition and exact final-SHA evidence live in [STATUS](STATUS.md) and [acceptance matrix](../../tests/ACCEPTANCE_MATRIX.md).

Implementation uses no second persistent ledger or preflight admission: historical identity sets are built once, only newly accepted observations extend the invocation-local identity/alias index, and each decoded Intent gets temporary membership sets passed to mutating validators. The real External ToolPort has no call-count gate; permissions, receipt capture and unknown effects retain their owners. MCP naming is collision-safe from registration to live advertisement. `resumeCursor` supports later arrival; bounded `omittedMetadataFields`/indexed unavailable entries distinguish metadata representation limits from missing evidence. A real model's autonomous tool use and latency are still UNVERIFIED.
