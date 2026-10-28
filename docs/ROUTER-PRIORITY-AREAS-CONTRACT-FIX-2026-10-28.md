# Role Orchestrator — Router Priority Areas Contract Fix (2026-10-28)

## Source and trigger

Baseline: `role-orchestrator-router-task-diagnostics-2026-10-28.zip`, SHA-256 `0f773fbbc83a0aefcc2ddfb98de148ad3db92c8eb184aab26baedec0aa154074`. No earlier codebase used.

Live Zed request: `/test-it необходио продолжить покрытие тестами текущий незакоммиченный функционал и реализованный на последних 6-ти коммитах этой ветки`.

Telemetry: one router invocation completed in 13,566 ms, no provider failure, `intent_unresolved`, `ROUTER_TASK_INVALID` at `shape_validation`, with `taskValidationReasons.invalid_task_spec_priorities = 1`. No execution route established; authorization rejection count 0 because a valid classification was never reached.

## Root cause assessment

- **CONFIRMED:** `validateTaskSpec` rejects a `constraints.priorityAreas` value if the array is not well-shaped (array, <=24) or any entry fails `path()`. `path()` requires filesystem-like characters and rejects spaces and many natural-language punctuation symbols. The advertised JSON Schema previously accepted any string in that field. The Router instructions did not explain the path restriction.
- **CONFIRMED:** this is an actual inconsistent contract for human-readable priorities; the field is not consumed as a Git scope or path by production code. Strict `excludedPaths` and `target.selector` fields remain independent.
- **NEEDS_MORE_DATA:** the original raw model field is intentionally absent from traces. The log does **not** prove whether the model sent a phrase with spaces, a wrong type, too many entries, or another invalid value; it only proves the field class failed. No assertion is made about model compliance or real ACP success.

## Changes

1. `src/routing/task-spec.mjs`: use dedicated, strict text-label validation for `priorityAreas` (string, 1–240 characters, no surrounding whitespace or ASCII control characters), retaining the max-24 limit and existing failure code `invalid_task_spec_priorities`. Explicitly do not reuse `path()`.
2. `src/schemas.mjs`: use the same exported validation regex in the Router-advertised JSON Schema, plus min/max item lengths. The schema and runtime now agree on text-label syntax. Note: JSON Schema `maxLength` counts Unicode codepoints, while JS `String.length` counts UTF-16 code units; the runtime can reject a string with many non-BMP characters that fits the schema. This conservative boundary is not expected to affect ordinary labels; no permission is granted on disagreement.
3. `src/roles.mjs`: instruct the Router to use `[]` when no priority was explicitly given; otherwise return concise textual labels, not inferred Git commands or paths. Git scope must still be expressed only in typed selectors.
4. `test/router-contract-reliability.mjs`: regression tests for text priorities, negative values, safe telemetry code, fail-closed Change, and routing through a fake provider with `union(worktree, recent_commits:6)`.
5. `test/semantic-intent.mjs`: actual Git-fixture integration covering union of six commits and dirty worktree (tracked, staged, untracked files).

## Security audit

- No change to explicit write authorization, host mode override, continuation permissions, named skill resolution, or execution policy.
- `excludedPaths` continues to require a safe relative path; malicious selector fields still fail independently.
- Diagnostics continue to emit allowlisted failure codes only; no prompts, raw model outputs, or freeform priority values are added to traces.
- A valid response is still required for Change; no fallback, retries, second Router, or new semantic keyword detection.

## ACP/provider audit

- ACP adapter and extraction code are unchanged. Successful ACP completion still cannot prove the Router contract is valid.
- Real `@agentclientprotocol/sdk` integration is **ENVIRONMENT_BLOCKED**; SDK is not installed and `npm ci --offline` failed with `ENOTCACHED` for zod. Node v22.16.0 is below the package requirement >=22.20.0. Live Zed with gpt-6-luna not executed.

## Regression audit and verification

The following completed successfully (exit 0): `npm run check`, `npm run test:structured-output`, `npm run test:semantic-intent`, `npm run test:router-request-parity`, `npm run test:router-context`, `npm run test:routing-quality`, `npm run test:routing-integration`, `npm run test:routing-regression`, `npm run test:semantic-evaluator-offline`, `npm run test:routing-quality-hardening`, `npm run test:prelive-security-failures`, `npm run test:monitoring`.

`npm run test:generic-acp`: **ENVIRONMENT_BLOCKED** (module not found). `npm ci --offline`: **ENVIRONMENT_BLOCKED** (missing cached zod). `npm run test:workflow-unstructured`: **NOT_VERIFIED** (combined run exceeded its allowed execution interval without a captured completion status). Full `npm test` and production Zed routing are **NOT_VERIFIED**. See verification-matrix.json and individual stdout/stderr logs.

## Live validation / limitations

Repeat the exact Zed request on the updated build, then run `/routing report`. A valid Router answer with `priorityAreas` containing ordinary Russian labels must no longer fail with `invalid_task_spec_priorities`. An array with invalid types or excess entries still must fail closed. If `invalid_task_spec_priorities` recurs, inspect a privacy-preserving shape diagnostic (array vs other, item count class, rejected item type class), **not** the raw value, and verify the Router provider actually loaded this build. Evaluate remaining failure reasons before changing unrelated contract fields.

The structural fix removes a confirmed source of false rejections, but without the original raw structured output it does not prove this specific Zed failure is fully resolved.
