# Evidence-driven efficiency — two-pass technical audit

## Pass 1 — functional behavior and durable review state

Checked deterministic review strategy, Git scope exclusions, structured review units, budget pause semantics, checkpoint v3 authority, token-usage unknown handling, source-revision invalidation, and source-level evidence proof boundaries.

Fixes during this pass:
- A new direct Investigation route invalidated legacy tests that expected an Explorer call. Preserved default legacy behavior, added separate opt-in integration coverage and verified read-only protection when the direct Investigator is used.
- Budget accounting initially treated missing provider usage as partial even if **all** observations were missing. Changed to unavailable/partial/provider-reported according to actual observations; token limits never trigger on incomplete token observations.
- Added an end-to-end budget pause test: review remains incomplete, reviewer invocation limit is respected and the previous verified work is persisted to the Review Operation checkpoint. Missing evidence is not promoted to success.
- Confirmed checkpoint's derived Evidence Projection cannot override actual persisted `records` and `reports` or authorize source edits.

## Pass 2 — host/provider independence, privacy and regression

Checked new modules for provider/editor names, role boundary, unsafe automatic verification, arbitrary code execution, prompt/evidence telemetry leakage, and old checkpoint/session compatibility. Default model invocation policies remain unchanged except risk-aware review strategy; risky cross-workflow paths are explicit opt-in.

Tests observed passing:
- `npm run check`
- `node test/efficiency-architecture.mjs`
- `node test/review-efficiency.mjs` (including budget pause, direct Investigation and explicit skill policy)
- `node test/review-operation-continuity.mjs`
- `node test/review-work-plan.mjs`
- `node test/config.mjs`, `node test/session-store.mjs`
- `node test/skill-routing-presentation.mjs`, `node test/skill-workflow-integration.mjs`
- `npm run test:evaluation` (P1/P2/P3 integration and observability cases, fake/in-process providers)

The long `test/workflow-unstructured.mjs` timed out when run by itself under this environment. Its previous Explorer-dependent expectations were isolated to legacy mode, but the entire long suite must **not** be recorded as a successful run.

No real provider session was available, so real token consumption, measured Codex 5-hour quota savings and claim-level reviewer accuracy remain unverified. A quality baseline on genuine user code and a real ACP integration run are required before declaring the full I1–I7 initiative complete.
