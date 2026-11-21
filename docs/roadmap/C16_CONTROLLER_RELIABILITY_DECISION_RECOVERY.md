# C16 — Controller Reliability & Decision Recovery

**Repo:** `apathoid/role-orchestrator`  
**Branch:** `feature/interactive-ux`  
**Baseline HEAD:** `22d06008d74616acb9be04645aaccab7f986853e` (pre-implementation; original planning baseline `465e82aa5e16f83459e8b41a38fe8dc3411b66cd`)  
**Status:** Engineering code/tests implemented on `feature/interactive-ux`; exact-final-SHA CI pending, native controlled quality comparison UNVERIFIED. Actual outcomes and CI provenance are in [STATUS](STATUS.md). This file remains the approved scope/acceptance plan, not a substitute for measured verification.  
**Scope:** Controller user-turn delivery, Decision v1 reference, error diagnostics, bounded correction 5/10. **No active-operation steering.**

## 1. Purpose and baseline observations

Improve Controller reliability without redefining model decisions, restricting the provider-native environment, or adding a Host-managed workflow.

**SUPPORTED by baseline code:**

- `src/application/orchestrator.js` supplies `objective: state.request.text` for Controller, including following `operation.continued`. This is the *original* request, not necessarily the user's latest instruction.
- `operationHistory()` in `src/application/controller-context.js` includes subsequent messages with user provenance and request IDs.
- `compactContext()` in `src/application/context-bundle.js` already treats literal user messages as mandatory. Do **not** assume the latest user message is removed by optional history truncation; verify actual Invocation bytes.
- `drive()` records `controller.invalid_proposal` and uses the common invocation budget for corrections; no dedicated 5/10 bounds exist.
- Current `host:decision-error` presents an immediate correction, but after a new user turn the former rejection is not automatically presented as the current correction.
- Technical waiting, `resume(operationId,input)`, `controllerFailureWaiting()`, independent Worker recovery and native tool/skill paths already exist.

**HYPOTHESIS:** a short corrected Decision prompt may help `llamacpp/small`. It must be measured, not accepted solely because parser tests pass.

## 2. Read and preserve project contracts

