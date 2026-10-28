# Evidence-driven execution — completion increment (2026-10-26)

This document describes **what the implementation actually enables** and the remaining production proof. It does not claim that real Codex subscription savings or semantic-review recall have been demonstrated.

## Implemented

### F0 / evaluation

`src/evaluation/benchmark-suite.mjs` and `tools/efficiency-benchmark.mjs` compare multiple independently labelled repeated baseline/candidate runs, preserving `null` token/quota metrics and returning `insufficient_evidence` if too few runs exist. CLI exit 1 indicates quality regression, 3 insufficient data. Inputs **must** contain independently adjudicated finding IDs, not raw provider-generated IDs used as ground truth. This tool is offline and executes no arbitrary commands or providers.

### F1 / persistent evidence

`src/evidence/store.mjs` provides bounded, content-addressed evidence records stored per Review Operation in the local state directory (`$AGENT_STATE_DIR/evidence` or platform state/evidence). Object digests are SHA-256, publication is atomic (objects before manifest), permissions are restricted, reads reject symlinks/oversized content and verify hashes. Mirror publication occurs only **after** authoritative `onReviewCheckpoint` success and only with `policy.evidence.persistentStore=true`. Resume always validates checkpoint v3/source/scope first; corrupt/missing mirror is diagnostic, never a proof or completion authority. Durable session deletion also removes the active operation's mirror once deletion is durable. This is scoped review mirroring, not a fully interoperable cross-task CAS database.

`reconcileDependentEvidence()` and `assessEvidenceCoverage()` are deterministic primitives for fine-grained invalidation and provenance-aware coverage. Legacy evidence without explicit source dependencies cannot be reused across source revisions. These are available for additional consumers but are **not yet** a universal cross-workflow automatic evidence authority.

### F2 / semantic findings

`src/evidence/adjudication.mjs` reconciles expert/host-verified equivalence decisions. A digest is not accepted merely because the model supplied it: its witness must exist in an independent trusted set injected by the caller. Distinct reproduction keys remain separate. The compact reviewer handoff now applies pre-existing strong structural reconciliation before transmitting known findings. **Automatic independent semantic adjudication** remains unimplemented; do not merge fuzzy findings with a model-only claim.

### F3 / role context

`src/execution/context-compiler.mjs` assembles typed blocks and can remove exact duplicate *optional* blocks at the same scope or optionally omitted retrievable content. Mandatory core/role/task/skill/policy/checkpoint text is never dropped. Workflow uses the compiler for all standard role prompts with all existing blocks mandatory: this preserves byte-equivalence with prior content. Opt-in optional content compression is available to future role-specific callers; large-scale automatic policy/project-context compression is not enabled because quality equivalence was not measured.

### F4 / verification

`src/verification/executor.mjs` executes at most one host-configured, explicitly allowed targeted test, in a read-only Review and only when `policy.verificationEfficiency.autoExecute=true` and `safeCommands` identifies an exact command in the existing verifier's configured suite. The reviewer may not supply a command. Existing effect-aware guards and Git drift checks remain enforced. It never upgrades model evidence to independent proof or considers an outstanding arbitrary obligation satisfied just because a test exited zero. Unsafe/unavailable/failing tests keep coverage incomplete.

### F5–F6 / workflow/budget

Non-review `policy.workflowEfficiency.executionBudget` is now accounted across role-start/done events and checked before **new Implementation stages**, preserving the checkpoint and returning `implementation_incomplete` on exhaustion. It does not interrupt the middle of an in-flight stage, and it is not a cross-session quota ledger. Existing review-specific budget remains active. Other adaptive planning/implementation/fix-round/model escalation mechanisms remain unchanged or experimental; no new automatic provider switching was introduced.

### F7 / P3

Privacy-preserving aggregate counters added for evidence mirror writes/failures and operator-approved targeted verification; existing metrics for prompts, role invocation, candidate findings and budget exhaustion remain. No new raw user data or evidence bodies are placed in efficiency exports.

## Configuration fragment (explicit opt-in)

```json
{
  "policy": {
    "evidence": {"persistentStore": true},
    "verificationEfficiency": {
      "autoExecute": false,
      "safeCommands": []
    },
    "workflowEfficiency": {
      "investigationDirect": false,
      "compactImplementationContext": false,
      "executionBudget": {"maxInvocations": 10}
    }
  }
}
```

The fragment is not a full configuration. Automatic verification is off by default. Test commands must also be in the operator-configured verifier suite and independently permitted by the execution policy. Do not enable targeted verification for commands with unaccounted effects.

## Evaluation

Run `node tools/efficiency-benchmark.mjs suite.json`, where each suite entry defines `id`, independently labelled `adjudication`, and arrays `baselineRuns` and `candidateRuns`. Each run matches the existing `efficiency-evaluate.mjs` input shape. Default minimum repeats: two per strategy. The benchmark never infers quota from tokens or model-provided findings from expected labels.

Use identical Git snapshots, task, security policy, presets, and model parameters for meaningful A/B trials. Actual Codex/OpenCode/Zed use, the 5-hour quota, and true cost/quality improvement still need external live measurement.

## Backward compatibility

No change to Review Work Plan v1 or Review checkpoint v3 authority, existing Engineering Core, P2 Quality State, ACP adapters or cancellation contracts. Additional configs are optional and default to non-effectful behavior. Unknown token observations remain unknown. Stored review mirrors can be lost/corrupted without affecting saved checkpoint proof, but their storage failures are visible in diagnostics.

## Remaining not fully complete

1. Universal permission-isolated cross-workflow CAS evidence reuse with task/source-level dependency tracking applied to *every* role and historical session, plus orphan GC for all superseded review operations.
2. Automated, independently verified semantic adjudication of genuinely paraphrased findings. Human/host adjudication is supported, not autonomous truth.
3. Measured role-specific context reduction with an accessible evidence resolver; the mandatory role prompt is still preserved, not heuristically truncated.
4. Independent verification scheduling for all obligation kinds, beyond opt-in targeted read-only Review tests.
5. Full Planner/Implementation/Fix-Round adaptive orchestration and budget-aware safe provider escalation with persistent budgets across sessions.
6. Measured live Codex/OpenCode usage, verified findings, and subscription quota improvement. Fake providers and offline benchmarks cannot establish these.
