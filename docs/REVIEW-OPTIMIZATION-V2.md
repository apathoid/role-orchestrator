# Review Optimization v2 — architecture and engineering policy

## Scope and non-goals

This change only opts **Review Workflow** into an additional role-specific instruction projection. Planning, Investigation and Implementation keep their original instruction assembly and execution policy. Core remains host- and provider-neutral. Existing Review Work Units, Checkpoint v3, security gates, Evidence Store and invocation recovery remain authoritative and are not replaced.

No automatic semantic deduplication, unsupervised tool execution, model-owned authorization or silent instruction truncation is permitted.

## Engineering development policy

1. **Extend existing contracts, do not stack new parallel owners.** `context.mjs` discovers authoritative instructions; `execution/instruction-projection.mjs` only projects them. `review-findings.mjs` owns the durable registry; `evidence/findings.mjs` produces candidate pairs; `evidence/adjudication.mjs` accepts only trusted, independently verified decisions. `review-source-location.mjs` resolves local source coordinates and the deterministic report renderer formats them. Review Checkpoint remains the completion authority.
2. **Security and content are not inferred from length, names or model opinions.** Optional project instruction deferral requires an operator-reviewed manifest with exact SHA-256 and role. Missing/stale/unreviewed/ambiguous manifest → full instructions.
3. **Separation of concerns.** Domain-level source locations and findings are structured. Markdown links are ordinary presentation values. No Zed-specific commands, ACP private extensions, or model-name branches enter the core.
4. **Proof boundaries.** Candidate duplication is not identity; reviewer summary is not independent verification; a checkpoint cannot become complete merely due to an evidence mirror. Only validated tool results have tool provenance.
5. **No expensive optimizer agent.** Candidate detection, URI generation, budgeting, context selection and reporting are deterministic. Trusted semantic adjudication is optional, bounded and never invoked implicitly.
6. **Compatibility first.** New issue coordinates are optional. Older findings, resumes and checkpoints remain readable. Missing locations remain plain text instead of creating broken links. Review-only policy is opt-in and independently reversible.
7. **Measure both cost and quality.** P3 records counts/lengths and per-run ephemeral block fingerprints only; it does not retain instruction bodies, prompts or evidence. Reduced characters are NOT billed tokens, and context occupancy is NOT cumulative usage.

## Instruction projection: opt-in rollout

Existing `policy.reviewEfficiency.contextMode: "bounded_history"` only bounds historic conversation text. Project instruction optimization uses a separate config key:

```json
{
  "policy": {
    "reviewEfficiency": {
      "enabled": true,
      "projectContext": { "mode": "observe" }
    }
  }
}
```

`mode` may be `legacy`, `observe`, or `optimized`. The default is `legacy`. In `observe`, the complete context is still sent, but projection size/reason is reported. Only `optimized` actually defers documents. There are no automatic exclusions.

For a project, use:

```sh
npm run review:context-inventory -- /path/to/repository
```

Review the candidate project **reference** documents manually. Place an explicitly reviewed file at `.agents/role-orchestrator/review-context.json` in the reviewed repository:

```json
{
  "version": 1,
  "reviewed": true,
  "defer": [
    {
      "scope": "project-reference",
      "path": ".agents/rules/unrelated-subsystem.md",
      "sha256": "<exact 64-character sha256 from inventory>",
      "roles": ["reviewerMedium", "explorer"]
    }
  ]
}
```

Do not defer mandatory rules or any document required for the role's current review scope. Deferrable documents remain discoverable by their project path and must be read before acting on code they govern. Global instructions, active skills, primary project rules and nested AGENTS.md are never excluded by this feature. Stale hashes revert to the complete context, not to an inferred replacement. The manifest is a developer/operator decision, not an authority escalation for the model.

The optimized Router context remains governed separately by the existing reviewed `router-context.json` contract.

## Findings and source navigation

`startLine`, `endLine`, and `sourceRevision` are optional issue coordinates. The renderer checks the resolved file is inside the current checkout (including symlinks) and emits a standard `file://` Markdown link when safe. Commit-review coordinates cannot be linked to a potentially different live worktree, so they remain plain text. Actual click behavior and `#L` fragment support must be smoke-tested in the selected host; the core assumes no editor-specific API.

The finding registry preserves observations and original IDs. Candidate discovery may cross file boundaries through a common reproduction/contract, but **does not merge**. A trusted adjudicator must independently provide a verified witness and explicit cross-file root-cause certificate. Different explicit reproduction keys remain separate. Related hypotheses appear only as hints in bounded next-batch handoffs.

The final four Russian headings follow the active skill's full recognized set, otherwise the conservative default. The positive section never invents compliments; accepted file/criterion evidence is labeled as review coverage rather than as test success. An optional `origin` is explicitly a model assessment, not proof of when the defect arose.

## P3 and evaluation

New telemetry: `contextCrossInvocationRepeatedCharacters`, `reviewInstructionCharactersSaved`, `reviewInstructionDocumentsDeferred`, `reviewLocationsResolved`, `reviewLocationsTotal`. Repeated blocks are tracked using an ephemeral HMAC key for each run. Source text, project paths and hashes of known contents are not published in the persistent export.

The existing Review Evaluation Harness and quality gates remain in place. The benchmark comparing 7% Codex usage to 2% Sol is a **manual real-provider experiment**; neither quota improvement nor Zed link navigation can be certified from deterministic offline tests. A/B runs must use the same Git snapshot, skill and model settings, repeat trials, compare expert-validated blocker/major findings and coverage, and record quota separately from provider-reported tokens.

## Required regression and architectural audit

- `npm run test:review-optimization-v2`
- `npm run test:review-operation-continuity`
- `npm run test:review-completion`
- `npm run test:review-efficiency`
- `npm run test:security`
- `npm run test:evaluation`
- `npm run check`

Release criteria: mandatory instructions intact, legacy fallback on mismatch, no inaccurate issue merge, no path escape or source mislink, durable Review v3 continuation, no extra LLM invocation introduced, no review-only behavior leaking into Change/Investigation, and no false completion when tests are absent. Real provider usage and host link rendering require separate end-to-end confirmation.
