# Review Operation Continuity: two-pass audit

## Pass 1 — functional correctness and durable evidence

Inspected the initial checkpoint boundary, validation, exact-operation continuation, pending-unit scheduler, checkpoint persistence and Git scope reconciliation. Regression tests exercise resumption after eight batches, independent mapping by file-group content and prerequisites, strict invalidation of changed groups, incomplete coverage semantics, and preservation of v1/v2 state. Corrective work in this pass: persisted skill identity and routing semantics across resumed invocations; independent verification of the previous scope before accepting evidence during `/review-reconcile`; check the entire saved plan structure, not merely its displayed plan key; preserve original task identity rather than use wording of the continuation command.

## Pass 2 — observability, presentation and host boundaries

Inspected structured finding identity, presentation behavior, count provenance, trace allowlists and session serialization. Corrective work in this pass: deterministic one-ID-one-entry finding rendering; additional structured review-only identity fields; P3 groups scoped by opaque review operation UUID; review-findings reported/reconciled allowlisted counters; ACP advertised resume/reconcile commands, checkpoint status and redacted host events. P2 identity was left unchanged.

## Evidence and limits

The run logs and `test/review-operation-continuity.mjs` support local production-logic assertions, not a claim of an end-to-end live ACP run. Exact-model-token usage remains unknown if the ACP provider does not expose usage. Heuristic deduplication of unstructured prose is deliberately not implemented because merging unlike defects would erase evidence. The real NWOF-7976 merge-parent result should be replayed against the original repository before a production rollout.
