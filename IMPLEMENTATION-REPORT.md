# Provider-agnostic architecture implementation report

## Status

This revision refactors role-orchestrator so workflow/core orchestration is provider-neutral. The workflow consumes a normalized Agent Provider contract and normalized events; vendor/runtime specifics remain in provider adapters/factory/compatibility layers.

## Engineering Core integration

This revision also adds a provider-neutral Engineering Core under `policy/engineering/`.

- `kernel.md` defines the default engineering decision model, centered on semantic generality without speculative complexity, mechanism/policy separation, lowest-correct ownership, contract preservation, source-of-truth discipline, and explicit lifecycle ownership.
- Planner receives the kernel plus the full decision process and must produce a structured `engineeringFrame` for non-trivial planner-backed work.
- Coder/fixer receives a fresh kernel, the task-local frame, and compact pre-write/pre-finish checkpoints appended after task evidence so the policy remains salient in long contexts.
- Reviewer receives the same kernel plus an independent rubric and a final review checkpoint; the planner frame is advisory and must be challenged against current repository state.
- Final validator receives only narrow hard invariants plus a final checkpoint, preventing optional architectural preferences from becoming merge blockers.
- Project instructions and skills remain overlays that describe the concrete repository architecture; the Engineering Core supplies the default decision process and is not Codex-specific.

Verification for this integration:

- all syntax and non-smoke unit/regression suites: PASS;
- dedicated `test/engineering-policy.mjs`: PASS;
- `test/workflow-unstructured.mjs`, including role-specific prompt injection and frame propagation: PASS;
- an isolated high-risk end-to-end workflow through the Codex ACP fake adapter (planner -> coder -> reviewer -> finalValidator): PASS;
- the monolithic smoke suite still exceeds the available execution timeout, consistent with the pre-existing cumulative smoke limitation documented below; no new smoke failure was observed before timeout.

## Activity-aware ACP turn timing

ACP role turns no longer use a single fixed wall-clock timeout. `src/providers/turn-timing.mjs` provides a shared two-level guard used by both the Codex ACP adapter and the generic ACP adapter:

- `idleTimeoutMs` is refreshed by every native ACP session update, so active reasoning/commentary/tool/plan/usage traffic demonstrates liveness instead of consuming a fixed budget;
- `turnDeadlineMs` is an absolute per-prompt-turn ceiling that cannot be extended by noisy or runaway progress;
- the idle watchdog is paused while waiting on an outer permission/elicitation decision, but the absolute deadline remains active;
- `timeoutMs` remains a compatibility alias and preserves the previous fixed-timeout behavior when used alone.

The bundled ChatGPT subscription provider now uses a 10-minute idle timeout and a 45-minute absolute deadline. Intermediate reasoning summaries/presentation are unchanged.

Verification includes unit coverage for idle refresh, absolute-deadline enforcement, paused idle timing, legacy compatibility, config validation, and Codex ACP integration that proves regular progress survives beyond the idle interval while silent and continuously-active-over-deadline turns fail for the correct reason.

## Universal Agent Provider Contract

The contract is implemented in `src/providers/provider.mjs` and the registry in `src/models.mjs`.

A provider exposes:

- identity/configuration through the provider registry;
- `capabilities()` returning normalized `AgentCapabilities`;
- optional `prepare()` for runtime negotiation before capability validation;
- `invoke(request)` for one invocation-scoped role execution;
- `cancel()` for cancellation;
- `close()` / lifecycle cleanup;
- `listModels()` where static/discovered model catalog is available.

The normalized invocation carries role/profile/model, reasoning level, workspace policy, reconstructed conversation/current content/historical attachments, instructions/structured-output requirements, requested capabilities and opaque `providerOptions`. Core does not interpret provider-specific options.

## Normalized events

The data-plane event set is defined in `src/providers/provider.mjs` and normalized by `src/providers/events.mjs`:

- `reasoning`
- `commentary`
- `final_text`
- `content_block`
- `tool_call`
- `tool_result`
- `plan_update`
- `permission_request`
- `progress`
- `provider_state`
- `warning`
- `error`
- `usage`

