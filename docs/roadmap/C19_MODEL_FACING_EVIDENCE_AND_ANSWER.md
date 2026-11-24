# C19 — Model-facing Evidence & Answer Clarity

**Status:** PLANNED, approved design after architectural review; implementation and C19 native acceptance UNVERIFIED. **Working branch:** `feature/controller-intent-deferred-admission`. **Source/review baseline:** `2650d327b01eddd5ed2939263ef73b803381be11`. Execute C19 before [C20](C20_OPTIONAL_INVOCATION_DEADLINE_AND_RESOURCE_DEFAULTS.md); separate implementation checkpoints and exact-SHA engineering acceptance. No master merge.

Read `AGENTS.md`, `.agents/REASONING.md`, applicable `.agents/engineering/`, [STATUS](STATUS.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md), [C18/C18R](C18_CONTROLLER_INTENT_AND_DEFERRED_ADMISSION.md), [C18N/C18N-R](C18N_LIVE_EVIDENCE_DISCOVERY_AND_RELIABLE_CORRECTION.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [EXECUTION](../EXECUTION.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [DECISIONS](../DECISIONS.md), [native procedure](NATIVE_ACCEPTANCE.md) and acceptance matrix. Verify actual HEAD/worktree, preserve unrelated changes. JS ESM/JSDoc/checkJs, Node 24, existing Nix/CI. These are development checkpoints, not runtime stages.

## 1. Motivation and evidence boundary

C18N-R engineering baseline passed full CI on `2650d327` ([#45269408086](https://github.com/apathoid/role-orchestrator/actions/runs/45269408086)). Operator-provided OpenCode ACP/Ornith experiments, analyzed in the planning conversation, reported:
- two Medium direct-result RO runs completed in one Controller invocation without mandatory retrieval;
- two Small RO runs reached the configured deadline; the mistaken use of byte rather than Unicode character counts was also reproduced without RO;
- additional experiment A (Small directly in OpenCode) completed after correcting its character-counting method;
- experiment B (Medium with explicit evidence request) used live list/fetch, submitted canonical refs and completed in one invocation. The six selected refs were reportedly three model messages and three nonterminal tool events; no selected ref was a completed tool result. The actual answer was a report of preparing the requested description, while the parsed submitted answer was preserved exactly through admission;
- experiment C (Small with a clarified native skill) completed, and independently corrected an invalid `replaces` reference within the same invocation. This is not a demonstrated correction after advisory evidence-ref preflight.

These observations are operator-supplied native evidence for specific scenarios, not controlled statistical A/B, proof of the exact runtime build, or blanket native PASS. Raw archives, private prompts and project sources stay out of Git. Record reproducible run metadata and sanitized fixtures as available. If exact build/fixture data cannot be independently established, retain that limitation. No C19 claim before implementation.

The task is to improve the model-facing information contract, not to fix model strategy. Native skill content, character counting and workspace investigation are outside RO runtime. The model owns evidence selection, sufficiency, task output, tools, skills and delegation.

## 2. Invariants and non-goals

- One model-owned coordination cycle, one accepted observation source and existing durable journal. No mandatory evidence retrieval, semantic scoring/filtering, automatic selection, ranking, grouping, Host-generated summary or evidence gates.
- Preserve provider-native tool/skill/subagent execution, direct workspace access, permissions, provider agnosticism, C18R proposal lineage/last-wins/finality, C18N-R ordinary MCP active-only accounting, canonical identity, advisory preflight, truthful late/unknown outcomes and no blind replay.
- Metadata is a technical representation of the received provider event, not a Host claim about tool semantics or task success. A title authored by a model and relayed by a provider remains provider-reported, not Host-verified.
- No universal tool ontology, catalog, new index/cache/store, second admission, new provider-specific Core branch, provider-native feature suppression or mandatory capability.
- No semantic validation, substitution, formatting or rewriting of the user's answer by Host. The answer string is preserved exactly after parse.
- This stage does not change resource defaults or timeouts. C20 is separate.

## 3. C19.0 — Baseline and RED fixtures

Inspect actual sources and ownership:
- `src/core/observation.js` (AdapterObservation, ProviderObservation, Observation, decoder, receiveProviderObservation, provenance), `src/core/ports.js`, persistence decoder and historical context projection.
- `src/adapters/acp/provider.js`: current native `tool_call/tool_call_update` handling and existing `mergeToolCall`; status and native event type already appear inside opaque captured value. Determine which fields are actually reported, which are missing and which are inherited from earlier updates.
- Codex CLI JSONL adapter and existing structured native records; all other ProviderPort implementations and extension boundaries.
- `src/application/orchestrator.js` providerReports/content equality and canonical ref ownership; `src/application/evidence-identity.js`; `src/application/live-evidence.js`; context fetch/list, capture and persistence.
- ControllerIntent MCP/text and legacy Decision instructions, prompt renderer and final response paths.

Record actual field sources, lifetimes, existing size limits, representation costs and failure behavior. Add sanitized RED fixtures demonstrating that an accepted native start/update/completion cannot be distinguished by useful directory metadata today and that the general answer contract lacks the clarified semantics. A fixture can demonstrate prompt contract, not prove real model compliance. No need to manufacture a model failure in production.

## 4. C19.1 — Optional source-preserving native observation metadata

Extend the existing observation contract with a small optional technical record; choose names/types after reading existing contracts. Illustrative only:

```json
{
  "ref": "evidence:<canonical>",
  "source": "provider_reported",
  "completeness": "complete",
  "native": {
    "eventKind": "tool_call_update",
    "nativeToolCallId": "<reported-id>",
    "title": "<reported-title>",
    "status": "completed"
  }
}
```

Optional event kind, native tool identity, actual tool name/kind/title/status may be carried when present and meaningful in that provider's native contract. Preserve native string values; do not map ACP/Codex/custom types into invented common categories. No required metadata completeness. Generic structural validation/normalization is allowed, semantic interpretation is not.

Adapter owns extraction from known typed native events; application/Core owns source attribution and technical validation. Do not parse arbitrary observation body, tool command or reasoning at Host to infer these fields. Prefer existing adapter state where it is already authoritative for observed metadata. For any field inherited from a previous event of the same native call, either omit it or explicitly distinguish inherited metadata from fields actually reported by the current event. Do not synthesize a missing completion/status or imply that inherited title was newly reported. An omitted optional field is not an error.

Freeze/snapshot the metadata at acceptance using existing observation construction and decoder boundaries. Never mutate older observations when a later event arrives. Repeated delivery of equivalent accepted native reports must retain existing identity/equality behavior: adding metadata must not make a duplicate conflict merely because adapter state changed since initial capture. New native updates remain new observations under the existing contract. Keep `providerEvidenceRef` and provenance unchanged; no new dedup protocol. Prevent untrusted raw model payload from manufacturing Host-observed metadata/provenance.

Preserve original payload and its capture completeness. `completeness: complete` means complete capture of that observation, not completion/success of a tool, sufficient evidence, or task success. Provider-reported status is only the state reported by that provider for this record. Existing native IDs may be reused only according to actual source contract.

Support observations without metadata, including existing stored schemaVersion 1 records, and providers with partial or no fields, without backfill or a migration subsystem. Update relevant decode/serialize/restore/context projections and JSDoc; avoid a new schema/version if an additive optional field suffices. Metadata must not prevent accepting an otherwise valid observation: handle invalid/overlarge optional values with accurate omission/capture diagnostics, retaining original permitted evidence and existing identity. Do not silently promote incomplete metadata to complete.

**Exit:** actual adapter event -> accepted immutable observation -> normal commit/reopen; original observation identities and provenance preserved.

## 5. C19.2 — Live and historical model-facing projection

Expose available metadata through existing `evidence_list` and `evidence_fetch`, and through appropriate existing historical context representation/retrieval. Keep a single accepted source; no extra durable writer, directory index, payload copy cache or semantic summary. Do not force eager history retrieval or enlarge Controller prompt wholesale.

Baseline live limits: 12 records/page, 24 KiB page, 1536 bytes/item, 16 KiB fetch chunk. Preserve these initially. Before expensive JSON serialization of optional large strings/arrays/objects, apply bounded representation. New fields must not displace the canonical ref, source, completeness or already representable essential provenance. Preserve C18N-R `omittedMetadataFields`/positional gap contract: distinguish absent provider field from omitted due to bound; mark precise omission at a useful granularity without unbounded omission markers. Preserve full accepted observation bodies under existing capture/retrieval contract; projection omission is not evidence loss. Do not render a formerly accessible observation inaccessible just because of new optional fields. Keep actual encoded envelope sizes, Unicode and existing limits safe. Do not automatically raise budgets to hide regressions.

Use append-only live cursor, `resumeCursor` even on empty/exhausted page, `nextCursor` only for available following entries; no change to historical revision/index semantics or current tool-name collision handling. Pending, in-progress and terminal events all remain visible if accepted; no preference by state or title.

Measure directory size, field omissions and retrieval call/byte costs relative to baseline. A benefit in model selection/latency is a hypothesis until controlled native measurements.

**Exit:** bounded directory gives the model useful technical distinctions among native events without reducing existing access or imposing retrieval.

## 6. C19.3 — General observation guidance

If needed, add one short provider-neutral explanation at the existing observation/retrieval instruction owner, not a second repetitive prompt section:

> Observation completeness describes capture completeness, not tool success or evidence sufficiency. Native event metadata, when available, reflects provider-reported activity. Independently determine which observations are relevant to your claims and assessment.

Only advertise fields/capabilities actually available via delivery path. Keep existing optional retrieval, empty refs, explicit uncertainty and no invention of refs. Do not require completed observations, a minimum citation count, extra fetches, or citations in every answer. Intermediate observations and model messages can be relevant; Host does not decide.

## 7. C19.4 — Actual user-facing answer

Clarify the existing model-facing Assessment/Decision/ControllerIntent instruction (actual field name for each supported delivery path):

> The Assessment answer is the actual user-facing response. Provide the requested result directly, including its applicable content and formatting requirements, rather than merely reporting that it has been prepared. When the request is for an action or an external artifact, provide the appropriate outcome, artifact references and material limitations.

In ControllerIntent this is `finalAssessment.answer`. Avoid duplicating the instruction across prompt layers; ensure MCP, text and legacy Decision all receive correct guidance. Keep prompt changes concise, generic and independent of user language/task/provider.

Do not change the answer schema, decoder, finality/admission, native final-message contract or exact string presentation. Do not copy native message/file content into answer, demand artifacts for direct-text tasks, enforce length/sections, infer intended answer or automatically ask for a correction. User request for an action may legitimately be answered with the outcome, references and limitations.

## 8. C19.5 — Engineering regressions

Use actual production paths in addition to unit fixtures:
1. Native start/update/completion and status-less updates; reported strings unchanged, unknown/missing fields absent; no later-status contamination, truthful inherited metadata if used.
2. Stable ref/provenance and immutable repeated observation; duplicate-equivalent vs real conflicting reports; existing late/cancel/unknown and journal identity unchanged.
3. Decode/round-trip/reopen new optional fields and pre-existing observations; legacy providers/fixtures without fields still work.
4. Real ACP SDK native event -> list -> fetch -> model-authored Assessment -> final admission -> durable history; other real adapter structured events if available; historical context retrieval and exact canonical ref.
5. Metadata oversized title/provider-specific field, escaped/Unicode strings, consecutive large entries, pagination/resume and explicit omission, full response size, no loss of prior provenance or access to subsequent records.
6. MCP built-in name collisions, >64 ordinary calls, preflight reference identity, optional retrieval, direct completion without new fields and native tools continuing after a pending/warning proposal.
7. Correct answer instruction in each delivery path, exact string round-trip with Unicode/Markdown/escapes; partial/unresolved and artifact/action cases remain legal. No semantic rejection of a valid submitted string.
8. Compare prompt/directory byte sizes and representative projection costs. No flaky hard latency threshold.

Run existing C18/C18R/C18N/C18N-R regressions. Do not change tests merely to hide an unintended contract regression.

## 9. C19.6 — Native verification and closure

Use [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md) and operator-approved real environment, exact build/config/model/skill/cwd/permissions/context/effort, repeated comparable runs if feasible:
- Direct result with clarified native skill, verify actual requested content in submitted answer, format, relevant source accuracy, natural tool selection and invocation counts.
- Explicit user evidence request: inspect new directory fields and selected references; assess evidence relevance outside Host, compare list/fetch counts, bytes, latency and actual answer vs baseline. No mandatory retrieval when user task does not request it.
- Natural in-turn correction after advisory reference warning if observed; distinguish from structural `replaces` correction. Use deterministic engineering fixtures for faults; no production prompt instruction to intentionally fail.
- Independent provider where available and native subagents without new gates. Record coverage gaps as UNVERIFIED. Native correctness and transport success are separate.

Run mandatory exact-SHA Node24/checkJs/foundation/core/contract/integration/root/npm/ACP SDK/PTY/Nix/package/install/release CI. Update applicable normative docs, acceptance matrix, CHANGELOG and STATUS based on actual shipped behavior; document decisions without duplicating normative text. Record code SHA and final documentation SHA CI separately; do not infer later PASS. Native tests are not replaced by synthetic engineering tests. No raw private logs committed.

**Executor exit report:** baseline/final SHA, changed files, owner/source/lifetime and actual optional fields per adapter, size/omission and duplicate semantics, answer instruction paths, RED/GREEN results, actual measurements, exact-SHA CI, native evidence or UNVERIFIED, remaining risks. C19 is complete only when engineering criteria are met; then start C20 from verified actual HEAD. No master merge.
