# Router Validation and Failure Classification Specification

The Router's top-level `task` must be present and pass `validateTaskSpec()`. Missing/null/invalid tasks never authorize Change. Existing workflow authorization rules continue unchanged.

## Machine-readable codes

| Code | Meaning | Origin |
| --- | --- | --- |
| `ROUTER_TASK_MISSING` | Structured object lacks required `task` | Contract/shape validation |
| `ROUTER_TASK_INVALID` | Present task does not pass Typed Task validation | Contract/shape validation |
| `ROUTER_OUTPUT_INVALID` | Parsed JSON conflicts with top-level Router schema | Contract/shape validation |
| `ROUTER_OUTPUT_UNSTRUCTURED` | No candidate structured output | Contract/extraction |
| `ROUTER_OUTPUT_MALFORMED` | Object-like content cannot be parsed as JSON | Contract/extraction |
| `ROUTER_OUTPUT_INCOMPLETE` | Unclosed JSON object / incomplete stream | Contract/extraction |
| `ROUTER_OUTPUT_AMBIGUOUS` | Multiple independent balanced JSON objects | Contract/extraction |

These are contract failures, not model intent accuracy scores. A provider cancellation/crash/timeout is separately attributed to the invocation layer, with no routing authorization. Unavailable details stay `null`, never guessed.

## Existing event extension (no new telemetry system)

`semantic_intent_validation` retains existing `status` (`accepted` / `missing` / `invalid`) and adds allowlisted `code`, `stage`, `failureClass`, `jsonRecognized`, `taskPresent`, `incomplete`, `ambiguousFragments`, `providerCompletionStatus`, and `recovery`. The new per-invocation `router_output_diagnostic` event contains only enumerated extraction metadata; full input/output text is never persisted. `routing report` adds `distributions.validationReasons` and `distributions.validationStages` while preserving older counters and historical trace support.

## Migration

Diagnostic consumers should treat the new fields as optional: older traces have no `router_output_diagnostic` and lack a reason/stage. This is additive; the existing event schemaVersion remains 1. A missing code in a historical trace is **not** a clean validation nor evidence of a provider failure. There is no configuration migration and no automatic recovery. On structurally invalid output, no alternate intent authority may be consulted.
