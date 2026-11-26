# C18 — Controller Intent & Deferred Decision Admission

**Status:** ENGINEERING CI PASS on C18R code/doc SHA `fab92fd037a0169e9e12ac6706801c3c6d4d1666` ([CI #45017738925](https://github.com/apathoid/role-orchestrator/actions/runs/45017738925)); NATIVE UNVERIFIED. Subsequent commits require a fresh exact-SHA check.  
**Branch:** `feature/controller-intent-deferred-admission`  
**Starting baseline:** `feature/controller-reliability` @ `836c379515202e5c9dfdf8304ed8aede981f6093`  
**Priority:** P1 Controller reliability / model autonomy, P2 transport capacity and native behavior  
**Owner:** implementation agent; no master merge without explicit instruction.

## 1. Goal, actual evidence, and non-goals

Replace the Controller's need to manufacture the entire technical Decision v1 with a **model-owned `ControllerIntent`**, deterministically completed with **Host-owned technical binding** to the existing canonical Decision v1. Support one common intent through native text/structured results and, where negotiated, invocation-scoped MCP `submit_decision` with **in-turn structural correction** and **deferred admission**. Improve end-to-end task quality, controller reliability and avoidable cost—not merely the percentage of JSON-shaped replies.

Prior operator R1-E1/E2 tests with OpenCode ACP 2.3.0 and local `llamacpp/medium` supported minimal/full submissions, a deliberately induced structural correction within **one ACP `session/prompt`**, explicit conflict handling and cancellation/missing-result behavior in a standalone harness. Those tests did **not** validate full RO lifecycle, the quality of real delegated work, root-agent provenance, durable admission or statistically prove MCP faster. Some experimental runs unexpectedly called a provider-native image generation tool. Preserve this distinction throughout C18; do not import the standalone harness as a second coordinator.

**Non-goals:** immediate/incremental Action dispatch from each tool call; second scheduler or persistent proposal log; agent root/subagent attribution guarantees not exposed by generic transports; active-operation steering; workspace/Git/fingerprint integrity gates; mandatory evidence freshness/reconciliation; Host semantic evaluation; mandatory provider-specific MCP; extra approval rounds; new compulsory role/workflow stages.

## 2. Read first; preserve architecture

Read current `AGENTS.md`, `.agents/REASONING.md`, applicable `.agents/engineering/`, `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/EXECUTION.md`, `docs/CONTEXT_AND_RECOVERY.md`, `docs/PROVIDERS_AND_CONFIGURATION.md`, `docs/EXTENSIONS.md`, `docs/DECISIONS.md`, `docs/roadmap/STATUS.md`, `docs/roadmap/IMPLEMENTATION_PLAN.md`, `docs/roadmap/NATIVE_ACCEPTANCE.md`, `docs/roadmap/C17_CONTROLLER_CONTEXT_AND_DECISION_RELIABILITY.md`, and `tests/ACCEPTANCE_MATRIX.md`. Reconfirm exact HEAD and code paths before editing. Preserve unrelated dirty-worktree changes, native tools/skills/subagents, the one Controller loop, worker independence, provenance, permissions, retry/unknown effects, StateStore single-writer/CAS **only for RO-owned state**, C16 recovery thresholds (5 consecutive identical / 10 total final rejected Decisions), C17R source identity, and provider-agnostic Core.

Host can validate **structure, trusted invocation identity, live technical authority, references and existing admission contracts**, not task strategy, semantic evidence relevance, model reasoning or repository integrity. No requirement for Git, clean tree, immutable working directory, reread/review or forced skill/tool use. Technical failures should be **addressable and correctable within the native turn** where possible, never turn into artificial host-induced blocks on the model's native work.

Existing ownership points to review: `src/core/contracts.js` Decision v1; `src/core/ports.js` ProviderResult; `src/application/decision-instructions.js` and `src/adapters/invocation-prompt.js` text framing; `src/adapters/mcp-bridge.js` invocation-local MCP; `src/adapters/acp/provider.js` native completion; `src/adapters/cli/codex-launch.js` headless path; `src/application/orchestrator.js` result handling/admission; `src/application/evidence-identity.js`, `src/application/decision-recovery.js`, and `src/core/finding.js`.

## 3. Target contracts and ownership

### 3.1 Model-owned `ControllerIntent`

The model chooses any existing legal combination of `additions`, `cancellations`, `acceptedActionIds`, `waitPolicy`, `clarification`, `finalAssessment`, `findings`, `nextController`. This is **not a tagged strategy enum or required workflow**. Preserve all expressivity of Decision v1: delegate profile/role, skills, required capabilities, objectives, expectedResult, continuationReference, `dependsOn` and its kinds, `retryOf/retryBasis`, wait target kinds, next reasoning and contextRequest refs/cursors, findings/supports/supersedes, Assessment overall/requirements/status/references/uncertainties/answer. Direct answer with no Worker is first-class.

The model owns `actionId`, `findingId`, `requirementId` and their cross-references, as well as evidence refs, action semantics, assessments, text and status. Do not fabricate or renumber these to hide errors. A failed reference check is technical, not a Host judgement on evidence relevance.

### 3.2 Trusted binding

Host supplies only `schemaVersion`, **stable** `decisionId`, actual `operationId`, original **observed** `contextCursor` from the dispatched Invocation, `author` on model-attributed findings/assessment from the selected Controller profile, plus pre-defined semantically empty array defaults where absence unambiguously means none. Provenance means content attributed to the Controller invocation, **not proof the root native agent rather than a native subagent authored the reasoning**. `attemptId` remains a trusted correlation/receipt field; do not silently add it to Decision v1.

Never supply semantic defaults: no invented `overall`, `requirement.status`, `answer`, `waitPolicy`, `retryBasis`, `nextController.continue`, strategies, profiles or dependencies. Preserve model strings byte-for-byte through UTF-8/JSON semantics, including Markdown and Unicode. Explicit `null` is not implicit omission; reject unknown fields and model attempts to set Host-owned identity with field-specific errors. Materialize a **new whitelisted object** (not a spread overwrite of untrusted payload), run the existing authoritative `decodeDecision`, and preserve the existing admission rules; do not add Host semantic checks.

Optional empty arrays may be filled only after establishing per-field equivalence (e.g., additions/cancellations, Action dependsOn/contextRefs, Finding supports/uncertainties, Assessment and each Requirement's observationRefs/findingRefs). Empty evidence lists are *absence of references*, never a Host verdict of truth or completion. Document each default explicitly.

### 3.3 Generic adapter result

Choose the Controller delivery mode before sending an invocation, based on **actual supported/negotiated capabilities**; never infer it from the content of the final model text or a provider name. Keep a distinct, typed ProviderPort result for: valid intent; clean terminal with no submission; ambiguous/invalid final intent; provider/protocol/timeout/cancellation failure; and proof of originating output/receipt where available. No MCP wire types in Core. Keep legacy Decision v1 provider behavior until an explicit negotiated migration path is verified; do not break existing third-party adapters.

**In MCP mode a valid submission followed by a blank or ordinary native final message is valid**, and the text-only `parseDecisionText` must **not** run on that final message. Conversely, clean `end_turn` without a submission is a completed Controller turn with an absent/invalid declared Decision, **not a provider disconnect**. A technical inability to determine which submitted candidate is final is **not** automatically a model parser error. Preserve actual ProviderResult/outcome dispatch certainty and C17R output identity: an MCP tool receipt is not the same observation as the agent's final textual message.

**Fallback:** before prompt dispatch, if MCP is unnegotiated/unavailable, use a supported native structured/text ControllerIntent route without hidden second provider invocation and without reducing other requested capabilities. After possible provider dispatch/effects, **do not silently retry** through another transport. Unsupported optional MCP does not render the entire Controller unavailable. `output.decision` support must not be confused with verified structured enforcement or MCP availability.

## 4. Pending proposal and finality

`submit_decision({intent, replaces?})` is an invocation-scoped **proposal-only** tool. Its receipt means syntactically/structurally received or rejected, **never Actions admitted, dispatched, or task completed**. A valid proposal becomes admissible only after the trusted native turn completed normally and a single unambiguous candidate was established. The model is not required to call an extra `finalize` or send an additional end-of-turn JSON message.

A **single invocation-local source of truth** holds bounded proposal metadata/values, observed invalidations/conflicts and dedup for MCP request IDs. No durable second proposal journal, automatic polling or second Controller scheduler. Intermediate invalid submissions do not create `controller.invalid_proposal` or consume another Controller invocation; their correction remains within the existing deadline/tool limits. An invalid **final** Decision entering existing admission retains journal-based 5/10 recovery, without a free retry budget.

### 4.1 Exact submission rules

| Input sequence | Rule |
| --- | --- |
| valid A → native completion | A is the candidate for existing admission |
| invalid → corrected valid | corrected valid is candidate, same native turn |
| valid A → unrelated valid B without `replaces` | **recoverable conflict**, no implicit last-wins |
| valid A → conflicting B → valid C with explicit `replaces:A` | C can resolve conflict before native completion |
| valid A → valid B(`replaces:A`) | B is candidate |
| valid A → concurrent valid B(`replaces:A`), C(`replaces:A`) | **temporary explicit last-wins**: later *reliably registered valid replacement* wins; no extra proposal CAS/versioning |
| valid A → observed invalid replacement of A | no silent fallback to old candidate; correctable in same turn |
| valid A → observed later valid correction of the replacement | corrected candidate considered normally |
| request rejected by native MCP client before reaching any trusted RO observation | no observed attempt; do not guess from native thoughts/text |
| valid candidate → cancel/disconnect/unknown end | no admission |
| late submission after finalization | cannot change result |
| `end_turn` without valid candidate | no Decision, bounded existing recovery/technical outcome |

A replacement references a known proposal within the same invocation/lineage, even when the source has already been superseded or an observed invalid replacement needs correction. Explicit `replaces` is never treated as permission to change the task, authority or previous durable Decision.

**Registration order** is the sequence at which the trusted boundary accepted a complete, attributable MCP `tools/call` request, **not** asynchronous validation-completion, Promise resolution or HTTP response order. Apply the order deterministically for competing explicit replacements. The model must receive bounded, specific errors; conflicts/invalidations must remain **correctable before the native turn ends**, not become permanent terminal flags that force a new Controller invocation. Track request-id dedup separately from payload equality; repeated same request is not a fresh proposal.

For an observed invalid replacement, determine whether `replaces` is technically reliable. Invalidate the applicable earlier candidate when it is; when not observable, do not infer an attempt. Do not parse hidden reasoning or arbitrary provider texts to reconstruct missing MCP calls. Define the minimal correction rule that avoids stale admission without making unrelated tool errors invalidate proposals.

### 4.2 Atomic finalization boundary (P1)

Define an explicit **linearization boundary** between MCP receipt registration and trusted native completion. On completion, stop registering *new* submissions; account deterministically for **all complete attributable calls already registered before the boundary**, even if handler promises have not resolved. A registered submission is not discarded merely because `end_turn` arrived while validation was running.

Bound finalization by existing invocation/cleanup deadlines: never wait indefinitely for native tools or arbitrary network requests. If a pre-boundary submission cannot be classified reliably, return an **addressable technical uncertainty/failure** rather than guess an old candidate, fabricate `invalid_json`, or block the model's unrelated native activity. Cancellation/authority revocation takes precedence. Ensure late callbacks cannot mutate finalized state.

Do **not** await all provider-native tools to finalize Decision; only account for known registered Decision submissions.

### 4.3 No artificial Host blocking (mandatory)

During an active native Controller turn, neither a valid pending proposal nor an invalid/conflicting proposal may disable unrelated native tools, file/script reading, provider-native skills/subagents, context retrieval, permissions or reasoning. Do not auto-complete or cancel a native turn upon submission. Do not require immediate resubmission or extra model turn. The model may keep investigating with native tools and later replace/correct its proposal. Respect **real** cancellation, authority and resource bounds, but do not invent new host-induced workflow gates.

## 5. Provenance, capacity, lifecycle

### 5.1 Provider-agnostic invocation capability

Bind Decision submission capability to a **live, trusted Controller invocation** (`operationId`, `attemptId`, kind, source, effective authority, signal/lifetime). One native invocation/session must not acquire another invocation's pending state via endpoint reuse, stale handle or late callback. A bearer URL/token proves access to that capability, **not** root native-agent identity. Do not require provider-specific root/subagent inspection or suppress native subagents. Clearly document the achievable cross-session/cross-invocation protection and limits of copied/leaked bearer credentials.

The existing ACP MCP bridge is only constructed when `contextAccess` or `externalTools` exists; the Decision tool must be available **independently** when negotiated. Never expose it as a regular RO Worker external tool or grant it arbitrary authority.

### 5.2 Budget and message sizes (P2)

Current MCP bridge baseline: 32 KiB total request, 256 KiB response, 64 tool calls, 4 concurrent calls. These were chosen for the old bridge, **not** full model-authored Decisions. A long valid final Assessment or batch of Actions can exceed 32 KiB, and exhausted context/tool calls must not arbitrarily make `submit_decision` unavailable.

Choose **bounded, measured** capacity for large ControllerIntent payloads and a way to convey accurate limit errors to the model when possible. Consider dedicated control-tool budgeting, but do not allow unbounded input/memory, bypass trusted resource envelopes, or suppress native capabilities. Demonstrate a large valid Decision deliverable via MCP and text/structured paths; if a transport genuinely has a smaller declared bound, report that limitation honestly, do not silently truncate model content or upgrade it to a semantic block.

### 5.3 Persistent result and crash-gap

Canonical Decision v1 and existing Operation journal remain authoritative. `decisionId` must be stable for a given final declared result, but stable ID **alone is not idempotency**. Distinguish duplicate delivery of the *same provable receipt and content* from changed content with same identity (`IDENTITY_CONFLICT`). Check actual order: provider completion, `attempt.outcome` durability, decoding/materialization, `controller.responded` durability, Action reservation/dispatch. A crash between those events must not replay an unknown-effect native Controller or accepted Worker. Reprocess only when the original complete result and its identity are reliably durable, using existing store/journal consistency; otherwise preserve unknown/unavailable and proceed via existing recovery without inventing intent. Do not introduce a second durable pending-proposal source of truth.

Preserve C17R exact source attribution: MCP submission is model-declared content received through a trusted tool boundary; neither its approval nor its tool completion proves task success or an arbitrary native tool effect. Do not claim `outputObservationParsed: true` for a different final text; no equality-by-text alone.

### 5.4 Tool and model errors

In-turn invalid structure: bounded model-visible tool error (MCP `isError` where applicable) with path/expected and an opportunity to correct; **not** a final Controller rejection. Actual final model-invalid result: existing `controller.invalid_proposal` and counters. Provider disconnect, ambiguous finalization, authority/cancellation, exceeded technical capacity and unknown dispatch: distinct technical outcomes, **not** invented model schema failures. Preserve independent already accepted Workers and real permission decisions.

## 6. Engineering sequence and checkpoints

Implement in small complete checkpoints. Use JS ESM/Node 24, JSDoc, `checkJs/noEmit`; test real production contracts rather than copy the orchestrator into a standalone harness. These steps are development sequencing only, **not a runtime workflow**.

### C18.0 — Baseline / failure mapping

Read all referenced docs; inspect actual call graph; record exact branch/HEAD, current C17R statuses and initial CI. Write RED regression fixtures where feasible: native finish during in-flight MCP validation, conflicts and correction, cross-invocation request, large Decision, crash-gap, no native tool suppression. Record who owns each field and event, native signal, lifetime, and cleanup. Preserve dirty checkout.

**Exit:** accurate baseline, test matrix and no accidental change of existing semantics.

### C18.1 — ControllerIntent decoder

Introduce transport-neutral model-owned schema; preserve all legal Decision v1 combinations and required **model** fields while removing only Host identity/technical boilerplate; document exact empty-field defaults. Unknown fields, explicit null and conflicting values fail with addressable structural reasons. Test direct answer, delegations/dependencies, retries, waiting, acceptance, findings/evidence, continuation/contextRequest, partial/unresolved, Unicode/Markdown.

**Exit:** full model expressivity with no Host semantic choice.

### C18.2 — Trusted materialization and text/structured reference

Implement one pure materializer `ControllerIntent + trusted binding → Decision v1`. Bind observed context revision and stable decision identity, attribute authors without claiming root native reasoning identity. Pass existing `decodeDecision`; do not duplicate `planRound`, `checkAssessment` or evidence decisions. Wire one text (or verified structured) adapter as reference, retain legacy explicit path. Test equivalence and no-drift on all model-owned data. Avoid changing Worker response format.

**Exit:** full ControllerIntent with real canonical Decision path, independent of MCP.

### C18.3 — Generic transport and result classification

Extend ProviderPort/Invocation minimally (typed delivery mode + typed result identity/status), preserve legacy adapters. At ACP initialization negotiate MCP; select mode **before prompt**, including no-MCP fallback. Empty final native text in MCP mode is not parsed as Decision JSON. Reuse shared model contract and existing prompt layering; don't inject redundant strategy templates or suppress native tool discovery.

**Exit:** unambiguous result table for clean absent, valid, conflict, invalid, cancel, disconnect, unknown; no duplicate provider invocation.

### C18.4 — MCP tool and pending finality

Expose proposal-only `submit_decision`, correct registration order, observed correction, explicit replacements, recoverable conflicts, and **last-wins only among competing explicit replacements of the same known lineage**. Implement native-completion barrier (P1), bounded in-flight resolution, request-id idempotency, exact stopReason treatment, late callback fencing; ensure native tools keep working after any submission.

**Exit:** one native turn can correct, replace and finish; no preliminary Action admission; no artificial Host waits.

### C18.5 — Generic provenance and capacity

Scope MCP capability to live Controller attempt, isolate independent sessions, bind abort/authority, reject late/foreign requests without blocking others. Make decision tool available without context retrieval/external tools. Address old 32 KiB / 64-call limitations with measured bounded control capacity; test large Results, concurrent requests and shared bridge access; do not invent root-agent guarantees.

**Exit:** no wrong-invocation admission; no accidental limitations on correct large Controller output or native tools.

### C18.6 — Existing admission and durable recovery

Map trusted final result to the **single existing** decoder/evidence/admission path; preserve original accepted Action semantics, direct finish, wait/clarify, `nextController`, 5/10 journal recovery and independent Workers. Examine failure windows before/after outcome commit and responded commit. No blind replay; dedup based on reliably persisted content/identity. Keep diagnostics bounded and source-correct.

**Exit:** integrated Operation lifecycle with no second coordinator or permanent proposal store.

### C18.7 — Full regression and hostile boundary tests

Run project checkJs/import, foundation, core, contracts, integration, acceptance, actual Linux PTY, storage/restart and native-protocol fixtures. Cover model intent full shape, all C18.4 table rows, in-flight completion, concurrency ordering not Promise order, errant/oversize MCP, canceled or wrong scope, cross-invocation, lost result, ambiguous receipt, crash-gap, legacy text providers, C16/C17R recovery, independent Worker progress.

**Exit:** regressions protect model-first behavior and actual error taxonomy; never weaken historical assertions solely to pass new code.

### C18.8 — Controlled native acceptance and exact-SHA verification

Compare same real tasks/environments under C17R baseline, text-minimal ControllerIntent, MCP ControllerIntent and native structured where genuinely supported. Use OpenCode ACP/local model and one independent available provider where possible; versions/model build/context/permissions/cold/warm/usage/time/traces recorded. Include direct response, multi-Worker delegation, findings/evidence, code change with native tooling, partial/unresolved, continued task, cancellation and a deliberate structural error. In a real workspace verify model can read `AGENTS.md`, discover provider-native skill not in RO Catalog, read/run project scripts, use provider-native subagent, and **continue using these tools after invalid, conflicted or valid pending submissions**. Absence of a Host Catalog skill must not be equated with absence of provider native skill. Compare task quality and unnecessary actions, time, invocations, in-turn corrections vs new Controller invocations, token/byte costs, unexpected tool calls and actual lifecycle. Note intentionally induced errors separately from natural errors. Native PASS requires actual live runs, not synthetic harness.

Run project required `npm run check`, `npm test`, applicable Node 24/Nix locked `nix flake check --no-update-lock-file`, package install outside checkout and exact-HEAD CI. Record failing steps precisely; do not claim native PASS when unavailable.

## 7. Acceptance and review checklist

- One canonical Decision v1, one existing admission, one existing Operation journal, **no new scheduler/workflow**.
- Model-owned content/IDs/refs/dependencies faithfully retained; Host-owned metadata provable and stable; no semantic guessing.
- Correct text/structured/MCP result classification and no double JSON parsing; correction in one native turn.
- **Temporary last-wins only for explicit same-lineage concurrent replacements in trusted registration order**; unrelated submissions conflict but can be resolved before end_turn.
- Host accounts for all reliably registered pre-finalization submissions; in-flight race bounded; never loses or guesses a valid Decision because a Promise finished late.
- Observably invalid replacement prevents silent fallback; unobserved MCP attempts are not fabricated.
- No premature tool-triggered Action execution, no extra `finalize`, no artificial native tool/skill/subagent blocking.
- Generic invocation-bound provenance, real cancel/late guarantees, no overclaimed root identity; no wrong-session/cross-operation admission.
- Real existing resource/permission budgets remain; measured adequate bounded Decision capacity even when ordinary context/tool budget is consumed.
- Durable duplicate/identity conflicts and crash-gap tested with same source receipt and bytes; no blind provider replay after possible effects.
- Worker independence, C16 5/10 recovery, C17R rejection-source fidelity and native UI remain intact.
- Native comparison records **task success and behavior**, not just JSON acceptance. Unknowns are marked UNVERIFIED.
- Final code commit and documentation pass mandatory CI on exact SHA; no master merge.

## 8. Knowledge updates and handoff

As implementation progresses, update only relevant normative files: `docs/CONTRACTS.md`, `docs/ARCHITECTURE.md`, `docs/EXECUTION.md`, `docs/CONTEXT_AND_RECOVERY.md`, `docs/PROVIDERS_AND_CONFIGURATION.md`, `docs/EXTENSIONS.md` where transport/plugin semantics change; `docs/DECISIONS.md` for accepted tradeoffs; `tests/ACCEPTANCE_MATRIX.md` and tests for executable contracts; `CHANGELOG.md` for user-visible changes; `docs/roadmap/STATUS.md`, `IMPLEMENTATION_PLAN.md` and `NATIVE_ACCEPTANCE.md` for exact evidence. Do not fill every document merely to satisfy a checklist or move old historical C17 acceptance.

Final implementation handoff must state exact HEAD, changed components, verified commands/exits and CI, native versions/results, acceptance evidence, P1/P2 open risks and limitations. The planning commit itself is **not** implementation complete, regression PASS or native verified.

## C18R — Corrective engineering follow-up (review baseline `f9d06f19`)

C18R addresses two confirmed P1 failures and P2 test/ownership gaps without altering C18.0–C18.8 model-first design, Decision v1, Action admission or temporary explicit same-lineage last-wins. The source of truth remains invocation-local pending control until **trusted native completion**, then existing `attempt.outcome`/`controller.responded` journal; no early Worker dispatch, additional finalize round or native-tool suppression.

- **C18R.0–R.1 (capture/finality):** observed RED from ACP SDK when auxiliary tool updates overflow 1 MiB after a valid MCP proposal. For trusted normal `end_turn`, a distinct completed MCP intent may still be admitted. The partial agent-message capture is **not** a complete final text; a bounded `acp-output-limit` host observation and actual truncated stop report remain. No relaxation for strict text/legacy, refusal, cancellation, unknown stop reason or wire protocol error.
- **C18R.2 (rejected replacement):** only a complete attributable Controller `tools/call` request with a known `replaces` lineage can invalidate the live selected candidate when a reused JSON-RPC id prevents execution. Same-id/same-payload retry remains exactly deduplicated; unknown/unreadable/cross-invocation refs have no effect. Unresolved request-id conflicts are technical outcomes, not fictional model invalidity. Subsequent explicit correction in the same turn clears that uncertainty.
- **C18R.3 (tool namespace):** when an external tool already occupies `submit_decision`, the built-in control tool takes the first available `role_orchestrator_submit_decision[_N]` name, with matching model-facing instructions. The external tool retains its original name/permission handling. No Core/provider-name branches or privilege elevation.
- **C18R.4 (durable identity):** same proven `decisionId`, content and Controller attempt may be an idempotent duplicate, while other content or a different attempt with the same ID is `IDENTITY_CONFLICT`, not an `INVALID_PROPOSAL` schema failure. Old opaque effects are never blindly replayed. Lost ACK and pre-Worker-dispatch recovery use the existing StateStore/journal and independent Worker lifecycle.
- **C18R.5 (fault boundaries):** regression tests exercise native capture >1 MiB, ACP SDK end_turn, near-2-MiB UTF-8 MCP payload, HTTP 413, independent ordinary/control budgets, request-id dedup/conflict, cancellation, late/foreign URLs, proposal finality, worker isolation and crash gaps. Unit/HTTP/ACP tests are **synthetic engineering**, not genuine LLM autonomy evidence.
- **C18R.6:** require full Node 24 specification/checkJs, foundation/core/contracts/integration/acceptance, real Linux PTY, historical C16/C17R, Nix locked package/install/release and full exact-SHA CI. Native provider trials remain UNVERIFIED until actually run.

**Limits:** a complete registered request is distinct from an incomplete/unreceived client-side MCP attempt; Host never invents submissions. A bearer URL is scoped capability rather than proof of root-agent authorship. Decision ID is stable but not proof of universal exactly-once for opaque external effects. Capture truncation preserves uncertainty rather than fabricating evidence. Last-wins remains only for explicit replacements of one known lineage.


**C18R engineering evidence (2026-11-22):** [CI #45017738925](https://github.com/apathoid/role-orchestrator/actions/runs/45017738925) SUCCESS on `fab92fd037a0169e9e12ac6706801c3c6d4d1666`: Node 24 specification/checkJs, foundation/core/contracts/integration/acceptance, 15 actual Linux PTY fixtures, C15/C17 comparison, Nix locked flake, external package install and release. Real OpenCode/Ornith and independent provider native acceptance remains UNVERIFIED. A later documentation-only change requires a fresh CI result and must not inherit PASS automatically.
