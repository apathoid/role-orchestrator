# role-orchestrator

`role-orchestrator` is a model-agnostic coding-agent orchestrator for Zed/ACP. Codex-backed profiles run through `@agentclientprotocol/codex-acp` **2.3.0** (stable ACP v1) and optional OpenAI-compatible local model providers can use the same adapter.

It separates stable **roles** from replaceable **model profiles**:

```text
user task
  ↓
router
  ↓
explorer
  ↓
[planner]
  ↓
change: real project workspace → coder → verification → reviewer → [fix loop/final validator] → responder
review: reviewer → [final validator] → responder
investigate: explorer → investigator (native final response)
```

The workflow never hardcodes model names. Models live only in config (`profiles` + `roles`).

## Invocation recovery

A shared, provider-neutral [Invocation Recovery Engine](docs/INVOCATION-RECOVERY.md) handles bounded, safe replay of individual read-only role invocations after unexpected ACP provider cancellation. This applies regardless of route or active skill; it is not tied to `/review-code`. Mutable, externally effectful or unknown operations are never automatically replayed. Trace and P3 export record attempts, suppression, recovery and ACP cancellation counters.

Standalone read-only review now uses [Review Work Units and checkpoints v2](docs/REVIEW-WORK-UNITS.md): a verified Git-scope manifest where available, bounded file/criterion assignments, per-file evidence, and durable continuation without re-running verified units. Review grouping is configured via optional `policy.reviewWork` and is independent of skill names.

Review execution budgets now distinguish an explicit segment from the durable operation, with optional immutable hard ceilings and deterministic first-parent `last N commits` Git scope resolution. See [Review Execution Reliability](docs/REVIEW-EXECUTION-RELIABILITY-2026-10-27.md) for exact semantics, cancellation/recovery limits and Zed validation.

## Engineering Core

Non-trivial planning, implementation, and review use a provider-neutral **Engineering Core** built into the orchestrator rather than a Codex-specific skill. The Markdown sources live under `policy/engineering/` and define the default decision model: semantic generality without speculative complexity, mechanism/policy separation, lowest-correct ownership, extension of existing abstractions, source-of-truth discipline, lifecycle ownership, contract preservation, and smallest coherent change.

The policy is delivered by role rather than copied into every prompt:

- `planner` receives the kernel plus the full decision process and, for structured plans, must produce an `engineeringFrame` grounded in repository evidence;
- `coder*` receives a fresh kernel on every invocation, the task-local `engineeringFrame`, and compact pre-write/pre-finish checkpoints at the end of the prompt;
- `reviewer*` receives the same kernel plus an independent review rubric and treats the frame only as context to challenge;
- `finalValidator` receives only narrow hard invariants, so optional architectural preferences cannot become merge blockers;
- `router`, `investigator`, and `responder*` do not receive the Engineering Core unless their own role contract needs it.

The Engineering Core also reinforces observable, consistent acceptance criteria; hypothesis-discriminating investigation for non-obvious failures; and evidence-calibrated conclusions (`observed`, `supported`, `hypothesis`, `unverified`). These are risk-proportional quality checks, not new workflow loops, schema fields, or authorization to widen task scope. The global instruction template at [`examples/global/ORCHESTRATOR.md`](examples/global/ORCHESTRATOR.md) is optional; install it as `~/.agents/role-orchestrator/ORCHESTRATOR.md` to apply cross-project working preferences. It is intentionally not loaded from the source tree itself.

Project instructions (`AGENTS.md`, etc.) and active skills remain overlays. They describe the concrete repository architecture and conventions; the Engineering Core describes how to reason about responsibility inside that architecture. A project may intentionally choose a different architecture without the orchestrator trying to rewrite it into a preferred pattern, while correctness, contract integrity, resource/lifecycle safety, and other hard invariants remain independently reviewable.

For planner-backed tasks the frame records the current owner, nearby abstractions, general mechanism versus specific policy, target placement, state ownership, resource ownership, contract risks, explicit things to avoid, and remaining uncertainties. Low-tier workflows that intentionally skip the planner do not fabricate a frame; coder/reviewer still receive the core policy and checkpoints.

## Persistent Plan → staged implementation (Zed)

In Zed **Plan** mode, a structured planner result is saved to the existing atomic
outer-session JSON as `implementationPlan` (plan ID, full ordered steps, acceptance
criteria, Engineering Core frame and Git checkout fingerprint). No inner ACP
session is kept alive. In the **same Zed session**, switch back to Default and
ask **"Реализуй предыдущий план"** / **"Implement the plan"**. This explicit
request selects the saved plan rather than silently regenerating a different one.
Unrelated change requests keep the existing router → planner → coder path. If the
planner returned only free-form text instead of a structured plan, there is no
reusable plan: create a structured Plan first. A saved plan that no longer matches
the working checkout cannot start writing automatically.

For a plan with **four or more steps**, or a change explicitly applying a saved
Plan, coder work is split into contiguous stages (prefer three steps per stage;
at most **12 stages**, no silent truncation). Every stage has stable `S1…Sn`
identifiers and requires a structured `stepResults` record with concrete
implementation evidence. A lightweight `git diff --check` runs for paths
changed by each stage. Expensive configured verification runs **once after all
stages**, followed by independent reviewer/final-validator checking. For staged
change, the reviewer must report every `A1…An` acceptance criterion separately;
missing/unverified evidence, a failed verification command or a contradictory
review cannot yield `planCompleted: true`.

After each **completed** stage, `implementationCheckpoint` is saved atomically
with the same session persistence mechanism as the transcript. It contains only
completed work and the Git workspace fingerprint; partial stage edits are not
silently classified as done. On a provider interruption, the task ends with
`implementation_incomplete` and **no automatic coder retry**. Explicitly ask to
continue the plan to resume, and only if its plan ID and workspace fingerprint
still match. A previously interrupted stage must inspect existing partial edits
before making new ones. Git/editor changes from another source invalidate the
checkpoint; no `git reset`, file restoration or automatic replan occurs.

Small changes retain the original single-coder route. Fix rounds remain limited
by the existing `policy.maxFixRounds`, and all previously established security,
permission, timing, cancellation diagnostics, provider neutrality, model preset
and Engineering Core contracts remain in force. `verified` means evidence for
the configured checks and independent reviewer decision; it **does not** imply
that unrun browser/manual scenarios were tested. For those, report limitations
and leave relevant criteria unverified.

Zed's native Plan and Markdown display both strip numbering already embedded
in planner step text before adding the canonical list number. The same steps
are used in ACP task plan snapshots and in the saved authoritative plan.

## Repository access model

The orchestrator now follows the same basic workspace model as an IDE coding agent:

- `router`, `explorer`, `planner`, `investigator`, review-only `reviewer`, `finalValidator`, and final `responder*` roles run against the **real project checkout** with Codex `read-only` sandboxing.
- `coder*` runs against that same checkout with Codex `workspace-write`, so existing `node_modules`, package-manager workspace state, generated caches and the real reachable Git history are available naturally.
- There is no per-task private clone and no automatic dependency reinstall.
- The orchestrator captures the working-tree baseline before coding. This allows already-dirty editor state to remain in place while the workflow tracks which repository paths changed after the coding step began.
- Reviewers receive both the pre-existing baseline diff and the current working diff, plus the paths changed during the workflow.
- Successful changes are already present in the user's working tree; there is no final patch-transfer step.

This also means `/review-commit <sha>` and all read-only analysis operate directly against the actual repository history.

## Security boundary

The repository and its Git history are intentionally readable by model roles. If secrets were committed historically, rotate/revoke them instead of treating repository-history filtering as a secret-management mechanism.

Write protection is layered:

- `role-orchestrator` is the outer ACP agent seen by Zed; for Codex-backed roles it is also an inner ACP client of `codex-acp`;
- `codex-acp` starts Codex App Server and supplies Codex-native shell/file-change/permission/reasoning/plan behavior;
- read-only orchestrator roles select the native `read-only` mode; coder roles select `agent` for workspace writes;
- inner `session/request_permission` requests are proxied to the current outer Zed session for writable roles, while read-only role requests are rejected;
- `security.denyPaths` / `denyGlobs` remain an independent orchestrator policy. If coder or verification side effects touch a denied path, that path is restored to its pre-task state and the workflow stops while unrelated edits are preserved;
- Coder/fixer role contracts forbid Git commits, resets, ref updates and direct `.git` edits. Git HEAD/ref/index/local-config changes detected during preparation, coding and verification are reported as **observations**, without automatic Git rollback or unsupported claims about their author. Reviewers/fixers see these observations and must inspect current Git state before resolving a conflict. Read-only roles treat the checkout as a **live workspace**: concurrent changes to file contents, current `HEAD`/branch, or the Git index are reconciled in the same Codex ACP session. Changes to unrelated refs (for example a background fetch) or local Git config remain audit observations but do **not** consume reconciliation turns by themselves. These after-the-fact snapshots are **not** a substitute for sandbox restrictions or exclusive write isolation.

