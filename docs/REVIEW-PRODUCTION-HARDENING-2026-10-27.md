# Review Pipeline — scoped evidence hardening (27 October 2026)

## Trust boundary and host migration

A `witnessDigest` in a reviewer result **is never proof**. The optional `runWorkflow.onReviewFindingAdjudication` callback must be owned by a trusted, independently verifying host adapter. It receives `operationId`, `scopeKey`, `sourceKey`, immutable `candidates` and a derived raw-observation `ledger`. This core does not sign certificates, authenticate a host callback's implementation, or infer independent inspection from a verifier name. If the host cannot independently inspect sources, **return no verified witnesses**.

The legacy `{ verifiedWitnessDigests: Set<string> }` shape is still accepted syntactically but cannot authorize a merge. A host wishing to enable semantic merges must return:

```js
{
  decisions: [{left, right, relation: 'equivalent',
    authority: 'independently_verified', witnessDigest, crossFile, rootCauseKey}],
  verifiedWitnesses: [{
    digest: witnessDigest,
    subjectDigest: reviewWitnessSubject({
      left: ledger.find(row => row.findingId === left),
      right: ledger.find(row => row.findingId === right),
      decision, scopeKey, sourceKey
    }),
    origin: 'trusted_host_verifier', verifierId: 'trusted-verifier-name',
    evidenceRefs: ['host-controlled/verification-record-id']
  }]
}
```

Import `reviewWitnessSubject` from `src/evidence/adjudication.mjs`. This API produces a SHA-256 **subject key, not a signature**. The subject includes the review scope, complete repository source fingerprint, both canonical finding IDs, all underlying source observations (with provenance), cross-file permission and normalized root-cause claim. A changed revision, revised observation, different pair or altered equivalence claim fails closed. Evidence remains model-reported until separately authenticated by the host. Never pass reviewer-generated `verifiedWitnesses` through this callback unchecked.

Conflicting explicit reproduction keys always prevent merging, even with host attestation. Cross-file merges require `crossFile: true` and a consistent specific `rootCauseKey`. `rejected` includes structural reason codes; `accepted` returns approved witness IDs, subject digests, host verifier IDs and bounded evidence references. The renderer labels host attestation as such; it cannot claim objective verification of the defect solely from the returned data.

## Durable retry contract

The v2/v3/v4 checkpoint formats and Review Plan/Unit schema are unchanged. When exactly the same Unit batch is retried after an incomplete attempt, its authoritative report keeps distinct raw issue observations (with source attempt IDs), earlier `riskAssessments`, earlier `openQuestions`, and the strongest verdict; identical replay is idempotent. `reportedBatchId` and `reportedUnitIds` are optional issue metadata, validated at checkpoint loading, and old records default to their enclosing report. They are injected by orchestration, never taken from a model. Limits remain fail-closed: no silently dropped findings when a report exceeds its storage budget. Derived finding IDs and visual identity ignore these provenance markers.

`raw`, `canonicalFindings`, and `reconciledDuplicates` keep their historical definitions. New `exactIdentityMerges` and `semanticMerges` split strict identity aggregation from host-attested semantic grouping. `confirmedMerges` remains the legacy total (`raw - canonical`) for compatibility, **not** proof that every merge was independently witnessed. Candidate discovery is strictly non-authoritative.

## Coverage, integrity and efficiency

All new changes live in the existing evidence, checkpoint, workflow and renderer owners. Review Units and quality gates still derive from source reports and `reviewCoverage`; model-reported structural coverage is not an observed test result. Neither role invocations nor instruction/context payloads were reduced solely to claim savings; provider token usage remains unknown in this environment. Compare estimated prompt size and real token counters only after a live host supplies them.

Run `npm run test:review-hardening`, `npm run test:review-quality-depth`, `npm run test:review-work-plan`, `npm run test:review-efficiency`, then `npm test` with Node >=22.20.0 and installed ACP dependencies. The retry integration fixture reproduces loss of observations on the original version (raw 1 instead of 2), then verifies recovery with both observations and unchanged canonical identity. The fake eight-unit fixture covers eight independent file Units, simulated provider disconnect, persisted in-progress checkpoint, three resumptions, no duplicate Units, deterministic final findings and byte-for-byte unchanged Git status. It is **not** a live Zed/Codex ACP test. For a live validation, open the plugin in the host, review a separate disposable repository with 8 changed file units, cancel a reviewer invocation, resume, verify checkpoint and source integrity, and compare `/efficiency export` with actual provider usage; keep separate logs and never mark simulated evidence as live.

Candidate discovery runs across the entire bounded checkpoint corpus, rather than arbitrarily limiting graph components to the first 128 ID-sorted records. A labeled 9-pair fixture improved true positive discovery from 2/4 to 4/4 without introducing false positive pairs on that fixture. An 80-group/160-observation fixture previously discovered 51 groups and now discovers all 80. These fixtures do not establish population-level precision/recall on real repositories.