`src/workflow.mjs` consumes these semantics only. Codex phase/collaboration metadata is interpreted inside the Codex adapter or outer compatibility/control layer, not workflow branching.

## Capability model

`normalizeCapabilities()` and `assertInvocationCapabilities()` implement capability negotiation/fail-closed validation. Capabilities cover:

- text;
- images;
- embedded resources;
- resource links;
- native plan;
- reasoning stream;
- commentary;
- permissions;
- read-only/write workspace modes;
- configurable model;
- configurable reasoning;
- MCP transports.

Optional presentation capabilities degrade safely. Required content/security capabilities do not silently degrade. In particular, unsupported image/resource input and unenforceable read-only/write workspace modes fail before invocation.

Generic ACP performs `initialize` before capability validation so ACP content capabilities are discovered from the actual runtime instead of being duplicated manually in config.

## Error model

`src/providers/errors.mjs` normalizes provider/runtime failures into:

- `AUTH_ERROR`
- `RATE_LIMIT`
- `MODEL_UNAVAILABLE`
- `CAPABILITY_UNSUPPORTED`
- `CONTEXT_LIMIT`
- `PROVIDER_CRASH`
- `TIMEOUT`
- `CANCELLED`
- `INVALID_REQUEST`

Native errors remain available as causes/diagnostics; workflow branching does not depend on vendor error strings.

Cancellation provenance is now explicit rather than collapsing every abort path to `Operation aborted.`. `src/cancellation.mjs` carries outer cancellation reasons through `AbortSignal.reason` and across provider normalization:

- `CLIENT_REQUEST_CANCELLED` — outer prompt request cancellation;
- `SESSION_CANCELLED` — explicit outer ACP session cancellation;
- `SUPERSEDED_BY_NEW_TURN` — a newer prompt replaced the current/pending turn;
- `PROVIDER_CANCELLED` — the inner provider returned `stopReason=cancelled` while the outer workflow remained active.

The first three are expected control-flow cancellations and are not reported as failed tasks. `PROVIDER_CANCELLED` remains an unexpected, retryable provider failure so intermittent inner-agent termination cannot masquerade as a user cancellation. Role failures are rendered with stable normalized codes such as `[TIMEOUT]`, `[MODEL_UNAVAILABLE]`, or `[PROVIDER_CANCELLED]`, and the outer JSON-RPC error data preserves normalized diagnostics where available.

Verification for cancellation diagnostics:

- dedicated cancellation/provenance tests: PASS, including propagation through repository subprocess cancellation;
- generic ACP and Codex ACP tests for unexpected inner `stopReason=cancelled`: PASS;
- all syntax and non-smoke regression suites: PASS;
- the monolithic smoke suite still exceeds the available 120-second execution window, matching the already-documented cumulative smoke limitation rather than producing a new assertion failure before timeout.

## Configuration schema

Canonical provider configuration uses `adapter` rather than provider=vendor semantics. Supported adapters in this revision:

- `acp-agent`
- `codex-acp`
- `codex-cli`

Example:

```json
{
  "providers": {
    "generic-acp": {
      "adapter": "acp-agent",
      "command": "some-acp-agent",
      "args": [],
      "workspaceModes": {
        "readOnly": "read",
        "write": "write"
      },
      "models": ["model-a"]
    }
  },
  "profiles": {
    "explorer-generic": {
      "provider": "generic-acp",
      "model": "model-a",
      "reasoningEffort": "medium",
      "providerOptions": {}
    }
  }
}
```

`providerOptions` is an opaque escape hatch interpreted only by an adapter.

## Migration semantics

- Legacy provider `type` is still accepted and migrated in-memory to canonical `adapter`.
- The bundled `config/chatgpt-plus.json` now uses canonical `adapter`.
- Existing Codex ACP/CLI adapter names remain valid.
- Session persistence remains backward compatible, including existing Codex-native outer UI/session control fields.
- Role/profile assignment semantics are unchanged.

## Implemented adapters

### Generic ACP (`acp-agent`)

Implemented in `src/providers/acp/generic-acp.mjs`.

Features include:

