# Quality-Preserving Adaptive Review (Q0–Q6)

## Scope and ownership

The implementation evolves only the Review workflow. No extra ACP agent, dedicated state database, Zed-specific dependency, privileged tool, new edit permission, or mandatory LLM pass has been added. Other workflows retain their existing behavior.

* **Work Plan** remains immutable and defines file/criterion coverage; its `planKey` is unchanged.
* **Risk state** lives in the authoritative Review checkpoint (`qualityState`), not a second store. Evidence Mirror continues to be optional; neither its contents nor a model claim can authorize a review pass.
* **Review quality** is a derived decision produced by `assessReviewQuality()`; the workflow combines it with established `reviewWorkCoverage()` and source-drift checks.
* **Model output** supports bounded `riskAssessments` and `openQuestions`. They are model-reported observations, never automatically independently verified evidence.
* **Generic providers** use the existing structured `scopedReview` contract and read-only execution path. Presentation and ACP tool policies are unchanged.

## Modes

```json
{
  "policy": {
    "reviewEfficiency": {
      "enabled": true,
      "executionBudget": { "maxInvocations": 4 },
      "qualityDepth": {
        "mode": "observe",
        "followUpPolicy": "material_only",
        "maxAdditionalInvocations": 1
      }
    }
  }
}
```

`qualityDepth` is new. `off` is the compatibility default and preserves legacy completion. `observe` constructs/persists the quality projection and records metrics but never vetoes the existing verdict. `enforce` requires resolution of known material risks before `review_passed` / `review_findings` can be declared. It may spend at most the configured number of additional reviewer calls, always under the *same* existing invocation/token/time budget. Budget exhaustion leaves a durable `review_incomplete`, never an invented pass.

The initial questions come from **grounded signals** (changed paths, subsystem relationships and existing workload classification), not arbitrary claims that a defect exists. Reviewers may add *source-anchored* hypotheses. Their impact, ownership, status, and relationship to original Units are checked and persisted. Open Questions are not silently discarded when a handoff is compacted. The next batch receives its applicable risks separately from the bounded prior-evidence summary. A reviewer cannot close an obligation relating to Units it has not fully completed.

`risk_follow_up` tasks can only execute when all original Units were verified, there are still open material risks, and the configured follow-up / shared budget permit it. These tasks have empty `coverage` and cannot re-certify completed Units. A contradictory assessment of an already resolved risk marks the risk `disputed`; subsequent ordinary model answers cannot silently overwrite that conflict. Without a trustworthy independent resolver, disputed risks remain incomplete.

The original file-based coverage is reported separately; complete Units **do not guarantee recall of all unknown defects**. Runtime gate checks consistency of *known* obligations only.

## Checkpoint migration and safety

`review-checkpoint.mjs` writes v4 when a Review quality policy is active; old modes continue to use v3 (or legacy v2). v3 continuation is supported into v4: old file evidence is reused under unchanged scope/source, but risks cannot be assumed evaluated merely because the original Units were checked. v4 resume validates structural risk seeds against the immutable Work Plan and preserved classification, checks model-reported resolutions against original reports, and refuses missing/incompatible quality data. Changed Git fingerprints, permissions, scope and instructions still invalidate evidence through existing validation.

The quality ledger is capped to 32 entries. If a very large linked plan would silently omit material structural obligations, `coverageOverflow` prevents `review_complete`. The system asks for a smaller scope rather than claiming all risks examined. Open Questions and evidence are bounded; no new raw prompts or source text enter P3.

## Quality-versus-cost policy

Quality decisions do **not** use minimum tool counts, elapsed time or output length as proxies for depth. Ordinary reviews without applicable risks add no reviewer calls. High-impact uncertainty may warrant a narrow follow-up, not a general re-review. Source anchors are always treated as model-reported until actual tooling verifies them. When evidence is insufficient, completion remains incomplete without pretending a test was run.

P3 adds `reviewRiskObligationsTotal`, `reviewRiskObligationsAssessed`, `reviewMaterialRisksOpen`, `reviewRiskContradictions`, `reviewRiskHypothesesPreserved`, `reviewQualityFollowUps`, `reviewQualityGateDisposition`, `reviewRiskEvidenceRejected`. Counters only, no sensitive content or stable digests. Tool/source reach beyond changed files cannot be claimed unless the tool event stream provides ground truth; unknown remains unknown.

## Q0: reproducible comparison identity

Run `npm run review:quality-baseline -- <repoRoot> [task-file] [config-file]` for each candidate/baseline. It produces only a SHA-256 identity manifest binding the actual checkout snapshot, task bytes and config bytes. For exact A/B ensure **identical** manifest fields, source snapshot, model/preset, instructions and scope. Save independently adjudicated issue IDs and reproduction notes separately (this tool never writes source contents or assumes model output is ground truth). Includes uncommitted workspace fingerprint; HEAD alone is insufficient.

The existing `evaluateBenchmarkSuite` is reused for independent offline comparisons. New tests cover improved recall, rejected major regressions and unknown provider costs. Real ACP/Codex A/B runs still require access to the user's connected model provider and a fixed, independently adjudicated fixture; they are **not** implied by local deterministic tests.

## Recommended promotion criteria

1. `off` baseline and `observe` run same source/preset snapshot without changed completion or safety behavior.
2. Repeat both and `enforce` with independently confirmed major/blocker fixtures. Measure precision, recall, actual quota (external observation) and provider usage when available.
3. Reject promotion if confirmed major/blocker recall regresses. Do not accept savings inferred solely from prompt characters or elapsed time.
4. Accept `enforce` as a default only when added token/quota cost is justified by meaningful additional findings and reproducible improvements over repeated runs.

## Development policy

Maintain single ownership of authoritative state, deterministic decisions and narrow side-effect boundaries. Require schema and checkpoint migrations with negative tests; preserve provider/host agnosticism, security/path restrictions and cancellation provenance. Do not duplicate existing Work Plan, risk/evidence storage, routing, adapters, execution budgets or validators. New functions must have a single responsibility, and P3 exports only bounded privacy-safe counters.
