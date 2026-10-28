# Engineering Hard Invariants

Use these for final risk validation. They are intentionally narrower than the full Engineering Core.

A final validation may block completion when repository evidence shows a concrete violation of one of these invariants:

1. **Correctness:** the requested behavior is not correctly implemented or a concrete regression remains.
2. **Contract integrity:** an observable contract, public API, type guarantee, persistence/error/lifecycle semantic, or explicitly required behavior changed unintentionally.
3. **Ownership and lifecycle safety:** a resource has no valid owner/termination path, cleanup is missing, or cancellation/failure/replacement can concretely leak or corrupt state.
4. **Source-of-truth integrity:** independently mutable duplicated state can concretely diverge and produce incorrect behavior.
5. **Dependency safety:** a responsibility/dependency inversion creates a concrete correctness, lifecycle, security, or contract-integrity risk that should block acceptance, rather than merely representing a stylistic alternative.
6. **Task scope safety:** unrelated user/editor state was overwritten or the implementation introduced material unrelated behavior changes.
7. **Verification integrity:** available evidence demonstrates a code failure that remains unresolved.

Do not block completion merely because a different abstraction, naming style, or refactoring would be preferable.
