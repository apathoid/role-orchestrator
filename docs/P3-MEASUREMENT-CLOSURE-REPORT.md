# Final P3 Measurement Closure — Implementation and Review

Base archive: `role-orchestrator-measurement-router-completion.zip`.

## Changes

1. Added `src/efficiency/outcome.mjs`: bounded, allowlisted projections of authoritative workflow results (status class, Review verdict/counts, verification dispositions/check counts, implementation/acceptance/P2 quality coverage). Unknown data remains `null`; no raw findings, test output, paths, prompts or reasons are persisted.
2. Extended the existing P3 run ledger with `outcome` and `executionGroupId`; reporting includes outcomes and groups. Task continuity is recorded **only** for tasks explicitly selected or registered by the execution service, never inferred from unrelated prior active tasks or similar text. Standalone turns remain separate.
3. Extended source-span profiling for Review batches, review-only validation and response, and staged Coder prompts. Tagged literal scaffolding is attributed to `workflow_scaffold`; repeat values can be measured independently. The submitted text remains unchanged, as checked by span parity tests and existing workflow tests.
4. Added `src/routing/evaluation.mjs` and explicit CLI `tools/router-evaluate.mjs`: run real Router in legacy and optimized mode, stop execution immediately on the routing decision, compare both complete routing-policy projections, verify independently curated expectations and detect safety downgrades. The evaluator does not call Explorer, Coder, Verification, or Responder.
5. Added example Router corpus, a new documentation page, and repeatable tests. Existing routing behavior, user permission policy, P2 durability/recovery, Engineering Core, provider architecture, context-optimization flags and defaults are unchanged.

## Review pass A: authorization and semantic scope

- Verified the A/B harness ends on `route` before downstream steps; fake provider observes exactly two Router calls, zero non-Router calls and zero edits.
- Verified that missing/stale routing manifests are **ineligible** for optimizer success, even if the outputs agree. Operator-reviewed digest and actual optimized selection are required.
- Verified classification and policy difference detection, including accidental write route, risk downgrade, complexity downgrade, required final validation loss, and missing expected classifications.
- Limitation: synthetic model outcomes cannot establish real-model semantic equivalence. `AGENT_ROUTER_CONTEXT_MODE` stays `legacy` by default; actual A/B testing is opt-in.

## Review pass B: telemetry truthfulness and privacy

- Added counts derived only from result structured fields; no new quality verdict inferred from telemetry.
- Detected and fixed a potential import path that trusted an externally supplied group ID. Group labels now always derive from validated task/run IDs. Injection and unknown-value test added.
- Separated P2-backed task grouping from independent run grouping, preventing stale task identity leakage onto unrelated read-only turns.
- Boundaries remain: exact input/output billing tokens cannot be recovered from context occupancy; uninstrumented dynamic values may appear as `other`.

## Review pass C: compatibility, prompt invariants and tests

- Source transformations were restricted to adding span tags and using `trackedBody`; no role instruction or prompt prose changed. The monitor tracks literal workflow boilerplate separately to avoid falsely labeling large known static strings as unknown.
- Extended the existing test scripts and added deterministic outcome, adversarial import and Router-only A/B scenarios. All tests in `npm run test:evaluation`, `npm run test:monitoring`, `test/execution-service.mjs`, `test/orchestrator-runtime.mjs`, and `npm run check` passed in this environment.
- Full `npm test` remains blocked at `test:generic-acp` because the package `@agentclientprotocol/sdk` is not installed here. Local Node is v22.16.0 while the package specifies Node >=22.20.0. Therefore live ACP/provider compatibility and real-model A/B approval have **not** been demonstrated by this container.

## Operational use

Run `npm ci && npm test` on supported Node in the real environment. Use `/efficiency run <id>` and `/efficiency export` for outcome and context analysis; use `test/fixtures/router-evaluation.example.json` as a starting point for a user-reviewed corpus, not as a universal expected-behavior oracle. For Router optimization, manually review the project manifest and run `node tools/router-evaluate.mjs /repo /fixtures.json --run`. Do not enable optimized routing by default until real-model decision parity and downstream policy/quality checks pass.