- ACP initialize/session/invoke transport;
- runtime capability discovery;
- image/resource delivery through ACP content blocks;
- normalized plan/reasoning/message/tool/usage events;
- permission request proxying through orchestrator policy;
- explicit read-only/write mode mapping;
- invocation-scoped sessions;
- timeout/cancellation;
- process-group cleanup;
- minimal subprocess environment;
- configured/static model catalog;
- opaque provider config options.

### Codex ACP (`codex-acp`)

Existing implementation retained as a Codex-specific adapter. It now exposes normalized capabilities/events and maps opaque provider options to Codex mode/collaboration semantics internally. Codex `_meta` phase semantics do not leak into workflow/presentation core.

### Codex CLI (`codex-cli`)

Existing implementation retained behind the same provider registry/contract. It exposes normalized capabilities/events/errors and now uses the hardened subprocess environment/cancellation path.

### Claude

No fake native Claude adapter was added. Current ACP ecosystem provides `claude-agent-acp`, so Claude can be configured through `acp-agent` without adding Claude-specific workflow/core code, provided that runtime is installed/configured. This environment did not contain `claude` or `claude-agent-acp`, so Claude subscription execution is **not runtime-verified here**.

## Security review

### Preserved invariants

- role isolation;
- `writeIntent` / `/change` boundary;
- read-only roles;
- sensitive paths;
- workspace boundaries;
- verification model;
- live reconciliation;
- outer persistent sessions / invocation-scoped inner sessions;
- historical multimodal attachment store/GC/quotas;
- dirty-tree support;
- native presentation;
- task-plan progress;
- structured role outputs.

### Fail-closed behavior

A provider that cannot enforce the requested workspace mode is rejected. Model instructions are not treated as a security boundary.

### Subprocess isolation

Generic ACP, Codex ACP and Codex CLI provider processes use an explicit/minimal environment instead of unrestricted `process.env`. Adapter config may explicitly allow required auth/runtime variables. Secrets are not copied into invocation context/session data by the provider layer.

Subprocess command/args are executed without constructing shell command strings. Generic ACP and CLI cancellation/timeout terminate process groups on supported platforms to reduce orphan-child risk.

### Core purity

A regression statically asserts `src/workflow.mjs` contains no Codex/Claude/Anthropic/DeepSeek/OpenAI/wire-API/collaboration-mode concepts. Generic provider contract/event/error/ACP modules were also manually checked for vendor naming.

Vendor names intentionally remain in adapter factory/config compatibility, Codex adapters, and the outer ACP compatibility UI/session-control layer. They do not select workflow behavior.

## Verification results

Environment:

- Node: `v22.16.0`.
- `package.json` requires Node `>=22.20.0`; therefore this run is below the declared engine floor.
- `codex`, `claude`, and `claude-agent-acp` executables were not present.

### Baseline before implementation

- `npm run check`: PASS.
- `npm test`: FAIL in `test/provider-progress.mjs` on the inner native Plan -> Default transition.

The failure was traced to an invalid fake ACP `config_option_update` payload that the ACP SDK discarded. The fake runtime now emits a schema-valid update and the regression passes.

### After implementation

- `npm run check`: PASS.
- All non-smoke unit/regression suites: PASS, including new `provider-contract` and `generic-acp` suites.
- All smoke scenarios: PASS when executed in three bounded groups.
- A single monolithic `npm test` run reaches the final hybrid smoke scenario and exceeds the execution timeout; the same hybrid scenario and all preceding smoke scenarios pass when grouped/separated. Therefore **the monolithic `npm test` is not reported as PASS**.

This cumulative smoke/lifecycle behavior is a remaining weak spot. The environment's Node version being below the project's engine requirement is a possible variable but is not proven to be the cause.

## Real providers actually checked

### Implemented and tested

- Generic ACP contract/transport with a subprocess fake ACP runtime.
- Existing Codex ACP semantics using the repository fake ACP runtime.
- Provider-neutral mixed-role workflow using fake providers/capabilities.

### Implemented, but real runtime not checked here

- Codex ACP with real Codex/ChatGPT subscription runtime.
- Codex CLI with real Codex runtime.

### Architecturally supported through generic ACP, runtime not checked here

- Claude through `claude-agent-acp` / Claude Agent SDK path.
- Other arbitrary ACP-compatible agents with explicit workspace-mode mapping.

