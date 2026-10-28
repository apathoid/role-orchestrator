# Audit 3 — Regression and Integration

## Confirmed checks

- `test:semantic-intent`, `test:router-request-parity`, `test:router-context`, `test:routing-quality`, `test:routing-integration`, `test:routing-regression`, `test:semantic-evaluator-offline`: **PASS** in available environment.
- `test:routing-quality-hardening`, `test:prelive-security-failures`, `test:fake-router-contract`, `test:structured-output` (now includes new tests), `check`: **PASS**.
- `/write-tests` with selector `{type:'recent_commits',count:6}`: fake valid Router output reaches Change routing (with resolved slash skill and explicit write intent). Invalid/missing/ambiguous inputs result in `intent_unresolved` and exactly one Router invocation, with no other roles started.
- Semantic evaluation corpus files are unchanged from the source archive. Deterministic contract fixtures are not claims of real semantic accuracy.

## Limitations

- `npm ci` was attempted but failed with npm's `Exit handler never called!`, on Node 22.16.0 (package requires `>=22.20.0`; requested verification was Node 24). The SDK package was not available in node_modules.
- Full `npm test` run 1 failed at the missing SDK after earlier tests; run 2 was started but did not complete within the execution window. They must **not** be represented as two passing runs.
- `smoke` and `test:generic-acp` failed due to missing SDK. Heavy `test:workflow-unstructured` did not finish in the available time. Others not explicitly listed as passed are **NOT_VERIFIED**, not assumed to pass.
- Full `Change` coder implementation, actual SDK notification ordering and user Zed replay remain **NOT_VERIFIED**.

## Defect register

| Severity | Defect | Reproduction | Fix | Status |
| --- | --- | --- | --- | --- |
| P0 | Missing Typed Task passes runtime shape check | `test/router-contract-reliability.mjs` | Required `task` and existing validator invoked | FIXED / regression PASS |
| P0 | Competing embedded JSON may be selected | Same test, two-fragment fixture | Reject ambiguous Router output | FIXED / regression PASS |
| P1 | Final and unphased candidates can be concatenated for Router | Multi-channel fixture | Single authoritative channel | FIXED / regression PASS |
| P1 | Generic ACP mixes phase-tagged commentary with final | Adapter inspection, deterministic chunk reproduction | Separate phase accumulation | FIXED / deterministic proof; live SDK blocked |
| P1 | Validation report omits machine cause and stage | Incident report only `missing` | Allowlisted diagnostics and report distribution | FIXED / regression PASS |

No unrelated code defects were confirmed. Full provider and live execution assurances remain explicitly unverified.
