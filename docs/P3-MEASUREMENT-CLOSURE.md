# P3 Measurement Closure: context attribution, outcomes, Router A/B

This is a **measurement and evaluation** extension to the existing P1/P2/P3
implementation. It does not shorten other-role prompts, change provider
selection, change routing policy, grant write permission or skip quality gates.

## Context composition

The Review-batch, review-only validator/responder and staged Coder body now
record **source spans during text construction**, including repeated identical
values; no after-the-fact regex on prompt headers is used. Tracked template
literals also attribute literal headings/boilerplate to `workflow_scaffold`
instead of treating that known text as unknown `other`. Remaining `other`
explicitly means that the source has not been instrumented. Existing outer
role sections and source-scope instruction measurements are unchanged. All
content labels are allowlisted and aggregate-only; neither the prompt nor its
source text is persisted.

## Workflow result / logical grouping

A run stores an optional, allowlisted `outcome` with status category, route mode,
review verdict, finding counts, checked/total review inventory, observed
verification counts, stage coverage and P2 quality counts, **only if the
workflow result actually contains those fields**. Missing fields remain `null`.
This is a projection of authoritative result data, not a new source of truth
and never a model-derived quality assessment. Failures with no result have
`outcome=null` and retain the existing run status.

`executionGroupId` is `task:<task-id>` **only when the execution service
actually selected or registered an authoritative implementation task**.
Independent turns use `run:<run-id>`; similarity of text, workspace or previous
active task is *not* evidence of continuity. Old stored runs receive their
safe group label when loaded; they do not acquire fabricated outcomes.

`/efficiency runs` and `/efficiency run <id>` now show the outcome/group; JSON
export contains the typed measurements. Aggregated read-only
`efficiencyView()` exposes `outcomes` and `executionGroups`. This does not
replace P2 evidence, acceptance or recovery state.

## Router-only model comparison

The optimization remains **off by default**. `observe` preserves the existing
Router prompt; `optimized` still requires the reviewed SHA-256 manifest and
otherwise falls back to full context. The additional tool provides an opt-in
real-provider comparison, with **two Router requests per fixture** and no
Explorer, Coder, verification or repository-writing workflow stages:

```sh
node tools/router-context-inventory.mjs /path/to/repo
# Review the inventory and prepare .agents/role-orchestrator/router-context.json
cp test/fixtures/router-evaluation.example.json /tmp/router-fixtures.json
# REVIEW every expected decision against your actual project requirements.
node tools/router-evaluate.mjs /path/to/repo /tmp/router-fixtures.json --run \
  > /tmp/router-ab-results.json
```

The `--run` flag is required to prevent accidental paid/model invocations.
Cases contain an opaque `id`, a task, optional mode override, optional planOnly
and skill name, and **independently curated expected mode, writeIntent,
complexity and risk**. The fixture corpus is an editable *example*, not a
universal oracle. Project-specific instructions and risk rules can change the
expected outcomes; review them before execution.

The evaluator runs the real Router call using the same role prompt,
classification enforcement and `routingPolicy()` as the workflow, and throws
an internal sentinel as soon as the `route` event is emitted. No downstream
role is called. Each mode gets a fresh provider registry, avoiding shared
in-session context effects. The returned JSON contains only aggregate
comparisons, changed enum/policy fields, safety flags, eligibility/fallback
and manifest reasons; **no fixture text, reasons or tool outputs**.

An unchanged full-context fallback is **not a passing optimization**.
A `pass` requires an actually selected optimized context, no safety downgrade,
a downstream-policy match and agreement with independently expected fields.
Deterministic fake-provider tests check orchestration isolation; they **do not
establish real-model semantic equivalence**. Re-run the same corpus on real
providers and inspect downstream outcomes before changing the default mode.

## Validation

```sh
npm ci
npm run check
npm run test:evaluation
npm run test:monitoring
npm run test:router-ab
npm test
```

Missing `@agentclientprotocol/sdk` or an unsupported Node runtime may block
full ACP tests; report that as not run. Exact token usage and provider-internal
prompts remain unavailable when the agent only reports context occupancy.
