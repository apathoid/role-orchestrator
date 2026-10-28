# Engineering Core

These principles define the default engineering decision model.

They are not a project architecture. Apply them through the architecture, conventions, contracts, and constraints of the repository being changed.

Explicit project rules override default architectural preferences, but they do not justify correctness regressions, resource leaks, or unintended behavior changes.

## 1. Solve the general problem that is actually present

Do not implement only the current manifestation of a problem when the requirement already exposes a more general mechanism.

Separate what follows from the nature of the problem from what exists only because of the current consumer.

If a mechanism is semantically independent of the current consumer, prefer implementing it at an appropriately general level and expressing the current use case as a specialization over it.

Do not wait for multiple consumers before extracting a genuinely general concept.

At the same time, do not add configurability, extension points, or abstraction for hypothetical variants that are not inherent in the current problem.

Prefer **semantic generality without speculative complexity**.

## 2. Separate mechanism from policy

Mechanism describes what the system can do.

Policy describes when, why, or in what concrete way the mechanism is used.

Keep reusable mechanisms independent of product-specific policy whenever the distinction is real.

Do not force a general mechanism to understand a particular consumer.

## 3. Place behavior at the lowest correct level

A behavior belongs at the lowest level that:

- can express it naturally;
- owns the required knowledge;
- does not need knowledge of more specific consumers.

Do not place behavior lower merely to maximize reuse.

Do not keep behavior higher merely because that is where the first requirement appeared.

Architecture should follow semantic responsibility rather than edit convenience.

## 4. Extend existing concepts before creating parallel ones

Before creating a new implementation, identify the nearest existing abstraction.

Determine whether the new requirement is configuration of it, composition of it, specialization of it, extension of its mechanism, or genuinely a different concept.

Prefer a natural continuation of the existing abstraction graph over a parallel implementation.

## 5. Abstractions must represent real concepts

The number of current consumers does not determine whether an abstraction is valid.

One consumer may justify an abstraction if the abstraction expresses a real, independent concept.

Many consumers do not justify an abstraction if the only commonality is accidental structural similarity.

Generalize semantics, not coincidental code shape.

## 6. Dependencies should follow knowledge

A component should depend only on concepts it is entitled to know about.

General mechanisms should not gain knowledge of specific consumers.

Domain behavior should not unnecessarily depend on transport or infrastructure details.

Consumers should interact with boundaries through semantic contracts rather than internal representations.

## 7. Prefer one source of truth

Do not introduce independently mutable state when the same information can be reliably derived from an existing source of truth.

When duplicated or derived structures are required for performance or integration reasons, make their synchronization invariant explicit.

## 8. Ownership includes lifecycle

Anything acquired, registered, started, subscribed, opened, scheduled, or allocated must have an identifiable owner and termination path.

Always be able to answer:

- who created it;
- who owns it;
- when ownership ends;
- how it is released;
- what happens on failure or interruption.

Lifecycle correctness is part of functional correctness.

## 9. Preserve contracts

Before changing implementation, determine what surrounding code relies on.

Do not weaken types, guarantees, public APIs, invariants, or failure semantics merely to make the current implementation easier.

Change a contract deliberately, not accidentally.

## 10. Prefer the smallest coherent change

Minimize conceptual disturbance, not line count.

A locally tiny patch is not preferable if it places behavior at the wrong responsibility boundary or duplicates an existing mechanism.

A larger refactor is not preferable merely because it produces a theoretically cleaner design.

Change enough to leave the system coherent, and no more.

## 11. Keep scope proportional to responsibility

A concept should be available as broadly as its semantics justify.

Do not keep a genuinely general mechanism artificially local.

Do not expose implementation-specific helpers globally merely because they may someday be useful.

Reusable does not mean miscellaneous.

General concepts should have explicit conceptual homes and narrow public contracts.

## 12. Simplicity is structural

Prefer designs with fewer:

- independent sources of truth;
- ownership ambiguities;
- special cases;
- duplicated concepts;
- knowledge edges;
- synchronization obligations.

Do not confuse simplicity with fewer files, fewer abstractions, or fewer lines.

The goal is the smallest accurate model of the problem.
