# Audit B — State, Continuation, Host Neutrality

Independent scope: persisted Implementation Plan, Review state, stage/checkpoint identity, Git HEAD drift, budgets and concurrency. Method: inspect `src/session-store.mjs`, stage and Review validators, exercise `test/prelive-state-restart.mjs` with actual files and separate Node processes.

| ID | Severity | Root cause and reproduction | Expected vs observed | Remediation | Regression evidence | Final status |
|---|---|---|---|---|---|---|
| B-PRE-01 | MEDIUM coverage gap | Earlier restart evidence relied on same-process simulation, not a real persisted and separately loaded session. | Expected Plan ID, task ID, records, Review operation and budgets to survive a new process. New harness confirms exact equality for its fixture. | Added multiprocess Plan/Review restart test. | `prelive-state.log` | TEST COVERAGE FIXED / LOCAL PASS |
| B-PRE-02 | HIGH risk / regression guard | Two writers can race on same checkpoint. Test two independent processes reading one revision and writing after a barrier. | Expected one winner and one explicit conflict; observed `saved` and `SESSION_REVISION_CONFLICT`. | Reuse existing lock and revision guard, add regression. | `prelive-state.log`; `src/session-store.mjs` | LOCAL PASS |
| B-PRE-03 | MEDIUM risk / regression guard | Mismatched Plan ID/scope/repo and HEAD drift could permit stale checkpoint reuse. | Expected mismatch refusal; validator returns false on each injected divergence. | Negative scenarios without authorization changes. | `test/prelive-state-restart.mjs` | LOCAL PASS |
| B-PRE-04 | HIGH release gate, unconfirmed | Crash after arbitrary external tool side effect but before persistence may duplicate on resume. | Exactly-once is not assured; no external transactional mechanism is tested. | Require recheck/reconciliation/idempotency acceptance; no blanket automatic retry. | No real external effect injection; live gate | NOT_VERIFIED |
| B-PRE-05 | MEDIUM evidence limit | Checkpoint write fsync, cancellation and concurrent Plan revision have more crash windows than this harness covers. | Need fail-closed behavior after each crash point. | Expand fault-injection + real host acceptance. | Existing `test/session-store.mjs`, targeted new harness | PARTIAL |

The shared core was not redesigned. No Zed-only behavior was added. Review v4 persists typed intent; legacy checkpoints remain diagnostic-only when not validated. No claim is made of fully verified end-to-end multi-process work-unit execution.
