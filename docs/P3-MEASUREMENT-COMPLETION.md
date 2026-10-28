# P3 Measurement Completion and Router Context Optimization

This stage extends the existing P1/P2/P3 observability. It does not modify
routingPolicy, model assignments, review/verification gates, write permissions,
Engineering Core or durable implementation/recovery state.

## Monitoring (enabled without environment flags)

- `prompt_profile` and `activity` survive the provider registry event boundary.
- The role's total `elapsedMs` is measured on the outer invocation monotonic clock;
  `timingBasis=monotonic_invocation` distinguishes new measurements from legacy rows.
- `providerPromptProfile` describes only the adapter-prepared text. It does not
  include unobservable hidden agent instructions or provider-side tool schema.
- Context composition includes top-level sections, source text measurements by
  instruction scope and (where instrumented) exact source spans for large
  Reviewer/FinalValidator bodies. `other` explicitly remains unclassified.
- `usageAvailability` separates occupancy observations from actual token usage.
  Generic ACP `usage_update.used/size` is occupancy **not** cumulative input.
- Tool categories and observed content sizes are bounded hints, not definitive
  per-tool token bills. Tool output text, arguments, code and paths are not
  persisted in metrics. Delayed updates after a terminal role result are ignored.
- `contextTimeline` and P3 session ledger are bounded, optional and subordinate
  to durable Plan/P2 task state.

### Commands

`/efficiency`, `/efficiency runs`, `/efficiency run <id>`,
`/efficiency export [id]`, `/efficiency coverage`.

`/efficiency history` requires `AGENT_P3_HISTORY=1` for cross-session reads.
Local batch export: `node tools/efficiency-export.mjs <session-id>`.

The `coverage` command counts invocations with each field observable; it is
not an assertion that providers have supplied exact input/output tokens.

## Router context modes

`AGENT_ROUTER_CONTEXT_MODE=legacy` is the default. `observe` computes an
alternative context **without changing the Router prompt or calling a model**.
`optimized` uses the specialized context only after explicit, hash-pinned
operator review; otherwise it automatically falls back to legacy. No other
role's context is changed by this flag.

To review documents, run:

```bash
node tools/router-context-inventory.mjs /absolute/path/to/repository
```

This lists scopes, paths, character lengths and SHA-256 digests of the **body
as actually loaded** by Role Orchestrator (trimmed/canonicalized by its loader).
Hashing the raw file including trailing newlines can produce a different hash.

Create `/repository/.agents/role-orchestrator/router-context.json` manually:

```json
{
  "version": 1,
  "reviewed": true,
  "excludeInstructions": [
    { "scope": "project", "sha256": "<64 hexadecimal chars from inventory>" }
  ],
  "routingConstraints": "Explicit, comprehensive project-specific instructions for mode, write intent, risk and complexity classification. Preserve all high-risk/security/data routing requirements from excluded documents."
}
```

This is a **manual attestation**, not automatic semantic analysis. Never mark
unknown instructions safe to omit. Changing a referenced document invalidates
its digest and triggers full-context fallback. Non-excluded documents, active
skills, review targets and conversation/task history are retained. The
manifest grants no write authorization or tool permissions. `AGENT_P3_CONTEXT`
remains independent; task history is never silently trimmed by this feature.

Suggested deployment:

1. Run `observe` and inspect `/efficiency run <id>` / JSON exports: original vs
   projected Router characters and the fallback reason.
2. Review the classification and resulting downstream policy for a curated
   corpus: read-only questions, explicit edits, Plan-only mode, saved Plan
   continuation, project-specific architectural/security risks and ambiguous
   intent. The optimizer does not prove semantic equivalence by itself.
3. Run `optimized` only in an explicitly selected/tested environment. Compare
   actual model outcomes and resulting workflow quality; revert to `legacy`
   immediately if the expected write/risk/tier decisions regress.

Existing `AGENT_P3_CONTINUATION_FAST_PATH` remains separate; enabling optimized
Router context does **not** cause the model call to be skipped.

## Measurement limitations

- Exact input/output/cached token usage depends on the provider's reporting
  capability; missing fields are `null`, not zero or a token estimate.
- Provider-internal model prompt composition, tokenization, prompt-cache billing,
  and costs are not observable from generic ACP occupancy alone.
- Nested profile sections are not summed twice. Legacy historical records
  retain their old timing/coverage semantics. Some template paths still fall
  into `other`; readiness reports this explicitly.
- Correlations between tool events and subsequent window growth do not prove
  that a particular tool caused those tokens.
- Synthetic fake-provider parity tests establish integration and prompt
  invariants, not real-model classification accuracy; real ACP/model A/B tests
  are still required before enabling optimized routing by default.

## Verification

```bash
npm ci
npm run check
npm run test:evaluation
npm run test:monitoring
npm run test:router-context
npm test
```

Full ACP/CLI smoke tests require the locked SDK dependencies and a compatible
Node version (package.json specifies >=22.20.0). In production, never claim
that provider-specific integration has been exercised until it has.

## Final closure of remaining coverage gaps

See [P3-MEASUREMENT-CLOSURE.md](P3-MEASUREMENT-CLOSURE.md). Source-spanned
Review/staged-implementation bodies, authoritative outcome counts, safe
cross-run grouping and a Router-only A/B evaluation runner were added after
the original three-audit release. The optimizer **remains opt-in**, and any
unavailable exact token figures remain unknown.
