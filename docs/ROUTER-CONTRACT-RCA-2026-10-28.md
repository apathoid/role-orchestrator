# Router Intent Failure — Root Cause Analysis (2026-10-28)

## Observed incident

The supplied Zed trace contains `/write-tests необходимо покрыть тестами функционал, реализованный на последних 6-ти коммитах этой ветки`. Router `gpt-6-luna` completed its ACP invocation in 16,677 ms, but the workflow stopped with `intent_unresolved`. The routing report records 1 router invocation, 0 validated, 1 validation failure of class `missing`, 0 provider failures and 0 authorization rejections; the slash skill was resolved. The 54,846-character prepared provider prompt and 28,953/258,400 context occupancy do not establish context exhaustion. No later role ran.

## Findings and evidence status

| Status | Finding | Evidence / qualification |
| --- | --- | --- |
| **CONFIRMED** | Router JSON Schema required `task`, while `assertShape('routing')` accepted its omission | Original `src/schemas.mjs`: `required` includes `task`, runtime guarded `validateTaskSpec` behind `task !== undefined`; reproduced with deterministic fixture. |
| **CONFIRMED** | Workflow rejected a missing Typed Task *after* the earlier check | Original `src/workflow.mjs` raised `missing_task_spec` and produced `intent_unresolved`. |
| **CONFIRMED** | Structured JSON extraction could choose one of several embedded objects, and mixed final/unphased candidates | Original `src/structured-output.mjs` returned first valid candidate, including concatenated source channels; reproduced in fixtures. |
| **CONFIRMED** | The incident's side effects were contained | No other role and no authorization bypass shown in supplied run; this does **not** prove all possible incidents are safe. |
| **NEEDS_MORE_DATA** | The model omitted `task`, emitted malformed/incomplete JSON, or ACP failed to preserve a final message | Supplied logs do not record the structured final output or safe extraction diagnostics; none can be singled out as *the* incident cause. |
| **NOT_REPRODUCED** | Context overflow or a deterministic `/write-tests` permission bug caused this exact failure | Context occupancy is well under the reported window; fake Router response with explicit write intent and six-commit selector reaches the Change route with skill constraints intact. This is not a live-model proof. |

## Corrective action

1. Required Typed Task is now checked at the first runtime validation boundary, matching the advertised schema.
2. Router extraction is fail-closed for competing fragments, partial answers and malformed output; explicit final-answer content takes precedence over prior unphased chunks. Other user-facing roles retain their former tolerant parsing.
3. The workflow receives a safe machine reason (`ROUTER_TASK_MISSING`, `ROUTER_TASK_INVALID`, `ROUTER_OUTPUT_*`) without using model text to synthesize a missing task.
4. Per-invocation sanitized diagnostics are emitted with stage, JSON presence, Typed Task presence and completion status when known.
5. Automated contract retry is deliberately **not** introduced until live traces demonstrate recoverability and safe time/rate budget: the observed incident does not provide that evidence.

## Live verification required

Retry the *same* slash command in Zed and use `/routing report`. Record the new safe `validationReasons` and `validationStages`, plus `router_output_diagnostic` in the execution trace; correlate them to the Router invocation. Avoid saving raw model outputs or private prompts in standard traces. A successful ACP completion alone is insufficient. If the issue persists, compare sanitized per-stage evidence and provider completion status, not prompt length alone.
