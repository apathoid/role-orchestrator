# Review Optimization v2 — two-pass engineering audit

## Pass 1 — behavioral correctness, evidence integrity and integration

Scope: role-specific reference projection, trustworthy location resolution, candidate finding linkage, adjudication and report layout.

Findings and corrections:

- **Regression in existing hypothesis test:** The first candidate algorithm ignored two same-file issues sharing a failure mode but using different reproduction keys. Corrected: they remain related candidates, never auto-merged. `test:efficiency-architecture` and a separate cross-file adjudication test pass.
- **Report headings:** Deterministic response originally emitted `Замечания и проблемы` before `Что хорошо` contrary to an active `/review-code` skill. Corrected with an explicit report section renderer. Existing saved finding IDs and the full ledger are preserved.
- **Unclickable source references:** Legacy output embedded a plain file path. Added safe worktree source-location resolution, Markdown URI with line fragment, and a no-link fallback for missing/escaping/symlink/historical files.
- **Source provenance:** Optional issue coordinates are validated at the schema boundary. `origin` is labeled a *model assessment*, not certified independent historical attribution.
- **Cross-file findings:** One defect observed in two files can be a candidate, and an independent verifier may certify the same root cause via its existing trusted callback. Different explicit reproduction keys remain separate. Review checkpoint remains authoritative.

Tests: `test:review-optimization-v2`, `test:review-completion`, `test:review-work-plan`, `test:review-operation-continuity`, `test:review-efficiency`, `test:review-scope-hardening`, security, skill routing and full evaluation passed.

## Pass 2 — architecture, privacy, operability and performance

- **No duplicated policy engine:** `context.mjs` remains the canonical instruction loader; `instruction-projection.mjs` is an opt-in, reviewed SHA-256 projection of its existing documents. Fallback on stale/missing manifests is complete context. No role-specific code enters ACP provider adapters.
- **Security boundaries:** Project reference documents alone can be deferred; global, primary and active skill contracts are never projected away. Source links require real files inside the current checkout. No automatic model-authored test command or write permission is introduced.
- **Privacy:** Cross-invocation repeated blocks are compared with an ephemeral per-run HMAC, not a globally reusable digest of the user's instruction text. Persisted P3 contains only aggregate counts. Source paths, prompt bodies and evidence remain outside these new fields.
- **Cost:** The optimizer adds no LLM invocation. New candidate processing is capped at 128 unique findings and does not change the required Work Units. Context savings are active only for explicitly reviewed project-document deferrals; `bounded_history` remains a separate setting.
- **Migration:** The new schema coordinates are optional; legacy outputs, Review v3 checkpoint and provider-specific settings retain their previous contracts. Independent source-link rendering and new P3 counters are backward compatible.
- **Host neutrality:** Standard `file://` Markdown URI is emitted by presentation, not an editor-specific command. Native Zed navigation and exact quota reduction require in-host/real-provider tests.

Validation: `npm run check`, explicit checks for all new modules, Review suite, `test:security`, `test:config`, `test:context`, skill routing and **full `test:evaluation`** returned success. `workflow-unstructured` printed `workflow-unstructured: passed`, but the launch did not return a clean process exit before the execution timeout; it is not claimed as a completely clean run. Remaining externally verifiable tasks: live Zed click-to-open, real Codex usage, quality A/B against Sol and a manually curated operator review-context manifest.

## Production readiness statement

The opt-in code paths pass local deterministic and fake-provider tests. Do **not** label real token/quota savings or Zed navigation as certified until tested in the actual environment. Run optimized projection first in observe mode with a reviewed manifest; enable only after the applicability review and quality-comparison gate.