`implementation.changedFiles` is **not** a security allowlist. It is model-reported intent/summary. The authoritative change set is the actual workspace delta, so scripts may legitimately generate reports, snapshots, manifests or similar artifacts. Those mutations are retained, surfaced to review, and checked by the security policy.


## Thin ACP data plane

`role-orchestrator` intentionally keeps Codex behavior in `codex-acp` instead of reimplementing every capability. The outer agent advertises image and embedded-context prompts, preserves ACP `image`, `resource_link`, and embedded `resource` blocks, forwards project `additionalDirectories` to read-only nested roles and MCP server definitions into nested Codex sessions, and transparently relays user-facing nested ACP updates that are not part of the orchestrator's own control plane. Writable coder/fixer roles intentionally do not receive client-supplied `additionalDirectories`: those roots are outside the repository delta/security boundary and therefore cannot be granted as implicit extra write roots. This lets new Codex media/tool update types flow through without adding provider-specific workflow code.

### Commentary versus final-answer streaming

Codex `agent_message_chunk` events tagged with `_meta.codex.phase = "commentary"` are retained in role progress diagnostics and CLI output, but are **not** forwarded as outer `agent_message_chunk` updates. ACP clients (including Zed) concatenate agent-message chunks into the visible answer; forwarding intermediate intent text would prepend it to the investigator/responder's final response. `agent_thought_chunk` retains its own ACP update type, while explicitly tagged `final_answer` text, Markdown, file diffs and native media are forwarded unchanged. A defensive outer presentation filter also drops a commentary-phase message erroneously received through native passthrough.

On older adapters without phase metadata, text chunks are buffered until the role turn completes. If an explicit `final_answer` appears, the ambiguous chunks are discarded from the user-visible answer; otherwise they are emitted in their original order as a compatibility fallback. Fully unphased answers therefore remain available, but lose live token streaming until the end of the turn. During workspace reconciliation, superseded fallback chunks are discarded with superseded final candidates. No heuristic can reliably distinguish commentary from final text when **all** phase metadata is absent.

`codex-acp` advertises `image` and `embeddedContext`; it does **not** advertise audio input, so the orchestrator does not claim audio support. Resource links remain standard ACP content and are forwarded. Shell command cards remain hidden by the presentation policy unless explicitly enabled, while file diffs and other useful tool/media updates continue to pass through.

Routing is capability-safe rather than keyword-driven. The router emits a separate `writeIntent` (`explicit`, `not_requested`, or `ambiguous`). A `change` route is honored only when write intent is explicit or the user explicitly selected `/change`; requests such as “how can I fix this?”, “investigate this”, or “show me an example” stay read-only even if the subject matter is an implementation problem. Explicit requests such as “implement this”, “fix it”, or “write/add these tests” permit the normal coder workflow.

### Conversation continuity and outer session titles

Inner Codex ACP sessions remain invocation-scoped so each role keeps its own permissions and control contract, but that does **not** mean each role starts without the user's conversation. The outer ACP session persists exact text user/final-assistant turns plus attachment references. Snapshot-capable ACP `image` and embedded `resource` payloads live in a separate per-session content-addressed attachment store; session JSON contains only metadata/`sha256:` references. `resource_link` remains link metadata and is never downloaded by the orchestrator. Recent historical attachments are rehydrated into fresh inner role sessions with explicit text markers that identify them as earlier user context rather than new instructions. Current-turn content blocks are always appended unchanged and are not displaced by the historical-media budget. The outer session also carries a separately bounded workflow-memory layer containing compact explorer/review/verification findings, so useful constraints that never made it into the final assistant prose can survive into later turns.

Historical media replay is bounded independently from transcript text. By default at most 8 historical attachment items / 32 MiB decoded payload are supplied to one inner invocation, preferring newer turns. Persistence defaults are 16 MiB per attachment, 32 MiB decoded attachment payload per turn, 256 MiB per session, and 1 GiB globally. These limits are configurable with `AGENT_ATTACHMENT_MAX_SINGLE_BYTES`, `AGENT_ATTACHMENT_MAX_TURN_BYTES`, `AGENT_ATTACHMENT_MAX_SESSION_BYTES`, `AGENT_ATTACHMENT_MAX_GLOBAL_BYTES`, `AGENT_ATTACHMENT_MAX_HISTORICAL_ITEMS`, and `AGENT_ATTACHMENT_MAX_HISTORICAL_BYTES`. A current attachment that exceeds a persistence limit is still forwarded for the current invocation; its transcript metadata records `persisted=false` and the refusal reason so later turns do not receive a broken reference.

Nested-session metadata is not part of the transparent user-facing data plane. In particular, inner `user_message_chunk` echoes and `session_info_update` notifications are kept private: forwarding them would expose internal role prompts or let an ephemeral role rename the outer Zed conversation. The router instead suggests one concise task-focused title for the outer conversation; `role-orchestrator` publishes it with ACP `session_info_update`, bounds it to a short human-readable form, and persists it with the outer session. No separate title-generation model call is required.

Generic role contracts deliberately do not prescribe Git-history inspection or a fixed list of shell tools. Repository history remains available, but explorer/investigator/coder/reviewer choose evidence sources themselves. `/review-commit` is the exception because the requested commit and its parents are explicitly the review subject.

## ChatGPT Plus / Codex authentication

Cloud profiles use the Codex runtime bundled by `@agentclientprotocol/codex-acp` and the normal Codex ChatGPT authentication state. Authenticate once with Codex if needed (`codex login`). The subscription provider passes Codex configuration that forces ChatGPT login mode, so a global API-key configuration cannot silently switch this workflow to API billing. `CODEX_PATH` may be configured if you intentionally want `codex-acp` to launch a specific Codex executable.

## Install

Requirements:

- Node.js >= 22.20.0
- Git
- `@agentclientprotocol/codex-acp@2.3.0` and `@agentclientprotocol/sdk@2.1.0` (installed by `npm install`)

```bash
npm install
npm test
```

Run from a repository:

```bash
AGENT_REPO=/path/to/project npm run agent -- 'Implement the requested change'
```

Review without edits:

```bash
AGENT_REPO=/path/to/project npm run agent -- --mode review 'Review my current changes'
```

Review a real commit:

```bash
AGENT_REPO=/path/to/project npm run agent -- --review-commit 6a6e8ebff6 'Focus on regressions and tests'
```

## Model-agnostic configuration

Example role mapping:

```json
{
  "profiles": {
    "economy":  { "provider": "subscription", "model": "..." },
    "balanced": { "provider": "subscription", "model": "..." },
    "strong":   { "provider": "subscription", "model": "..." },
    "frontier": { "provider": "subscription", "model": "..." }
  },
  "roles": {
    "router": "balanced",
    "explorer": "economy",
    "planner": "frontier",
    "investigator": "balanced",
    "coderLow": "balanced",
    "coderMedium": "balanced",
    "coderHigh": "strong",
    "reviewerLow": "balanced",
    "reviewerMedium": "strong",
    "reviewerHigh": "strong",
    "finalValidator": "frontier",
    "responderLow": "balanced",
    "responderMedium": "strong",
    "responderHigh": "strong"
  }
}
```

The workflow code only knows role names. Replacing models or moving a role between cloud/local providers requires config changes only.

ACP turns use two independent timing limits instead of one fixed wall-clock timeout:

- `idleTimeoutMs` — cancelled only when the inner agent produces no ACP session activity for this long. Reasoning/thought chunks, commentary, plan updates, tool updates, usage updates, and other native session updates refresh this watchdog. The bundled subscription provider defaults to **10 minutes**.
- `turnDeadlineMs` — an absolute ceiling for one inner ACP prompt turn and is never refreshed. The bundled subscription provider defaults to **45 minutes**.

The idle watchdog is paused while the orchestrator is waiting for an outer user permission/elicitation response, while the absolute deadline keeps running. `timeoutMs` remains accepted as a legacy compatibility setting; when used alone it supplies both limits and therefore preserves the old fixed-timeout behavior. New provider/profile configs should prefer the two explicit fields. Per-profile values override provider defaults.

Intermediate reasoning summaries are unchanged by this policy: they are still forwarded to the UI and now also count as evidence that the provider is alive rather than consuming a fixed 15-minute budget regardless of progress.

### Inner ACP cancellation and timing diagnostics

Unexpected `stopReason=cancelled` (`[PROVIDER_CANCELLED]`) now includes a bounded, payload-free `diagnostics.innerAcp` snapshot for both `codex-acp` and generic ACP adapters:

- `turnNumber`, `turnElapsedMs`: the current inner ACP prompt (separate from total invocation `elapsedMs`);
- `configuredTiming.idleTimeoutMs` / `turnDeadlineMs`: resolved settings actually used by the outer watchdog;
- `acpUpdateCount`, `lastAcpUpdateType`, `msSinceLastAcpUpdate`: the last **ACP notification** from the inner agent (not its private model/network Responses stream);
- `outgoingCancelCount`, `outgoingCancels`: bounded list of locally initiated `session.cancel` notifications, each containing the initiator (`outer_signal`, `idle_timeout`, `turn_deadline`), optional typed outer cancellation reason, elapsed time, and transport submission status;
- `localTimeout`, when present, identifies the fired watchdog (`idle` or `deadline`).