### Requires a suitable agent harness/adapter

A raw OpenAI-compatible inference endpoint (DeepSeek, Devstral via llama.cpp/vLLM/Ollama/LM Studio, etc.) is not automatically a coding agent. It can be used only through an agent runtime/ACP bridge that supplies the required tooling/security semantics, or by adding a dedicated provider adapter. This intentionally preserves the distinction between model backend and agent runtime.

## New regression coverage

Added/expanded checks cover:

- provider-neutral capability validation;
- read-only/write fail-closed behavior;
- image capability mismatch;
- normalized error/event semantics;
- workflow core purity;
- real subprocess Generic ACP initialization/invocation/cleanup;
- ACP-discovered multimodal capabilities;
- legacy provider config migration;
- canonical `adapter` configuration;
- generic provider state propagation;
- valid native plan/config updates;
- mixed custom/subscription provider smoke path;
- minimal provider subprocess environment;
- process-group cancellation/timeout path.

Existing security/session/attachment/reconciliation/presentation/plan suites remain passing in independent runs.

## Remaining weak spots

1. The full monolithic `npm test` still has cumulative smoke lifecycle/timeout behavior at the final hybrid scenario even though every smoke scenario passes in bounded groups. This should be investigated under the supported Node version before calling the full suite clean.
2. Real subscription flows could not be executed because Codex/Claude runtimes were absent.
3. Outer ACP still exposes Codex-named mode/collaboration controls for backward-compatible Zed/session UX. They are intentionally isolated from workflow; a future UI-neutral control schema could remove those final compatibility names.
4. Generic ACP workspace security relies on an explicit runtime mode mapping. An arbitrary ACP agent with no enforceable read-only/write mode is rejected; no universal external OS sandbox was introduced in this revision.
5. ACP model discovery is not standardized by the currently used contract, so static configured models remain the default; `listModels()` is available for adapters that can discover models.
6. Raw local/API model backends still require an agent harness. This is deliberate rather than pretending `/v1/chat/completions` is an agent provider.

## Adding the next provider

For an ACP-compatible agent:

1. configure `adapter: "acp-agent"`;
2. provide command/args/auth environment allowlist;
3. map enforceable read-only/write runtime modes;
4. declare configured models/provider options as needed;
5. add adapter/runtime-specific regressions.

No workflow/router/session/presentation changes should be necessary.

For a non-ACP agent, implement the small Agent Provider contract, normalize events/errors/capabilities, enforce workspace/security semantics, register it in the provider factory, and add adapter-specific tests. Core workflow must remain unchanged.


## Role presets (2026-10-11)

- **Canonical runtime configuration:** session-scoped, fully materialized `roleAssignments` (role → `{ profileName, profile }`), using the same named profiles as the existing `config.roles` mapping. The model registry consults the snapshot; adapters remain unchanged. Old `profileOverrides` data is interpreted once when upgrading previously persisted sessions; it remains compatible with the fast-mode toggle, but profile editing is now config-file-only.
- **Preset resolution:** `src/role-presets.mjs` provides strict config validation, fixed-base overlay, snapshot materialization, canonical structural comparison, and first-declared exact-match selection. A preset ID is *not* part of runtime correctness. `defaultRolePreset` applies only to new sessions.
- **ACP UI:** `Role preset` selector is shown only if configured; other role, model, reasoning and shared-profile controls are no longer published, as requested. The native ACP mode/collaboration controls and the default-profile fast-mode boolean remain. `Custom` is computed from effective role assignments. Session option updates publish the complete ACP config-options array and the corresponding notification; config-option mutations are serialized per session.
- **Persistence:** the existing version-2 atomic session format is extended additively with `roleAssignments`. No new persistence store or provider-specific handling was introduced. The workflow takes a deep snapshot of the selected assignments at startup.
- **Verification:** targeted `role-presets`, `session-config`, `config`, and existing session/persistence/security/timing/cancellation/context/engineering regression tests passed in the local runtime. Syntax checks passed. End-to-end ACP/provider suites and smoke require the npm dependencies; in this sandbox `npm ci --offline` cannot complete because `zod@4.6.5` is missing from the local cache, and the registry download attempt timed out. No Zed desktop UI execution was performed here.

