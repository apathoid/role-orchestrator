# Engineering Decision Process

Use this process for non-trivial implementation and refactoring work.

Its purpose is not to force additional architecture. Its purpose is to prevent implementation convenience from silently determining architecture.

## Phase 1 — Establish the actual requirement

Determine:

- what observable behavior is requested;
- what behavior must remain unchanged;
- what constraints are explicit;
- what assumptions are currently unverified.

For non-trivial work, translate important requirements into observable acceptance criteria. Check for contradictions, missing contract-preserving behavior, and relevant negative/boundary/integration/lifecycle cases. Do not silently invent requirements: expose consequential gaps as questions or explicit assumptions.

Do not begin architecture work from a guessed expansion of the requirement.

## Phase 2 — Map the existing system

Before designing a new solution, inspect the code that currently owns the relevant behavior.

Identify:

- the current owner;
- the nearest lower-level abstractions;
- analogous implementations;
- public boundaries;
- state ownership;
- lifecycle ownership;
- relevant integration boundaries.

Do not search the entire repository without purpose.

Search downward and sideways from the intended change until the relevant abstraction structure is understood.

For a non-obvious failure, distinguish **what was observed** from the proposed root cause. If a competing explanation would materially change the fix, identify the strongest plausible alternative and seek a targeted observation, trace, or discriminating test that could falsify the leading hypothesis. Do not manufacture alternatives for obvious, well-supported failures or repeat broad investigation without new evidence.

## Phase 3 — Decompose the requirement

Separate the requested behavior into:

### General mechanism

Behavior whose meaning does not depend on the current consumer.

### Specific policy

Behavior that exists because of the current product/domain/use case.

Ask:

> If the current consumer were replaced by another valid consumer of this mechanism, which parts would remain meaningful?

Those parts are candidates for the general mechanism.

Do not assume that a mechanism must already have multiple consumers.

## Phase 4 — Find the lowest correct owner

For each responsibility ask:

1. Which layer has enough knowledge to implement this correctly?
2. Could the behavior live lower without learning about the current consumer?
3. Would moving it lower make the abstraction genuinely more general, or merely more configurable?
4. Does an existing abstraction already own most of the concept?

Choose the lowest level that naturally owns the semantics.

Not the lowest technically possible level.

## Phase 5 — Prefer extension of the abstraction graph

Before introducing a parallel implementation, test these options in order:

1. reuse;
2. configure;
3. compose;
4. specialize;
5. extend the existing mechanism;
6. introduce a new concept.

Do not force an unrelated requirement into an existing abstraction merely to avoid creating a new one.

The result should make the conceptual model clearer.

## Phase 6 — Test the proposed abstraction

For every new reusable abstraction ask:

### Semantic test

Does this abstraction represent a concept that exists independently of the current call site?

### Consumer-removal test

If the current consumer disappeared, would the abstraction still have a coherent meaning?

It does not need to have another current consumer.

### Speculation test

Did we add parameters or extension points only for imagined future variants?

Remove them unless they are inherent in the concept.

### Knowledge test

Does the abstraction depend on anything more specific than its own responsibility?

If yes, reconsider its level or contract.

## Phase 7 — Determine state and ownership

Identify all mutable state and resources involved.

For each state value ask:

- what is its source of truth;
- whether it can be derived;
- who may mutate it;
- what invariant relates it to other state.

For each resource ask:

- who acquires it;
- who owns it;
- who releases it;
- what happens during partial failure;
- what happens during replacement, cancellation, or repeated execution.

Do this before implementation when lifecycle is non-trivial.

## Phase 8 — Preserve contracts

Identify observable contracts before modifying them:

- public APIs;
- types;
- emitted events;
- persistence format;
- ordering;
- error behavior;
- lifecycle behavior;
- concurrency guarantees;
- caller-provided configuration.

Do not accidentally redefine an existing contract while solving a local requirement.

## Phase 9 — Implement the smallest coherent design

Prefer direct code.

Do not introduce architecture whose only purpose is architectural appearance.

Do not duplicate a mechanism merely to minimize the diff.

Do not refactor unrelated areas unless they prevent the requested behavior from being placed correctly.

The implementation should look like a natural continuation of the existing system.

## Phase 10 — Challenge the implementation

Before considering the change finished, deliberately attempt to disprove the design.

Ask:

- Did I solve only the current manifestation instead of the real general problem?
- Did I over-generalize beyond the actual problem?
- Did a lower-level abstraction learn about a higher-level consumer?
- Did I create a parallel concept where specialization was sufficient?
- Did I add another source of truth?
- Did I create a resource without a clear cleanup path?
- Did I weaken an existing contract?
- Did I keep a general mechanism artificially local?
- Did I expose implementation detail globally without semantic reason?
- Did I make the diff smaller at the expense of the architecture?
- Did I refactor beyond the actual requirement?

If one of these is true, revise the design before polishing the implementation.

## Phase 11 — Verify

Verify both:

### Functional correctness

The requested behavior works and existing behavior remains intact.

### Structural correctness

The change preserves the intended responsibility, dependency, ownership, and abstraction boundaries.

For consequential conclusions, state the evidence level accurately: **observed** (reproduced/measured), **supported** (reasoned from concrete repository evidence), **hypothesis** (plausible but unconfirmed), or **unverified** (needed check not performed). Static inspection is not an executed test. Treat verification failures and unavailable tooling distinctly, and record remaining uncertainty without inventing numerical confidence.

A passing test suite is necessary evidence when relevant, but it does not by itself prove structural correctness.