`notificationStatus=submitted` means the local ACP send promise resolved, **not** that the inner provider acknowledged or obeyed the cancellation. A zero `outgoingCancelCount` alongside `[PROVIDER_CANCELLED]` establishes only that this adapter did not send `session.cancel`; it cannot prove why Codex itself stopped (for example, an upstream Responses stream timeout). Local ACP timeouts surface as `[TIMEOUT]` with the same diagnostics, rather than being misclassified as a provider-initiated cancellation or crash. Cancellation policy, timeout values, and stream forwarding are unchanged; the implementation does not automatically retry provider cancellations. No prompts, reasoning text, or tool payloads are captured in diagnostics.

Cancellation provenance is preserved separately from timeout handling. Expected outer cancellations carry a stable reason through `AbortSignal.reason` (`CLIENT_REQUEST_CANCELLED`, `SESSION_CANCELLED`, or `SUPERSEDED_BY_NEW_TURN`) and are reported as cancellations rather than task failures. An inner ACP provider that returns `stopReason=cancelled` while the outer workflow is still active is **not** treated as if the user cancelled the task; it is surfaced as `[PROVIDER_CANCELLED]` with role/profile/session diagnostics. Provider/runtime failures shown for a role are prefixed with their normalized code (for example `[TIMEOUT]` or `[MODEL_UNAVAILABLE]`) so a generic `Operation aborted` no longer hides the failure source.

See:

- `config/chatgpt-plus.json`
- `config/hybrid-plus-local.json`
- `config/project-security.example.json`

## Preparation and verification

Verification runs in the real project workspace. Existing project-local tools therefore work normally, including binaries resolved through `node_modules/.bin` by npm/pnpm/yarn scripts. No dependency installation is performed automatically.

Optional project-specific preparation is still available when explicitly configured:

```bash
export AGENT_PREPARE_COMMANDS='[
  ["pnpm", "run", "generate"]
]'
```

Verification commands can be overridden:

```bash
export AGENT_VERIFY_COMMANDS='[
  ["pnpm", "run", "typecheck"],
  ["pnpm", "run", "test"]
]'
```

Optional trusted verification input closure for durable Evidence Matrix freshness:

```bash
export AGENT_VERIFY_INPUT_CLOSURES='{
  "node check.mjs": {"complete": true, "paths": ["check.mjs", "runtime.flag"]}
}'
```

Only declare `complete: true` when these are **all** inputs influencing that command, including Git-ignored files. This operator-supplied manifest is never inferred from a reviewer, model or Git status. Without a proven closure, `PASS` still means the command ran successfully, but its reusable evidence freshness remains `unknown` rather than falsely `verified`. External service and environment dependencies generally cannot be proven complete by a file list. See `docs/P2-QUALITY-RECOVERY.md`.

Each verification command is classified as `PASS`, `TEST_FAILED`, `TOOL_UNAVAILABLE`, `ENVIRONMENT_ERROR`, or `INFRA_FAILURE`. Environment/tooling failures do not by themselves trigger a coder fix loop. If review passes but checks cannot run, the workflow completes as `completed_with_unverified_checks` and leaves the working-tree changes intact.

In a change workflow, verification commands **may** update ordinary project artifacts (for example architecture reports or snapshots). The orchestrator captures those side effects as a separate workspace delta, subjects them to the same sensitive-path policy, and includes their resulting state in the reviewer evidence. Review-only verification rejects changes to tracked/non-ignored project files or Git metadata, but does not automatically restore the changed files or Git metadata: a concurrent user operation could otherwise be overwritten. Security-denied ignored paths are independently restored by the sensitive-path policy. Ordinary ignored cache/dependency files are intentionally outside the general Git workspace delta.

After each verification command the orchestrator checks Git HEAD/ref/index/local-config state and emits a `git_metadata_drift` event when it differs from the previous observation. The event contains changed field names and added/removed/updated ref names, but never staged diff contents or Git config values. The interval is diagnostic **only**: an editor, another agent, or Git itself may have made the change concurrently. No Git metadata is rolled back, including on verification failure. Reviewers, fixers and the final responder receive those observations; the CLI and Zed ACP transcript display them. Existing sensitive-path detection and rollback remain independent and still stop the workflow.


## Zed / ACP

Add the custom external agent to Zed:

```json
{
  "agent_servers": {
    "Role Orchestrator": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/role-orchestrator/src/acp.mjs"],
      "env": {
        "AGENT_CONFIG": "/absolute/path/to/role-orchestrator/config/chatgpt-plus.json"
      }
    }
  }
}
```

Then choose **Role Orchestrator** in the Agent Panel.

Supported commands include:

```text
/review <task>
/review-commit <revision> [focus]
/change <task>
/investigate <task>
/skills
/skill <name> [task]
```

Project and personal skills are discovered from `.agents/skills/.../SKILL.md`. Project instructions are loaded independently for the external agent.

Skills may influence both execution and the final presentation, but they do not change role permissions. The orchestrator still keeps machine decisions such as reviewer `verdict`/`issues` private for control flow. The final user-facing role receives the applicable project/user instructions and skills and is free to present the answer naturally instead of filling an orchestrator-owned Markdown template.

The ACP reporter publishes both a preliminary role route and the grounded execution plan before the write/review phase, and shows the currently running role in real time. The route controls **which resources/roles run**, not the formatting of the final answer.

### Codex runtime, reasoning and commentary inside each role step

For `type: "codex-acp"`, the runtime is nested ACP rather than `codex exec --json`:

```text
Zed (ACP client)
  ↕
role-orchestrator (outer ACP agent / inner ACP client)
  ↕ stdio ACP v1
@agentclientprotocol/codex-acp 2.3.0
  ↕
Codex App Server
```

The provider forwards native `agent_thought_chunk`, phase-tagged commentary/final messages, plan updates, usage updates and tool telemetry. Streaming thought/commentary chunks are forwarded verbatim: the orchestrator does not trim them or append line breaks between chunks. These native updates also refresh the ACP idle watchdog; they do not extend the absolute turn deadline. Permission requests from writable Codex roles are forwarded through the outer ACP connection to Zed, and the idle watchdog is paused while the outer user is deciding.

For tool telemetry, file/edit tool calls and ACP `diff` content remain visible, while shell-command (`execute`) tool calls are hidden from the outer Zed transcript by default. This prevents `Run Command` cards from exposing long command lines or utility output while preserving Codex's native edit/diff UI. The provider emits complete unfiltered tool events to the workflow; **only the ACP host adapter** applies display filtering. The provider also retains unfiltered command events in invocation metadata. Set `providers.<name>.showCommandToolCalls: true` to restore command cards; with command cards enabled, successful stdout/stderr remains hidden unless `showSuccessfulCommandOutput: true` is also set, while failed command output remains visible for diagnostics.

### Control plane vs native presentation

Structured output is now reserved for **internal orchestration data**, not for deciding how the user sees the answer. `router`, `reviewer`, and `finalValidator` still prefer machine-readable JSON because their fields control routing/review/escalation. `explorer`, `planner`, and `coder` may also use structured data as downstream evidence. Parsing remains tolerant: malformed structured output is preserved as text, and the workflow never invents a missing decision.

User-facing presentation is separate:

- `investigator` is a read-only final-response role for investigate/advice tasks and receives **no orchestration response schema**;
- completed `change` and `review` workflows end with a read-only `responder*` selected by the same routing tier;
- these presentation roles choose their own Markdown, prose, lists, tables, fenced code blocks, or fenced unified diffs based on the task;
- their native final `agent_message_chunk` stream is forwarded to Zed unchanged instead of being parsed and rendered again by the orchestrator;
- actual Codex file edits continue to use native ACP edit/diff tool events, so Zed can render real file changes with its normal diff UI.

For example, “investigate this and show me the proposed code, but do not edit files” stays read-only while the investigator can return a readable fenced code block or unified diff directly in chat. The route chooses models/capabilities; it does not force `Findings`/`Evidence` headings or any other presentation template.

Live-workspace reconciliation is presentation-safe: final-answer chunks from read-only presentation roles remain buffered until a post-turn workspace check observes a stable **semantic** repository state. File-content changes plus current `HEAD`/branch/index changes can invalidate repository assumptions; unrelated ref movement and local Git-config writes are logged for audit but ignored by this decision. Before spending another model turn, semantic drift receives a short bounded confirmation window (`AGENT_RECONCILIATION_STABILITY_MS`, default 125 ms) so transient editor/index refreshes can settle. If semantic state changes again during a reconciliation turn, the same inner Codex session re-reads the newer state and revises the answer again. The provider allows up to three revised turns; if the workspace still never stabilizes, the error includes the recent semantic drift observations rather than only a generic retry count. If no semantic drift occurred, the buffered native answer is flushed unchanged.

