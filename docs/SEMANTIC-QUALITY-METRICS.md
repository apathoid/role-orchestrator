# Semantic Routing Quality Metrics Specification — v2 (2026-10-28)

## Authority and evidence

Semantic execution originates **only** from the LLM Router / Typed Task v1, with deterministic host/permission/write gates. Traces, Ground Truth, reports and evaluators have no execution authority. Neither successful execution nor a synthetic fixture proves that the Router classified real-world intent correctly. The 56 original legacy cases are unchanged, but **not** automatically `confirmed`.

## Execution trace operational metrics

`aggregateRoutingTraces` reads bounded, persisted JSONL event envelopes `version=1`, without model calls. Every `role_start(role=router)` is one invocation; repeated `eventId`/`sequence` and invocation IDs are deduplicated. Replayed runs sharing `(sessionId, runId)` count once. Unknown or invalid events and partial traces degrade coverage. Trusted continuations do not create Router invocations. No attempt is inferred from a mere `route` or success.

| Metric | Numerator | Denominator / eligibility | Missing evidence |
|---|---|---|---|
| Provider failure rate | Unique router invocation failures with recognized provider origin (`PROVIDER_CRASH`, `PROVIDER_CANCELLED`, `TIMEOUT`, `PROVIDER_TIMEOUT`, `RATE_LIMIT`, `MODEL_UNAVAILABLE`, or explicit `UNCLASSIFIED_PROVIDER_FAILURE`) | Observed unique Router `role_start` | Null / `NOT_VERIFIED` for zero invocations |
| Validation failure | Observed validation `invalid` or `missing` | Observed semantic validation events | Null |
| Authorization rejection | Observed `authorization_resolution=denied` | Observed authorization resolutions | Null; not a security attestation |
| Optimized context fallback | Requested `optimized` and selected `legacy` | Router context events requesting optimized | Null |
| Latency / tokens | Sum and mean of finite, nonnegative samples | Separately reported sample count; missing samples excluded | Null, not zero; `PARTIAL` if incomplete |

`distributions.providerErrors` counts the same normalized provider failures as `counters.providerFailures`: **sum of buckets equals providerFailures**. `failureOrigins` separately contains provider, contract, environment, authorization, cancellation and unknown; `nonProviderErrors` has only recognized non-provider reasons. Historical errors lacking a safe normalized reason remain `unknown` (not silently attributed to a provider). An absent `role_start` cannot establish a Router provider failure. Ambiguous historical failures without correlation are credited to one observed invocation only if a single start is present and no correlated error exists; additional/unattributable failures remain unknown. The failure rate cannot exceed 100% even when historical traces contain multiple errors without IDs. Duplicates, interrupted traces, incompatible versions and read errors contribute to partial evidence. The provider failure rate is a ratio of failed invocation attempts to observed invocation starts, **not** a semantic accuracy statistic. Cancellation explicitly initiated by the client/session is not a provider failure.

`records` intentionally contain only identifiers, categorical labels, context mode and evidence flags. Provider/model identifiers come from validated diagnostic fields, never prompts. Unavailable `usage` fields are null. `status=MEASURED` is operational completeness, not model accuracy.

## Evaluation result metrics

Failure types are `CONTRACT_FAILURE`, `PROVIDER_FAILURE`, `ENVIRONMENT_FAILURE`, `FIXTURE_MISSING`, plus semantic mismatches for valid outputs and `INSUFFICIENT_EVIDENCE` when comparison lacks valid matched labels. `simulated_provider` fixtures are **not** actual provider invocations; count them separately as `simulatedProviderFailures`, never `providerFailures`. An offline `--offline` run reports zero `routerInvocations`, even when a fixture contains a synthetic error or valid output. A real `--run` provider call alone may be counted as invoked. Invalid structured outputs are contract failures, not mismatches; request-building failures are environment failures.

`accuracy` and `groundTruth.accuracy` use **only** `labelStatus=confirmed` with manually validated expected fields and a valid Router prediction. For each field, numerator is correct predictions; denominator is confirmed valid predictions for which both sides are comparable. `semanticDenominator = verifiedOutputs`; coverage is `verifiedOutputs / confirmedCases` (null if no confirmed cases). `fixtureAgreement` is a separate, explicitly synthetic legacy fixture agreement metric and **must not** be advertised as semantic accuracy. `semanticAccuracyVerified` is false in offline mode, regardless of sample size. `falsePositiveWrite`, `falsePositiveChange`, precision/recall and continuation accuracy require confirmed Ground Truth. Saved operation comparison includes `operationId`, if expected, and rejects an unintended ID when Ground Truth expected it absent.

Git scope comparison is validated typed selector **identity**, not equivalence after Git ref resolution. Different ref names, `..` versus `...`, merge parents, worktree modes, and union ordering are distinct. Object key order is irrelevant; missing optional fields and unknown/invalid fields are not silently normalized.

## Regression gates

Regression evaluator is read-only and requires explicit positive `minConfirmedCases`, paired identical `caseDigestVersion=2`/digest identities, equivalent case sets, matching evaluation conditions and enough valid paired cases. A baseline with v1/missing digest is `INSUFFICIENT_EVIDENCE`, not a spurious pass. Configuration changes require `allowConfigurationChange:true` explicitly; corpus/evaluation-mode differences remain incompatible. For each gate `numerator`, `denominator`, `evidence`, `reasonCode`, `baseline`, `candidate` and `decision` are emitted. Both sides use **exactly the same** confirmed eligible subset. Failure gates may use invalid outputs but never silently fold infrastructure failures into semantic accuracy. There are no default universal quality thresholds; unspecified minimum means insufficient evidence.

See [Evaluation & Regression Gates Guide](EVALUATION-REGRESSION-GATES.md) for exit codes, applicability and boundaries.
