# Git scope, review coverage and P3 corrections (2026-10-25)

## Scope resolution

- `commits-by-key` collects independent per-commit change sets. A merge (including octopus) without a known parent does **not** select first parent implicitly. The resolved ordinary commits remain usable and the unresolved commits are represented explicitly.
- A user may specify `merge-parent=N` in a review request or a caller may supply `reviewTarget.mergeParentIndex` for a historical commit. This selects that parent explicitly for **all** matching merges; if a merge lacks parent N, it remains unresolved. Users can alternatively choose an explicit `A...B` Git range. There is deliberately no hidden branch-base guess.
- `status` is `resolved`, `partial` or `unresolved`; `complete` is true only for fully resolved scopes. `changesets` preserve all appearances of the same path; `paths` are unique review-file assignments.
- Git scope keys depend on all resolved commit identities, chosen merge parents and unresolved entries. When source refs change, incompatible checkpoint evidence is not reused. This is intentionally fail-closed rather than speculative cross-plan migration.
- `oldPath` and *all* historical `oldPaths` participate in the security policy check. One prohibited origin invalidates the entire path assignment. Changes remain missing from verified coverage, rather than being silently counted.

## Review coverage and continuation

- Review work completion requires complete Git scope, completed dependencies, complete evidence per assigned changed file and checked criteria.
- The result exposes distinct `scope`, `criteria`, `units`, `files` and `gapCodes`. For partial scope, `files.total=null`; `files.known` counts only the known inventory. Completed Units do not imply complete ticket review.
- If no Units remain but Git scope is unresolved, `review_scope_resolution_required` is emitted; the user should clarify the desired merge parent or range. No open-ended retry loop is started.
- Review checkpoint v2 remains supported. Plan/scope/repo hashes are checked; old or ambiguous evidence is not silently migrated.

## Findings and verification

- Review findings are reconciled locally by explicit `contractId + reproductionKey + path`; absent such keys, exact Quality State identities are used. Evidence is combined without changing global P2 `findingIdentity`. Possible duplicates are counted separately; uncertain cases are never silently merged.
- The responder receives the normalized findings; any missed finding message is appended deterministically. P3 separates raw, unique and potentially duplicate findings.
- Workflow verification results are the authority for verification disposition. ACP `execute` tool events count as observed command activity, *not* independently confirmed passed test cases. Unsupported numeric test claims are downgraded in the final review response; no raw tool contents enter P3.

## P3/UI

- The progress event describes *executed batches*, the *maximum allowed batches*, Review Units, Git scope and file coverage separately. `Review batch 1/8` no longer claims 8 planned batches.
- `review_progress` is a privacy-filtered projection of the authoritative Review Coverage, not an independent mutable registry. New efficiency fields are allowlisted on persistence; absent total file counts stay `null`.
- Legacy efficiency records retain their old fields and load with new optional fields as null.

## Verification and limits

- Added `test/review-scope-hardening.mjs`, which creates actual Git histories including two-parent and octopus merges; verifies explicit parent selection, partial inventory, recurring file changes, aggregated historical rename security, per-file coverage, safe findings reconciliation, test claim downgrades and P3 persistence.
- Full real Codex ACP and Generic ACP integration was not exercised; test fixtures and local Node execution do not prove upstream provider behaviour.