`codex-acp@2.3.0` also exposes the experimental AIR `sessionFailure` capability after capability negotiation. The inner ACP client opts into it, so usage/quota, context-window, authentication, transport, service, and related terminal failures retain the adapter's user-facing title and machine-readable category instead of collapsing to a bare `Internal error`. The orchestrator does not reinterpret those categories; it surfaces the provider's failure and aborts the affected control workflow. JSON-RPC `RequestError` message/data extraction remains as a compatibility fallback for legacy or non-negotiated failures; only known diagnostic fields are forwarded from arbitrary upstream error data.

Provider-native tool behavior does not replace routing, role boundaries, verification policy, review/fix/escalation decisions, project skills, or the sensitive-path policy.

### Native Codex mode controls in Zed

For Codex-backed work, the outer ACP session mirrors the two controls already provided by `codex-acp@2.3.0`; `role-orchestrator` does **not** reimplement their behavior:

- native **AgentMode**: `Ask for approval` (`read-only`), `Approve for me` (`agent`), and `Full access` (`agent-full-access`);
- native **Collaboration mode**: `Default` or `Plan` through the `collaboration_mode` session config option.

The outer session only persists the selected IDs and forwards them into newly-created inner Codex ACP sessions. Approval decisions, sandbox presets, auto-review behavior, full-access behavior, and Plan-mode prompting remain owned by `codex-acp`/Codex. In particular, the orchestrator never translates these choices into its own `allow_once`/`allow_always` policy and does not append a custom Plan prompt.

Role boundaries still take precedence over user-selectable provider permissions. Machine/read-only roles (`router`, `explorer`, `planner`, `investigator`, reviewers, validators, responders) are always started in native `read-only` AgentMode and any attempted write escalation from those roles is rejected. A writable coder receives the user's selected native AgentMode unchanged.

`Plan` remains provider-native rather than becoming a separate orchestrator routing mode. The orchestrator does **not** downgrade an explicit `change` route to `investigate`. Instead, the selected collaboration mode is delegated only to the role that is actually executing the current user task (`investigator` or a writable `coder`). Control roles and the final `responder*` stay on `default`, so a completed workflow cannot accidentally start a second Plan flow while phrasing the answer.

`codex-acp`/Codex may transition `collaboration_mode` from `plan` to `default` after its native plan-approval flow. That specific inner config update is synchronized back into the persistent outer session/UI and into later coder/fix invocations in the same workflow; unrelated inner config metadata stays private. The orchestrator still does not implement the approval or Plan semantics itself.

Native form **and URL** elicitation capabilities are forwarded through the outer ACP connection when the Zed client advertises them, so Codex can use its normal elicitation flows rather than requiring an orchestrator-specific substitute.

### Model catalog and fast-tier capability

Role assignments (`profiles`, `roles`, `rolePresets`) are edited in the JSON
config. Zed's ACP session toolbar does not expose per-role model/reasoning
editors. The provider model catalog supplies metadata for resolving compatible
models: both `providers.<name>.supportsFastMode` **and** the exact model's
`supportsFastMode` must be `true` to opt into the session Fast mode switch.
Explicit `supportsFastMode: false` on an assigned profile also disables it.
Unknown capability is treated as unsupported. Generic `acp-agent` providers
can advertise the feature with `supportsFastMode: true`, but must also configure
their native boolean ACP control ID as `fastModeConfigId` so that the adapter
can actually forward the request.

Example provider catalog entry:

```json
{
  "id": "some-model",
  "name": "Some Model",
  "contextWindow": 1050000,
  "reasoningEfforts": ["low", "medium", "high"],
  "supportsFastMode": true
}
```

### Role presets in Zed

Use `rolePresets` (optional) in an `AGENT_CONFIG` override to declare named role configurations. For an example with **GPT 5.6**, **High Performance**, **Efficient** and an inline override, see [`config/role-presets.example.json`](config/role-presets.example.json). `config.roles` remains the required, stable base map of named profiles. A preset may override a role by naming an existing profile **or by specifying its model/profile fields inline**, without adding a profile or modifying `roles`. Example:

```json
{
  "rolePresets": [
    {
      "id": "experimental",
      "label": "Experimental",
      "roles": {
        "router": "triage",
        "reviewerMedium": {
          "model": "gpt-6.1-sol",
          "reasoningEffort": "medium"
        },
        "coderHigh": {
          "provider": "subscription",
          "model": "gpt-6-astra",
          "reasoningEffort": "high"
        }
      }
    }
  ]
}
```

**Three forms are supported:** (1) `"reviewerMedium": "strong"` uses a reusable named profile; (2) `"reviewerMedium": { "model": "...", "reasoningEffort": "high" }` overlays the *fixed base profile* from `config.roles.reviewerMedium` and inherits its provider and other unspecified profile fields (except stale model-specific capability metadata and fast-tier state when the model changes); (3) `"reviewerMedium": { "provider": "local", "model": "..." }` is a complete provider/model assignment and does **not** inherit provider-specific fields such as `providerOptions` from the original profile. When `provider` is specified, `model` is required. The named provider must exist in `providers`; the model ID need **not** occur in `profiles`, `roles` or the optional `providers.<provider>.models` metadata list. However, the provider must really accept that model ID at runtime.

Inline fields go through the **same profile validator** as `profiles`: unknown providers, invalid timeouts, invalid `providerOptions`, etc. fail configuration loading with preset and role context. The resulting profile is copied into the session's canonical `roleAssignments`, with a diagnostic `profileName` such as `inline:reviewerMedium`; there is no separate inline execution path. Provider/model capability metadata is not guessed: an unlisted model cannot use the session-wide Fast mode toggle without explicit metadata opting it in.

The omitted role assignments come from the **fixed configured `roles` map**, not from whatever was previously selected in Zed. `rolePresets` may be omitted or `[]`; the preset selector is then hidden, while models and role mappings remain configured in the JSON file. An optional `defaultRolePreset` ID applies **only to new sessions**; a restored legacy session uses its original effective profile overrides rather than receiving the new default retroactively.

With configured presets, Zed's ACP session toolbar shows only the existing native **Approve for me** and **Default** controls, a **Role preset** selector, and a session-wide **Fast mode** toggle (when at least one assigned role supports it). The preset list is **Custom** followed by configured presets in declaration order. There are no per-role model/reasoning selectors, shared-profile template editors, or profile navigation controls in Zed; edit `profiles`, `roles` and `rolePresets` in your JSON config instead. When no presets are configured, the **Role preset** selector is hidden. Zed shows the selected *option label* in its compact dropdown, so the values are prefixed `Role preset:` for clarity.

Selecting a preset materializes all 14 role assignments atomically; the running workflow uses its own snapshot. **Fast mode** is a separate session-scoped speed override: enabling it requests the fast service tier for **every** eligible role assignment in the selected preset (or Custom configuration). Models on unsupported providers, models without an explicit opt-in, and explicitly opted-out profiles are not changed. Disabling it requests the default tier for those same eligible roles. The switch applies when the next workflow starts; already running workflow snapshots remain unchanged.

The toggle is persisted as `fastModeOverride` in the existing session JSON, independently of `roleAssignments`. It remains effective when switching presets and after restoring the session; it does not mutate the saved role assignments or profile templates. Therefore it does **not** turn a matching preset into `Custom`. For older sessions with no override, each role retains its previously materialized `fastMode` configuration; the switch reads as enabled only if all eligible roles currently request fast mode. This preserves older session behavior until the user changes the switch.

**Custom is derived, not stored.** The selector shows the first preset whose *fully resolved effective role profiles* exactly match the session's materialized role assignments, otherwise `Custom`. Model name, provider, reasoning, speed, provider options, and other profile fields participate in matching; named-profile labels are not compared. Merely selecting `Custom` changes nothing. Changing a preset declaration does not reapply it to existing sessions: saved role assignments remain authoritative, so the restored UI can show `Custom` after an edit to a preset definition.

`roleAssignments` is stored in the existing atomic session JSON, in addition to legacy-compatible profile-template overrides. This is not a new storage system; sessions from earlier versions without materialized assignments are migrated from their effective profile overrides when loaded. No `presetId` is used for workflow execution. Preset matching and the ACP fast-mode control do not modify routing tiers, write intent, security, verification, or cancellation handling.

The ACP agent responds to `session/set_config_option` with the complete updated `configOptions` and publishes a `config_option_update` notification, enabling clients to refresh dependent controls. Exact widget placement and how quickly Zed redraws sibling controls depend on the installed Zed version. There is no Zed-specific UI workaround.

Fast mode is exposed by role-orchestrator as the ACP boolean option `Fast mode`. It is a service-tier request forwarded by supported provider adapters (`codex-acp` sets `fast-mode`; `codex-cli` requests `service_tier`), not a promise that the backend actually grants the fast tier. The toggle is hidden if no role currently has declared support.

### Context usage

`codex-acp` usage updates are forwarded to the outer ACP session together with the configured context-window value. Each orchestrator role currently gets a separate inner Codex ACP session for its invocation, so usage remains role-scoped rather than one accumulated Codex context shared by every role. Outer `role-orchestrator` sessions remain durable across Zed restarts.

