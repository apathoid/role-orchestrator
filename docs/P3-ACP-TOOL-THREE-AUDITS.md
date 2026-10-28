# P3 ACP Tool Event completion — implementation and 3 audits

Base: uploaded `role-orchestrator(1).zip` (2026-10-25). Scope: S1–S8 measurement completion; **no changes to model prompts, routing policy, permissions, verification gates, or Native Presentation**.

## A1 — architecture / ACP compatibility

Reviewed provider -> workflow -> P3 flow and both ACP adapters. Implemented a single ACP measurement conversion in `src/providers/acp/tool-events.mjs`; emitted the original tool update unchanged to the native UI. Added explicit v1/v2 version selection from negotiated response and limited v2 chunk/upsert handling. Ensured no provider/host dependencies were introduced in the tool accumulator. Prevented per-event O(N) aggregate recomputation by taking snapshots at invocation readout. Verified `test/provider-contract.mjs`, `test/host-neutral.mjs`, `test/acp-presentation.mjs` and `test/acp-tool-bridge.mjs` passed.

## A2 — measurement semantics / ledger consistency

Tested duplicates, terminal-only updates, changes in kind/status, trailing updates, content replacement vs chunks, clear and unknown non-text content, UTF-8 and bounded arrays/ID sets. Fixed missing instruction reference scopes. Added `toolMetrics.version=2` with strict sanitizer, coverage, outcomes, duration semantics and backward compatibility. Found and fixed inconsistent imported legacy counters by deriving legacy-compatible fields from the sanitized v2 aggregate whenever available. Future/custom ACP tool kinds correctly become `unknown`. Tests: `test/evaluation/p3-tool-events.mjs`, P3 production monitoring and session store passed.

## A3 — privacy / resource bounds / operational resilience

Verified no raw text, paths, tool names, IDs, or arguments are written into `toolMetrics` or session JSON. Checked rejection of malicious metadata, byte/character bounds, duplicate terminal state, overflow/truncation and old session import. Nonessential ACP-to-observation extraction is exception-safe. Verified complete Evaluation Harness, monitoring tests and relevant host tests. Source code retains pre-existing ACP Native Presentation and bridge behaviors.

## Residual verification boundaries

- The complete `npm test` **cannot pass in this container**: installed Node v22.16.0 is below project requirement >=22.20.0; `@agentclientprotocol/sdk` is not installed. Offline `npm ci` fails on uncached `zod@4.6.5`. This is a tooling/dependency blocker rather than evidence that ACP integration passed. Run full suite on a supported machine with dependencies installed.
- Live ACP-provider fidelity, real stream fragment shapes, and negotiated v2 SDK support have not been confirmed here. v2 normalizer behavior has been tested synthetically; the existing pinned SDK may not accept v2 notifications.
- Exact input/output token usage is provider-dependent and cannot be inferred from context occupancy or observed tool content.
