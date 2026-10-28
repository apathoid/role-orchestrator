# Known Limitations and Live Validation Readiness

**Status: READY FOR CONTROLLED LIVE VALIDATION, NOT VERIFIED FOR PRODUCTION.**

Structural fixes are implemented and independently tested with deterministic fixtures. Fail-closed semantics and telemetry privacy are covered. No additional model invocations are introduced. The original live failure has not been conclusively attributed to missing task vs malformed/final-channel output, because the supplied trace predates the new safe diagnostics.

Remaining checks must be run in a clean Node 24 environment: `npm ci`, `npm test` twice, `npm run smoke`, `npm run test:generic-acp`, and `npm run test:workflow-unstructured`. Verify the exact `/write-tests` request in Zed through an installed provider. Observe `router_output_diagnostic`, `semantic_intent_validation`, and `/routing report`; confirm correct Typed Task with `recent_commits:6`, explicit authorization and correct stage behavior. Re-test cancellation, partial/duplicated streams and mixed commentary on the actual ACP SDK.

A large prompt was observed in the incident; it is not established as causal. Router context defaults and projection were intentionally left untouched. If new telemetry confirms reliably recoverable contract failures, consider one bounded retry with cancellation, rate-limit and request-budget evidence; do not enable generic `intent_unresolved` replay.
