# Audit 2 — Metrics & Evaluation Correctness (2026-10-28)

## Independent mathematical checks

Compared the original failure distribution and typed selector equality against source-controlled reproductions from a **clean original archive**. Evaluated denominator eligibility, confirmed Ground Truth only, false-positive Change, saved operation IDs, missing fixtures, versioned case/config identity, historical compatibility and paired regression gates. Checked contract/provider/environment separation and CI statuses.

| Severity | Root cause and reproduction | Local fix | Regression test | Status |
|---|---|---|---|---|
| HIGH | Distribution used `fails.map(r=>r.failure)` although normalized records were `{code}`; one Router crash produced counter=1, distribution={}. | Count `providerFails` directly by validated `code`; separate origins, dedupe event/replay/invocation, unknown historical reason remains unknown. | `test/routing-quality-hardening.mjs`: one/many/different/duplicate/partial/historical. | FIXED |
| HIGH | `JSON.stringify(selector)` comparison depended on object property insertion order; equivalent typed selectors returned false. | Production-validator-backed structural identity (`isDeepStrictEqual`) without weakening Git selector validation. | Selector type/ref/notation/parent/union/worktree tests. | FIXED |
| HIGH | Missing offline fixture was categorized provider failure with `routerInvocations=0`. | `FIXTURE_MISSING` and simulated provider failure categories; only actual provider calls contribute real provider failures. | Source reproduction and offline CLI regression. | FIXED |
| HIGH | Original `accuracy` included legacy fixtures not independently confirmed. | Accuracy/precision/recall/false positive metrics use confirmed rows exclusively; fixture agreement is explicitly separate. | Routing quality and regression CI. | FIXED |
| MEDIUM | Case digest omitted host/continuation/context; JSON key order could change digest. | Canonical versioned v2 semantic case digest over trusted replay conditions; separate configuration identity. | Digest mutation and order invariance tests. | FIXED |
| HIGH | Continuation accuracy counted correct mode when the saved operation ID was incorrect. | Exact `operationId` comparison, including absent vs extra ID; continuation gate detects regression. | Saved review tests and regression gates. | FIXED |
| HIGH | Aggregate comparisons could combine unlike eligibility sets or historical digests, yielding false pass/fail. | Explicit paired confirmed sample and v2 digest; incompatible conditions and insufficient paired observations return `INSUFFICIENT_EVIDENCE`. | CI test compares false-positive Change, historical digests, changed config, sample min, mismatch. | FIXED |

| MEDIUM | Multiple distinct historical failure events without invocation IDs could be counted as separate provider failures for one start, producing failure rate above 100%. | Attribute to at most one observed Router start; prioritize explicit matching invocation IDs; additional ambiguous events become unknown/partial. | Uncorrelated same-run errors, duplicate starts, and correlation-priority regressions. | FIXED |

| MEDIUM | Provider regression gate could count a newly invoked candidate failure in its numerator while excluding that row from the paired-invocation denominator. | Derive numerator strictly from rows where both sides have observed invocations; incomparable failures cannot establish a paired provider regression. | Provider-invocation eligibility boundary test. | FIXED |

## Evidence rules

Accuracy numerators and denominators are computed on valid **confirmed** predictions, not on task completion. Paired accuracy uses only rows valid on **both** sides, with identical case digest and input corpus. A newly invalid output affects contract failure counts but not semantic misclassification; provider failure counts require actual provider invocation. Missing measurements remain null. Each gate reports numerator, denominator, evidence, baseline/current and reason. No universal model quality threshold was invented.

## Limitations

The 56 legacy cases are synthetic developer fixtures, not real labeled production distribution. No independent evidence of model accuracy, confidence intervals, real false-positive Change incidence or provider A/B result is available in this environment. The offline CI result demonstrates correctness of the **evaluation mechanics**, not the quality of a production LLM.
