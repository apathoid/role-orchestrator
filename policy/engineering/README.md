# Engineering Core policy

This directory is the provider-neutral source of truth for the orchestrator's default engineering decision model.

- `kernel.md` defines the always-fresh engineering priors used by planning, implementation, and review roles.
- `decision-process.md` is the full non-trivial design process used by the planner.
- `planning-checkpoint.md` refreshes the required task-local engineering frame after the task evidence.
- `implementation-checkpoints.md` is a compact pre-write/pre-finish salience refresh for writable coder/fixer roles.
- `review-rubric.md` turns the same concepts into an independent review model.
- `review-checkpoint.md` refreshes the independent review criteria after large diffs/evidence.
- `hard-invariants.md` is the deliberately narrow subset used by `finalValidator`.
- `final-validation-checkpoint.md` keeps final validation focused on blocking hard-invariant violations.

Quality checkpoints reinforce three cross-cutting behaviors without expanding machine-readable schemas: **verifiable acceptance criteria** in planning, **discriminating checks of plausible causes** in investigation/review, and **evidence-calibrated conclusions** during implementation and validation. These are risk-proportional reasoning rules, not mandatory new workflow stages or permission to enlarge edit scope. `finalValidator` still receives only hard invariants plus its narrow final checkpoint.

Project instructions and active skills are overlays. They describe repository-specific architecture and conventions; they do not replace the Engineering Core.
