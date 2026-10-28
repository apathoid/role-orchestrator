# Migration notes — Pre-Live Hardening

## Supported API and caller behavior

- **No Typed Task schema change:** v1 remains required. Host override/plan-only do not rescue a Router response that omits `task` (existing contract; not loosened).
- `runWorkflow` signature remains intact. Its Router request is now constructed via `buildSemanticRouterRequest(options)` from `src/routing/request.mjs`; the runtime invokes the same registry and existing policy.
- Dynamic `roleSessionContext('router')` is resolved before Router projection; callers providing both `sessionContextText` and callback should check which history they intended (callback is authoritative for Router). Other role history composition is unchanged.
- `tools/semantic-evaluate.mjs <repo> <corpus> --run` remains supported. New `--offline <responses.json>` is test-only; outputs include `version:2`, `semanticDenominator`, `contractDenominator`, `errorCategory`, `latencySamples`, `falsePositiveWriteRate` and `source`. JSON consumers expecting `version:1` should migrate to v2; no compatibility alias was added to avoid silently treating provider failures as semantic errors.
- Offline inputs can supply `routerInput` for trusted `modeOverride`, `planOnly`, skill/Plan metadata, scoped instructions and host prompt blocks; this is fixture data, not production write authorization.
- `npm test` now includes focused parity, offline and state/security tests. `npm ci` dependencies, lockfile and no-SDK-stub requirement unchanged.

## Integration/migration checks

For an external caller: construct the typed task through the existing Router; keep host slash parsing separate; pass saved Plan/Review metadata as data not authorization; do not parse fresh requests via keywords; preserve exact repo and digest verification before continuing. Review checkpoints missing validated `taskSpec` remain diagnostic-only. Reevaluate any consumer of semantic evaluation JSON due to metrics version change.

## Breaking-change ledger

| Old public contract | New public contract | Reason | Migration | On invalid call |
|---|---|---|---|---|
| Evaluator aggregate `version:1` | `version:2` | Correct applicability denominators and error taxonomy | Use `source`, `semanticDenominator` and per-case error category | CLI exits nonzero on unresolved/invalid outputs; malformed corpus exit 2 |
| Independent evaluator manually formed prompt | Shared `buildSemanticRouterRequest` | Ensure equivalent semantic input | Use the builder for future fixtures/evaluators | `TypeError('invalid_router_request')` on missing required task/repo |
| Late Router session-history override (internal) | Pre-projection callback history | Prevent bypass of audited manifest projection | Keep callback semantics and supply desired session history explicitly | Callback exception propagates; no write grants |
| Fake-review fixture top-level route without typed task | Typed task v1 required in fixture | Match existing fail-closed production contract | Supply `task: emptyTaskSpec('review')` | `intent_unresolved` in production |