### Message spacing

Role starts/finishes are emitted as separate ACP message blocks with explicit blank-line boundaries. In particular, the first `▶ role` line is no longer part of the Markdown list used for `Preliminary route`. Planner-authored task steps are shown only through the native ACP Plan widget, without a duplicate Markdown `Task plan` block.

## Durable ACP sessions

The storage directory is derived from `package.json` rather than a hardcoded project string.

With the current package name:

```text
role-orchestrator
```

the default session directory is:

```text
$XDG_STATE_HOME/role-orchestrator/sessions/
```

or, when `XDG_STATE_HOME` is unset:

```text
~/.local/state/role-orchestrator/sessions/
```

Override it with:

```bash
AGENT_STATE_DIR=/custom/private/location
```

If you used an older build with a different hardcoded directory name, move that directory manually to the new package-derived location before reopening old Zed sessions.

Persisted outer sessions are repository-bound. `session/load` or `session/resume` may use a different subdirectory of the same Git repository, but attempting to reopen the same orchestrator session against another repository is rejected instead of carrying old conversation constraints into unrelated code. Prompt turns for one outer session are serialized: a newer prompt cancels the prior/pending turn and waits for it to release provider/workspace activity before starting.

That serialization cancellation is explicitly tagged `SUPERSEDED_BY_NEW_TURN`. A direct outer request cancellation is tagged `CLIENT_REQUEST_CANCELLED`, while an ACP `agent.session.cancel` notification is tagged `SESSION_CANCELLED`. The first cancellation reason wins if several signals race, which makes intermittent aborts diagnosable instead of collapsing all paths to the same message.

Attachment payloads are stored under:

```text
$AGENT_STATE_DIR/attachments/<session-id>/<sha256>
```

or the equivalent directory under the default state root. Session-store v1 files are migrated lazily to v2 on load; legacy text-only turns simply gain an empty `attachments` array. Blob writes and session JSON writes use same-directory temp files plus atomic rename/fsync. The commit order is attachment blob + pending marker → atomic session JSON → eager unreachable cleanup → pending-marker release. Pending protection is acquired even for a CAS dedup hit, so an orphaned-but-reused blob cannot be collected before its new transcript reference commits. A crash can therefore leave an orphan, but cannot make GC delete a blob that is already referenced by durable session state. If the session JSON rename succeeds but directory fsync reports an unexpected durability error, the save is treated as installed and destructive eager cleanup is deferred; retaining extra blobs is safer than risking a resurrected pre-crash JSON that references deleted data.

Normal trimming/session deletion performs eager cleanup. Startup and a 10-minute periodic reconciliation additionally run reachability-based mark-and-sweep from persisted session JSON. Fresh pending blobs, attachment temp files, and atomic session-write temp files receive a one-hour orphan grace period (`AGENT_ATTACHMENT_ORPHAN_GRACE_MS`); the periodic interval is configurable with `AGENT_ATTACHMENT_GC_INTERVAL_MS`. GC never traverses symlinked attachment/session/pending roots. Corrupt session JSON protects that session's entire attachment directory rather than guessing which blobs are dead. Missing/corrupt referenced blobs degrade to explicit historical-unavailable context and do not make the outer session unloadable. Quota accounting conservatively includes partial regular files, and global quota pressure triggers one reconciliation pass before a new attachment is refused; referenced blobs are never silently evicted to make room.

## Write security policy

`security.denyPaths` and `security.denyGlobs` form an independent write boundary around the real project workspace. Mutations to denied paths are detected even when Git normally hides the path as ignored (for example `.env` or `*.key`); denied mutations caused by coder/fixer turns, preparation commands, or verification are restored to their pre-mutation state and stop the workflow, while unrelated allowed workspace edits are preserved. `allowPaths` / `allowGlobs` provide explicit exceptions where supported by the policy precedence rules.

Example:

```json
{
  "security": {
    "denyPaths": ["config/local-secrets.json"],
    "denyGlobs": ["**/*.private.json"],
    "allowPaths": ["fixtures/public.private.json"]
  }
}
```

These rules do **not** hide the original repository/history from read-only model roles in the trusted repository mode.

## Tests

```bash
npm test
```

The smoke suite verifies, among other things:

- review/investigate roles stay read-only;
- `/investigate` invokes a dedicated investigator and no longer runs an unused planner;
- investigator/responder final answers remain native free-form ACP/Markdown rather than being forced into orchestrator-owned headings;
- coder roles use `workspace-write` in the real project checkout;
- existing project-local `node_modules/.bin` tools are visible to verification;
- `TOOL_UNAVAILABLE` completes as unverified without a meaningless fix loop;
- real commit review works against the source repository;
- dirty-editor follow-up tasks remain supported;
- denied output paths are restored/rejected, including preparation and verification-command side effects;
- Git index/ref/local-config mutations are detected, reported per stage/verification-command interval, and preserved without implicit rollback;
- review-only verification detects tracked/non-ignored file or Git metadata changes and fails without destructive rollback;
- historical commit review resolves the requested revision and never invokes a coder;
- writable roles do not inherit unmonitored `additionalDirectories`;
- generated/unreported ordinary files are accepted as real workspace mutations rather than rejected because the model omitted them from `changedFiles`;
- Codex-backed roles communicate through the nested ACP provider contract;
- cloud and hybrid provider routing still work;
- session storage resolves from the package name and persisted sessions are repository-bound;
- config validation rejects unsupported provider types and malformed policy/profile values before the first model invocation.

### Zed Plan shows the task plan

The native ACP/Zed **Plan** widget represents the planner's grounded task steps, not the internal orchestration route. The model route is still printed in the transcript as **Preliminary route** so you can see which roles/models are expected to run.

When the planner returns a structured `plan.steps`, `role-orchestrator` sends those steps as a full ACP `plan` snapshot. Internal fallback scaffolding used by low-tier or malformed-planner workflows is **not** advertised as a planner-authored Zed Plan, and `/investigate` emits no synthetic task plan because it does not invoke the planner. Inner Codex plan updates received from `codex-acp` update the outer entries' `pending` / `in_progress` / `completed` statuses while the planner-authored text remains authoritative. Executor roles receive a strict progress contract requiring the same item count/order and progressive status updates instead of reporting the whole checklist only at turn completion. Incompatible, regressive, or reordered inner snapshots are ignored with a diagnostic rather than corrupting the Zed Plan; an initial all-pending provider snapshot also cannot erase the outer `role_start` in-progress marker. If no valid inner plan updates are produced, the last valid planner-authored task plan remains visible and is marked complete when the workflow completes.


### Zed Plan mode (outer orchestration)

Selecting **Plan** in Zed's collaboration-mode selector now runs a dedicated
read-only route: router → explorer → planner. It returns the planner's grounded
Markdown plan (steps, acceptance criteria, relevant files, risks) and publishes
ACP plan entries for structured output. It **does not run a coder, preparation,
verification commands, or any write stage**, even when the task itself includes
a request to implement or a `/change` slash command. The mode is snapshotted
at outer turn acceptance; switching during a run only affects later turns.

**Default** retains the existing investigate/review/change routing behavior.
The native Codex collaboration mode of individual internal agents stays Default
while the outer Plan workflow is active: there is only one planner owner.
The session and plan transcript are stored by the existing persistence layer.

### ACP tool calls and permissions

The outer ACP bridge namespaces tool IDs by outer turn, provider and inner
session. ACP v1 `tool_call_update` messages are forwarded only after a public
`tool_call` exists. A first update containing a valid title can be converted
into a v1 create (for agents using upsert-style reporting); otherwise orphan
updates are logged and withheld rather than producing Zed's “Tool call not
found” card. Permission requests refer to the same outer tool IDs; if the
underlying command card was hidden, the bridge creates a permission subject
card before requesting approval. No additional permissions are granted.

### Read-only review scope and bounded completion

A Git SHA mentioned inside a review plan, historical discussion or pasted checklist
is **not** automatically a target commit. `/review-commit <revision> [focus]`
explicitly selects a commit; the natural-language shortcut works only for a
leading `Review commit <sha>` directive. Normal `/review` and review skills
preserve the full task scope without inferring a target from incidental SHAs.

For read-only review workflows, `src/review-coverage.mjs` derives a stable
checklist from explicit Markdown `### Steps` and `### Acceptance criteria` in
the user task, falling back to the planner's checklist only when no explicit
checklist is present. It distributes up to **32 checks in four fixed batches**
(eight per batch) to the configured reviewer role, with at most **one additional
format-repair call** across the whole workflow. There are **no retries for
unverified checks** or live workspace drift; excess items remain visibly
unverified. This budget is independent of the existing provider idle/deadline
limits and cancellation provenance.

Review-only structured output uses `scopedReview` and requires coverage rows
with exact checklist IDs, `checked` / `blocked` / `not_checked` status,
and concrete evidence. It also requires a Git file inventory. When the user
states a changed-file count, the final inventory must reconcile that count
and claim full file coverage, or the workflow is **`review_incomplete`**.
An unavailable, malformed or conflicting report never silently becomes a
`review_passed`. File counts and evidence come from the reviewer, not an
independently authenticated manifest; such reporting is an accountability
mechanism, **not cryptographic or automated proof that every file was
inspected**. The reviewer must use actual repository evidence and disclose
what was not checked.

