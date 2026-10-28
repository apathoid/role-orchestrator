# Updated Zed Live Acceptance Guide — 2026-10-28

Retains all **35** original positive/negative scenarios and log names from [`SEMANTIC-FINALIZATION-ZED-ACCEPTANCE-2026-10-27.md`](SEMANTIC-FINALIZATION-ZED-ACCEPTANCE-2026-10-27.md). Do **not** reinterpret the local test results as completed Zed checks. All 35 live E2E cases remain **NOT_VERIFIED** until executed.

## Prerequisite gates

1. Install a supported **Node >=22.20.0** (prefer Node 24), run `npm ci` using the existing lockfile without mocks, then `npm run check` and **two uninterrupted `npm test`** runs.
2. Record resolved Router model/profile/provider for the actual preset, role context mode, available skills, saved Plan metadata, project scope and relevant host instructions. Ensure a real ACP provider is configured and its credentials are not included in logs.
3. Execute all 56 unmodified corpus cases via `node tools/semantic-evaluate.mjs "$PWD" test/evaluation/semantic-intent-corpus.json --run`; record *all* errors, nonresponses, false-positive Change cases, invocation counts, time and usage. Do not compute semantic accuracy over provider errors.
4. Use a disposable real Git repository and backed-up Zed session-state directory. Capture initial `git status --porcelain`, `git rev-parse HEAD`, content fingerprints, provider traces and checkpoint JSON (redacted).

## Additional pre-live acceptance controls

- For scenarios **1, 3, 4, 5, 6, 21, 22, 25, 26, 27 and 28**, compare the *actual* Router input against `buildSemanticRouterRequest` using identical trusted host/skill/Plan/Review/context and verify real provider authorization boundaries. Do not inspect secrets in plaintext logs; store salted digests and structured provenance.
- For scenarios **7–13 and 29–31**, capture pre/post checkpoint IDs, frozen scope, completed/pending units, cumulative budgets and persisted file hashes. Restart both Zed and the provider process; never count completed units twice without explicit drift-invalidated evidence.
- For scenarios **9, 10, 12, 23, 24 and 33–35**, inject cancellation, provider exit, timeout and malformed/duplicate ACP notification sequences. Compare actual ACP event ordering, progress terminality and provider telemetry with session snapshots.
- For scenarios **14–16**, use real staged/unstaged/union targets, invalid revisions and merge-parent ambiguity. Missing union members must fail closed without fabricating a smaller scope.
- For scenario **28** and all read-only invocations, compare before/after tracked, untracked, ignored/protected path witnesses where permitted. Diagnostics may write only to explicitly allowed paths; do not hide side effects in the Git-only fingerprint.
- For crash-consistency acceptance, force interruption after an external side effect but before the corresponding checkpoint. Verify recovery by direct reconciliation or true external idempotency key; no generic exactly-once guarantee can be accepted.

## Live PASS rule

Mark a scenario PASS only with actual Zed/ACP trace, real provider response, pre/post Git/session evidence, and positive and negative controls. `NOT_VERIFIED` is not `PASS`; a provider crash is not a semantic false negative. Any schema-valid false-positive Change that causes unauthorized writes blocks release. Maintain the 35-case matrix; append exact `zed-live-NN*` file names, model/profile, timestamp, git hashes, invocation counts and observer verdicts.