## Inner ACP cancellation diagnostics enhancement (October 2026)

The provider-neutral `src/providers/acp/turn-diagnostics.mjs` records turn-scoped ACP activity and session-scoped `session.cancel` attempts. Both the subscription (`codex-acp`) and generic ACP adapters use the same recording mechanism. `PROVIDER_CANCELLED` retains its existing public code, but now includes effective timeout limits, ACP progress timestamps, and whether any local cancellation notification was submitted. Local watchdog errors carry `source=orchestrator_timing`, the timed-out guard kind, and the outbound cancel attempt. The `codex-acp` request wrapper preserves these fields for normalized `[TIMEOUT]` errors. An absolute-deadline timeout previously classified as `PROVIDER_CRASH` when its message lacked the literal word `timeout`; classification now honors `timeoutKind` directly.

The snapshot records only update types, counts and elapsed times; it does not record prompt, reasoning, tool or credential content. The notification status indicates only local send completion and cannot reveal internal Codex/Responses cancellation origin. No changes were made to ACP presentations, Engineering Core, role assignments, scheduling, session persistence, or retry behavior.

Regression coverage: `test/turn-diagnostics.mjs` (pure unit), plus added checks in `test/generic-acp.mjs` and `test/codex-acp-cancellation.mjs` (fake ACP integration after dependency installation). The latter exercises both spontaneous inner `cancelled` and watchdog-triggered cancellation.


## Compact ACP role-preset controls (2026-10-13)

- **Cause:** Zed renders all ACP `configOptions` in one wrapping toolbar, with dropdown triggers displaying the selected option's `name` instead of the control's own `name`. Exposing 28 per-role dropdowns made the UI unusable. Zed's ACP config controls have no supported grouping or collapsed-container facility for this case.
- **Fix:** With presets enabled, publish one `Role preset`, one `Edit role`, and only the selected role's model and effort controls, followed by the unchanged shared-profile template editor. Dropdown values have explicit `Role preset:`, `Role:`, `Role model:`, `Role effort:` and `Template:` labels. This is standard ACP `session/set_config_option` + full `config_option_update`, not a Zed-specific protocol extension. Configs without presets retain their original control set.
- **State and safety:** `roleEditor` is session-scoped UI navigation metadata saved in the existing atomic session JSON. No runtime role assignments depend on it. Published per-role control IDs still identify the exact role, so stale requests cannot accidentally edit a different role when switching the editor selection. Switching roles leaves materialized assignments and derived `Custom` unchanged. The existing per-session rollback now also covers `roleEditor`.
- **Verification:** All syntax checks and 21 executable test modules pass, including targeted UI-option shape/refresh, editor navigation, stale-control targeting, preset materialization/matching, persistent role-editor selection, and multi-session isolation. Five ACP/integration/smoke modules could not execute because `@agentclientprotocol/sdk` is not installed; the local npm cache is incomplete. Real Zed UI behavior is supported by inspection of the upstream source, not by a desktop end-to-end run.

## Preset-only ACP role controls (2026-10-13)

- **ACP presentation:** The orchestrator now publishes only `Role preset` (when configured) and `<ui.defaultProfile> fast mode` (when supported). The existing native Codex approval/collaboration controls remain untouched. Model, effort, role and shared-profile editors have been removed from ACP config-options; stale requests to their former IDs are rejected without altering the session.
- **Configuration:** Role assignments, provider/model settings and reasoning effort are edited through `AGENT_CONFIG` (`profiles`, `roles`, `rolePresets`). Named preset selection continues to materialize the complete effective role map and `Custom` is still derived from it. Without presets, no preset selector is shown, and the fast-mode toggle remains if supported.
- **Fast-mode target:** The toggle is bound to `ui.defaultProfile` (falling back to `balanced` or first profile) rather than an obsolete saved UI-editor selection. It updates only the `fastMode` property of existing matching materialized assignments; all role-level provider/model/effort fields remain intact. Historical `selectedProfile` and `roleEditor` metadata may still appear in persisted session JSON for backward compatibility but no longer influence role editing or UI layout.
- **Verification:** New regression assertions check the exact published ACP control IDs, absent-presets behavior, rejection of stale options, deterministic fast-mode target, preservation of custom role assignments, preset `Custom` matching, persisted sessions and independent session assignment maps. ACP/Zed runtime presentation requires a real desktop verification when dependencies are installed.