The orchestrator captures the workspace before and after review batches;
semantic live drift invalidates a full pass without attributing or restoring
external changes. Missing checklist items, unverified file inventories,
malformed outputs and exhausted batch budgets all yield `review_incomplete`,
with the missing coverage in the machine result, response and session history.
A mismatched role result cannot mark the Zed plan complete. Findings from the
portion already reviewed are retained and reported distinctly from coverage.
Only `review_passed`, `review_findings` and `review_unresolved` mean the
requested checklist was accounted for. This guard applies to review-only mode,
not to the existing change/fix workflows or Zed's Plan-only mode.

### Review-only skill presentation

Review-only findings are rendered deterministically from the authoritative
structured finding ledger. An active skill can request a quoted report title
(e.g. `Use the heading "Skill review format"`) and an `Evidence` section.
The optional Evidence section reports reviewer coverage and workflow verification
provenance, rather than implying independent confirmation of reviewer claims.
Skills can also reorder the four required report sections by explicitly listing
all four `###` headings. The standard sections and finding IDs cannot be
suppressed, duplicated or replaced by model-authored prose. Other arbitrary
skill-provided sections are not synthesized without a corresponding trusted
data source.

### Review batch continuity

Review-only workflows break large checklists into at most four bounded batches. Each batch receives a compact summary of prior findings and explicitly assigned check IDs. The Zed timeline shows `Review batch N/M` before the corresponding reviewer call, followed by checked/assigned counts. Separate acceptance criteria remain separately verifiable, even when grouped with a related step.

Successful batch outputs are checkpointed atomically in the existing ACP session store. If a provider fails during a later batch, the review finishes as `review_incomplete`, preserving completed evidence and identifying the interrupted group; the orchestrator does **not** retry rate limits, unexpected cancellations, or malformed outputs automatically. Repeating the identical request in the same persisted session can resume completed batches when the checkout and review contract have not changed. A changed Git checkout, task, skill context, or checklist invalidates that reuse. The outer router, explorer and planner still run when continuing, so a newly generated plan that differs will deliberately force a fresh review. A single user's cancellation stops the workflow without an automatic recovery loop.

## Automatic safe reconciliation after manual workspace changes

Staged implementation **never** silently discards its saved Plan or completed
stages. On `Продолжи реализацию плана` (or a bare `Продолжай` when the same
session has an `in_progress` **or `interrupted`** implementation checkpoint), a changed checkout is
analyzed **read-only before any preparation or coder invocation**.

For a small, well-understood change, the same turn can automatically accept
an updated baseline and continue **only** if all of these checks pass:

- The saved Plan and checkpoint validate, and the previous dirty-file hash
  snapshot is available (`exact` comparison). Previously clean tracked files
  are recognized through Git; new/untracked/deleted dirty paths require consent.
- HEAD, branch and Git index are unchanged; changed paths are within the
  configured security policy and the bounded auto-accept budget (20 paths).
- The read-only investigator returns a valid structured `compatible` or
  `reverify` decision with no unresolved risks. Affected stages and their
  required integration checks remain recorded; it cannot certify completion.
- The repository fingerprint matches the analyzed snapshot again at the
  atomic checkpoint save and before the next writable stage.
- Persistent session saving is available and succeeds. No implementation may
  start after a failed save.

Before the read-only investigator runs, the host-neutral workflow checks the
saved Plan and checkpoint structure deterministically. The investigator receives
this validation result, checkpoint status, completed stages, the next and
interrupted stage IDs, and bounded evidence from completed step records and
stage reports. It judges **semantic compatibility of the checkout change**, not
whether an unavailable raw checkpoint JSON is structurally valid. Structural
validation does not certify that code or tests are correct; a genuine conflict
or insufficient repository evidence still produces `blocked` without running
coder. These facts are delivered by the core workflow, not a Zed or
provider-specific adapter.

If the change is not eligible for automatic acceptance, but a read-only
analysis can establish compatibility, role-orchestrator persists a proposal
bound to the exact Plan, completed-stage prefix and checkout fingerprint.
The UI explains the uncertainty and requests a **plain language confirmation**:

`Подтверждаю согласование и продолжи реализацию плана`

No confirmation token is necessary. `Подтверждаю, продолжай` is also supported
when that session has a pending proposal. Merely saying `Продолжай` never
counts as approval of a riskier proposed change. Subsequent changes to the
checkout invalidate the proposal. Older pending proposals with confirmation
codes remain readable; the code is no longer needed.

A read-only `Согласуй текущее состояние checkout` inspects and reports a
proposal but does not start coding. Invalid reports, moved HEAD/branch,
security-denied paths, excessive changed-file counts and incompatible
architecture/requirements block reconciliation; confirmation cannot bypass
these protections. For legacy checkpoints without historical file hashes,
never claim an exact delta or auto-accept. The user may explicitly accept a
valid analysis, but the agent must block if evidence is insufficient.

On either accepted path, the Plan and completed stages are preserved,
`revalidationRequired` is recorded in checkpoint history, and existing
full verification plus independent acceptance review still apply. There is
**no automatic retry, recursive reconciliation, replan or Git reset**.

## Host-independent configuration and instructions

The canonical global directory is `~/.agents/role-orchestrator/` and the project directory is `<repository>/.agents/role-orchestrator/`. Put Markdown rules in `ORCHESTRATOR.md` and optional JSON overrides in `config.json`. Global and project `AGENTS.md` are combined with these instructions; unrelated editor/provider instruction files are not automatically loaded. `AGENT_CONFIG` remains an explicit backwards-compatible JSON override. Per-session materialized roles and checkpoints retain their existing persistence behavior.

See [HOST-NEUTRAL-ARCHITECTURE.md](HOST-NEUTRAL-ARCHITECTURE.md) for migration guidance, complete precedence, session/host boundaries, example files, and the implementation-stage progress fix.

### Host-neutral execution runtime

`createOrchestratorRuntime` in `src/orchestrator-runtime.mjs` provides the complete
session contract shared by the ACP adapter and any headless/custom host:
`createSession`, `restoreSession`, `persistSession`, `runTurn` and `cancelSession`.
It does not load an ACP SDK or assume any editor UI. Hosts supply native
permission/elicitation bridges and a reporter for semantic workflow events.
The runtime owns per-session turn serialization, abort provenance, materialized
plans/checkpoints, reconciliation, transcript persistence, and attachment storage.

The existing one-shot CLI deliberately keeps its direct `runWorkflow` path and
does not create persistent sessions implicitly. The ACP adapter calls the
complete runtime API. Provider adapters publish raw tool telemetry; the ACP
host adapter applies its command-card display policy. See
[HOST-NEUTRAL-IMPLEMENTATION-RESULTS.md](HOST-NEUTRAL-IMPLEMENTATION-RESULTS.md)
for verification and outstanding end-to-end checks.

### Optional provider dependencies and independent-host verification

Provider implementations are now imported on demand by `src/providers/lazy-provider.mjs`.
`createModelRegistry()` and synchronous `resolveRole()` work without importing
unselected providers or the ACP SDK. Pure capability manifests in
`src/providers/capabilities.mjs` preserve previews and role preset selection;
capabilities discovered from a live generic ACP handshake still take effect
when that adapter starts. The selected ACP adapter still requires its SDK.

To verify the host boundary without ACP dependencies:

```sh
npm run test:lazy-providers
npm run test:headless-real-provider
npm run test:orchestrator-runtime
```

The second command exercises the real `runWorkflow` and `CodexCliProvider`
with a deterministic local CLI fixture (not an injected/mock workflow),
including plan creation, change, saved-plan continuation across a session
reload, investigation, real workspace editing, event emission and sandbox
checks. It does **not** call a live Codex model service. All ACP client/provider
and Zed interaction checks still require installing the dependencies and
running the relevant integration tests under the supported Node version.


### Saved Plan vs. current-turn intent

A stored implementation Plan and its checkpoints are session artifacts, **not**
permission to modify the repository on every later turn. The host-neutral
execution service selects a saved Plan only for an explicit implementation /
reconciliation directive (or a bare `continue` / `Продолжай` when the saved
implementation is `in_progress` or `interrupted`). A question about the Plan,
a quoted/example command, or an independent task does not resume the Plan.
Explicit `/review` and `/investigate` routing always remains read-only; the
workflow also guards against a host accidentally passing a Plan to a question.
These safeguards preserve the saved Plan, checkpoints, and session history.


### Scope-aware validation and bounded corrective rounds

The **host-neutral** change workflow maintains three independent judgments:

- **Correctness:** reviewers and final validators proactively investigate significant real defects, including connected pre-existing bugs discovered by new regression tests. Such findings remain visible regardless of change scope.
- **Task compliance:** acceptance criteria and executed verification retain their actual evidence (`CODE_FAILURE`, `UNVERIFIED`, `PASS`). Out-of-scope does not mean non-blocking, and failing tests are never relabelled as passing.
- **Repair authorization:** discovery of a defect does **not** grant permission to modify unrelated production code. `finalValidation.assessment` can provide `correctness`, `taskCompliance` and `fixAuthorization`. Each issue can supply `origin`, `taskRelation`, `remediationScope` and concrete `evidence`. These fields are optional for older provider outputs; missing or unsubstantiated declarations never authorize ignoring a defect.

A fully evidenced pre-existing defect outside the requested remediation scope can stop further coder calls and produce `completed_with_findings` when checks pass. Critical findings or failing checks requiring out-of-scope remediation produce `needs_user_decision`, preserving both the changes and an explicit `CODE_FAILURE` when present. Unknown provenance/authorization is not permission to edit production code or to waive a defect. Introduced/in-scope defects remain eligible for corrective rounds.

A `no_change` fixer is re-adjudicated **once** by the read-only final validator. An unresolved fix demand returns `implementation_blocked`; exhausted `maxFixRounds` also returns `implementation_blocked` without throwing a raw REVIEW/FINAL JSON exception. The persisted implementation checkpoint retains incomplete integration status; `planCompleted` remains false for unresolved findings. Each result exposes `fixDisposition` and `unresolvedFindings` for headless hosts, ACP consumers and subsequent session context. Existing security and Git safeguards remain intact. No additional retry loop or new provider/host dependency is introduced.


## Execution observability (P1)

The host-neutral runtime now exposes versioned, correlated execution events, a
redacted bounded trace and a read-only `ExecutionView`. ACP/Zed supports
`/status`, `/trace [count]`, and `/checkpoint` without launching a model or
changing the workspace. Native ACP plans, tool calls, diff presentation and
session persistence are preserved. Stateless CLI runs record a synthetic run
trace. See [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) for architecture,
retention, privacy, limitations and deterministic evaluation commands.

### Execution observability (P1 continuation)

Execution history and progress remain independent of any host or provider. The
runtime now exposes snapshot-safe `watchExecution(sessionId, listener)`,
`listExecutionRuns(sessionId)` and its existing `getExecutionView` /
`getExecutionTrace` API. Saved checkpoints remain authoritative; historical
execution views do not inherit later checkpoints. Each observable event has
bounded, privacy-filtered causal metadata linking inner invocations, stage
operations and reconciliation attempts. For details see `docs/OBSERVABILITY.md`.

In Zed ACP, `/runs` lists recent executions, `/status [run-id]` shows a
checkpoint-aware overview, `/trace [count] [run-id]` shows causal diagnostic
events, and `/checkpoint` shows durable progress. These commands are read-only
and do not invoke models, even with an unfinished saved plan. Native ACP Plan,
tool/diff, progress and answer streaming are preserved.

Use `npm run test:evaluation` to run deterministic checks,
`npm run benchmark:observability` for an environment-specific performance
baseline, or `npm run evaluation:report -- <session-id> [run-id]` to compute
bounded metrics from a sanitized trace without running a model.

### Durable implementation tasks

Each staged Change now persists its structured Plan **before** the first
writable stage, including when the user did not explicitly enter Plan mode.
Interrupted stages keep their checkpoint and evidence without blocking other
independent tasks in the same chat. Previous Plans and checkpoints are
archived per task; use `/plans` to inspect them and explicitly resume an older
Plan by its ID. See [Implementation task continuity](docs/IMPLEMENTATION-TASK-CONTINUITY.md).

### Staged verification and interrupted independent review

Verification-only implementation stages can complete without new file edits
when the coder supplies structured check outcomes and evidence; failing or
unavailable checks must remain unverified. An unexpected provider cancellation
in read-only independent review is retried at most once against unchanged
workspace state, never by repeating coder. If review remains unavailable, the
workflow returns `review_interrupted` with preserved implementation checkpoints
and incomplete final acceptance. See
[Implementation Task Continuity](docs/IMPLEMENTATION-TASK-CONTINUITY.md).

### Effect-aware verification

For trusted diagnostic commands that update JSON reports and use nonzero exit codes for domain deltas, see [Effect-aware verification](docs/EFFECT-AWARE-VERIFICATION.md). It is opt-in and does not relax default verification, recovery or security policy.


### Evidence-driven efficiency completion increment

See [`docs/EVIDENCE-DRIVEN-COMPLETION-IMPLEMENTATION.md`](docs/EVIDENCE-DRIVEN-COMPLETION-IMPLEMENTATION.md) for the implementation matrix, opt-in verification/evidence policies, and known limits; [`docs/EVIDENCE-DRIVEN-COMPLETION-TWO-PASS-AUDIT.md`](docs/EVIDENCE-DRIVEN-COMPLETION-TWO-PASS-AUDIT.md) documents the security and compatibility audit.


## Review quality-depth policy

See [`docs/QUALITY-PRESERVING-REVIEW-Q0-Q6.md`](docs/QUALITY-PRESERVING-REVIEW-Q0-Q6.md) for Review-only risk obligations, checkpoint v4, `qualityDepth` modes, reproducible A/B identity and cost-based promotion gates. Four-pass audit: [`docs/QUALITY-PRESERVING-FOUR-PASS-AUDIT.md`](docs/QUALITY-PRESERVING-FOUR-PASS-AUDIT.md).


### ACP lifecycle hardening (2026-10-27)

Generic and Codex ACP adapters now distinguish connected transports from fully
initialized clients: parallel invocations share one handshake and must wait for
negotiated initialization before creating sessions. Startup rejection and child
process failure reset the adapter for controlled retry. ACP preflight operations
can be interrupted before `session.new` completes. Optional positive-integer
`preflightTimeoutMs`, `invocationDeadlineMs` and `cleanupTimeoutMs` are accepted
on providers and profiles. The defaults are 120,000 ms for each preflight RPC,
3,000 ms for best-effort session close, and a conservative invocation budget
calculated from the model turn deadline plus preflight/cleanup allowances.
These limits supplement, and do not replace, the existing model turn idle and
absolute deadlines. The ACP adapter cannot guarantee that a remote peer
abandons an orphaned request if a shared transport must remain alive for other
sessions; local invocation completion is bounded and such cases require live
SDK-level integration testing.

Security-denied workspace paths are captured and restored through anchored
Linux directory descriptors and no-follow leaf opens. This deliberately fails
closed on platforms without that supported filesystem boundary; there is no
check-then-write fallback for denied-path restoration. Project config allow
patterns cannot bypass a trusted global user policy denial; an explicitly
selected `AGENT_CONFIG` file remains a trusted override for glob exceptions.

Persistent outer sessions use per-session cooperating-writer exclusion and
revision checks. A second independent host holding a stale snapshot receives
`SESSION_REVISION_CONFLICT` rather than silently overwriting newer state. It
must reload before attempting a further mutation. This is conflict detection,
not automatic transcript merging. Review checkpoint v4 (including quality
state) is preserved by the session store. Unsupported checkpoint versions are
rejected on save instead of discarded.

### Review witness hardening (October 2026)

The optional trusted-host semantic adjudicator now requires a scope-, source- and observation-bound `verifiedWitnesses` record. A legacy digest set alone never proves independence and no longer permits semantic merging. Checkpoint retry preservation, semantic candidate evaluation, and the fake eight-unit resume/recovery validation are described in [`docs/REVIEW-PRODUCTION-HARDENING-2026-10-27.md`](docs/REVIEW-PRODUCTION-HARDENING-2026-10-27.md). Run `npm run test:review-hardening` for the targeted regression and integration fixtures.

## Semantic Intent Resolution (experimental migration, 2026-10-27)

The existing Router can produce a versioned typed task description (`task.version = 1`)
with `operation`, `writeIntent`, typed Git selectors, review constraints,
continuation reference, and ambiguity indicators. The core validates this
contract, resolves Git objects using Git rather than model-supplied paths,
and enforces the existing execution policies. The original user task remains
available to execution roles but is not the authoritative selector in the
migrated workflow path.

**Deployment status: experimental / not production-validated.** Existing
compatibility APIs still contain legacy natural-language interpreters, and
some old test fixtures have not been migrated. A model can still
misunderstand natural language while returning schema-valid JSON. Do not
assume schema validation independently proves explicit write authorization.

See `docs/SEMANTIC-INTENT-IMPLEMENTATION-2026-10-27.md` for the contract,
remaining migration work, baseline/test limitations, and live Zed validation.

For deterministic tests: `npm run test:semantic-intent`. For live semantic
quality evaluation (invokes your configured Router only, read-only):

```
node tools/semantic-evaluate.mjs "$PWD" test/evaluation/semantic-intent-corpus.json --run
```

Use a real Git checkout with compatible configured provider. Running this command
may consume provider quota. No automatic execution of model-proposed changes
is performed by the evaluator.


## Semantic intent resolution (experimental migration)

