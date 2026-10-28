# Audit A — Semantic Authority & Security

Independent scope: Route construction, Typed Task v1, authorization, project/skill trust, Git selector resolution, read-only integrity. Method: inspect source call sites and run adversarial integration fixtures. An internal audit, **not** an external certification.

| ID | Severity | Root cause and reproduction | Expected vs observed | Remediation | Regression evidence | Final status |
|---|---|---|---|---|---|---|
| A-PRE-01 | MEDIUM | Standalone evaluator built a shorter Router prompt than production; compare former `tools/semantic-evaluate.mjs` to `src/workflow.mjs`. | Expected equivalent semantic request, formerly divergent. | New `src/routing/request.mjs` shared builder. | `test/router-request-parity.mjs`; `router-parity-final.log` | FIXED / LOCAL PASS |
| A-PRE-02 | MEDIUM | `roleSessionContext('router')` formerly replaced projected instruction context after `buildRouterContext`; compare `callOnce` and projection. | Expected verified digest/manifest projection preserved; callback previously overwrote it. | Resolve Router callback history before projection and skip late override only for Router. | Dynamic history parity tests | FIXED / LOCAL PASS |
| A-PRE-03 | MEDIUM | Old fake Review Router had only top-level fields; `test/fake-review-smoke-contract.mjs` returned `intent_unresolved`. | Expected typed v1 mock matching strict production contract; actual test failed. | Repair mock task, no production fallback. | `fix-fake-review-smoke.log` | FIXED TEST FIXTURE |
| A-PRE-04 | HIGH release gate, not a confirmed bug | Real model may falsely classify informational requests as explicit Change. | Expected zero unauthorized edits; no real model tested. | Preserve fail-closed policy; run 56-case real eval + Zed controls. | `test/prelive-security-failures.mjs` mock-only; live pending | NOT_VERIFIED |
| A-PRE-05 | MEDIUM evidence limit | Global absence of authoritative downstream linguistic parsing is not provable by targeted scan. | Expected all supported new paths route only from typed spec/host commands; main checked paths satisfy this. | Static inventory + legacy cleanup registry; review remaining host paths live. | `src/routing/`, `src/workflow.mjs`, Git/Review modules | PARTIAL / NOT LIVE-PROVED |

Negative tests cover missing task, contradictory fields, unauthorized Change, bad selector, malformed JSON, project and skill prompt injection, plan-only, provider timeout/crash and read-only Git fingerprints. These tests cannot prove that a real provider will resist malicious instructions in every prompt.
