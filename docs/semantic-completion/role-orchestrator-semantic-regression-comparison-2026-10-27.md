# Regression comparison

| Scenario | Experimental source | Hardened working tree | Evidence / limits |
|---|---|---|---|
| Typed Router contract | Version 1 partially accepted, nested task optional | Missing/invalid task yields `intent_unresolved` in production; nested routing task required by output schema | Semantic workflow and malformed-output tests pass |
| Git selector interpretation | Parallel lexical and typed resolver | Main resolver only accepts typed selector; explicit `union` composite supported | Real temporary Git repository test passes |
| Review user obligations | Some obligations extracted from natural language | `reviewChecks`, `expectedFileCount`, `excludedPaths` are typed | Review coverage/efficiency tests pass |
| Saved Plan in injected workflow | Service chose Plan from text before Router | Caller must request typed `onSelectSavedImplementation` | Execution service, implementation-task-continuity and runtime tests pass |
| Plan discussion/continuation | Legacy lexical shortcuts | No normal natural-text shortcut before Router; saved Plan requires verified Change intent | P3 continuation and semantic workflow tests pass |
| Reconciliation approval | Language phrase could be read as approval | Only recorded structured host decision may approve | Reconciliation tests pass |
| Router failure | Could downgrade to successful Investigate | Explicit incomplete `intent_unresolved` | Semantic-workflow PASS; legacy workflow-unstructured remains FAIL |
| Full `npm test` | Earlier failure due unavailable ACP SDK | Reaches `test:generic-acp`, then `ERR_MODULE_NOT_FOUND @agentclientprotocol/sdk` | `ENVIRONMENT_BLOCKED`; full pass not proved |
| `npm run test:evaluation` | Stopped at legacy P3 continuation | Entire script passes, exit 0 | Local deterministic/mocked tests; not real LLM evaluation |
| Real semantic accuracy | Not measured | 56-case corpus, 0 valid provider outputs | `NOT_VERIFIED` (56 provider crashes; *not* 0% model accuracy) |
| Zed and real Codex ACP | Not verified | Still not verified | Host live validation required |

All observations are from this container with Node 22.16.0, below required >=22.20.0. Prior archive remains unmodified.