Before coding read current `AGENTS.md`, `.agents/REASONING.md`, relevant `.agents/engineering/`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/DECISIONS.md`, this roadmap, `tests/ACCEPTANCE_MATRIX.md` and touched code/tests. Record actual HEAD and CI; reconcile plan examples with latest contracts.

**Model owns semantics:** user intent, task changes, requirements relevance, planning, tool/skill selection, delegation, assessment and quality. Host neither classifies a message by text/status nor merges turns into a new synthetic objective.

**Host owns technical truth:** request/attempt identity, order, provenance, permission/authority, byte budgets, validation/admission, durable errors/recovery, cancellation and unknown effects.

**Provider/model owns native execution:** available tools, skills, project files, scripts, terminal and subagents. Do not require registration of a native capability in Host Catalog, create a virtual filesystem, sandbox, preflight environment inference or a new filesystem runtime. No Git assumptions.

No second scheduler/state machine; no mandatory review/fix sequence; no provider-specific conditions in Core/Application; no forced compact history/retrieval; no Host-generated Decision/Assessment/finding/plan; no automatic model/effort selection; no JSON regex extraction/repair or weakening `decodeDecision()` and admission; no hidden replay of unknown effects. Direct answer with zero Workers is valid.

## 3. Ownership/source of truth

| Concern | Owner / authoritative data |
| --- | --- |
| Turn sequence | Request + `operation.continued` in existing Operation journal |
| What a new message means | Controller/model |
| Context presentation and completeness | Application, journal ContextItems and ContextPort |
| Accepted Decision / Action | Existing decoder, admission and committed journal |
| Technical rejection / retry count | `controller.invalid_proposal`, `controller.responded`, `operation.continued` |
| Permissions/native tools/skills | Real provider execution and trusted authority |

Avoid parallel persisted ledgers or duplicated authoritative user message bodies.

## 4. C16.0 — Baseline and RED (P1)

1. Record current branch HEAD, dependencies, available CI, relevant limits and actual Controller Invocation.
2. RED scenario A→B: A investigates the latest commit; after `finished`, B asks about an unrelated Undo/Redo focus defect. Inspect actual `objective`, delivered ContextItems/provenance and model result.
3. Separately test clarification after `waiting:question` and a user message changing the task instead of answering.
4. Simulate repeated malformed/invalid Decisions through synthetic ProviderPort, with accepted decisions interleaved; record events, attempts and budget changes.
5. Distinguish absent message, unclear attribution and incorrect model interpretation. Reproduce observed behavior rather than asserting an unproven cause.

**Exit:** reproducible pre-change tests separate turn delivery from Decision formatting.

## 5. C16.1 — Explicit user turns, no Host intent classifier (P1)

### Required behavior

For each Controller Invocation expose technical identities of (a) the original request and (b) the *latest accepted* user turn, retaining all user messages, original references, provenance, journal order and existing question correlation.

Prefer a small pointer/identity inside the existing `host:invocation-context` to the **original** user ContextItem. Do not copy its full text into a second authoritative source. Preserve original `Request.text` as original task; if `Invocation.objective` remains that text, describe its meaning clearly to the model: it is the initial request, not an instruction to ignore later user messages.

The latest turn is a **chronological fact**, not Host-selected active objective or priority. Controller determines whether it is a clarification, correction, changed task, unrelated question or answer to a pending question. `questionId` is technical correlation, not proof of semantic compliance.

Do not rewrite original messages, `Request.userConstraints`, authority, historic Decisions or Worker objectives. Preserve provenance and let the model interpret subsequent instructions within actual permissions.

### Context and limits

Existing `compactContext()` already keeps literal user messages mandatory. Preserve that property; do not invent a new user-turn size cap, Host summary, silent truncation or forced ContextPort fetch. Keep optional history bounded with honest completeness markers and retrievable original records.

A request exceeding the actual provider context window is a separate transport/resource issue: do not claim that text was delivered in full when it was not, and do not smuggle a new policy for hiding user instructions into C16.

### Cases

Initial request; independent B after `finished`; additional context after `finished`; answer after `waiting:question`; complete task change after `waiting:question`; new input after `waiting:technical`; restart without input; long journal and long user message; stable refs; repeated request IDs; ACP `session/load` and replay.

Keep current ACP behavior for `continueOperationId`, `newOperation:true`, `supersedeOperationId`. A concurrent message while `active` is **not** silently appended (steering explicitly out of scope).

**Owner candidates:** `src/application/orchestrator.js`, `src/application/controller-context.js`; only if necessary `src/adapters/invocation-prompt.js`.

**Exit:** user chronology is visible and accurate; no Host intent classifier, no duplicate transcript entry, no priority imposed on latest text by Host.

## 6. C16.2 — Minimal Decision v1 model reference (P2, experimentally justified)

- Keep `src/core/contracts.js` and current admission authoritative. `src/application/decision-instructions.js` is documentation for the model, not a new schema; `src/adapters/invocation-prompt.js` only renders it.
- Use a concise and accurate field description (JSDoc-like prose allowed **outside** JSON), actual field dependencies and **one** valid JSON example of direct `finalAssessment`. The example must decode and be marked *shape only*, not a strategy, required status or instruction to avoid delegation.
- Distinguish Controller Decision envelope from `finalAssessment.answer` (the latter is an unmodified string holding user-requested Markdown, Unicode or JSON text). Native thoughts, plans, tool calls and Worker outputs are **not** bound to Decision JSON.
- Keep full expressive set: direct answer, delegation, wait policy, question, findings, cancellations and `nextController.continue` with optional context retrieval/reasoning. Do not add many examples or long lists of hypothetical model failures.
- No provider-specific schema, simplified small-model Decision, extra validator, regex fence stripping, or forced JSON from intermediate/native content. Reference must be included once, not repeated.
- Compare on real models (C16.6). If first-decision acceptance improves but quality/tools/delegation decline, revise/rollback this prompt change independently.

**Exit:** decode example passes, all existing valid forms accepted, and no workflow/strategy has been added to a transport description.

## 7. C16.3 — Bounded, actionable INVALID_PROPOSAL diagnostics (P2)

Continue using existing `FieldError` as validation truth and `host:decision-error` as immediate correction. Provide only *technical* facts: rejected `attemptId`, category/stage, `path`, `expected`, consecutive identical count, total rejections in current user turn, and thresholds.

Category from actual boundary: `invalid_json`, `non_object`, `depth` (text parser), `schema_invalid` (decoder), `admission_invalid` (admission/ref checks). No inferred intent/meaning or words such as “stop checking Git”.

If needed for durable categorization, minimally extend the existing `controller.invalid_proposal` event metadata while preserving `reason: FieldError` and journal compatibility. No separate error store/table, unbounded rejected-output retention or second validator.

Do **not** count timeout, cancellation, disconnect, provider `PROTOCOL_ERROR` or no declared result as a rejected Decision.

On new input after a decision-recovery technical wait, make the **last durable rejection** accessible as historical technical context, clearly separated from the new user message. It is not a fresh failure of the new turn. If rejected provider output exists with trustworthy observation ref, allow normal context access; do not copy full output into each prompt.

**Exit:** rejection diagnostics remain truthful after restart/resume and identify the failed validation stage without semantic Host interpretation.

## 8. C16.4 — Bounded Decision recovery 5/10 (P2)

| Limit | Count |
| --- | ---: |
| Consecutive identical technical failures | **5** |
| Total rejected Decisions during one accepted user turn | **10** |
| Extra invocations above operation `maxInvocations` | **0** |

Limits apply **only** to invalid Controller Decisions; never to correct Decisions, native tool calls, Workers, legitimate model reasoning steps or normal provider failures.

Compute an identical failure signature from structured category + `FieldError.code` + `path` + `expected`; normalization may remove objectively irrelevant technical details, but never compare original natural-language model outputs.

A different rejection resets only the consecutive series. An accepted `controller.responded` also resets consecutive series but not total. New accepted `operation.continued` starts a new count period; initial Request starts the first. Recovery/restart/`operation.recovered` without input does **not** reset counts. Durable Operation journal is the sole source; duplicate outcome must not count twice.

On the **5th identical** or **10th total** rejection, after committing `controller.invalid_proposal` stop automatic Controller retries and transition to existing `operation.waiting(kind=technical)` with `INVALID_PROPOSAL` and actual Controller attempt correlation (`actionId === attemptId`), plus `resource: controller_decision_recovery` when valid.

**Crash gap:** after restart, inspect durable rejection count **before another Controller reservation** so a crash after the last rejection but before waiting cannot dispatch an extra Controller invocation. No new scheduler or separate state machine.

**Independence:** `controllerFailureWaiting()`, `runRecoveredWorkers()`, late outcome recording, independently accepted actions and unknown-effect protections remain operative. No automatic Worker cancellation/replay; invalid Decision additions are not dispatched; no invented final Assessment.

**User resume:** `resume(operationId,input)` with an accepted new message leaves waiting and resets only turn-local counters. Budget and authority are not replenished; if maxInvocations is exhausted no “free” Controller attempt. Message meaning (resume old task, additional context, new task) belongs to Controller. Plain technical `resume()` without input cannot bypass the 5/10 limit.

**Exit:** thresholds survive crashes and duplicates, Controller correction halts at the specified attempt, independent legitimate work continues.

**Owner candidates:** `src/application/orchestrator.js`, `src/core/operation.js` (only needed contract detail), `src/application/controller-context.js`.

## 9. C16.5 — Integration and regression matrix

Prefer existing suites in `tests/integration/controller-contract.test.js`, `resume.test.js`, `context-continuity.test.js`, `host-acp.test.js`, `tests/contracts/acp-provider.test.js` and other directly relevant tests.

**Context:** A→B after finished; clarification and new task after question; additional context; waiting technical; restart without new input; latest user reference preserved with long journal; no Host semantic classification; `session/load`, request-id dedup and provenance.

**Decision:** invalid JSON→correct Decision; non-object/depth/schema/admission errors; structured ProviderResult bypasses text heuristics; native tools before final Decision; valid direct answer; delegation and continue; exact `finalAssessment.answer`; invalid Decision cannot dispatch additions.

**5/10:** same technical error ×5; different errors ×10; signature changes; accepted Decision between failures; new turn vs recovery; budget exhausted; duplicate outcome; crash between rejection/wait; concurrency/cancel/late result; independent Worker; unknown effect without replay.

**Capability transparency:** existing native tools/skills/subagents/scripts/project files available without a Host Catalog registration, Git, or environment-specific assumption. Test via supported provider fixtures and actual provider where possible, not by adding production virtualization.

Map cases to existing A05/A06/A21/A24 and other directly affected acceptance rows; new IDs only for genuinely new contractual requirements.

## 10. C16.6 — Controlled native quality comparison

Compare three configurations on same tasks, model, provider, settings, tools, permissions, budgets:
1. Baseline.
2. C16.1 + C16.3 + C16.4 with **old prompt**.
3. Same Host fixes + new C16.2 prompt.

Primary: real OpenCode ACP and failing `llamacpp/small`; include a stronger model as control when accessible. Tasks: direct answer, native repository exploration, delegation, multiple Decisions, A→B, clarification, technical wait, incomplete context.

Track first Decision acceptance; failure categories; attempts; time/token usage (unknown permitted); waits; native tool/Worker counts; actual task quality/completeness; user-context correctness; unexpected external effects. JSON acceptance is **not** a proxy for task quality. Keep or revert C16.2 based on quality, not solely formatting success.

Mark independently: IMPLEMENTED, ENGINEERING VERIFIED, NATIVE VERIFIED, UNVERIFIED. Do not present synthetic tests as real Zed/provider acceptance.

## 11. C16.7 — Specification, CI and closure

After implementing actual behavior, update only applicable `docs/CONTRACTS.md`, context/recovery specification, `docs/DECISIONS.md` or ADR, `tests/ACCEPTANCE_MATRIX.md`, `docs/roadmap/IMPLEMENTATION_PLAN.md`, `docs/roadmap/STATUS.md`, `CHANGELOG.md`. Do not duplicate normative text and do not pre-label C16 as PASS.

Run full Node 24 root tests, strict checkJs, contract/integration, ACP/CLI, specification guards, Nix/package/release checks at exact final SHA. Record CI URLs, provider versions and native gaps. Historical CI does not certify later SHA.

**Order:** C16.0 RED → C16.1 → C16.3 → C16.4 → C16.2 A/B → C16.5 → C16.6 → C16.7.

**Done means:** user turns faithful, no Host intent/workflow; Decision v1 expressive and provider-neutral; correction and 5/10 durable; independent Workers/cancel/unknown effects safe; no forced native-tool/skill restrictions or artificial environment; full engineering checks at final SHA; native quality evidence and limitations recorded.

**Known risks:** latest message cannot become Host-authoritative replacement objective; existing mandatory user messages can exceed actual provider window; one direct-answer example may discourage delegation; technical waiting must not freeze independent work; user steering during `active` remains a separate future capability.

**Executor starts:** inspect latest `STATUS.md` and this plan on current checkout; record exact baseline and begin C16.0 RED, without mixing code changes and prompt optimization.