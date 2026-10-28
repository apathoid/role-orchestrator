# P3: ACP Tool Events normalization and measurement

## Purpose / invariants

Provider adapters translate ACP tool updates into a **private, aggregate-only observation stream**. ACP native tool updates continue on their existing host presentation path, unmodified. The workflow does not interpret ACP status/kind/content fields, and the efficiency ledger never stores IDs, names, titles, paths, arguments, raw input/output, or content.

- `src/providers/acp/tool-events.mjs`: ACP v1/v2 boundary, patch and chunk semantics, allowlisted `ToolKind`, Unicode text/diff/resource-text measurements. Exceptions in nonessential profiling return `null`, not provider-turn errors.
- `src/providers/acp/generic-acp.mjs` and `src/providers/codex-acp.mjs`: emit unchanged native `update` **plus** private `observation`. Protocol version uses negotiated `initializeResponse.protocolVersion` (or local SDK protocol version); `tool_call_content_chunk` is explicitly v2-only.
- `src/workflow.mjs`: forwards `toolObservation` for per-invocation P3 measurement; existing `update` continues to Native Presentation.
- `src/efficiency/tool-metrics.mjs`: bounded, provider-neutral per-invocation accumulator; tools keyed transiently by opaque ID. One aggregate generated when the invocation snapshot is requested. A minimal legacy adapter is retained for fake/in-process providers and old tests.
- `src/efficiency/analytics.mjs`, `src/session-store.mjs`, `src/efficiency/readiness.mjs`, `src/acp.mjs`: persisted v2 aggregate, strict sanitization, legacy compatibility, coverage and reports.
- `src/efficiency/profiling.mjs`: includes known `*-reference` instruction scopes (especially `project-reference`), without changing prepared prompt strings.

## Measurement semantics

`toolMetrics.version=2` is the version of the **measurement schema**, not the negotiated ACP version. `calls` is the number of distinct observed tool IDs, bounded to 2,048; `events` and `updates` count observed events and saturate at 100,000. Tool outcomes are `completed`, `failed`, `cancelled` and `incomplete` (including missing/unknown terminal status). Terminal-only first updates count as outcomes but do not fabricate a duration. `lifecycleMs` sums intervals from first observation to terminal status where the interval is observable, and `runningMs` sums intervals from observed `in_progress` to terminal; both have coverage counters and can exceed invocation elapsed time when tools overlap.

`kinds` represents ACP declared kind, a narrow name inference for known legacy tools, or `unknown`. Unknown/custom kinds are not inferred from titles or commands. `kindCoverage` indicates source confidence. `contentCharacters` and `contentUtf8Bytes` measure **observed text**, never context tokens or raw JSON size. Snapshot content replaces the earlier content; chunks append, and explicit empty content clears. Unsupported images/terminals/binary content are not assigned fictitious text sizes. If all observed content volumes are unknown, the aggregate is `null`, not zero. `contentCoverage` makes non-text and unobserved content explicit. The measurement is not evidence that the model ingested the whole tool result.

When the provider cannot send complete events, some metrics remain incomplete; this is displayed as `unknown`, `truncated` or missing coverage, rather than reconstructed from context-window occupancy. Full historical event data is not reconstructed by importing old sessions; the legacy fields remain readable without a synthetic `toolMetrics.version=2` record.

## ACP protocol-version boundary

Current pinned `@agentclientprotocol/sdk` may not negotiate v2; the code recognizes v2 upsert and `tool_call_content_chunk` **if those updates reach the adapter**. This does not add a host-facing v2 capability or upgrade the SDK's notification validation. Native bridge remains v1-compatible. End-to-end v2 negotiation and display require future SDK/host support and separate compatibility verification.

Normative references:
- https://agentclientprotocol.com/protocol/tool-calls
- https://agentclientprotocol.com/protocol/v2/tool-calls
- https://agentclientprotocol.com/protocol/v2/migration

## Tests / validation

```sh
npm run check
node test/evaluation/p3-tool-events.mjs
npm run test:monitoring
npm run test:evaluation
node test/acp-presentation.mjs
node test/acp-tool-bridge.mjs
node test/session-store.mjs
npm test
```

The evaluation fixtures cover v1/v2 patch semantics, terminal-only upsert, status/kind evolution, duplicated terminals, streaming content replacement/append/clear, Unicode, unknown/partial content, data poisoning, privacy, reference scopes, bounded tool maps and legacy-session imports. Real-provider ACP parity and v2 SDK support still require running full integration tests in a supported dependency environment.
