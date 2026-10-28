# Legacy cleanup and semantic authority registry — 2026-10-28

| Component / call site | Classification | Evidence / disposition |
|---|---|---|
| `src/workflow.mjs` `deterministicContinuation=false` branch | Removed | Branch unreachable under the constant; removed along with associated redundant condition. Real typed Review continuation retained. |
| `src/workflow.mjs` `readOnlyRequest=false` | Removed | Unused local constant; no authorization effect. |
| `src/workflow.mjs` `modeOverrideText` | Removed | Only caller migrated into shared `src/routing/request.mjs`. |
| `src/routing/request.mjs` | Typed resolver / request builder | No permission authorization; consumes host signals, skill names, saved typed metadata, project context and session history. |
| `src/routing/task-spec.mjs` | Deterministic validator | Typed Task v1, Git selector grammar, continuation enums, restrictions. |
| `src/routing/consistency.mjs` | Deterministic validator | Typed fields only. |
| `src/routing/context.mjs` | Deterministic context projector | Verified manifest digest, never word-based authority. |
| `src/review-scope.mjs` | Typed Git resolver | Git ref and path regex are syntax/security validators, not user-intent parsers. |
| `src/review-continuity.mjs` | Typed resolver + protocol parser | `/review-reconcile` exact command grammar intentionally retained. |
| `src/implementation-stages.mjs`, `src/implementation-tasks.mjs`, `src/implementation-reconciliation.mjs` | Typed state validators | No re-interpretation of ordinary user prose for permissions. |
| `src/execution-service.mjs` | Typed resolver / compatibility adapter | Saved tasks identified from validated continuation metadata. |
| `src/context.mjs` frontmatter/document discovery | Protocol/document parser | YAML-like skill metadata and safe Markdown references, not semantic classification. |
| `src/providers/`, `src/structured-output.mjs` | Protocol parser | ACP/JSON parsing required and preserved. |
| `src/workflow.mjs` `/review-resume` and `merge-parent` | Protocol parser | Explicit user protocol syntax, not generic natural-language inference. |
| `test/fake-codex.mjs` deterministic string matching | Test fixture only | Fake provider dispatches fixed fixture prompts; not a production semantic authority. |
| Existing deprecated linguistic adapters listed in `docs/semantic-completion/role-orchestrator-semantic-legacy-cleanup-2026-10-27.md` | Previous migration record | Retained prior assessment; no lexical fallback reintroduced. |

**Unverified:** No static audit certifies every external host adapter or real provider behavior; do not equate absence of detected parsers in checked files with universal proof.
