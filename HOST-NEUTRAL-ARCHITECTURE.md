# Host-neutral architecture and instruction migration

This document describes the host/configuration split implemented in this version. The ACP surface remains compatible with Zed; the workflow is not tied to a particular client.

## Ownership map

| Module | Responsibility | Boundary |
|---|---|---|
| `src/orchestrator-runtime.mjs` | Public host-neutral API: create/restore/persist sessions, `runTurn`, cancel session; combines lifecycle, execution and per-session scheduling | Runtime core |
| `src/execution-service.mjs` | One durable workflow turn: authoritative plan selection, implementation/review checkpoints, reconciliation, history, attachment transactions, provider lifecycle | Execution core |
| `src/turn-coordinator.mjs` | Per-session turn queue, supersession, abort provenance, concurrency isolation | Execution core |
| `src/workflow.mjs` | Routing, Engineering Core, plan/review/staging, verification, semantic event emission | Workflow core |
| `src/session-lifecycle.mjs`, `src/session-store.mjs`, `src/attachment-store.mjs` | Repository binding, materialized role state and durable persistence | Session core |
| `src/config.mjs`, `src/context.mjs`, `src/instruction-files.mjs` | Configuration and instruction precedence, security-bound discovery | Core |
| `src/models.mjs`, `src/providers/lazy-provider.mjs`, `src/providers/capabilities.mjs` | Lazily loaded provider registry and synchronous, SDK-free capability manifests | Provider abstraction |
| `src/providers/codex-cli.mjs`, `src/providers/codex-acp.mjs`, `src/providers/acp/generic-acp.mjs` | Selected provider implementations, capability enforcement, **unfiltered** normalized progress including tool telemetry | Provider adapters |
| `src/acp.mjs`, `src/acp-presentation.mjs`, `src/acp-tool-bridge.mjs` | ACP host requests, permission/elicitation bridge, UI policy, tool ID correlation, native plan and progress presentation | ACP host adapter |
| `src/index.mjs` | Existing one-shot CLI, invoking the common workflow engine directly | CLI host |

`createOrchestratorRuntime({ getConfig, ... })` is the canonical complete-session entry point. The ACP host calls `runtime.createSession`, `runtime.restoreSession`, `runtime.runTurn`, and `runtime.cancelSession`. The runtime requires no Zed import, no ACP SDK, and no host UI; the provider registry is loaded lazily when an actual provider is needed. For programmatic hosts, supply `reporter`, `providerBridge` (permission/elicitation callbacks and capabilities), `controls`, and optional `onStarted`/`onProviderStateChange` callbacks to `runTurn`. The same durable session schema is used regardless of host.

**Host adapters are separate from provider adapters.** Model providers must not suppress command telemetry because a particular client renders it awkwardly. The Codex ACP provider emits raw normalized tool updates; the outer ACP adapter applies `sanitizeToolUpdateForUi` and `createOuterToolCallBridge` only when projecting into the external ACP client. The existing `providers.<name>.showCommandToolCalls` and `showSuccessfulCommandOutput` compatibility flags are interpreted at this boundary. Permission request tool subjects are still explicitly published before prompting for approval, even if command cards would normally be hidden.

The execution service owns the saved implementation plan and its continuation policy, checkpoint persistence and rollback on save failures, reconciliation, review checkpoints, history summary, attachment bookkeeping and provider closure. The coordinator guarantees a newly accepted turn supersedes an older turn **within the same session only**. ACP-specific collaboration-mode UI controls and request notifications remain in the ACP host adapter. Existing ACP v1 presentation semantics and tool-call ID namespacing are retained; ACP itself is a general protocol, not a Zed-private API.

`runWorkflow` remains host-neutral and can also be called directly by the existing one-shot CLI. This deliberately preserves its historical behavior rather than silently making all one-shot CLI invocations create persistent sessions. The full persistent-session API is available to a future CLI or other host through `createOrchestratorRuntime` (and is exercised by the mock-host tests).


## Lazy provider boundary and headless integration

`createModelRegistry(config, bridge)` creates cheap `LazyProvider` handles for selected provider names. Role assignment and capability previews are **synchronous** and do not load provider modules; the capability declarations live in `providers/capabilities.mjs` and match the corresponding provider classes. Only invoking a role, asking that provider for models or explicitly preparing it imports its implementation. `close()` on an unused handle does not import the implementation. Generic ACP capability reporting is recomputed after the actual handshake, preserving capability discovery from the upstream agent.

