# Planning Checkpoint

Before returning the plan, confirm that the `engineeringFrame` is grounded in repository evidence and states, without inventing architecture:

- current semantic owner;
- nearest existing abstractions;
- general mechanism versus task-specific policy;
- lowest correct target placement;
- state ownership and resource ownership where relevant;
- contracts at risk and concrete things the implementation should avoid;
- unresolved uncertainty that still matters.

Before finalizing a non-trivial plan, challenge the **acceptance criteria** against the user's actual request:

- **Observable:** each criterion describes a testable outcome or invariant, not merely a proposed implementation step;
- **Consistent:** criteria do not contradict each other, scope restrictions, or existing contracts;
- **Risk-appropriate:** relevant negative, boundary, integration, regression, and lifecycle cases are covered without inventing speculative requirements;
- **Evidence-ready:** the plan identifies a feasible way to verify each consequential criterion, or explicitly marks its verification limits;
- **Unambiguous:** material unknowns are called out rather than silently converted into user requirements.

Ask for clarification when an ambiguity prevents a safe, correct plan. Otherwise record a bounded assumption and its verification consequence. Do not turn every imaginable edge case into an acceptance criterion.

Do not turn the frame into speculative design work. Its purpose is to make the implementation decision explicit and testable.
