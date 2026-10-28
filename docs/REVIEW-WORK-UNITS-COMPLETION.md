# Review Units completion — security & semantic scheduling

Changes are based on `role-orchestrator-review-work-units.zip`.

## Security invariant: both sides of renames/copies

`src/workflow.mjs` validates both `entry.path` and optional `entry.oldPath`
using the active `evaluateSecurityPath`. If either side is denied, **the
entire change** is removed from the reviewer assignment and from static
relationship analysis. Its inaccessible-file count remains visible in the
coverage gaps, so it cannot silently produce `review_passed`. The security
policy is also part of the checkpoint scope fingerprint; even changes that do
not immediately alter the visible manifest invalidate prior checkpoint reuse.

## Semantic scheduling, with explicit limits

`src/review-work-plan.mjs` groups files by package/domain/module and keeps
implementation/test basenames adjacent. `src/review-relationships.mjs` reads
only permitted, bounded text from the selected Git tree or explicitly selected
working tree to identify relative static `import`, `export from`, `require`,
`import()` and stylesheet imports between changed paths. It records only
normalized path relationships, not source text.

Cross-unit imports create prerequisites, and cyclic imports retain a related
unit hint while acquiring a deterministic acyclic schedule. Criteria retain
their own evidence units. Matching criteria depend on the relevant file units;
ambiguous/broad criteria conservatively depend on all file units. Batch
selection is dynamic and checks actual completed evidence at every step:
`blocked` and `not_checked` prerequisites cannot unlock later dependent Units.
Persisted checkpoints reject dependent evidence without persisted prerequisites.

This is a **static, best-effort scheduling heuristic**, not a semantic proof of
runtime dependencies: dynamic imports, module aliases, generated code, imports
from unchanged files, oversized sources, large inventories (>256 changed
paths), and commits-by-key may not produce edges. The fallback is deterministic
subsystem/path grouping. No absent relationship is interpreted as evidence of
independence or completeness. Source inspection evidence still comes from the
reviewer and is separately validated for explicit path membership.

## Verification

Confirmed locally (Node v22.16.0):

- `npm run check`
- `node test/review-work-plan.mjs`
- `node test/workflow-unstructured.mjs`
- `npm run test:config`, `npm run test:session-store`
- `npm run test:p2`, `npm run test:p3`, `npm run test:monitoring`
- `npm run test:security`, `npm run test:invocation-recovery`
- `npm run test:evaluation` (exit 0)

New regression scenarios: `secret/tokens.ts -> public/tokens.ts` with
`secret/**` denied, static import dependency between auth and checkout modules,
non-completing source Units blocking dependent work, cyclic imports remaining
schedulable, and tampered checkpoint dependencies being rejected.

## Remaining external-verification boundary

There was no authenticated live Codex ACP / Generic ACP session in the test
environment. The original ~212s reviewer cancellation has not been reproduced
with a real provider. This implementation does not claim to fix or explain the
provider's underlying cancellation reason. Node v22.16.0 is also older than
the project's declared minimum 22.20.0.