A headless process can use the same persistent API as an ACP client:

```js
import { loadConfig } from './src/config.mjs';
import { createOrchestratorRuntime } from './src/orchestrator-runtime.mjs';

const runtime = createOrchestratorRuntime({
  getConfig: (repoRoot) => loadConfig({ repoRoot }),
});
const { sessionId } = await runtime.createSession({ cwd: '/path/to/repository' });
const { result, assistantText } = await runtime.runTurn({
  sessionId,
  invocation: { task: 'Inspect the current project', modeOverride: 'investigate' },
  rawText: 'Inspect the current project',
  reporter: async (event) => { /* process normalized semantic progress */ },
});
// On subsequent processes: runtime.restoreSession({ sessionId, cwd: ... })
```

The public `runTurn` contract takes an `invocation` containing the task, explicit mode override, skill and review target; optional `mediaBlocks` contain platform-neutral message content, and `controls` contains session execution preferences such as `planOnly`. `providerBridge` permits scoped capability/permission/elicitation delegates. `mcpServers` is the standard Model Context Protocol server configuration in the persisted session, **not** a Zed-specific tool; `promptBlocks` is a provider-facing content abstraction. These fields do not authorize bypassing sandbox, security, or provider capability checks. The ACP host adapter is responsible for parsing external wire content into these inputs, and any non-ACP host is free to supply the same structures directly.

`test/headless-real-provider.mjs` executes the **actual workflow** through the **actual Codex CLI adapter** with an instrumented deterministic local CLI fixture, including Plan → Change → disk restore → saved-plan continuation → investigation, checking repository writes, transcript durability, role events and sandbox mode. Unlike the injected-workflow unit tests it exercises the production registry and adapter without installing or starting Zed or the ACP SDK. This does not establish interoperability with a live Codex installation, which still requires a live smoke test.

`test/lazy-providers.mjs` verifies that having unselected ACP adapters in the configuration does not require their SDK and that synchronous role resolution, capability previews, provider lifecycle and model listings remain compatible.

## Configuration discovery

For each repository:

1. Bundled `config/chatgpt-plus.json` defaults.
2. `~/.agents/role-orchestrator/config.json` (optional).
3. `<project-root>/.agents/role-orchestrator/config.json` (optional).
4. `AGENT_CONFIG=/absolute/path/override.json` (optional, **legacy explicit override**).
5. Session's already materialized role assignments and Fast mode override (when a session exists).

Object properties merge recursively, ordinary arrays replace, and `rolePresets` in the canonical global/project layers merge by `id`: an existing ID replaces the entry in the same declaration position, while new IDs append. An explicit `AGENT_CONFIG` preserves historical **array replacement** semantics. Security allow/deny lists merge using the existing additive security merger, not ordinary replacement. Unknown provider profiles and invalid JSON produce errors identifying the relevant config path.

The runtime caches validated configuration **per repository for the lifetime of the outer ACP process**. Restart the agent to incorporate changes to JSON config; this does not rewrite persisted session role assignments. New sessions apply the current default preset, and resumed sessions retain their materialized assignments.

Configuration and instructions do **not** live in the session store. The old XDG session data is not migrated or deleted.

## Instruction order and scope

Automatically loaded, in precedence order (later is more specific):

1. `~/.agents/role-orchestrator/ORCHESTRATOR.md`
2. `~/.agents/AGENTS.md`
3. `<repo>/.agents/role-orchestrator/ORCHESTRATOR.md`
4. `<repo>/AGENTS.md`
5. Nested `AGENTS.md` along explicitly selected subdirectory scopes, from outer to inner.

Explicit Markdown links from those documents pointing to `.agents/*.md` can load additional rule files at the same precedence level as their referring document, in a deterministic order. They are deduplicated by canonical file path. Only files contained inside authorized `.agents` roots can be loaded through that mechanism. A file that is only *listed* in `.agents` is **not** automatically trusted or injected into every role: the discovery catalog gives the exploring role paths to inspect when relevant.

`SKILL.md` retains its own global/project discovery, project overrides and explicit activation; it is not silently treated as always-on policy. `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.rules`, Copilot instructions and other tool-specific files are not automatically read by the orchestrator. Native provider instruction loading remains the responsibility of the provider itself.

