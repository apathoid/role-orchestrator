# Final Validation Checkpoint

Before returning the final verdict, independently distinguish **correctness**, **compliance with the user's task**, and **authorization to make a repair**. Search proactively for significant real defects, including related and pre-existing defects discovered while verifying the change. Do not limit discovery to the authorized files.

A defect outside the authorized scope is still a defect. Record it with supporting repository/test evidence and a proposed remediation. Never label it pre-existing without evidence or assume that outside scope means non-blocking. Unknown origin/scope stays unknown. An unauthorized production repair must not be performed merely to clear a failing regression test.

A confirmed serious defect may warrant `verdict=fix` even when its remedy requires the user's approval. It must not be suppressed or silently transformed to `pass`. The host-neutral workflow, not the validator, decides whether another coder invocation is authorized.

Calibrate every consequential claim to the evidence available: **observed** means reproduced or measured; **supported** means established by concrete repository evidence and execution semantics; **hypothesis** means plausible but unconfirmed; **unverified** means a necessary check was not performed. Do not call checks passed unless they were actually executed. Avoid invented numerical confidence scores.

Check that consequential acceptance criteria are independently verified or explicitly left unverified, including material negative/boundary/lifecycle scenarios. When competing root-cause hypotheses would change a fix decision, require discriminating evidence or state the uncertainty; do not convert an uncertain theory into a confirmed issue. A reported `pass` must not conceal known failing tests or missing evidence.

Before returning the verdict, determine whether current evidence shows a concrete violation of a hard invariant that should block acceptance.

Do not block for naming, style, preferred abstractions, optional refactors, or another valid architecture.
