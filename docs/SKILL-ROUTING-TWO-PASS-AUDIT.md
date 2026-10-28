# Two-pass audit: skill, routing, review progress and ACP output

## Pass 1 — behavior, correctness and safety

Findings and corrections:

1. A direct `/changed <arguments>` was stripped to arguments before being sent to the models. Added a canonical, explicit skill invocation directive and retained the original message in the in-memory contract. Unknown explicit commands now fail clearly.
2. The initial guard required keywords for every authorized `change`, which incorrectly downgraded legitimate change tasks with uncommon wording. Removed that gate; existing write-authorization logic remains authoritative for general tasks. Explicit skill selection alone still cannot grant writes.
3. The initial Cyrillic regex used JavaScript `\\b` word boundaries, which do not behave as expected around non-ASCII letters. Corrected the language-specific matching.
4. A bare skill command with only commit arguments lacks explanatory verbs. Added optional `orchestrator-mode` metadata and a conservative read-only hint from the skill description; no skill-name heuristics.
5. Repeated structured output failures now use a bounded no-progress guard. A single failed batch or mixed/independent problems does not trigger an early stop.

Checks: `test/skill-routing-presentation.mjs`, `test/skill-workflow-integration.mjs`, `test/context.mjs`, `test/workflow-unstructured.mjs`, `test/review-work-plan.mjs`, `test/review-coverage.mjs`, `test/review-operation-continuity.mjs`, `test/security.mjs`, `test/review-scope-hardening.mjs` — PASS. The workflow regression test includes change-mode and read-only paths.

## Pass 2 — ACP boundaries, telemetry and compatibility

Findings and corrections:

1. Generic ACP previously emitted final text as inner `agent_message_chunk`, then the outer ACP layer could publish it again. Generic ACP now buffers *text* until outer publication, preserving other progress and non-text data updates.
2. Markdown normalization is bounded to complete outer `markdown`/`md` fenced documents. It avoids transformations to structured outputs, ordinary code examples and literal-source requests.
3. Observability now records only safe enum-like statuses and reason codes. Run-level telemetry survives the Session Store allowlist boundary without raw prompt or tool data.
4. Parser tests explicitly reject mentions in inline code spans and fenced code, negative instructions, and informational questions.

Checks: `npm run check`, `npm run test:evaluation`, `test/evaluation/p3-tool-events.mjs`, `test/evaluation/p3-measurement-closure.mjs`, `test/evaluation/p3-monitoring-production.mjs`, `test/evaluation/real-workflow.mjs`, `test/invocation-recovery.mjs`, `test/session-store.mjs` — PASS in the available environment (Node 22.16.0). The project's declared minimum Node version is newer.

### Outstanding verification

`test/generic-acp.mjs` could not run because `@agentclientprotocol/sdk` was not installed. Live OpenCode/GPT-OSS behavior, real permissions and final Markdown rendering in Zed still require integration testing. The patch must not be presented as independently confirmed production-ready until these are checked.