Canonical files remain optional. A missing optional file is ignored; a malformed, overlarge or boundary-escaping path raises a descriptive error. Each file is limited to 40,000 Unicode code units; combined automatically loaded instructions are limited to 160,000, without silent truncation. There is a maximum of 64 listed optional project rules. The scope resolver reads nested `AGENTS.md` only along the initial working subtree (or paths passed explicitly to `loadInstructionContext`), rather than recursively loading instructions for every repository folder. Before operating on a different subtree, a role should inspect its applicable nested rules; this is not presently an automatic file-operation interception hook.

Security invariants, user permissions and host policy are still enforced programmatically. No instruction file can authorize a denied write or bypass cancellation.

## Migration

```text
~/.config/zed/AGENTS.md              → ~/.agents/AGENTS.md
~/.agents/role-orchestrator/          → canonical global orchestrator config
<repo>/.agents/role-orchestrator/     → canonical project config
```

The previous `~/.config/zed/AGENTS.md` is intentionally **not silently merged**. Copy relevant generic instructions to `~/.agents/AGENTS.md`; extract orchestration-specific rules into `ORCHESTRATOR.md`. Move the relevant content of a previous `AGENT_CONFIG` JSON override into the new global/project `config.json` if desired; the old environment variable remains supported with higher explicit precedence. Do not copy tool-specific rules wholesale unless a project intentionally links to them as task material.

Existing persistent session JSON, saved plans, implementation/review checkpoints, history, Fast mode and role assignments remain in place; no storage format conversion is required.

## Example global instructions

`~/.agents/role-orchestrator/ORCHESTRATOR.md`:

```markdown
# Global Orchestrator

Preserve valid implementation and review checkpoints.
Report verification results accurately and distinguish tool errors from test failures.
Preserve user changes when reconciling repository drift.
```

## Example project instructions

`<repo>/.agents/role-orchestrator/ORCHESTRATOR.md`:

```markdown
# Project Orchestration

For this repository, plan integration checks across independent packages.
For review tasks, inspect the public API contract before proposing implementation details.
See [review policy](../review/guidelines.md) when reviewing public interfaces.
```

A project may additionally define `<repo>/AGENTS.md` with more specific rules for the codebase. Global/project `config.json` may contain any valid **partial** existing configuration schema; no new JSON schema is required.

## Implementation progress correction

The old ACP event adapter had `step.description.slice(0, 75)` and joined those truncated descriptions with `; `, losing content and mixing adjacent steps. `implementationStagePresentation` now generates a stable short event title (`Implementation 6/9 — S16–S18`) directly from the canonical step identifiers. Original descriptions remain in the **full ACP Plan entries**; if a stage has no native plan, the adapter emits a separate, full detail block. No stage, checkpoint, coverage record or plan digest is rewritten to support presentation. Cyrillic and Unicode labels are preserved.

## Testing and known limits

- `node test/host-neutral.mjs` exercises instruction and configuration precedence, boundary checks, stages and session persistence **without the ACP SDK**.
- `node test/execution-service.mjs` exercises full Plan → Change → Resume → Review lifecycle, persistence, checkpoints, reconciliation, attachment references, failure rollback and cancellation without a host.
- `node test/orchestrator-runtime.mjs` runs the same entry point as ACP under a mock host, including reload from disk, request supersession and direct host cancellation.
- The existing provider telemetry test expects **raw** execute-tool events; only the ACP presentation adapter suppresses them for a host by default.
- Full interactive Zed interoperability (tool permissions, UI plan rendering, reasoning, reconnect, and cancellation) requires running the installed ACP SDK and the Zed client. Static or mock-host tests alone cannot prove this UX behavior.
- Nested rules for paths first discovered midway through an execution still need the model to read their instructions when changing scope; this version does not automatically inject them on each tool call.

## Directory layout

```text
~/.agents/
├── AGENTS.md
├── skills/<name>/SKILL.md
└── role-orchestrator/
    ├── ORCHESTRATOR.md
    └── config.json

<repository>/
├── AGENTS.md
└── .agents/
    ├── role-orchestrator/
    │   ├── ORCHESTRATOR.md
    │   └── config.json
    ├── review/guidelines.md
    └── skills/<name>/SKILL.md
```