Every new natural-language task is interpreted by the existing Router into a
versioned `task.version=1` specification (`src/routing/task-spec.mjs`). The
validated specification describes `operation`, `writeIntent`, Git selectors,
review constraints, skill name and continuation mode; it does **not** convey
provider/model authorization. Trusted slash commands and host controls remain
protocol inputs; the deterministic policy, Git resolver, write sandbox,
checkpoint identities, execution budgets and mandatory review gates are
independent of Router claims.

Downstream components must not reinterpret natural-language text to select a
Plan, authorize writes or choose Git scope. A missing/invalid Router task or
contradictory classification returns `intent_unresolved`, not a successful
Investigate. Ambiguous targets/continuation return an incomplete or
clarification-needed state without executing the requested operation.

Git selectors accept typed `recent_commits`, `commit`, `range`,
`relative_ref`, `worktree`, `staged`, `unstaged`, `ticket_commits` and
`union` (two to four independent selectors). A composite fails closed if
any component is unresolved. Review requirements may include typed
`constraints.reviewChecks`, `expectedFileCount` and `excludedPaths`;
mandatory technical coverage remains core-controlled. Legacy checkpoints
without a validated saved Review intent are readable for inspection but
are not automatically resumed or upgraded from task text. A saved Plan is
never itself permission to execute it.

Contract/integration tests: `npm run test:semantic-intent`,
`npm run test:evaluation`, `npm test`. Real-model classification evaluation
(requires a working Router provider and credentials):

```sh
node tools/semantic-evaluate.mjs "$PWD" test/evaluation/semantic-intent-corpus.json --run > semantic-eval.json
```

Model errors are *not* semantic accuracy scores: when no provider responds,
metrics remain unavailable and the result is `NOT_VERIFIED`. The migration is
not production-ready until the full suite, live provider evaluation and host
integration have been checked.

## Pre-Live Hardening (2026-10-28)

The shared semantic Router request builder lives in `src/routing/request.mjs`. Production and the Router evaluator use the same prompt/schema/context construction. To run the new local checks:

```bash
npm run test:router-request-parity
npm run test:semantic-evaluator-offline
npm run test:prelive-state-restart
npm run test:prelive-security-failures
```

The original 56-case semantic corpus remains unchanged. Run the evaluator with a configured real provider using `node tools/semantic-evaluate.mjs "$PWD" test/evaluation/semantic-intent-corpus.json --run`, or supply controlled offline responses using `--offline fixture.json`. Offline results do **not** establish real-model semantic accuracy. Complete status, provider/runtime limitations, three audits, migration notes and Zed gates are in [`docs/PRELIVE-TECHNICAL-REPORT.md`](docs/PRELIVE-TECHNICAL-REPORT.md).

## Semantic Router Quality Observability (P0–P2)

Router context can be set in the standard global/project configuration (project wins):

```json
{"policy":{"routerContext":{"mode":"observe"}}}
```

Valid modes are `legacy`, `observe`, `optimized`; `AGENT_ROUTER_CONTEXT_MODE` remains a compatibility fallback only when JSON has no explicit mode. `optimized` still requires an operator-reviewed, SHA-256-verified router-context manifest. Invalid config values abort configuration loading.

- `/routing report` or `/routing report <run-id>`: read-only, no provider calls.
- `npm run routing:report -- [--session ID] [--run ID] [--from ISO] [--to ISO]`: JSON report from existing traces.
- `npm run routing:ground-truth -- candidate ...` and `... label ...`: explicit, locally reviewed prompt export and independent expected labels (see `docs/GROUND-TRUTH.md`).
- `node tools/semantic-evaluate.mjs /repo corpus.json --offline responses.json [--context-mode legacy|observe|optimized]` or `--run`: reproducible diagnostic vs live evaluation through the same Router request builder.
- `npm run routing:compare -- baseline.json current.json criteria.json`: paired, confirmed-case regression checks. Without an explicit `minConfirmedCases`, result is `INSUFFICIENT_EVIDENCE`.

Docs: `docs/SEMANTIC-ROUTING-OBSERVABILITY.md`, `docs/SEMANTIC-QUALITY-METRICS.md`, `docs/GROUND-TRUTH.md`, `docs/ROUTER-CONFIGURATION-MIGRATION.md`; machine-readable case schema in `test/evaluation/ground-truth-v1.schema.json`.

**Accuracy is never inferred from successful workflows or routine traces.** Offline fixtures prove machinery, not real provider quality. Unlabeled/legacy cases are excluded from confirmed-ground-truth metrics.

### Execution verification evidence (2026-10-28 hardening)

`npm run test:execution-completion` exercises scope-aware fix decisions, finite
verification, timeout diagnostics, declared-input reuse, bounded output and the
Git-union test-coverage inventory. Run the full `npm test` with Node.js
**>=22.20.0** and the exact lockfile dependencies installed. Generic ACP
integration additionally requires `@agentclientprotocol/sdk` to resolve.

The verifier rejects known interactive/watch-mode invocations rather than
silently rewriting an operator-configured command. `ENVIRONMENT_ERROR` with
`reasonCode: INTERACTIVE_VERIFICATION` indicates a script must be replaced by
an explicitly approved finite command (for Vitest, often `vitest run`). A
`VERIFICATION_TIMEOUT` reason indicates an observed timeout, not a test failure.

An optional same-attempt verification result cache is available through the
**trusted host-owned** `AGENT_VERIFY_INPUT_CLOSURES` manifest. A command must
provide a complete list of its relevant input paths and environment keys **and**
`cacheable: true`; that flag is an explicit assertion that the check is safe to
reuse for unchanged inputs. Example (adapt paths to the actual project):

```json
{
  "npm run test:unit": {
    "complete": true,
    "cacheable": true,
    "paths": ["package.json", "package-lock.json", "src/example.ts", "test/example.test.ts"],
    "environment": ["NODE_ENV"]
  }
}
```

Do not enable for non-hermetic checks or undeclared dependencies. The cache
requires a witnessed tool version, identical command, complete input digest,
unchanged full Git/workspace state and successful prior execution. It is scoped
to one verification attempt and never replaces mandatory final `git diff --check`.
Only host-controlled verification calls can be deduplicated this way; direct ACP
provider tool calls are not intercepted. Extra Git/version witnesses can make
caching more expensive than simply re-running a very short check.

`node tools/test-coverage-evidence.mjs 6 /path/to/repo` builds a bounded
read-only inventory for the union of the most recent six first-parent commits
and staged, unstaged and untracked changes. The main workflow also adds this
inventory to a typed `test-it` Change result. Candidate tests are matched by
path/basename only: all behavioral scenarios remain `NOT_VERIFIED` until
independent observations confirm their assertions. The inventory intentionally
does **not** manufacture a percentage of code coverage.

Large controlled verifier output contains a bounded prefix, a suffix and a
count of omitted characters; use the original complete log for debugging.
ACP provider-owned direct tool streams do not pass through this wrapper and
are not claimed to be truncated or cached.

### Semantic quality obligations and write-scope audit (2026-10-28)

The Router may emit optional `task.qualityGoals` (typed, version 1):
`test_inventory`, `scenario_assessment`, `executed_test_evidence`,
`measured_code_coverage`. These obligations are inferred from the user task,
not from a command or skill name. Any skill may request the same goals, and
historical Task Specs without the field remain valid. On a concrete Git scope,
Role Orchestrator collects a conservative candidate inventory before planning
and refreshes it after implementation. The inventory is **not** a verified
scenario matrix, test execution result, or measured coverage percentage. When
there is no Git selector, it reports `UNVERIFIED` instead of inventing paths.
Language-specific discovery conventions are isolated behind the extensible
`src/testing/discovery.mjs` adapter boundary; unknown languages remain unknown.

Optional `task.constraints.writeScope` may be `unspecified`, `tests_only`,
`production_only`, or `combined`. Together with `excludedPaths`, they enable a
post-write audit of observed path changes after preparation, coder, staged
execution, fix rounds and verification. Unrecognized file types are rejected
under restricted scopes; restrictions from a resumed saved Plan are also
checked, so a new turn cannot silently broaden the older write scope; existing tasks without the field stay compatible.
**Important limitation:** this is a post-write guard, NOT atomic write
authorization: provider-owned tools execute before the audit, and changed
files are preserved for inspection on a violation. An upstream host-approved
write manifest and provider/tool-side enforcement are still required for a
full security guarantee. Router output and skill metadata are not trusted
sources of broader write authorization.

### Scoped write safety (current limitation)

The orchestration boundary fails closed for `tests_only`, `production_only`,
and nonempty task exclusions before workspace-writing stages because ordinary
ACP permissions and tool notifications cannot guarantee interception of every
provider-owned write. Unrestricted legacy writes remain possible but do **not**
have universal per-path enforcement. Read [the boundary contract](docs/TASK-WRITE-BOUNDARY.md)
before using path-scoped tasks or declaring production readiness.

Typed Git review/coverage selectors also accept `{ "type": "files", "paths": ["src/example.ts"] }`.
File selections are inventory, not edit permissions or measured test coverage;
explicit content snapshots distinguish content drift from mtime-only changes.
