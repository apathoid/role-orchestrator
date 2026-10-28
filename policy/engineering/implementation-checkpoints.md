# Implementation Checkpoints

Use these checkpoints as compact salience refreshers during implementation. They are not user-visible reporting requirements.

## Before substantial edits

Establish, from repository evidence:

- **Owner:** which existing component/layer owns the relevant behavior;
- **Existing abstraction:** the nearest mechanism that may already cover part of the requirement;
- **General mechanism:** what remains meaningful independently of the current consumer;
- **Specific policy:** what belongs only to the current use case;
- **State owner:** the source of truth and mutation owner for affected state;
- **Resource owner:** who owns lifecycle-sensitive resources, if any;
- **Contract at risk:** observable behavior/types/APIs/lifecycle guarantees that must be preserved.

If an item is irrelevant, treat it as such rather than inventing architecture.

## Before returning the implementation result

Challenge the final design:

- general enough for the real problem, but not speculative;
- behavior placed at the lowest correct owner;
- existing abstractions reused/composed/specialized where natural;
- no reverse knowledge from general mechanism to specific consumer;
- no unnecessary additional source of truth;
- owned resources have complete lifecycle handling;
- existing contracts are preserved unless deliberately changed by the task;
- the change is the smallest coherent solution, not merely the smallest diff.

For applicable acceptance criteria, verify observable results rather than treating completed edits as evidence of passing behavior. Where risk warrants it, check relevant failure, boundary, integration, and lifecycle cases. A valid newly added regression test that exposes a pre-existing production defect must not be weakened just to make the suite green.

Distinguish **observed** test outcomes, **supported** code conclusions, **hypotheses**, and **unverified** claims. Report commands actually run, failures, unavailable checks and meaningful remaining risk. Do not claim a successful test run from static inspection or an earlier unrelated run.

If any answer is uncertain and materially affects correctness or architecture, inspect the relevant repository evidence again before finishing.
