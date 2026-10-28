# Router Typed Task Failure Diagnostics — Follow-up (2026-10-28)

## Scope and evidence

Source of truth: `role-orchestrator-router-contract-hardened-2026-10-28.zip` (SHA-256: `060e098bbc182c053ecdc86845bfd1134de9630113016c99350262c3e23d32a9`). The supplied Zed run `/test-it ... последних 6-ти коммитах` finished the Router invocation but ended in `intent_unresolved`; the report recorded `ROUTER_TASK_INVALID` at `shape_validation`, with zero provider failures and no authorized downstream operation. That confirms a *contract rejection*, not the exact invalid field or the cause of the model output. The raw structured answer is not available in the provided diagnostic trace.

## Confirmed defect and repair

`validateTaskSpec()` emits stable, specific failures such as `invalid_recent_commit_count`, `invalid_task_spec_git_ref`, `invalid_task_spec_continuation`, and `invalid_task_spec_skill`, but `routingCandidate()` previously collapsed these into `ROUTER_TASK_INVALID`. The observer and reporting code had no field for the nested reason. As a consequence `/routing report` could not identify the rejected field class despite successful parsing.

- Added an explicit allowlist of **validator-generated** failure reasons (`TASK_SPEC_FAILURE_CODES`) and `taskSpecFailureCode()` in `src/routing/task-spec.mjs`.
- `parseStructuredStateOrText('routing')` now provides nullable `diagnostics.taskFailureCode`, while preserving existing `code`, `stage`, `taskPresent` and `jsonRecognized`.
- `runWorkflow()` forwards the nested diagnostic from the provider result, or captures it when its own task validation fails. The terminal behavior on invalid output is unchanged: `intent_unresolved`, no Change execution.
- `observableEventData()` keeps the allowlisted value in `router_output_diagnostic` and `semantic_intent_validation`, dropping arbitrary strings.
- `aggregateRoutingTraces()` exposes `distributions.taskValidationReasons` (counts of recognized codes only), without copying raw output or user prompts. Historical traces lacking the new field yield an empty distribution, not an invented failure cause.
- Added a stronger Router instruction that requires one complete JSON object with a non-null Typed Task and mutually consistent outer and inner fields. Kept semantic interpretation within the Router; no keyword-based routing or additional LLM invocations.
- Aligned advertised JSON Schema numerical and string constraints (recent-commit counts and merge-parent bounds, skill name, operation ID, ambiguity lengths) with runtime validation. Cross-field semantic authorization and Git selector constraints remain enforced by `validateTaskSpec` and the workflow; the JSON Schema is not itself a substitute for this authority.
- Extended `test/router-contract-reliability.mjs` with nested-failure mapping, invalid string injection, JSON Schema bounds, full observer/report propagation, fail-closed Change, direct adapter bypass of the parser, and both `/write-tests` and `/test-it` slash-skill resolution.

## Safety, compatibility and audit

1. **Authorization:** invalid tasks still fail closed; slash skill discovery does not grant writeIntent. No new retry, silent fallback, or Change path was introduced.
2. **Privacy:** diagnostic values come from a fixed allowlist. No raw prompts, JSON fragments, tool output or model reasoning are added to redacted event traces.
3. **ACP/provider:** the public response envelope and existing `ROUTER_TASK_INVALID` category are retained. This follow-up does not assert that live provider transport is correct, nor that the specific Zed failure was caused by a particular field; only the new diagnostic event can establish it on a subsequent run.

## Verification and limitations

Verified with Node.js `v22.16.0`, npm `10.9.2` (the project requests Node `>=22.20.0`). The following commands returned exit code 0 in the available environment:

- `npm run check`
- `node test/router-contract-reliability.mjs`
- `node test/structured-output.mjs`
- `node test/acp-router-response.mjs`
- `npm run test:structured-output`
- `npm run test:semantic-intent`
- `npm run test:router-request-parity`
- `npm run test:router-context`
- `npm run test:routing-quality`
- `npm run test:routing-integration`
- `npm run test:routing-regression`
- `npm run test:semantic-evaluator-offline`
- `npm run test:monitoring`
- `npm run test:prelive-security-failures`

`npm ci` returned exit 1 (`Exit handler never called!`, npm internal failure), and `npm run test:generic-acp` returned exit 1 because the real `@agentclientprotocol/sdk` could not be installed. `npm run test:workflow-unstructured` printed its success message, but remained active beyond a bounded test timeout; no clean exit is claimed. The complete `npm test` suite and a genuine Zed ACP run remain **NOT VERIFIED**. See the external test log bundle for exact available stdout/stderr; this report makes no claim of Node 24 or production validation.

## Live verification after deployment

Repeat exactly `/test-it необходимо покрыть тестами функционал, реализованный на последних 6-ти коммитах этой ветки`, then run `/routing report`. If validation fails, inspect `validationReasons`, `validationStages`, and **`taskValidationReasons`**. A nonempty `taskValidationReasons` maps the rejection to a specific validator condition. If it remains empty, the response was rejected before a known nested validator condition (or a provider path bypassed the new propagation); do not infer a field error. Compare identical task, model and context mode across retries before attributing failure to prompt size or a skill. Never use test fixtures as evidence of live semantic accuracy.

## Diagnostic schema migration

Event payloads for `router_output_diagnostic` and `semantic_intent_validation` gain optional/nullable `taskFailureCode`; reports gain a `taskValidationReasons` distribution. Existing consumer fields and schemaVersion remain unchanged (additive change); consumers should tolerate missing or null codes in historical events. No configuration migration is required.
