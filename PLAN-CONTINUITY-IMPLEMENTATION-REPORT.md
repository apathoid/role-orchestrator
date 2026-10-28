# Plan/Checkpoint Continuity Fix — Implementation Report

## Base

`role-orchestrator-p1-completion-source.zip` (host-neutral architecture with P1 observability).

## Fixed failure modes

1. Ordinary staged `change` persists the exact structured Plan *before* any preparation, coder or workspace modifications. Plan-saving failures prevent starting changes.
2. Checkpoints and reconciliation state are owned by a particular implementation task. New unrelated changes and questions never receive a foreign checkpoint.
3. New Plan-mode and Change-mode plans archive previous Plans/checkpoints rather than destroying them. Old tasks may be selected explicitly by ID from `/plans`.
4. Interrupted stages preserve bounded `invalid_stage_evidence` diagnostics, completed-stage prefixes and partial workspace edits. The coder can re-assess previously written code with concrete `already_satisfied` evidence; verification requirements are unchanged.
5. Legacy sessions migrate non-destructively. Orphan checkpoints (where Plan was never saved) remain inspectable but cannot be falsely resumed with a fabricated Plan.
6. Persistence of task selection, Plan, checkpoint and reconciliation is atomic via the existing durable session storage; on persistence failure in-memory state is restored.
7. The workflow itself discards a checkpoint unless an authoritative saved Plan was selected, so a foreign host integration cannot trigger the same failure.
8. An ambiguous request for a "previous" Plan when multiple saved Plans exist is rejected until the user supplies an ID.

## Changed modules

- `src/workflow.mjs`: early Plan persistence callback, checkpoint isolation guard, detailed interruption evidence.
- `src/execution-service.mjs`: task binding, Plan archiving, callback ownership and atomic updates, safe selection.
- `src/implementation-tasks.mjs`: task catalog, migration, ID selection, compatibility aliases.
- `src/session-store.mjs`: durable task catalog with strict validation (no silent task loss).
- `src/acp.mjs`: read-only `/plans` command; existing ACP progress/tool/native presentation unchanged.
- Tests, package scripts and documentation.

## Checks

- `npm run check`: passed.
- Targeted `test/implementation-task-continuity.mjs`: passed.
- `test/evaluation/implementation-plan-durability.mjs`: passed on real workflow using fake model transport, including interruption and I2-only resume.
- Existing test suites: 32 other lightweight suites passed, plus five existing evaluation scenarios, and `workflow-unstructured` passed.
- Full ACP/provider integration/smoke with actual SDK was not verified: `@agentclientprotocol/sdk` is missing in this container. Here Node is 22.16 rather than project-required 22.20+. Real Zed should be smoke-tested after updating.

## Limitations

This preserves *future* Plan/checkpoint continuity. An older session whose original Change Plan was never saved cannot reconstruct that Plan from an orphan checkpoint alone. Keep the old checkout and any backup session JSON; use a new read-only audit and Plan for the missing requirements if no original structured Plan survives.

Tasks share the user's real checkout, even when their checkpoint histories are separate. Returning to an older task after independent edits may require the existing read-only reconciliation procedure. The task catalog is capped at 100 retained entries and fails closed instead of deleting old tasks automatically.