## Preset-wide Fast mode (2026-10-13)

- **Previous behavior:** The ACP toggle targeted only `ui.defaultProfile` (usually `balanced`), updating the materialized profiles of roles referencing that profile and potentially making the active preset show `Custom`.
- **New behavior:** A session-scoped `fastModeOverride` boolean is persisted alongside the existing atomic session JSON. `session-config.mjs` filters the current role assignments by explicit provider and model `supportsFastMode: true` capability and an optional profile opt-out. When a workflow takes its snapshot, the speed override is applied **only to eligible roles**. Model/provider/reasoning/role mappings are never modified; existing in-flight snapshots are immutable. All eligible roles are targeted, even if they reference different profiles or providers; unsupported and unknown-capability models are untouched.
- **Preset matching:** The speed override is orthogonal to the materialized role assignments, so selecting a preset continues to resolve and match those assignments without being invalidated by the speed switch. Switching presets preserves the toggle and applies it to the next workflow's newly eligible models. The default speed state, when no override is stored, is derived from the already materialized role profiles; old persistent sessions are not silently rewritten.
- **UI:** The ACP boolean option is now named `Fast mode` rather than `<default profile> fast mode`, and is absent if there are no eligible models. Codex adapters already honor the `profile.fastMode` field; a generic ACP provider can forward it through an explicitly configured `fastModeConfigId` (required if it advertises fast-mode support). No provider-specific logic was added to preset resolution.
- **Verification:** `test/session-config.mjs` and `test/role-presets.mjs` cover mixed support, all-role application, snapshots, exact preset matching, persistence, no-presets mode, error cases and session independence. The real backend may still decline a requested service tier. Real Zed/backend integration was not exercised in this environment.

## Inline profile overrides in role presets (2026-10-13)

- **Config ergonomics:** `rolePresets[].roles[role]` accepts a named profile as before, a partial inline override (inheriting the named profile from required `config.roles[role]`) or a self-contained `provider` + `model` assignment. No registration in `profiles`, `roles` or the provider model metadata catalog is required for inline model IDs. Named providers remain mandatory; model availability is validated by the provider at runtime.
- **Single canonical owner:** `src/role-presets.mjs` resolves every form to `{ profileName, profile }`. `src/profile-validation.mjs` supplies the same structural profile validator to both `config.profiles` and inline resolution. Full inline provider switches do not inherit the old provider's options, timeouts or capabilities. A partial model change clears inherited model-specific context/capability/fast-mode flags unless explicitly provided, while preserving general provider/profile settings. Inline assignments are labelled `inline:<role>` for accurate diagnostics. All 14 roles still materialize atomically via the existing session state; workflow, adapters, tier routing and timing/cancellation code are unchanged.
- **Semantics:** Preset overrides are resolved from the immutable configuration, never mutable session selections; preset matching compares normalized effective profiles, ignoring declaration shape and `profileName`. The existing session store persists materialized profiles, so modifying a preset cannot change an older session's model. Unknown model IDs have no assumed fast-mode capability until catalog metadata declares it.
- **Verification:** Inline positive/negative config tests, cross-provider and inherited assignment tests, atomic failure, `Custom` matching, Fast mode, session save/load and changed-preset drift tests added. Registry runtime tests added but depend on `@agentclientprotocol/sdk`; execution availability reported separately. No Zed/backend smoke assertions implied.


## Zed Plan workflow / ACP tool-call correlation fix (2026-10-14)

- Selected collaboration mode is snapshotted for each outer turn. `Plan`
  forces the read-only router → explorer → planner route and outputs a complete
  Markdown plan; it never falls through to the mutating change workflow.
- Planner structured output continues to feed the native ACP task-plan UI.
  Unstructured planner text is returned directly, not replaced by a fake plan.
- Internal ACP providers run in Default collaboration mode during outer Plan
  execution; their Default state notifications cannot switch Zed out of Plan.
