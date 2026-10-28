# Ground Truth v1 — opt-in capture, labeling and provenance

`Ground Truth` is an independent human judgment, not a Router prediction and never a permission grant. Existing cases have `schemaVersion:1`, stable `id`, manually redacted `task`, `taskDigest=SHA256(task)`, ISO `recordedAt`, and `labelStatus:'unlabeled'|'confirmed'`. Confirmed cases require `expected:{operation,writeIntent,selector,continuation,ambiguity}` and manual `provenance:{method:'manual_review',confirmedBy:'user'|'operator',confirmedAt:ISO}`. Optional `expected.operationId` is validated for continuation targeting and compared strictly with Router output. Absence means that an extra operation ID is **not** accepted as correct. Expected selectors are checked with production Typed Task validation, not an alternative grammar.

Optional case inputs include `hostConstraints` (`modeOverride`, `planOnly`), `routerInput` (request-builder-compatible bounded values) and `projectContext` (`fixtureId`, `description`). Full scenario identity is a versioned canonical digest of id, task, expected, host constraints, router input and project context; it is separate from the **execution configuration identity**. Human `provenance`, capture metadata and timestamps are **not** part of semantic case identity. Changes to inputs invalidate v2 comparability. Legacy 56 cases are **not** modified or promoted to confirmed Ground Truth.

## Safe diagnostic correlation

Candidates can carry optional `capture` with validated, bounded identifiers: `sessionId`, `runId`, optional `invocationId`, `eventSchemaVersion`, `typedTaskVersion`, `routerConfigurationDigest`, `provider`, `model`, `rolePreset`. A missing/deleted trace does not invalidate the label, but prevents later reinspection of that provenance. Capture is supplied manually from already reviewed diagnostic metadata; the CLI **does not** read raw prompts from telemetry. To attach provenance:

```bash
npm run routing:ground-truth -- candidate --id my_case --task-file scrubbed-task.txt \
  --out private-candidate.json --consent-reviewed \
  --session-id session_123 --run-id run_456 --invocation-id invocation_789 \
  --config-digest abcdef1234 --provider codex --model router-model --preset my_preset
```

Read, redact and approve the task file **before** invoking this command. The standard trace never provides raw prompt content. Candidate creation always produces `unlabeled`, `expected:null`. Files are created exclusively, with `0600` permissions; symlink output paths and symlink ancestors are refused. No overwriting, no automatic CI registration. Make IDs unique; corpus validation rejects duplicate IDs and duplicate versioned inputs. Input files are explicitly selected by the operator; the CLI refuses unsafe file types/symlink parents.

Label independently:

```bash
npm run routing:ground-truth -- label --candidate private-candidate.json \
  --expected-file independently-reviewed-expected.json \
  --out private-confirmed.json --confirm-label
```

Only after inspecting both task and expected answer, manually add confirmed records to a private versioned corpus. Do not put sensitive prompts or secrets into repository/CI. The label action never infers expected from Router outputs. A captured case cannot affect authorization, security gates, or saved operation selection.

## Version / migration

Ground Truth **schema remains v1**; optional `capture` and `expected.operationId` are additive. `caseDigest` moves to **v2** with `caseDigestVersion:2`. Historical v1 evaluation rows can be read, but cannot safely be compared as identical to v2; comparisons return `INSUFFICIENT_EVIDENCE`. Re-run old cases with the current evaluator to produce comparable v2 results. No automatic mutation of existing corpora or user files occurs.
