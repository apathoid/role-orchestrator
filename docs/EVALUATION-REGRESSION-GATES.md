# Semantic Evaluation & Regression Gates — CI guide (2026-10-28)

## Entry points

- `npm run test:routing-quality-hardening` — deterministic metrics, typed selector, provenance, privacy, replay and gate tests.
- `npm run test:routing-regression` — deterministic end-to-end offline evaluation through **existing** `tools/semantic-evaluate.mjs` and `tools/routing-compare.mjs`; verifies JSON outputs, a new false-positive Change, gate pass/fail, digest incompatibility and exit statuses. No LLM, ACP mock or network needed.
- `node tools/semantic-evaluate.mjs /repo/path corpus.json --offline responses.json [--context-mode legacy|observe|optimized]` — production request builder, synthetic fixtures, machine-readable JSON printed on stdout; never provider-backed.
- `node tools/semantic-evaluate.mjs /repo/path corpus.json --run [--context-mode ...]` — real provider evaluation (requires working configured provider and credentials).
- `npm run routing:compare -- baseline.json candidate.json criteria.json` — side-effect-free comparison; returns JSON.

Example CI command: `npm run test:routing-regression`. To gate a pinned, **independently confirmed** private corpus and fixtures, save stdout from two evaluations as baseline/current JSON and compare with `criteria.json`, e.g. `{ "minConfirmedCases": 10, "denyNewFalsePositiveChange": true, "denyContinuationRegression": true, "denyNewContractFailure": true }`. The minimum is your explicit evidence policy, **not** a universal recommended threshold.

## Exit codes and meaning

`routing-compare`: `0=PASS`, `1=confirmed regression`, `3=INSUFFICIENT_EVIDENCE`, `2=invalid inputs/environment`. `semantic-evaluate`: `0=no measured structural failure`, `1=contract failure or confirmed unsafe false-positive Change`, `3=incomplete confirmed evidence/missing fixture`, `2=environment/CLI failure`. The offline suite is a mechanics test; a code 0 **does not** prove production LLM accuracy.

## Pairing and eligibility

`caseDigestVersion:2` is a canonical SHA-256 over validated semantic case conditions. Historical v1/missing digests are incompatible. `evaluationIdentity` records version, corpus digest/version, request builder version, evaluation mode, hashed effective Router configuration, Router instruction digest, provider, model, role preset, context mode and projection digest. Never record raw instructions, prompts or secrets in this metadata. A corpus mismatch, changed evaluation mode, missing identity, changed case conditions or different confirmed eligibility sets leads to `INSUFFICIENT_EVIDENCE`. Configuration changes are explicitly visible; setting `allowConfigurationChange:true` permits an intentional model/context A/B comparison **only** when corpus, mode and case conditions remain comparable. Caller must assess whether changed instruction projections undermine interpretation.

Each regression gate has `numerator`, `denominator`, `evidence` (case IDs), `baseline`, `candidate`, `decision` and `reasonCode`. Changes are measured on paired identical confirmed cases, never comparing unrelated aggregate accuracy. `operation` and `target` report paired baseline and current correct counts and denominators. New false-positive Change is a valid predicted explicit Change contrary to confirmed expectation; continuation regression includes wrong/missing `operationId`; scope regression compares typed selector identity; new contract/provider failures are counted separately (provider evidence only when actually invoked). Insufficient paired evidence, invalid historical digests and missing measurements are not converted to zero.

## Limits of inference

A fake output/fixture can test scoring mechanics but cannot establish behavior of the selected model, prompt quality, real provider availability, write authorization, or live Zed ACP compatibility. `semanticAccuracyVerified` is always `false` for offline runs. Never automatically publish or commit new candidate Ground Truth. No regression gate makes an execution/authorization decision.