- Inner ACP tool calls receive unique outer-session IDs per outer turn and
  inner provider/session, and all updates require an established create.
  A titled first upsert is promoted to an ACP v1 create. Untitled orphan
  updates are suppressed with a diagnostic instead of broken Zed cards.
- Permission requests use that same mapping and publish a subject card when
  necessary, without changing approval policy or bypassing user consent.
- Targeted tests: `test/workflow-unstructured.mjs`,
  `test/acp-tool-bridge.mjs`, existing `test/codex-native-controls.mjs`.

## Review-scope inference and bounded completeness (2026-10)

- `inferReviewTarget` only recognizes an explicit first-line commit review
  directive. Incidental SHAs in user plans/branch histories no longer override
  `/review` or review-skill scope; `/review-commit` remains authoritative.
- Added a provider-neutral `review-coverage.mjs` contract and separate
  `scopedReview` schema for review-only workflows. User-declared checklist
  items outrank planner-generated steps. Fixed budget: at most 4 x 8 reviewer
  check items + one schema-format repair attempt, never an unbounded review loop.
- Exact checklist IDs and statuses are reconciled before a pass. File-count
  claims in the user task require a matching complete inventory report; missing
  or contradictory reports produce `review_incomplete`, not a misleading
  `review_passed`. Partial findings are preserved. **Limits:** inventory and
  evidence are reviewer assertions; the core does not establish independent
  file-by-file proof for arbitrary unspecified Git refs.
- Review-only workspace snapshots detect cross-batch semantic drift and fail
  closed without resetting external edits or retrying indefinitely.
- Machine status, ACP task-plan completion, CLI fallback, persistent history
  summary and responder prompts all distinguish incomplete coverage.
- Added unit/integration regression tests for incidental SHA, 28-check batches,
  11/337 partial coverage, successful report, one-time schema recovery,
  repeated malformed output, blocked checks, >32 checklist items, concurrent
  workspace drift, standard change workflow and explicit commit review.

## Review batching and continuation (October 2026)

- Read-only review batches now carry a bounded evidence handoff from earlier batches: checked IDs, findings, inventory, and summaries. Previous evidence remains model-reported, not independently verified; a new group must independently support its assigned IDs, and cannot infer coverage from earlier claims.
- Related acceptance criteria are *scheduled* with their matching review steps when the wording provides a sufficiently clear topic match. Each criterion keeps its own ID and separate coverage check; no criteria are silently deduplicated or marked complete.
- Every completed review batch writes an atomic, session-scoped checkpoint using the existing session store. A later identical request may reuse a prefix of finished groups only when scope, checklist and repository HEAD/index/worktree fingerprint match. Invalid, stale or finished checkpoints are not resumed. The checkpoint is only a progress ledger, not a provider session.
- Unexpected reviewer provider errors end the remaining review as `review_incomplete` rather than discarding completed batches. Client/user cancellation still propagates. No automatic provider retries or review-format retry invocations are introduced.
- Malformed `scopedReview` outputs are deterministically treated as incomplete; they do not trigger another full reviewer invocation just to rewrite the JSON.
- ACP/CLI now display review group number, assigned checklist IDs, checked count, checkpoint resume/rejection, and interruption details. The usual complete review/cancellation/skill/presentation routes are preserved.
- Hard limits remain 4 batches × 8 checks. Checks beyond the limit are explicitly `not_checked`, never silently dropped. Repository semantic drift invalidates further reuse and produces an incomplete result.
- Limitations: the handoff contains bounded model-reported evidence rather than independent observation of every file read. Reuse depends on the same resolved checklist; a substantially changed planner plan safely prevents checkpoint reuse. Recovery still reruns router/explorer/planner, and a reviewer may need a targeted cross-check of an earlier finding if a contradiction is discovered.

## 2026-10-14: Plan → staged implementation and duplicate step numbering

- Added provider-neutral `src/implementation-stages.mjs`: canonical plan step normalization,
  deterministic plan/repository identity, bounded stage scheduling, stage evidence validation,
  acceptance-criterion reconciliation and fail-closed checkpoint validation.
