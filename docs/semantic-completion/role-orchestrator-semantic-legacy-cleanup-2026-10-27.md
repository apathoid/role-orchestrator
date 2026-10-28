# Legacy semantic decision cleanup register

| Mechanism | Result | Remaining limits |
|---|---|---|
| `namedSkillInvocation` | Removed | Natural-language skill requests now use `task.skillName`; explicit `/skill` is protocol parsing |
| `inferReviewTarget` | Converted to typed resolver | Explicit commit command remains a structured host signal |
| `validateRouteConsistency` | Kept as typed validator | No user prompt inspection |
| `implementationPlanIntent` | Removed | Saved Plan selection follows Router |
| `isReadOnlyUserRequest` | Removed | Read-only is policy plus Router typed contract |
| `isBareImplementationContinuation` | Removed | Saved Plan state is not authorization |
| `isReviewContinuationRequest` | Converted to typed resolver | Explicit review-resume slash commands remain a trusted protocol |
| `reviewExcludedPaths` | Converted to typed resolver | `constraints.excludedPaths` required |
| `chooseReviewStrategy` | Kept as deterministic policy | Typed preference cannot bypass mandatory units |
| Review obligation extraction | Converted to typed review requirements | Planner-derived work units still validated deterministically |
| Reconciliation language confirmation | Removed | Host-recorded `accept_checkout` only; semantic `reconcile` is read-only |
| `execution-service.resolvePlan` | Converted to typed resolver | Missing validated intent produces no selected Plan |
| `resolveReviewScope` string argument | Removed | Text input returns explicit `typed_git_selector_required` |
| `parseSlashInvocation` | Kept as protocol parser | Slash recognition requires beginning-of-input command |
| `reviewScopeReconciliationRequest` | Kept as explicit slash-protocol parser | No generic NLP recognition |
| Provider JSON extraction | Kept as protocol parser | Strict task validation after parsing |
| Security, authorization, checkpoint validation | Kept as deterministic validators | No model-produced privileges |
| Review checkpoint with no taskSpec | Compatibility-only, read/diagnose | Resume denied rather than guessing from original text |

**Authoritative natural-language parsers:** none identified in the modified primary execution path; this is a static/test finding, not proof of all host/provider paths. Some legacy tests still expect textual continuation and must be migrated.
