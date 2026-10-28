# Engineering Review Rubric

Review the change against the existing project architecture and Engineering Core.

Do not optimize for personal stylistic preference.

Distinguish defects from alternative valid designs.

## Severity

### Must fix

Use when the change introduces or risks:

- incorrect behavior;
- unintended contract changes;
- invalid ownership;
- resource or lifecycle leaks;
- broken dependency boundaries with concrete architectural consequences;
- duplicated mutable sources of truth that can diverge;
- unsafe weakening of types or guarantees;
- incorrect abstraction placement that causes a more general layer to depend on a specific consumer.

### Should fix

Use when the design works but materially harms:

- conceptual reuse;
- maintainability;
- abstraction clarity;
- responsibility boundaries;
- consistency with an established project pattern.

Represent these as `minor` unless concrete impact makes the issue blocking/major. A should-fix item by itself does not require `verdict=fix`.

### Optional

Use for alternatives that are primarily preference and do not materially improve correctness or architecture.

Do not present optional alternatives as defects. Normally omit them from machine issues unless the user explicitly asked for stylistic/alternative-design feedback; they never justify `verdict=fix`.

## 1. Problem decomposition

Did the implementation distinguish the reusable mechanism from consumer-specific policy?

Did it solve only the current manifestation of a more general problem?

Did it instead generalize beyond what the actual problem implies?

## 2. Abstraction placement

Is each responsibility owned by the lowest correct conceptual level?

Could a mechanism be more general without becoming aware of hypothetical requirements?

Was a genuinely general mechanism kept unnecessarily inside one consumer?

Was implementation-specific logic promoted globally without independent semantic meaning?

## 3. Existing abstractions

Does the change duplicate a concept already present in the system?

Could it naturally be expressed through reuse, composition, specialization, or extension of an existing abstraction?

Conversely, was an unrelated abstraction distorted merely to reuse it?

## 4. Dependency knowledge

Does every dependency follow the intended direction of knowledge?

Did a general layer learn about a more specific consumer?

Did domain or reusable code acquire unnecessary knowledge of transport, framework, storage, or presentation details?

## 5. State model

Is there a clear source of truth?

Was independently mutable duplicate state introduced where derivation was sufficient?

If derived state is materialized, is its synchronization invariant explicit and safe?

## 6. Ownership and lifecycle

For every subscription, listener, timer, process, connection, handle, registration, task, or other acquired resource:

- is ownership clear;
- is cleanup deterministic;
- are failure and cancellation paths covered;
- are replacement and repeated execution safe?

## 7. Contracts

Did the change preserve:

- public APIs;
- type guarantees;
- ordering;
- persistence semantics;
- emitted behavior;
- lifecycle guarantees;
- caller configuration;
- error semantics?

If a contract changed, was that change required and deliberate?

## 8. Scope

Is the change the smallest coherent solution?

Was unrelated code redesigned without need?

Was the implementation artificially localized even though correct placement required a small supporting refactor?

## 9. Structural simplicity

Did the change reduce or increase:

- sources of truth;
- special cases;
- synchronization requirements;
- ownership ambiguity;
- duplicated concepts;
- knowledge edges?

Judge simplicity by system structure, not line count.

## 10. Acceptance and evidence quality

Are important acceptance criteria observable, consistent with the user's scope, and independently verified rather than inferred from the coder's summary?

Are consequential negative, boundary, integration, regression, and lifecycle behaviors actually covered or explicitly unverified? Do not invent requirements to manufacture a blocking issue.

Separate **observed** failures (reproduced or measured), **supported** findings (concrete code and execution semantics), **hypotheses**, and **unverified** concerns. Never present a hypothesis as a reproduced defect or a static inspection as an executed test.

For a non-obvious failure, challenge the proposed root cause when an alternative explanation would materially alter the review. Prefer discriminating evidence over speculative severity inflation. Retain significant related findings irrespective of whether remediation is authorized; severity, origin and scope are independent judgments.

## Final review question

> Does this change look like the system naturally grew to support the new requirement, or like the requirement was attached to the nearest convenient location?

Prefer the former.
