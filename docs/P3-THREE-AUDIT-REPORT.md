# P3 Measurement Completion – Implementation and Three Audit Passes

Base: `role-orchestrator-context-monitoring-hardened.zip`.

## Shipped

- Provider event preservation and adapter prompt measurement.
- Outer monotonic invocation timing, late-progress protection and per-field
  usage observability; ACP occupancy never presented as billed input tokens.
- Per-scope instruction source measurements and explicit source-span support
  for critical Reviewer/FinalValidator bodies; safer handling of repeated text.
- Bounded tool classification/completion timing and output-length observations.
- Read-only `/efficiency coverage` with explicit coverage gaps.
- Three router modes (`legacy`, `observe`, `optimized`) with reviewed SHA-256
  document exclusion, conservative fallback and unchanged other-role prompts.
- Opt-in manifest inventory utility and regression/evaluation cases.

## Audit 1 — boundaries, security, architecture

Findings and resolutions:

- `prompt_profile` and `activity` were downgraded to `progress` in provider
  normalization: explicit handling added, preserving the telemetry through the
  registry without adding UI events.
- A generic ACP context occupancy update could create an apparent cumulative
  usage scope: observation explicitly marked `occupancy`; counters remain
  unknown where provider does not report them.
- Project documents may contain risk policies: optimizer forbids automatic
  omission, requires reviewed exact hashes, retains skills/history and falls
  back to legacy when uncertain. Core routing/security policy unchanged.

## Audit 2 — numerical correctness and event races

Findings and resolutions:

- Provider meta time and ledger first activity had incompatible origins:
  both now use outer monotonic invocation time; legacy measurements are marked.
- Duplicate tool-call events inflated per-category counts: category totals
  now respect observed tool identity when supplied.
- Streaming activity after the terminal event could corrupt elapsed timings:
  terminal invocations no longer accept later telemetry.
- Per-field token coverage now considers the field's own known-scope
  completeness instead of treating unrelated missing counters as partial.

## Audit 3 — prompt invariants, privacy, operational constraints

Findings and resolutions:

- Explicit span marking inside a nested template literal could stringify a
  marker object as `[object Object]`, changing a Review prompt. Fixed by
  preserving primitive string conversion and added a nested-template test.
- Profiled tool data and Router telemetry are normalized through strict
  allowlists; adversarial text is not retained, including after save/load.
- Router `observe` has identical prompts to `legacy`; `optimized` only changes
  Router's prompt when hash validation passes. Non-router prompt equality is
  asserted in a real workflow driven by a fake provider.
- Persistent telemetry retains bounded sample sizes and existing P3 limits.

## Tests and evidence

`npm run test:evaluation`, `npm run test:monitoring`,
`node test/evaluation/p3-router-context.mjs`, and
`node test/evaluation/p3-monitoring-production.mjs` were run in this
workspace. Exact commands and final results should be checked alongside this
report. The fake provider verifies orchestration, not live LLM decisions.

## Remaining external and experimental limits

- Full `npm test` requires `@agentclientprotocol/sdk`, which is missing from
  this container. `npm ci --offline` could not fetch the uncached `zod` package;
  installed Node is 22.16.0 while package.json requires >=22.20.0.
- Exact token usage is intrinsically unavailable from a provider that reports
  only occupancy. No billing estimate is fabricated.
- Specialized Router context remains an opt-in experiment pending an actual
  model comparison corpus. The system fails safely to legacy context on
  missing/stale manifests, but semantic quality cannot be proved by unit tests.
- Some rare/legacy prompt construction sites still report `other` for context
  whose source is not explicitly tagged; monitoring exposes these as gaps.
