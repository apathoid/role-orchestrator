# Audit 3 — Integration & Reliability (2026-10-28)

## Paths checked

Offline production request-builder parity; four main Investigate/Review/Change/Plan flows; saved continuation paths and trusted resumes; cancellation/invalid Typed Task authorization denial; event normalization, restart and replay; Ground Truth candidate/label; deterministic offline evaluator and regression CLI; JSON output and exit codes. Testing used fake providers **only** for deterministic integration, not a fake ACP SDK replacing production dependencies.

## Findings and dispositions

| Severity | Observation / cause | Remedy and evidence | Status |
|---|---|---|---|
| MEDIUM | Replay can duplicate delivered events/run traces and inflate counts. | Dedup by run, event identity/sequence, invocation identity; partial and unknown reasons explicit. Tests cover duplicate delivery, partial and replay. | FIXED |
| MEDIUM | Unknown old reason codes cannot reliably identify failure origin. | Partial coverage and `unknown` classification, rather than invented provider reason. | SAFE INCOMPLETE EVIDENCE |
| LOW | `readRun` must refuse unsafe links, permissions, partial/corrupt files. | O_NOFOLLOW, owner/link/mode checks, validated sequence; JSONL partial final line remains interrupted evidence. | HARDENED |
| ENVIRONMENT_BLOCKED | Full integration suite imports `@agentclientprotocol/sdk`, not present after offline dependency install failed for uncached `zod`; Node is 22.16.0, project declares >=22.20.0. | No mock replacement. Run `npm ci` and full `npm test` on Node 24 in real Zed environment. Independent targets tested here. | NOT_VERIFIED |

## Test verdict

The required targeted npm scripts pass in independent runs. Two sequential `npm test` executions fail at the missing real ACP SDK (distinct from test assertions); the complete production suite **cannot** be claimed successful. `npm ci --offline` failed for uncached dependency, while direct `npm ci` did not complete in the network-limited sandbox. Per-command stdout, stderr, exit codes and environment are retained in the log artifact.

Patch and archive equivalence are verified separately during packaging. No modified or added test case was injected into the original 56-case corpus. No observed authorization bypass or additional Router invocation was found in the deterministic integration tests. The conclusion is conditional `READY_WITH_LIMITATIONS` for attempting real Zed validation after restoring dependency availability.
