# Evidence-driven completion: two audit passes

## Pass 1 — integrity and safety

- Review checkpoint is authoritative; secondary mirror is written **after** the authoritative checkpoint and cannot mark review complete.
- The mirror stores only bounded derived evidence, uses SHA-256 checksums and atomic publication, and refuses corrupt objects instead of rewriting them without acknowledgement.
- Evidence reads use `O_NOFOLLOW`, check file identity and maximum size, and do not trust arbitrary filename components.
- Model-reported evidence is not tool-observed evidence. Independently verified semantic merges require a digest already admitted by a trusted host witness set, not a model-provided digest string alone.
- Targeted verification requires an exact, operator-approved configured command; no model-authored shell commands, no silent promotion of coverage. Failures and Git drift prevent a clean completed verdict.
- The Implementation budget checks only at stage boundaries; it saves interrupted checkpoint state instead of abandoning partial code or fabricating completion.

## Pass 2 — compatibility, efficiency and telemetry

- Existing v3 checkpoint and the original `reviewCoverage` evidence gates remain authoritative.
- Context compiler preserves mandatory instructions and only deduplicates optional repeated blocks. It does not claim provider-side caching or token savings.
- Reviewer handoff uses structurally reconciled known findings, reducing repetition without fuzzy merging.
- P3 stores only aggregate counters for mirror writes/failures and targeted verification; paths, witness text and raw tool output are excluded.
- Offline benchmark uses adjudicated ground truth, repeated runs and explicit missing usage; no false certainty about 5-hour Codex quota.

## Tests / limitations

Record actual command results before publishing. The long `test/workflow-unstructured.mjs` has a known environment-timeout limitation and must not be marked passing unless it completes. The optional real-provider ACP tests and live A/B benchmarking require a configured environment and independent quality adjudication.

## Observed local test results (2026-10-26)

- `npm run check`: PASS.
- `npm run test:efficiency-completion`: PASS (CAS tampering, scope/revision mismatch, fine-grained invalidation, evidence levels, trusted finding merge, mandatory context preservation, approved targeted verification, repeated-run quality gate).
- `node test/review-efficiency.mjs`: PASS (real temporary Git repository, explicit exclusions, single reviewer, durable checkpoint preceding CAS mirror).
- `node test/review-operation-continuity.mjs`: PASS.
- `node test/session-store.mjs`: PASS.
- `npm run test:evaluation`: PASS (P1/P2/P3).
- `node test/security.mjs`: PASS.
- `node test/skill-workflow-integration.mjs`: PASS.
- `node test/evaluation/implementation-plan-durability.mjs`: PASS.
- `node test/config.mjs`: PASS.
- `node test/workflow-unstructured.mjs`: exceeded command timeout in this environment; **NOT** counted as passing.

These results are local/fake-provider verification. They do not establish real Codex token/quota reduction, externally adjudicated review quality, or real ACP session integration.
