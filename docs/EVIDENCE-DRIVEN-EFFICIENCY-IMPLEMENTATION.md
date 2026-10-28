# Evidence-driven efficiency — implementation increment

## Scope and architecture

Based on the Adaptive Review release. This is an **incremental, backwards-compatible implementation** of the follow-up I1–I7 roadmap, not a claim that every research track is production-complete. Preserve the original implementation/review checkpoint authorities, P1/P2 verification and recovery, and P3 privacy.

### Implemented and connected

1. **I1, evaluation groundwork:** `src/evaluation/efficiency-quality.mjs` and `tools/efficiency-evaluate.mjs` accept externally adjudicated stable finding IDs, mandatory coverage IDs, optional provider usage and externally observed quota depletion. They compute precision/recall/coverage and report whether a candidate maintained the baseline. They do not invent ground truth or usage. `test/efficiency-architecture.mjs` covers the evaluation contract. Real-world adjudicated datasets and live ACP A/B runs are still needed.
2. **I2, budget and workload:** `src/execution/workload.mjs` produces deterministic risk/uncertainty signals (e.g. auth/security and async/reconnect paths). `chooseReviewStrategy` uses them conservatively. `src/execution/budget.mjs` limits reviewer invocations and elapsed time per review execution, and uses input/output token ceilings **only if all attempted reviewer invocations report valid token counts**. On exhaustion, coverage stays incomplete and existing Review Operation checkpoint/continuation is preserved. No 5-hour subscription quota is inferred. Budget defaults to unconstrained; caps are explicit opt-in.
3. **I3, derived Evidence Graph v2:** `src/evidence/graph.mjs` projects immutable review obligations and model-reported evidence from the authoritative Review Work Plan/records. The v3 checkpoint persists only a small derived projection, not an alternative mutable state. Reconciliation is revision-key sensitive. A tool-observed result can only be produced with explicit invocation, command digest, numeric exit code and revision key; model claims cannot become tool-observed evidence. The existing checkpoint remains the persistence mechanism; a new cross-workflow CAS-backed evidence database is **not** implemented.
4. **I4, safe semantic candidates:** `src/evidence/findings.mjs` detects possible semantic finding groups using path/contract/failure mode, but **does not merge** different reproduction scenarios. Existing stable structured deduplication remains authoritative. P3 captures aggregate candidate group counts, not issue text. Automated semantic adjudication is not yet implemented.
5. **I5, context and verification:** `src/execution/context.mjs` computes content-free, digest-based role context manifests; workflow emits only aggregate size/duplicate metrics. It currently observes context and does **not** silently truncate mandatory policy/skill text. `src/verification/decision.mjs` derives advisory verification options from outstanding obligations and risk without executing code or claiming tests passed. The shared role-context manifest is not yet a universal compact context compiler for every workflow.
6. **I6, guarded cross-workflow improvements:** low-risk `investigate` can bypass Explorer when `policy.workflowEfficiency.investigationDirect=true`; default **off** for backwards compatibility. The investigator retains read-only tools and checks. `src/execution/stage-context.mjs` supports bounded, explicitly incomplete implementation-stage handoff with `policy.workflowEfficiency.compactImplementationContext=true`; default **off** until validated in real staged workflows. There is no automatic cost-based model escalation. Skills can optionally declare `orchestrator-delegation: allowed|restricted|forbidden`; explicit `forbidden` returns a structured incompatibility instead of silently delegating, without modifying the security or write-authority rules.
7. **I7, P3 updates:** allowlisted `reviewWorkloadRisk`, `reviewEvidenceRecorded`, `reviewObligationsSatisfied`, `reviewVerificationStrategy`, `reviewSemanticCandidateGroups`, `executionBudgetPauseReason`, `rolePromptCharacters`, `roleDuplicateCharacters`. Session-store deserialization sanitizes the fields; neither paths, prompts, skill text nor evidence contents are persisted in the efficiency counters.

### Configuration

```json
{
  "policy": {
    "reviewEfficiency": {
      "enabled": true,
      "executionBudget": {
        "maxInvocations": 6,
        "maxElapsedMs": 600000
      }
    },
    "workflowEfficiency": {
      "investigationDirect": false,
      "compactImplementationContext": false
    }
  }
}
```

This is a *policy fragment*, not an entire config. Both `executionBudget` ceilings are optional. The example does not enable either guarded cross-workflow behavior. **Do not** interpret a budget pause as a review pass; resume the same Review Operation if full coverage is required.

### Evaluation CLI

Provide externally adjudicated inputs (no actual user/repository contents required):

```json
{
  "expectedFindings": ["F1", "F2"],
  "reportedFindings": ["F1"],
  "blockerMajorIds": ["F1"],
  "mandatoryObligations": ["C1", "C2"],
  "verifiedObligations": ["C1"],
  "measurements": {"invocations": 8, "inputTokens": null, "quotaPercentage": 28}
}
```

Call `node tools/efficiency-evaluate.mjs baseline.json candidate.json` to compare. **Do not** use model-only finding IDs as expert ground truth. For meaningful model A/B trials, use exactly the same Git snapshot, task/scope, presetted models, and multiple runs; report critical recall and false-positive behavior independently from quota reductions.

### Unfinished original roadmap goals

- Universal CAS-backed evidence sharing and fine-grained cross-workflow dependency invalidation.
- Safe independent semantic adjudication of paraphrased findings (current logic produces candidates, not proof of equivalence).
- Universal role-context compilation that can omit non-mandatory project material with measured equivalence.
- Automatic execution of targeted verification according to the new advisory decision contract, with side-effect policy and invalidation.
- Full adaptive orchestration of Planner/Implementation/Fix Round and budget-aware model escalation.
- Real OpenCode/Codex/Zed integration and an adjudicated benchmark showing preserved quality and measured subscription quota savings.

Those items require further implementation/evidence. Tests with fake providers cannot establish real token/quota savings or production-ready quality.
