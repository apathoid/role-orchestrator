# Role Orchestrator — Semantic Quality Hardening Implementation Report

**Base:** `role-orchestrator-semantic-quality-2026-10-28.zip` SHA-256 `1742345126b3f2c1fe8eb6149eb3b87c1b1deca462a86a8c0d6a3509b9d03ff1`. No older archives were used. No `AGENTS.md` file exists in this archive; existing routing, architecture and quality documentation was inspected. The original 56-case corpus was preserved byte-for-byte.

## A. Baseline, confirmed defects

On an independently extracted original tree, deterministic P0 reproduction demonstrated: (1) one `PROVIDER_CRASH` resulted in `providerFailures=1` and `providerErrors={}`; (2) identical Git commit selectors in different key orders returned `target=false`; (3) a missing offline fixture yielded `providerFailures=1` despite `routerInvocations=0`. All three are **CONFIRMED**. The baseline `check`, semantic intent, offline evaluator, routing-quality and routing integration tests had passed, proving these defects were not covered by the existing tests.

## B. Correctness changes

- **P0:** normalized provider failure distribution, role/event replay dedup and unknown provenance; production-validator-backed Git selector structural identity; explicit contract/provider/environment/fixture failure types, no simulated invocations counted as live.
- **P1:** v2 canonical semantic case identity, separate reproducible evaluation configuration, exact saved operation comparison; optional candidate capture provenance and safe manual labeling; paired matched-confirmed regression gates with explicit evidence and `INSUFFICIENT_EVIDENCE`.
- **Observability:** adversarial allowlist categorization, stable opaque identifier hashing, safe provider code taxonomy, restricted Git fields, secure existing trace-file ownership/mode/link checks; tests confirm no raw token injection via the analyzed event families.
- **P2:** `npm run test:routing-quality-hardening` and `npm run test:routing-regression` reuse existing evaluator and comparison scripts, with JSON output and CI-compatible exit codes; no second evaluator, no provider use in offline tests.

## C. Verification and audit

Three focused audits are in `docs/audits/`. Independent runnable tests and detailed stdout/stderr/exit codes are in the accompanying logs archive. Exact patch application is verified against a fresh extract of this base ZIP. Full production integration could not be certified because `@agentclientprotocol/sdk` and Node 24 are unavailable; this is recorded as environment blocked, not treated as a passing test. Do not label the project production-ready on offline evidence.

## D. Migration

Ground Truth v1 remains readable, with optional `expected.operationId` and `capture`. New evaluation reports have `version=3`, `caseDigestVersion=2`, `evaluationIdentity` and segregated fixture/real-provider metrics. Regression evaluator emits version 2 and refuses unsupported legacy digest comparability with `INSUFFICIENT_EVIDENCE`. Old raw event envelope schema remains v1; unknown historical reason codes contribute to partial coverage. Trace model/provider/profile identifiers may be hashed; consumers must not assume the raw configured names are present in JSONL. Existing `policy.routerContext.mode` behavior is unchanged.

## E. Deferred/non-claims

No complete real ACP negotiation, real model accuracy, live Zed acceptance or formal adversarial filesystem concurrency proof was performed. Re-run full tests after `npm ci` on supported Node 24, then collect manually confirmed live Ground Truth and paired comparisons.
