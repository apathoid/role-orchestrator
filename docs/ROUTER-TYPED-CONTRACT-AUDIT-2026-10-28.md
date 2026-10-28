# Audit 1 — Architecture, Typed Task Contract and Security

- **CONFIRMED / FIXED (P0)**: `schemas.routing.required` includes `task` and `assertShape()` rejects absence immediately. `task:null`, wrong types, invalid fields and Git selectors are rejected by the existing `validateTaskSpec()`. No new semantic interpreter was added.
- **CONFIRMED / FIXED (P0)**: The Routing-only extractor will not accept the first of competing JSON fragments. No selection is made from untrusted response content when evidence is ambiguous.
- **CONFIRMED / PRESERVED**: `validateTaskSpec` remains authoritative for the Typed Task; host mode overrides and `writeIntent` enforcement are unchanged. A resolved slash skill by itself does not grant write permission. The workflow still blocks Change before any coder on a failed route contract.
- **CONFIRMED / PRESERVED**: `routing report` and evaluation remain read-only consumers of telemetry. No shadow router, regex-based intent fallback or ground-truth auto-routing was introduced.
- **CONFIRMED / PRESERVED**: Allowlist event projection does not retain raw prompt, model answer, source code, secrets, tool output or reasoning. Added event values are enumerations/booleans only.
- **NOT VERIFIED**: A complete live authorization and full multi-provider audit requires installed ACP dependencies and a Zed session.

Severity: P0 schema/runtime disagreement — fixed, covered by `test/router-contract-reliability.mjs`. No independent in-scope authorization bypass found in deterministic tests; this is not a global security certification.