- Saved full structured Zed Plan in the existing atomic session JSON. It is activated only
  on an explicit follow-up reference to the plan, and old sessions still load without it.
- Large plans (>=4 steps; or any saved Plan) run stage-by-stage, retaining ordinary
  workspace-write ownership/security and the existing implementation role contract.
  No parallel writers. Stages have structured `stepResults` and per-stage `git diff --check`.
- Every completed stage is persisted. Provider interruption saves only previous completed
  stages plus current workspace state; a user-requested retry of the interrupted stage
  explicitly reconciles existing partial edits. No automatic retry/rollback.
- A separate `implementationReview` schema requires evidence for every acceptance criterion.
  Complete status requires all steps, all acceptance criteria, successful configured
  verification and resolved independent review. Unstructured/inconsistent agent output
  remains incomplete rather than entering an open-ended correction loop.
- Restored checkpoints republish completed step IDs in the outer ACP native Plan; inner
  role progress cannot mark the entire outer plan complete during stage execution.
- Normalized list numbering for both ACP Plan widgets and the Markdown plan response.

Testing: `node test/implementation-stages.mjs`, `node test/workflow-unstructured.mjs`,
`node test/session-store.mjs`, syntax checks, and the available non-ACP suites.
Full Zed/ACP and real-provider smoke still need validation in an environment with
`@agentclientprotocol/sdk` installed. The final integration test gate is the project's
configured verification suite; no browser/manual UX checks are fabricated.

## 2026-10-14: Explicit staged implementation reconciliation

- Added `src/implementation-reconciliation.mjs`: immutable Git hash snapshot,
  bounded delta detection, read-only structured analyst decision, session-scoped
  short confirmation token, exact-state validation, and human-readable report.
- A stale saved Plan/checkpoint no longer blindly invites unsupported
  `reconcile` commands. The first turn is read-only and only persists a
  proposal. The second turn must explicitly confirm its token. A mismatched or
  expired token performs no model calls, preparation, or writes.
- The same atomic session JSON persists the proposal, approved baseline and
  completed stage prefix. Legacy checkpoint formats are still accepted, but
  cannot claim an exact per-file delta when old hashes are unavailable.
- Known HEAD/branch changes and security-denied paths fail closed. Index
  changes remain visible and require consent. Every accepted reconciliation is
  marked as needing independent re-verification at the final acceptance gate.
- New checkpoints store dirty-file hashes (not contents). An interruption
  caused by out-of-band workspace drift no longer writes an implicitly
  rebased fingerprint to the stage checkpoint.
- No automatic retry, replan, rollback, or added coder loops.

Targeted tests: `test/implementation-reconciliation.mjs`,
`test/workflow-unstructured.mjs`, `test/session-store.mjs`, plus available
regression suites. Full ACP/Zed smoke depends on installing the SDK.

## 2026-10-15: Bounded automatic implementation reconciliation

- The existing saved Plan/checkpoint and provider-neutral read-only
  `implementationReconciliation` schema are reused; no additional runtime
  source of truth was introduced.
- A single explicit resume request automatically accepts only a validated,
  small, exact-state, HEAD/branch/index-stable change with a risk-free
  structured investigator verdict; tracked files clean in the previous
  snapshot are verified via `git ls-files` before eligibility is granted.
- Other analyzable changes receive a persisted state-bound proposal.
  Confirmation now uses ordinary words (`Подтверждаю согласование и продолжи
  реализацию плана`) rather than an exposed code. Bare `Продолжай` can resume
  only an interrupted implementation, not authorize a pending risky change.
- Approval of stale proposals, invalid checkpoints, protected paths, moved
  Git HEAD/branch or invalid analyses remains forbidden. New reconciliation
  still passes a final snapshot check before atomic persistence, then the
  existing pre-write gate verifies the checkpoint independently.
- Recorded revalidation obligations are passed to the final acceptance
  reviewer. Neither automatic acceptance nor confirmation marks previous
  evidence as proof of correctness. No extra coding attempts are scheduled.
- Test coverage includes automatic continuation, initially clean tracked
  files, index drift, no-code consent, legacy snapshots, stale proposals and
  existing staged workflow persistence. ACP/Zed integration requires SDK.
