# Активный план реализации и приёмки

C22-R2 review follow-up (P2.1/P3.1 only): actual HTTP RED for both transport causes, local conflict-invalidation correction, comment clarification, existing finality/lineage semantics and focused regression tests. See [STATUS](STATUS.md) for exact evidence. Engineering PASS on `acb93c62e4e792459576ec3f491e979106af907f` / [CI #45752408795](https://github.com/apathoid/role-orchestrator/actions/runs/45752408795) SUCCESS (39/39 steps; root 722/722, integration 585/585, Linux PTY 15/15; all four new regressions, historical comparisons, resource probes, Nix and release checks). No further engineering cycle; native utility and compatibility remain UNVERIFIED.

## C22-R2 — Technical Interface Reliability & Diagnostic Accuracy (engineering PASS at 6bbdbcb6; native UNVERIFIED)

Review baseline `c5d4d333214be9bcca37908985efbd72bc59f823` / [CI #45747991614](https://github.com/apathoid/role-orchestrator/actions/runs/45747991614) SUCCESS. F1 baseline Node24 HTTP regression confirmed; reuse ordered transport observation. F2/F3 attachment-aware Action context advisory, accurate optional availability; F4 string-only cross-operation description including bounded fallback; H1 existing selected ref in conflict receipt only. No additional validator, admission, limits or persisted state. C22-R2.0–.7 implemented and engineering verified. Engineering PASS on `6bbdbcb61cf283b65d6637ea9bd56096ee1e475e` / [CI #45750885864](https://github.com/apathoid/role-orchestrator/actions/runs/45750885864) SUCCESS (39/39 steps; foundation/package 4/4, core 31/31, provider contracts 98/98, integration 581/581, acceptance 4/4, root 718/718, actual Linux PTY 15/15; historical comparisons, resource probes, Nix, installation and release checks). See [STATUS](STATUS.md); documentation closure CI checked separately. Native compatibility/model utility and prompt/example practical assessment remain UNVERIFIED. No master merge or further cycle authorized.

## C22-R — Retrieval Argument Diagnostic Refinement (engineering PASS at 8061e88e; native UNVERIFIED)

Only review P2.1: clarify historical reference/cursor/selection alternatives in the existing bounded error, preserve primary identity, exact nested errors, decoder/normalization, retrieval scope and legacy numeric cursor behavior. C22-R.0–.4 implemented and engineering verified. Engineering PASS on `8061e88e0b6f40f05e41f43924e735f0d9b78908` / [CI #45747522796](https://github.com/apathoid/role-orchestrator/actions/runs/45747522796) SUCCESS (39/39 steps; foundation/package 4/4, core 31/31, provider contracts 98/98, integration 573/573, acceptance 4/4, root 710/710, actual Linux PTY 15/15; all historical comparisons, resource probes, Nix and release checks). See [STATUS](STATUS.md); documentation closure CI checked separately. Review baseline `e724030cfb6faabecbe0c77e0f4fbe862365c0b7` / [CI #45707658158](https://github.com/apathoid/role-orchestrator/actions/runs/45707658158) SUCCESS. P3.1/P3.2 unchanged pending real runs; no next engineering cycle authorized.

## C22 — Model-facing Technical Information Accessibility (ENGINEERING VERIFIED at 8ad7f541; native UNVERIFIED)

[Detailed executable plan](C22_MODEL_FACING_TECHNICAL_INFORMATION_ACCESSIBILITY.md), [STATUS](STATUS.md), [native procedure](NATIVE_ACCEPTANCE.md). Authorized on `feature/controller-intent-deferred-admission` from `7906710019d46debb4ec4cd9c226a2b13491d156` / [exact CI #45668749511](https://github.com/apathoid/role-orchestrator/actions/runs/45668749511) SUCCESS. The introducing commit is planning HEAD. Goal: improve accessibility of technical information already owned by RO, not expand the contract machinery. F1–F5 mandatory; conditional opportunities may end without edits. Joint design of .1/.3 before implementation, without mandatory shared framework.

| Checkpoint | Deliverable |
| --- | --- |
| C22.0 | Verify baseline, ownership and joint design; scoped C21 native evidence |
| C22.1 | Accurate bounded technical error information and retained retrieval diagnostics |
| C22.2 | Unambiguous proposal registration receipts, unchanged replacement/finality |
| C22.3 | Accessible input format at tool-use boundary, prioritize information over schema strictness |
| C22.4 | Truthful correction context and current delivery; optional existing reference only |
| C22.5 | Limited owned availability/scope/retrieval audit, changes only if proven |
| C22.6 | Actual model-facing consistency, not a prompt size optimization project |
| C22.7 | Same-input invariants, focused regressions and exact-HEAD full CI |
| C22.8 | Separate real-client contract compatibility and experimental model utility, UNVERIFIED if unavailable |

Preserve existing runtime semantics and model autonomy; no extra gates/quotas, schema or diagnostic service, semantic history selection, automatic corrections or external provider work. F1–F5 implemented at the existing owners; H4 clarified in descriptions, H1–H3/H5 require no additional mechanisms. Engineering PASS on `8ad7f5415de3be64286a41aa90d2a30634c78d4d`, [CI #45706899430](https://github.com/apathoid/role-orchestrator/actions/runs/45706899430) SUCCESS (39/39 steps; foundation/package 4/4, core 30/30, provider contracts 98/98, integration 570/570, acceptance 4/4, root 706/706, actual Linux PTY 15/15; all resource probes, historical comparisons, Nix and release checks). Documentation closure changes no runtime/test files; exact closure HEAD CI must be checked separately. See [STATUS](STATUS.md) for detailed checkpoint measurements and test evidence. Native compatibility and model utility remain separately UNVERIFIED. No master merge or next cycle authorized.

## C21-R — Model-facing Clarity & Comparison Refinement (ENGINEERING VERIFIED at dbcc6d88; real native UNVERIFIED)

Review baseline `71d6b2d64de96c43076021878e82387adc79a049`, CI #45663007700 SUCCESS. R0 baseline; R1 editorial guidance deduplication; R2 exact A/B/C/D comparison including actual ACP sparse events; R3 historical STATUS correction and hasCapturedValue unchanged; R4 focused regressions and full CI SUCCESS on D `dbcc6d881074ceee8a8cd123f69962b0f92e4d45`, [CI #45667902352](https://github.com/apathoid/role-orchestrator/actions/runs/45667902352). See [STATUS](STATUS.md) for measured A/B/C/D and native limitations. No expanded evidence API, runtime policy, metadata capture or provider investigation. Native quality remains UNVERIFIED.

## C21 — Model-facing Information Clarity (ENGINEERING VERIFIED at 2ed30f83; real native UNVERIFIED)

[Detailed executable plan](C21_MODEL_FACING_INFORMATION_CLARITY.md), [STATUS](STATUS.md), [native procedure](NATIVE_ACCEPTANCE.md). Implemented approved engineering scope on `feature/controller-intent-deferred-admission`; source baseline `5b6e55ccdd9ce2fba4a5dfdcb3d53dcd4b87ff55` / [CI #45563489787](https://github.com/apathoid/role-orchestrator/actions/runs/45563489787) SUCCESS. Planning HEAD `16525506fd3dd4d4543b85377212234468f53037`; engineering checkpoint C `2ed30f83fddaf6d34ab562c4774bc4704277cd92`, [CI #45661813661](https://github.com/apathoid/role-orchestrator/actions/runs/45661813661) SUCCESS. See STATUS for measured A/B/C and limitations.

| Checkpoint | Deliverable |
| --- | --- |
| C21.0 | Actual source/contract/fixture baseline and existing tests |
| C21.1 | RO-owned native integration check only; defect fix, supported finding or UNVERIFIED |
| C21.2 | Existing adapter-owned identity metadata, inherited attribution/paired omission, immutable refs and duplicate semantics, C20-R |
| C21.3 | Evidence presentation first; preserve ordinary pagination/default 12; optional minimal API additions only if justified |
| C21.4 | Clarify evidence identity, provenance, completeness and model-owned Assessment; no semantic admission |
| C21.5 | Clarify MCP native turn completion; continued tools/replacement preserved; checkpoint B |
| C21.6 | Comprehensive prompt audit last, retain technical and role contracts, remove unjustified prescriptions/dedup losslessly; checkpoint C |
| C21.7 | Focused regressions using existing infrastructure and full exact-SHA CI |
| C21.8 | A/B/C native comparison where available, separate native compatibility and model quality; UNVERIFIED where unavailable |

No mandatory filters/order/limit, new store/registry, provider internals/diagnostics investigation, external-effect contract changes, forced retrieval/workflow, hidden capability selection, tool-count/latency or prompt-size target. Preserve existing user authority, real workspace, provider independence, C18–C20-R and prior native obligations. No master merge. Engineering CI verified on checkpoint C; real native results remain UNVERIFIED.


## C19 — Model-facing Evidence & Answer Clarity (ENGINEERING VERIFIED at 876a33c7; native UNVERIFIED)

[Detailed executable plan](C19_MODEL_FACING_EVIDENCE_AND_ANSWER.md), [STATUS](STATUS.md), [native procedure](NATIVE_ACCEPTANCE.md). Branch `feature/controller-intent-deferred-admission`; source baseline `2650d327b01eddd5ed2939263ef73b803381be11`. Implement before C20, with separate exact-SHA acceptance.

| Checkpoint | Deliverable |
| --- | --- |
| C19.0 | Baseline actual native metadata sources, observation identity and prompt paths; RED fixtures |
| C19.1 | Optional immutable provider-reported metadata, native values preserved, no universal ontology or invented provenance |
| C19.2 | Bounded live/historical projection, canonical ref and essential provenance priority, explicit omissions, unchanged pagination |
| C19.3 | Concise general observation guidance, capture completeness distinct from tool status |
| C19.4 | Actual user-facing answer clarified across MCP/text/legacy; no Host semantic validation or text substitution |
| C19.5 | Production-path ACP SDK, identity/duplicate/reopen/budget/answer/optional retrieval regressions |
| C19.6 | Native model evaluation or UNVERIFIED, exact-SHA mandatory CI and documentation |

## C20 — Optional Invocation Deadline & Resource Defaults (ENGINEERING VERIFIED at e092712f and c86d3e5e; native UNVERIFIED)

[Detailed executable plan](C20_OPTIONAL_INVOCATION_DEADLINE_AND_RESOURCE_DEFAULTS.md). Begin from verified C19 implementation head. Approved defaults: `maxConcurrentInvocations=5`, `maxInvocationsPerOperation=null`, `invocationTimeoutMs=null`. All remain configurable. No additional execution timeouts, idle/tool/startup/interaction/recovery deadlines, watchdog or liveness tracking. Preserve post-stop technical teardown and actual provider policies; never infer detachment or replay unknown work.

| Checkpoint | Deliverable |
| --- | --- |
| C20.0 | Source/timer ownership inventory, RED fixtures incl. ACP startup cancellation; capture/output/resource audit |
| C20.1 | Nullable configuration, explicit finite/absent/null semantics and trusted precedence |
| C20.2 | Unlimited cumulative invocations and default concurrency 5 through Operation limits, reserve, state, resume, context and presentation |
| C20.3 | One optional hard invocation deadline, no scheduled execution timer by default |
| C20.4 | No hidden adapter/owned-process execution timeout; transport and post-stop mechanics distinguished |
| C20.5 | Indefinite interactions and recovery, reliable explicit cancellation across all boundaries, truthful pending cleanup/late detachment and occupied slots |
| C20.6 | Deterministic lifetime/resource/finality regressions, >40 invocations, scale/capture measurements and residual limits |
| C20.7 | Native acceptance or UNVERIFIED, full exact-SHA CI, normative docs/config/acceptance matrix and handoff |

No new scheduler, semantic gates, execution phase/watchdog subsystem or replacement cumulative quota. C19 and baseline C20 have exact-SHA engineering checkpoints; C20-R closes the remaining ACP result-capture defect. Native acceptance remains UNVERIFIED.

## C20-R — Independent ACP Result Capture (ENGINEERING VERIFIED at c86d3e5e; native UNVERIFIED)

Separate bounded current result from retained history in the existing ACP adapter; preserve message identity, complete-result refs and C18R finality. Actual SDK RED/GREEN, identity/Unicode/overflow/cancellation tests, capture scale probe and exact-SHA [CI #45488863848](https://github.com/apathoid/role-orchestrator/actions/runs/45488863848) PASS (38/38; 98 contracts, 561 integration, 15 PTY). No change to C20 defaults or lifecycle. Engineering work closed; use [native N1–N8](NATIVE_ACCEPTANCE.md#c19c20-r--native-acceptance-procedure-n1n8). No further implementation without concrete native evidence and separate authorization.

## C18N-R — Review corrections (ENGINEERING VERIFIED at 0687a40; native UNVERIFIED)

Review baseline `0dbae3434b626fcd4132059f6d349b3f4dcab3c6`; [STATUS](STATUS.md) and [C18N specification](C18N_LIVE_EVIDENCE_DISCOVERY_AND_RELIABLE_CORRECTION.md). The five RED regressions are recorded at `1a53134d` / [CI #45266076178](https://github.com/apathoid/role-orchestrator/actions/runs/45266076178). R1–R5 production fixes passed [CI #45266687474](https://github.com/apathoid/role-orchestrator/actions/runs/45266687474) on `295499174be7f4475dc14b59bfa6c7b5bbe3e427`. Expanded code/probes passed [CI #45267563474](https://github.com/apathoid/role-orchestrator/actions/runs/45267563474) at `f9ede6d`. Final code `0687a40a8cf2d2886ab1f722aa8e91663e9e43eb` passed [CI #45268444761](https://github.com/apathoid/role-orchestrator/actions/runs/45268444761): 36/36 steps including 543 integration, 15 PTY, Nix/release. The documentation-only head still requires its own exact-SHA workflow; real provider/model comparisons remain UNVERIFIED.

| Corrective checkpoint | Deliverable |
| --- | --- |
| R.0 | Five specific RED tests for registered ToolPort call 33, repeated preflight scan, real tool registration, exhausted live cursor and oversized metadata |
| R.1 | Genuine External ToolPort no cumulative 32-call limit; unchanged permission/cancel/late receipts and input/output bounds |
| R.2 | Historical index once, incremental live alias/identity lookup, Intent-size temporary `EvidenceRefs` |
| R.3 | Valid external names including context/evidence/submit_decision; built-ins aliased dynamically |
| R.4 | Live `resumeCursor` after every page without historical cursor changes |
| R.5 | Explicit omission/gap markers, bounded directory metadata and navigable later entries |
| R.6 | Real-port, large-history/finding/alias, multi-page/Unicode, ACP SDK, cancellation/finality/restart regressions |
| R.7 | Comparative GC/preflight measurements, complete Node24/npm/PTY/Nix/release CI at exact SHA, real native UNVERIFIED |

No additional scheduler, semantic gate, call quota or compulsory workspace validation.



## C18N — Live Evidence Discovery, Reliable Controller Correction & Minimal MCP Bridge (ENGINEERING VERIFIED at `42293b6`; native UNVERIFIED)

**Approved executable scope:** [C18N.0–C18N.10 plan](C18N_LIVE_EVIDENCE_DISCOVERY_AND_RELIABLE_CORRECTION.md), [STATUS](STATUS.md), [native procedure](NATIVE_ACCEPTANCE.md). Branch `feature/controller-intent-deferred-admission`; planning baseline `12b88248c8b59408b06d2ec1919498050bee19a9`. The feature branch contains implementation and automated regression fixtures for C18N.1–C18N.8. Synthetic ACP SDK testing does not establish native LLM acceptance, which remains **UNVERIFIED**. Required Node24/checkJs, core/contracts/integration/PTY, Nix packaging and release CI passed on [`42293b6`](https://github.com/apathoid/role-orchestrator/actions/runs/45260312459) (35/35 job steps, 534 integration tests). Earlier intermediate failures and the accepted ordinary request-ID post-completion replay compromise are recorded in STATUS. Later commits require independent exact-SHA verification; native-model autonomy/performance remains UNVERIFIED.

| Checkpoint | Required deliverable and exit |
| --- | --- |
| C18N.0 | Baseline current ACP/Orchestrator/MCP resource behavior; sanitize operator trace; RED for missing live discovery, late evidence rejection, cross-invocation replacement and cumulative ordinary-call limit |
| C18N.1 | Existing canonical observation refs exposed from accepted current-invocation data; stable identity, truthful provenance and explicit lack of durability before journal commit |
| C18N.2 | Optional read-only live list/fetch with append-safe cursor independent of historical `context_list` snapshot; bounded scopes, body, metadata and collision-free tool names |
| C18N.3 | One general Controller instruction about scoped observations, optional retrieval and model-owned evidence interpretation; no task/tool/path-specific heuristics |
| C18N.4 | Advisory bounded technical preflight; structural registration precedes optional checks, no second admission or StateStore wait, copy-on-check temporary reference indices |
| C18N.5 | Same-turn correction, C18R finalization/last-wins/identity and cross-invocation historical-result recovery preserved |
| C18N.6 | Ordinary MCP calls retain active correlation only, release completed responses, remove cumulative 64-call ceiling; explicitly accept reduced late same-ID dedup, preserve strong RO control/durable invariants |
| C18N.7 | Provider-native tool/skill provenance and exact `finalAssessment.answer` transport; no Host editing/semantic verification |
| C18N.8 | Full contract, ACP SDK, concurrency, fault, cancellation, restart, memory and native autonomy regression matrix |
| C18N.9 | Controlled real-native direct/legacy/C18N comparisons on actual permitted model/workspace, or explicit UNVERIFIED |
| C18N.10 | Exact-SHA Node 24/checkJs/npm/Nix/PTY/release CI, normative docs updated for actual implementation, reviewer/executor handoff |

**Mandatory constraints:** no additional scheduler/store/Host semantic policy, no per-tool effect classification, no requirement to discover evidence before submitting, no alteration of historical ContextPort cursor, no blind Host replay of unknown effects, no weakening of RO-owned Decision/Action finality. Do not silently remove the 128-control-call bound if its removal would weaken proposal identity: measure, document and either safely replace with retained-resource accounting or report as explicit residual technical limit.

## C18R — corrective review and exact-SHA verification (IMPLEMENTED; NATIVE UNVERIFIED)

C18R fixes on `feature/controller-intent-deferred-admission` derive from the engineering review of `f9d06f19`. The corrected implementation and added tests passed [CI #45017738925](https://github.com/apathoid/role-orchestrator/actions/runs/45017738925) on `fab92fd037a0169e9e12ac6706801c3c6d4d1666`; any later documentation-only SHA requires a fresh exact-SHA CI. P1: ACP capture overflow no longer invalidates separately proven MCP completion; clearly observed invalid explicit replacements of the current proposal cannot silently admit its predecessor. P2: dynamic collision-free builtin MCP tool naming, trusted attempt-bound duplicate/identity treatment and crash-gap, finality/capacity/cancellation/provenance regressions. Production fixes are confined to ACP/MCP adapter and existing identity/admission owners; no extra scheduler, semantic Host gate, CAS for proposals or native-tool restriction.

Node 24/Nix and all applicable regressions passed at `fab92fd037a0169e9e12ac6706801c3c6d4d1666`; see [STATUS](STATUS.md). Any subsequent commit requires a new exact-SHA PASS. Real native provider comparisons remain UNVERIFIED and are not inferred from SDK/PTY fixtures.


## C18 — Controller Intent & Deferred Decision Admission (IMPLEMENTATION; NATIVE UNVERIFIED)

**Current implementation record:** [C18 executable plan](C18_CONTROLLER_INTENT_AND_DEFERRED_ADMISSION.md), branch `feature/controller-intent-deferred-admission` from C17R `836c3795`, planning HEAD `f8722bc8`. Read [C18 status](STATUS.md) for exact code/CI/native evidence. C18 production code and synthetic tests exist on the feature branch; engineering verification requires full exact-SHA CI, while real-model native acceptance is UNVERIFIED. No master merge.

| Checkpoint | Required deliverable and exit |
| --- | --- |
| C18.0 | Baseline, exact provenance/call-graph analysis, RED failure fixtures; record real limits |
| C18.1 | Full transport-neutral model-owned ControllerIntent decoder and per-field empty defaults |
| C18.2 | Trusted deterministic Intent→Decision v1 materialization and text/structured reference path |
| C18.3 | Generic ProviderPort transport/result discrimination, capability negotiation and legacy fallback |
| C18.4 | MCP proposal-only tool, in-turn correction, explicit same-lineage last-wins, recoverable conflicts, pre-`end_turn` in-flight barrier |
| C18.5 | Invocation-scoped generic provenance, cross-session tests, bounded large-intent/control-tool capacity |
| C18.6 | Existing single admission/journal, C16 5/10 recovery, C17R source identity, crash-safe receipt dedup and no replay |
| C18.7 | Complete contract/integration/cancel/late/restart/PTY regressions and native autonomy invariants |
| C18.8 | Real OpenCode+independent provider comparisons, code quality and native tool behavior, final exact-SHA Node 24/Nix/CI and documentation |

**Nonnegotiable:** native tools/skills/subagents and ordinary research must continue after any pending/invalid/conflicted submission. Host does not evaluate semantic correctness, enforce Git/workspace integrity, invent model defaults, or block independent Workers. The full C18 document governs details; this table is a navigation summary, not a second specification.

## C17R — Recovery Delivery & Diagnostic Verification

Corrective scope approved after C17 review; baseline `e7e8bf84` (full CI PASS), branch `feature/controller-reliability`. C17R.0–.2 baseline/recovery packing/chronology; .3 bounded configurable capture; .4 source correlation; .5 existing durable/concurrency paths; .6 diagnostic isolation and exact-build synthetic overhead; .7 two main native comparisons; .8 full exact-SHA verification. Existing [C17R scope and criteria](C17_CONTROLLER_CONTEXT_AND_DECISION_RELIABILITY.md#c17r--recovery-delivery--diagnostic-verification), [STATUS](STATUS.md) and [native procedure](NATIVE_ACCEPTANCE.md). No new model workflow, Decision transport or default context budget. Engineering evidence is exact-SHA only; native UNVERIFIED.

## C17 — Controller Context Efficiency & Decision Reliability (historical exact-SHA CI PASS; corrective C17R above)

**Approved implementation scope:** [C17 plan](C17_CONTROLLER_CONTEXT_AND_DECISION_RELIABILITY.md). **Branch:** `feature/controller-reliability`, from master at `d80638609d86da92e2a88d939fa09a90a1a3cfbf` (merge PR #3). Scoped implementation and regression changes are committed; see [STATUS](STATUS.md) and [native comparison procedure](NATIVE_ACCEPTANCE.md). Native acceptance remains UNVERIFIED. This is the active development milestone; older entries below are historical, with their original verification boundaries. No master merge by the implementation agent.

| Step | Executable result |
|---|---|
| C17.0 | Exact baseline, actual parser/decoder/admission and deterministic RED fixtures where needed |
| C17.1 | Faithful model-neutral Controller Invocation presentation; unchanged Decision v1 and native capabilities |
| C17.2 | Proven rejected-result correlation, bounded addressable recovery and existing C16 lifecycle |
| C17.3 | Proven inline deduplication; passive bounded diagnostic measurements and opt-in capture |
| C17.4 | Reproducible comparison of native direct/baseline/presentation/recovery builds; real results or explicit UNVERIFIED |
| C17.6 | Native optional-field CLI UX; original schema, payload and broker authority |
| C17.7 | Compact terminal summary without loss of significant outcomes or machine output changes |
| C17.8 | Architecture audit, focused and full regressions, exact-SHA mandatory CI, docs and handoff |

C17.6/7 may progress independently. Minimal measurement precedes comparisons. Preserve model-owned strategy, native discovery/tools/skills/subagents, existing Decision parser/decoder/admission, authorization, budgets, journal, cancellation and independent Workers. No new transport, scheduler, semantic Host decisions, mandatory retrieval or provider-specific core. No default resource changes, steering or persistent native sessions. Acceptance is quality + effectiveness + technical integrity, not JSON acceptance alone. Engineering verification and native verification are separate. See [STATUS](STATUS.md) for actual evidence; do not transfer previous CI PASS to new SHA.


## C16R — follow-up regression completion (code verified; final-doc-SHA CI pending)

**Review baseline:** `8e8f55212ef5070b8c0a9624770821b4a505b683`, [baseline full CI #44624794657](https://github.com/apathoid/role-orchestrator/actions/runs/44624794657) SUCCESS. Only `tests/integration/c16-controller-reliability.test.js` changed in production/test portion. C16R.1 added a real local StateStore restart test for an accepted unsent reserved independent Worker (same attemptId/budget/threshold) and two dispatched unknown-effect cases with and without negotiated lookup; no blind replay. C16R.2 added parser `non_object` and `depth` via declared ProviderResult, Application, persisted rejection and snapshot, lost commit-ACK crash gap and restarted correction; explicit Provider failure without a completed Decision does not count. C16R.3 corrected a test-only mistake requiring removal of original model output evidence; no production defect was found. No steering, runtime policy, schema, prompt or new scheduler.

**Code/tests GREEN:** `d930af087209551bade0b77d3cc89fd351c9bc26` [CI #44629076306](https://github.com/apathoid/role-orchestrator/actions/runs/44629076306) **SUCCESS**: 577 root/475 integration/14 PTY, Node 24 specification/checkJs/contracts/ACP/C15 comparators, full locked Nix/package/NixOS/release/lock checks. Previous parser-test false-negative [#44628672064](https://github.com/apathoid/role-orchestrator/actions/runs/44628672064), 2 failures, was fixture-only and corrected at `d930af08`. Final docs-only commit must get its own exact-SHA full CI; do not transfer the code-SHA PASS to it. Native C16.6 real model/provider comparison and graphical client verification remain **UNVERIFIED**. Full evidence and environment limitations: [STATUS](STATUS.md), [A124/A125](../../tests/ACCEPTANCE_MATRIX.md).

**Historical C16R handoff:** verify the final documentation SHA with mandatory Actions; separately perform C16.6 real provider comparison. The C16R scope did not include active-operation steering or prompt tuning. The separately approved C17 scope above is now active; prior native obligations remain recorded as UNVERIFIED.

## C16 — Controller Reliability & Decision Recovery (ENGINEERING VERIFIED at 8e8f5521; C16R follow-up above)

**Approved scope:** [C16_CONTROLLER_RELIABILITY_DECISION_RECOVERY.md](C16_CONTROLLER_RELIABILITY_DECISION_RECOVERY.md). Actual pre-change baseline `22d06008d74616acb9be04645aaccab7f986853e` on `feature/interactive-ux`, CI [44619859886](https://github.com/apathoid/role-orchestrator/actions/runs/44619859886) SUCCESS. Previous planning baseline `465e82aa5e16f83459e8b41a38fe8dc3411b66cd`.

**Delivered:** C16.0 regression-first commit `d2d91ae` (RED CI [44620740812 attempt 2](https://github.com/apathoid/role-orchestrator/actions/runs/44620740812) observed four expected failures; initial fifth-error fixture was strengthened at `b88230aa` to prevent fixture assertion from changing Provider outcome); C16.1 stable initial/latest original user ContextItem refs and model-owned turn semantics; C16.3 parser/decoder/admission technical rejections in the existing journal and error context; C16.4 journal-derived 5 consecutive/10 total threshold with pre-reservation crash-gap guard and local technical waiting, independent Workers preserved; C16.2 separate Decision v1 transport reference with one valid shape-only example; C16.5 extended fixture/regression, including durable crash injection, duplicate attempts, budget/resume and independent Worker. C16.7 normative docs, decisions, acceptance matrix and changelog updated. No steering, Host intent classifier, synthetic objective or new scheduler/virtual workspace.

**Verification:** C16.5 integration [44622240562](https://github.com/apathoid/role-orchestrator/actions/runs/44622240562) at `ac47ea3` recorded 466 PASS / 2 FAIL solely in the old tests' hard-coded requirement-entry example assumptions, fixed at `3b4846e`. Full Node24/checkJs/root/ACP/CLI/PTy/Nix/package/release [CI 44623424777](https://github.com/apathoid/role-orchestrator/actions/runs/44623424777) SUCCESS on `59751950` (571 root / 14 PTY). Final fixture+docs SHA CI remains **PENDING**, and native C16.6 quality comparison (baseline vs Host fixes old prompt vs Host fixes new prompt), authenticated Zed, second real provider and `llamacpp/small` remain **UNVERIFIED**. Synthetics and CI cannot certify their output quality. For evidence and remaining steps use [STATUS](STATUS.md) and [A05/A06/A21/A24/A121/A123–A125](../../tests/ACCEPTANCE_MATRIX.md).

**Original C16 exact-SHA verification:** [CI #44624794657](https://github.com/apathoid/role-orchestrator/actions/runs/44624794657) SUCCESS at `8e8f5521` (571 root/14 PTY). C16R extends that evidence above. Remaining work is controlled C16.6 native provider/model comparison; revise prompt-only C16.2 only if real quality evidence warrants. Active-operation steering remains explicitly excluded.

## C15R-GUI-R2F — preserve model Assessment status in compact (ENGINEERING CODE GREEN; native UNVERIFIED)

Review baseline `b68302ee5684d0536ee8116a813284c6febf047b`. Minimal P2 change in `src/hosts/presentation.js`: omit model Assessment decoration only when **both** `assessmentOverall=complete` and `hasModelAnswer=true`; preserve literal partial/unresolved model status for any answer presence; preserve missing/unconfirmed final text and avoid invented status. No change to read-only fact construction, live or history source, native ACP or CLI. Unit/projection, SDK live `inline/notices`, repeated `session/load`, empty/nonempty final, detailed/debug and effect-vs-model status covered by existing A117/A118/A121 plus new targeted assertions. RED [44601136344](https://github.com/apathoid/role-orchestrator/actions/runs/44601136344), GREEN code [44601922257](https://github.com/apathoid/role-orchestrator/actions/runs/44601922257) at `5bda2fac` (560 root, 14 Linux PTY, full Nix/package/release). Documentation+code [full CI #44603084212](https://github.com/apathoid/role-orchestrator/actions/runs/44603084212) SUCCESS at `e9f2a75`; later commits require independent exact-SHA verification. Real Zed/second client UNVERIFIED. [STATUS](STATUS.md). No master merge.

## C15R-GUI-R2 — Compact ACP transcript UX refinement (ENGINEERING PASS; real Zed UNVERIFIED)

Baseline `6617c0b924a7a4dc1b248772aedaef0e0b3dea37`. R2.0–R2.6 implemented as ACP-only policy: compact suppresses redundant accepted/final decoration and routine known completed attempts, shortens trustworthy Controller/Worker dispatch, retains exact unknown/failure/wait/cancel/late/discrepancy/finding signals. Detailed/debug remain technical projections, never unfiltered diagnostics. Read-only Assessment final-text presence protects missing final. Only ACP presentation, its pass-through call sites and read-only execution fact changed; model output/native activity, coordination and bounded delivery are intact. R2.7 uses existing R1 deterministic comparator with `--r2` and 3-round modes/clients; exact final-SHA run owns the measurements. R2.8 docs and A116–A122 updated. [Full code + comparator CI 44551217099](https://github.com/apathoid/role-orchestrator/actions/runs/44551217099) SUCCESS at `0aeacb1` (557 root/14 PTY/full Nix). Compact direct/parallel/intense own messages fall 4→2, 10→8, 13→11; benchmark details in STATUS. Final evidence-doc-only SHA must be verified separately. Real authenticated Zed and second client UNVERIFIED. [STATUS](STATUS.md). No master merge.

## C15R-GUI-R1 — ACP presentation fidelity corrective (ENGINEERING GREEN; native UNVERIFIED)

Review baseline `9cb5bc9eec05ee95292a5c52a21534148f3c3cc4`; four precise corrective changes in `src/hosts/presentation.js` only: shared typed event selection in ACP debug, plain-text notices rather than Markdown-escaped notices, indented fixed-field RO finding projections, truthful requested route labels. Regression tests extend A117–A120 without new IDs. RED [44528875854](https://github.com/apathoid/role-orchestrator/actions/runs/44528875854), GREEN code [44530205461](https://github.com/apathoid/role-orchestrator/actions/runs/44530205461); deterministic exact planning-SHA bounded transport comparator in mandatory CI including overflow/gaps/latency. Final docs/code SHA needs an independent full CI. No Markdown parser, provider/core/Coordinator/CLI change or native ACP reconstruction. Zed and second real client remain UNVERIFIED. [STATUS](STATUS.md).

## C15R-GUI — Graphical ACP Presentation Refinement (ENGINEERING CI PASS; native UNVERIFIED)

Baseline `420358abeea67a4cf40cfb7ae4fa433cd34914e9` on `feature/interactive-ux`. GUI.0 protocol/SDK v1 review and existing client limitations documented; native Zed unobserved. GUI.1 actual Controller typed native `plan` forwarded in compact/detailed/debug; GUI.2–GUI.5 compact factual ACP-only progress, genuine role/profile/attempt attribution, recorded model claims without Host confidence/verification and safe fixed escaping of RO-owned copies; **no Markdown builder** or model text modification. GUI.6 keeps existing bounded transport, history, terminal/cancel/permission and input ownership unchanged. GUI.7 new unit/SDK coverage plus existing C13–C15R suites; full [CI 44519422152](https://github.com/apathoid/role-orchestrator/actions/runs/44519422152) SUCCESS on `c0299bec` (546 root, 14 Linux PTY, Nix/package/release). Native Zed rendering remains separately UNVERIFIED; any later documentation SHA has its own independent CI. GUI.8 status/spec/decisions/changelog updated. [Current operational evidence](STATUS.md); [approved boundaries](C15R_GUI_GRAPHICAL_ACP_PRESENTATION.md); [A116–A122](../../tests/ACCEPTANCE_MATRIX.md). No master merge.

## C15R-UX-P1 — terminal-only transcript outer spacing

Baseline `8117f51ca402b074dcbd2fa13947145684f8d8de`. P1.0–P1.6 implemented as a presentation-only refinement: `cli-layout.js` has one incremental terminal margin policy (2/1/0 columns depending on credible TTY width, unknown width fallback 1); `cli-input.js` applies it once to native progress/input/streaming Writable output, readline adds its own prompt prefix, and `cli.js` decorates only the final human TTY stdout after Markdown rendering. No new model semantics, wrapping engine, ACP output changes, permission grants, or scheduler. Existing A101/A103/A105/A107/A114 cover this layout and regressions; no new acceptance IDs required. Full [CI 44339483661](https://github.com/apathoid/role-orchestrator/actions/runs/44339483661) **SUCCESS** on implementation `619f907dc73697081e4ab77f6a944f18f21bed78` (540 root, 14 Linux PTY, Nix), while the docs-only final SHA needs separate CI. Native installed provider/Zed remains UNVERIFIED. Source provenance and limitations: [STATUS](STATUS.md). No master merge.

## C15R-UX-R2F — native choice display receipt corrective

Baseline `84b5570ea95deac90a871cdca7418b387980b14b`. R2F.0–R2F.5 engineering completed as a narrow CLI input follow-up: the initial native permission/form view, `nextForm()`, `:back` and `:choices N` admit numeric positions only when a successful terminal Writable callback confirms that page and the original request/field generation is still current. A bounded per-request page history, exact provider IDs and broker authority are retained. Seven controlled-Writable integration regressions, 12 real Linux PTY and existing input historical comparisons are covered by A110/A114. No change in Controller/native provider/tools or operation timeout. Exact implementation SHA `2dc1d2a433615dbb8d39ada08f1b6c42101c7475` [CI 44282977384](https://github.com/apathoid/role-orchestrator/actions/runs/44282977384) PASS (535 root/12 PTY/full Nix); a docs/CI-restoration final SHA requires its own CI. Native model/Zed A115 remains UNVERIFIED; current evidence and boundaries [STATUS](STATUS.md). No master merge.

## C15R-UX-R2 — final CLI corrective follow-up

**Baseline:** `8c0e056a279442ff83231af1fc53631d13f4c290`. Адресные R2.0–R2.6 реализованы после повторного review: отсечение невидимых числовых permission/form choices с bounded per-request history, exact native IDs без замены grant/ACK, `PERMISSION_UNAVAILABLE` mapping, fixed-key bounded `:details` с честным partial metadata disclosure и Unicode-safe clipping. RED [CI 44265635274](https://github.com/apathoid/role-orchestrator/actions/runs/44265635274); **GREEN** [CI 44267481834](https://github.com/apathoid/role-orchestrator/actions/runs/44267481834) на `5bb46f79cdf9d439933704741faf05d659e612ed` (528 root, 12 real Linux PTY, full Nix/package/release). Нормативные критерии уже в [A109/A110/A112/A114](../../tests/ACCEPTANCE_MATRIX.md), новых acceptance IDs нет. Actual installed provider/Zed A115 и историческая native-приёмка UNVERIFIED, процедура в [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md); текущий статус в [STATUS](STATUS.md). Никаких дополнительных Host workflow/Controller semantics, core/provider/permissions changes и merge в master. Этот docs-only SHA требует собственной CI проверки.

## C15R-UX-R1 — корректирующая инженерная работа

Актуальные owner и acceptance: [STATUS](STATUS.md), [A109–A115](../../tests/ACCEPTANCE_MATRIX.md), [C15R-UX](C15R_UX_CLI_VISUAL_FIDELITY.md). Review baseline `d1f2133a961992dbf988721fdd5949078e5a95db`. RED [CI 44255128308](https://github.com/apathoid/role-orchestrator/actions/runs/44255128308) подтвердил четыре defects. Исправления ограничены CLI source/view/input, без Host semantics, ACP/schema/decision/permissions authority, scheduler или workflow. R1.1 broker outcome disclosure без request identity/ACK; R1.2 structured visual native fields/scopes; R1.3 нейтральный `completed`; R1.4 честный bounded preview `:details`; R1.5 immediate generic pending; R1.6 regression/PTy/CI; R1.7 native acceptance/handoff или UNVERIFIED. Полный инженерный **PASS**: [CI 44257161408](https://github.com/apathoid/role-orchestrator/actions/runs/44257161408) на `1820ff700b8e25821597fe761bb52b1ba383cd4f` (514/514 root, 11/11 Linux PTY, mandatory Nix/package/release). Документационный follow-up получает отдельный SHA и требует отдельного CI. Следующее действие — установленный реальный provider/Zed A115 (UNVERIFIED); исторические native вопросы не закрыты. No master merge.

## C15R-UX — CLI Visual Fidelity & Markdown Rendering (ENGINEERING CI PASS, REAL NATIVE UNVERIFIED)

**Инженерная реализация:** [C15R-UX.0–.8](C15R_UX_CLI_VISUAL_FIDELITY.md) после baseline `9223fad4d9242bc131aaa3ecbef6e93d691ef02f` выполнена кодом/тестами. Полный mandatory CI [44186026545](https://github.com/apathoid/role-orchestrator/actions/runs/44186026545) PASS на `9480cb7fc642f4b4071d39e37ecd82fd7ea562eb` (505/505 root, 10/10 actual Linux PTY, Nix/package/release). После этой записи документация получает отдельный SHA с собственной CI-проверкой; реальная installed model/Zed приёмка A108 остаётся UNVERIFIED, а прежний A100 не закрывается. Safety follow-up `94c3b88475ae80de5f96f1117c0d8f3a44c03b6a` + `75410c365846d95b6d803187e0bb55bf3a5f2bfb`: bounded Markdown delimiter/line checks, TERM plain fallback, сохранение обычных `foo_bar`/`a*b`; весь код снова подтвердил **PASS** [CI 44187637516](https://github.com/apathoid/role-orchestrator/actions/runs/44187637516) на `7b5a29faf523ffe1652cfaa2f55f4a8b23576254` (505 root, 10 PTY, complete Nix). Следующий шаг после его подтверждения — native-приёмка, не новый Host workflow.

| Шаг | Исполнимый результат |
|---|---|
| C15R-UX.0 | HEAD/CI/current source owners, RED full-transcript baselines, immutable output/input/provenance boundaries |
| C15R-UX.1 | Minimal trusted text segments; **фиксированный Controller accent**, все неизвестные заранее Worker roleId → стабильный цвет палитры, без hardcoded role names |
| C15R-UX.2 | Человеческие original native questions/permissions, отдельные accent/neutral/meta/prompt/footer, exact values/ACK/authority |
| C15R-UX.3 | Лаконичные реальные source headers, streaming Thinking и независимые Workers без artificial plan/grouping |
| C15R-UX.4 | Identity-aware compact tools, debug-only raw lifecycle codes, truthful status/gap/unknown; no event loss/guessed success |
| C15R-UX.5 | Safe Markdown formatting **только** `Assessment.answer` в human TTY; unchanged raw/machine/JSON/ACP; final once |
| C15R-UX.6 | Model-authored findings, factual snapshots и honest final summary без Host semantics |
| C15R-UX.7 | Regression/golden/real PTY/performance/execution equivalence/full exact-SHA CI; non-Git/arbitrary roles/tools |
| C15R-UX.8 | Native visual acceptance or UNVERIFIED, docs/handoff, explicit unclosed native obligations |

**Приёмка:** [A101–A108](../../tests/ACCEPTANCE_MATRIX.md). Ни один новый тест не считается выполненным на основании CI C15R.6R. Без master merge; нормативные docs только если изменился внешний contract. Доступ к skills/native tools и environment discovery не ограничивать ради renderer.

## C15R.6R — corrective technical completion (engineering verified; real native UNVERIFIED)

Baseline `804bbaa24f606dc5be79a27db303489dda1dd27f` and review `0bd01ccca8eb1740805af5d04aed6cbced5b3d60` (historical CI 43970858896 PASS, 497 root / 9 PTY). C15R.6R.0–.6 and narrow C15R.6R-Final cancellation correction completed on `8b9be91a96f4657dd861647da13808f86f548e93`: [CI 44035000221](https://github.com/apathoid/role-orchestrator/actions/runs/44035000221) PASS, 500/500 root and 9/9 PTY, full Nix/package/release. Scoped fix: native form `:cancel`/`:decline` are accepted during asynchronous provider-regex validation, abort the technical worker and ignore late outcomes without changing external correlation or other pending requests. [C15R.6R contract](C15R_PRESENTATION_QUALITY.md), [STATUS](STATUS.md) and sole [acceptance matrix](../../tests/ACCEPTANCE_MATRIX.md) have actual evidence. A94–A99 engineering PASS; A100, A93/A86/A81 and F4/C12/C13/C14/C13R/C14R native visual/comparative UNVERIFIED. **Historical C15R.6R handoff:** separate installed real-provider/client native acceptance remained open. New approved engineering work is now C15R-UX (above); C15R.6R itself has no pending engineering fixes.

## C15R.6 — CLI Interaction Safety & Presentation Refinement (engineering PASS on 804bbaa2; native UNVERIFIED)

[Исполнимый corrective plan C15R.6.0–.7](C15R_PRESENTATION_QUALITY.md). Approved architecture review 2026-11-16: natural native questions/forms and unambiguous permissions without new Host semantics, forms framework, capability restrictions, forced workflow or artificial execution environment. Exact current step and baseline in [STATUS](STATUS.md). Earlier C15R engineering/CI is historical and remains valid only for its original implementation SHA; C15R.6 original implementation and its corrective follow-up are verified on the exact SHAs above; real native acceptance is separate.

| Шаг | Обязательный результат |
|---|---|
| C15R.6.0 | Current HEAD/pinned ACP 2.4.0 contract, original payload if available, red SDK and actual PTY evidence |
| C15R.6.1 | P1 permission selection and active-input/request binding; deadline/reconnect/observer safety |
| C15R.6.2 | Thin human-readable native forms, strict original values/types, safe fallback, no capability regression |
| C15R.6.3 | Readline + thinking logical continuity with independent Worker streaming |
| C15R.6.4 | Readable append-only sources/tools/findings/final, safe bounded presentation-only caches |
| C15R.6.5 | ACP legacy history fallback for known partial/unassociated turn records, no chronology inference |
| C15R.6.6 | New acceptance tests + full CI, runtime invariant audit and same-input deterministic overhead |
| C15R.6.7 | Real installed CLI/Zed/native/comparative acceptance or precise UNVERIFIED; separate changed diagnosis and handoff |

Implement sequential logical checkpoints; do not stop after baseline. Single existing [acceptance matrix](../../tests/ACCEPTANCE_MATRIX.md) gains actual new coverage during implementation, not speculative PASS now. Native tasks are documented in [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md#c15r6--native-corrective-re-acceptance-planned). Existing A86 and earlier real-world obligations stay UNVERIFIED. No master merge without explicit request.

## C15R — Presentation Quality & Fidelity (engineering complete; native re-acceptance)

[Детальное задание C15R](C15R_PRESENTATION_QUALITY.md). Review baseline `0aee345c9833ec741b6cd8e622c39c1c7c6b88ce`; C15 engineering PASS, compact visual acceptance NOT ACCEPTED. Ветка feature/interactive-ux. Следующий шаг исключительно по [STATUS](STATUS.md).

| Шаг | Обязательный результат |
|---|---|
| C15R.0 | Baseline, red native-tool fixture, full transcript contract |
| C15R.1 | Bounded CLI tool identity projection, sparse updates and distinct modes |
| C15R.2 | Rich append-only source/Thinking/tool/finding/interaction blocks, actual PTY |
| C15R.3 | Authoritative answer first on shared human terminal, truthful counts/summary |
| C15R.4 | ACP history outcome classification/provenance fidelity, existing journal |
| C15R.5 | Full regression/CI, measured overhead, native re-acceptance or explicit UNVERIFIED; separate changed diagnosis |

No model prompt/Decision/context/evidence/routing/scheduling/permission/native tool/skill changes; no second lifecycle, journal or virtual environment. Native ACP mapping and inline default unchanged. A82–A85 engineering PASS, A86 native/comparative UNVERIFIED; exact SHA/CI in STATUS. C15R does not close earlier native obligations. Logical commits and STATUS per checkpoint; no merge master.

## C15 — Rich Presentation & ACP Transcript (исторический engineering handoff)

[Детальное задание C15](C15_PRESENTATION_EXPERIENCE.md). Ветка feature/interactive-ux, prerequisite C13/C14/C13R/C14R engineering handoff выполнен; native/comparative obligations остаются открыты. Следующий шаг исключительно по [STATUS](STATUS.md).

| Шаг | Обязательный результат |
|---|---|
| C15.0 | Baseline, actual sources, transport mapping и acceptance contract |
| C15.1 | Minimal scoped presentation facts, historical route/source identity |
| C15.2 | Rich CLI streaming, safe styles, grouping, tools/findings/final |
| C15.3 | CLI interaction UX, existing single input owner, no live status line |
| C15.4 | Standard ACP inline progress default, native client widgets unchanged |
| C15.5 | Chronological ACP transcript history via session.requests and journal |
| C15.6 | Full regression, resource bounds, architecture audit, CI |
| C15.7 | Actual CLI/Zed native/comparative acceptance or explicit UNVERIFIED, handoff |

Presentation-only; no model prompt/Decision/context/evidence/dispatch/scheduler changes, no Host semantic inference, no native tools/skills/environment restriction, no second execution journal. Inline is default immediately; explicit notices compatibility; preserve dynamic native plan. No live status line/REPL. History is user presentation, not model context. Native unavailable does not block engineering; existing F4/C12/C13/C14 obligations remain. No merge without separate instruction.

## C13 / C14 — Interactive protocols and client UX (новая ветка)

**Инженерный handoff завершён; реальные native/comparative обязательства открыты (см. STATUS). Ветка:** `feature/interactive-ux`, ответвлена от master merge PR #2 (`50cffa4f0ab4151871beb36529be27e33f2c1d11`). Следующий шаг исключительно по [STATUS](STATUS.md). Два последовательных инженерных кластера, не runtime workflow; реализация на этой ветке, master не изменять без отдельного поручения.

| Шаг | Обязательный результат |
|---|---|
| [C13.0](C13_INTERACTION_PROTOCOLS.md#c130--baseline-карта-возможностей-и-проверяемые-решения) | Actual baseline, SDK/transport matrix, доступные F4 baseline probes |
| C13.1 | Минимальный Model Activity Stream, независимый от execution |
| C13.2 | Достоверные capabilities, generic ACP relay в adapter/Host |
| C13.3 | Native activity без изменения result parser / evidence |
| C13.4 | Correlated interaction, authority, timeout, prompt lifetime |
| C13.5 | Bounded delivery, local control, redaction |
| C13.6 | Полная автоматизированная регрессия, архитектурный audit, docs |
| C13.7 | Native/comparative acceptance или явный UNVERIFIED, handoff |
| [C14.0](C14_CLIENT_UX.md#c140--ux-baseline-и-transport-mapping) | UX mapping, точные flags/defaults, проверка C13 contract |
| C14.1 | Общая минимальная presentation mapping без семантической интерпретации |
| C14.2 | Интерактивный CLI, TTY/headless, existing owner endpoint |
| C14.3 | Графические ACP-клиенты через стандартный протокол |
| C14.4 | Полная регрессия, packaging, docs и UX compatibility |
| C14.5 | Реальный CLI/ACP и comparative quality/performance либо UNVERIFIED |
| C14.6 | Финальная передача с независимыми статусами готовности |

**Детальные задания:** [C13 Interaction & Model Activity Protocols](C13_INTERACTION_PROTOCOLS.md) и [C14 CLI & Graphical Client UX](C14_CLIENT_UX.md). C13 полезен без renderer, C14 только потребитель. Сохранять model-first, provider/workflow/environment-agnostic, native tools/skills/scripts, existing permission, Decision/Outcome, evidence, one scheduler/lifecycle. Без OS/FS/host isolation, жёстких проверок идентичности workspace/model, обязательного reporting, реконструкции пропущенных событий, новых модельных ходов или host semantic logic. Техническая correlation/authority остаётся scoped к живым запросам и ресурсам. Active-time accounting условно и вне обязательного scope. Live public messages/findings только при подтверждённом отдельном канале; fallback native thinking и accepted findings. Не откладывать независимые Workers из-за UI/transport.

C12R.10R F4 и прежние native obligations **не закрыты**: попытка baseline probes в C13.0, доступные повторные comparative probes в C13.7/C14.5; unavailable остаётся UNVERIFIED без блокировки engineering implementation. При material regression исправить до handoff, не считать native readiness по fixture CI. Каждый шаг отдельным коммитом, status/evidence в STATUS, матрица одна. До C14 требуется C13 engineering regression verified. 

## C13R/C14R — corrective follow-up

[Interaction Reliability & Presentation Completeness](C13R_C14R_INTERACTION_RELIABILITY.md): C13R.0–.4, C14R.1–.6 and narrow final review corrections C13R.4R/C14R.5R, full regression/audit and native disposition (A67–A76). Addressed defects only, no new runtime workflow. STATUS determines next step. Existing C13/C14 verified baseline and open F4/C12/native obligations retained.

## C12R — корректирующий этап и приёмка

**Актуальный следующий шаг определяется [STATUS](STATUS.md).** Единый детальный план: [C12R — стабилизация](C12R_STABILIZATION.md). C12R устраняет подтверждённые дефекты нативной эксплуатации до окончательной приёмки C12; это корректирующий инженерный этап, не новый runtime workflow.

| Шаг | Назначение |
|---|---|
| C12R.0 | Baseline, evidence, воспроизведение дефектов |
| C12R.6.0 | Instruction scope и фактическая доставка skills |
| C12R.1 | Независимость Controller/Workers, fairness и recovery |
| C12R.2 | Reasoning provenance |
| C12R.3 | Адресная диагностика |
| C12R.4 | Context/evidence/findings |
| C12R.5 | ACP, частичные observations и lifecycle ресурсов |
| C12R.6.1–6.4 | Проверка и точечная оптимизация модельной координации |
| C12R.7 | Регрессия, native acceptance и сравнение качества |

Порядок инженерный, может уточняться по зависимостям; статус каждого шага и фактические результаты — только в [STATUS](STATUS.md). Каждый самостоятельный шаг отдельным коммитом. Context compaction и изменение native skill discovery исключены. После инженерных исправлений сохраняются незакрытые C12.3/C12.4 и native NixOS acceptance.

## C12R.8 — новая корректирующая диагностика и условные исправления

[**Детальный инженерный план C12R.8**](C12R8_RELIABILITY.md) исполнен в подтверждённом инженерном scope: C12R.8.0 проверил доступный baseline, C12R.8.1–.6 условно оценены (runtime изменение обосновано только для рекомендаций optional retrieval; инфраструктурные лимиты отдельно протестированы), C12R.8.7 завершён автоматизированной регрессией. Подробности, коммиты и CI provenance — в [STATUS](STATUS.md). Это не новый runtime workflow и не автоматическое переоткрытие закрытых C12R.4/.5/.6/.7.

Реальная native acceptance [C12.3/C12.4/C12R.7/NixOS](NATIVE_ACCEPTANCE.md) по-прежнему не закрыта. Текущее выполнение, проверки и оставшиеся gaps — только в [STATUS](STATUS.md).

## C12R.8R — адресные исправления по ревью

На актуальном implementation HEAD `4c3f324e11b8d7ab851f893bafcbd492fd03f26d` завершена доступная инженерная часть [C12R.8R](STATUS.md): восстановлена post-execution MCP provenance при response overflow, исправлен byte check полного JSON-RPC envelope и non-finite id, проверены общий tool/history budget, bounded cache, cancellation/late receipts, durable reopen и optional direct Controller без retrieval. **CI 324/324 PASS**; реальный Zed/ACP, независимые модели, native NixOS и качество сравнительных retrieval A/B прогонов остаются UNVERIFIED. C12R.8R не меняет обязательные runtime workflow, Host semantics, permissions или лимиты.

## C12R.9 — обязательные исправления непрерывности контекста

**Исторический план C12R.9.0–.7 реализован; текущая готовность и review-fixes определяются [STATUS](STATUS.md).** [**Нормативный инженерный план C12R.9**](C12R9_CONTEXT_CONTINUITY.md) определяет обязательные результаты (а не гипотетические возможности). Предыдущие шаги C12R.0–.8R инженерно закрыты в доступном scope, реальная native acceptance остаётся открытой.

| Этап | Обязательный результат |
|---|---|
| C12R.9.0 | Воспроизвести loss/duplication/size проблемы на synthetic fixtures, зафиксировать actual baseline |
| C12R.9.1 | Удалить технически доказанную повторную inline-доставку одного результата, сохранив raw history |
| C12R.9.2 | Разделить бюджеты Controller/handoff/fetch/capture/skills/tools, default Controller = 256 КиБ, убрать отдельный фиксированный 128-record guard и ограничить dynamic technical context |
| C12R.9.3 | Добавить компактную **производную**, не persisted, карту Action→Attempt→Outcome→refs и разнести terminal completion/effect uncertainty |
| C12R.9.4 | Сохранить MCP ContextPort и добавить **необязательный модельный** запрос refs/cursor в обычном `nextController` для случаев без retrieval tools; не создавать новый host index или workflow |
| C12R.9.5 | Уточнить Host Catalog vs native skills, не сканируя проект и не ограничивая provider-native tools |
| C12R.9.6 | Добавить техническую диагностику реальной границы доставки, без сбора bodies по умолчанию |
| C12R.9.7 | Полная регрессия, comparative native acceptance (либо честный UNVERIFIED), документация и STATUS |

**Границы:** Model-first, provider-agnostic, unconstrained native execution в пределах настоящих permissions, отсутствие фиксированных workflows, Host compaction/summary/relevance scoring, нового indexed store, второго scheduler, Host файлового runtime, обязательного MCP/Worker/Controller turn или persistent native session. Эти шаги — этапы инженерной реализации, не новые runtime stages. Бюджеты по фактическим техническим ресурсам и все ссылки/исходные наблюдения сохраняют provenance. Сначала проверка на fixture, затем минимальное адресное изменение; новые возможности реализуются только для воспроизведённого случая, который не устраняется одной корректной inline-доставкой.

**Историческая запись плана: первоначально runtime implementation не начиналась; C12R.9.0–.7 затем реализованы.** NATIVE C12.3/C12.4/Zed/NixOS и comparative quality остаются UNVERIFIED. Действующие результаты и следующий шаг — только в [STATUS](STATUS.md).

## C12R.10 — устойчивость модельного интерфейса Controller

[**Детальный план C12R.10**](C12R10_CONTROLLER_CONTRACT.md) — новый адресный инженерный этап по результатам пользовательских native runs. Текущий следующий шаг и фактическая готовность — [STATUS](STATUS.md). Не переоткрывает C12R.9 без нового воспроизводимого дефекта.

| Этап | Обязательный результат |
|---|---|
| C12R.10.0 | Synthetic baseline, воспроизведение противоречий Decision и технических отказов; без prerequisites реальных моделей |
| C12R.10.1 | Единое актуальное представление Decision v1, точные поля/cursors, валидные структурные примеры |
| C12R.10.2 | Разделить итог пользователя и transport envelope, сохранить native tools и Worker format |
| C12R.10.3 | Краткая адресная parsing/validation диагностика, строгий отказ без ремонта, сохранение effects/recovery |
| C12R.10.4 | Точное объяснение Host Catalog rejection, независимость native capabilities |
| C12R.10.5 | Проверка архитектурной нейтральности, permissions, выразительности и C12R.9 invariants |
| C12R.10.6 | Адресные/полные регрессии, CI, документация, engineering handoff |
| C12R.10.7 | Отдельное локальное comparative native acceptance после инженерного завершения, либо UNVERIFIED |

**Границы:** model-first, provider-agnostic; нет Host semantics, read/write классификации, FS/OS isolation, новых workflow, discovery native окружения/skills, JSON repair, обязательного MCP/делегирования/проверок, изменения Decision schema/lifecycle или defaults budgets. Технические гарантии и реальные permissions сохраняются. Этапы относятся к разработке продукта, не к выполнению задач. Реальные LLM, OpenCode, llama.cpp и Zed не запускаются в GitHub Actions и не блокируют .0–.6; параметры native runs фиксируются только для последующего локального эксперимента. Существующие C12.3/C12.4/C12R.9/NixOS native obligations остаются открыты.

## C12R.10R — точность transport contract и прозрачность нативного исполнения

[**Детальный план C12R.10R (§12 существующего плана C12R.10)**](C12R10_CONTROLLER_CONTRACT.md#12-c12r10r--уточнение-transport-contract-и-прозрачность-native-execution) — адресное инженерное продолжение C12R.10 перед продолжением локальной native acceptance. Следующий шаг — [STATUS](STATUS.md). Не новый runtime workflow.

| Этап | Обязательный результат |
|---|---|
| C12R.10R.0 | Actual baseline, границы адаптеров, evidence и пробелы покрытия |
| C12R.10R.1 | Компактный submission/admission/dispatch contract, без предписания workflow |
| C12R.10R.2 | Scope tools.bridge и независимость native tools/skills/environment |
| C12R.10R.3 | Точная семантика optional retrieval и Host lifecycle, неизменные cursors |
| C12R.10R.4 | Уточнение вложенных/optional полей Decision v1, без schema change/repair |
| C12R.10R.5 | Реальные ACP/CLI adapter wire regressions, preservation tests |
| C12R.10R.6 | Полная доступная инженерная проверка, docs, STATUS, handoff |
| C12R.10R.7 | Локальное дополнение к C12R.10.7, реальная сравнительная приёмка или UNVERIFIED |

Границы C12R.10 сохраняются. Не предполагать наличие конкретного workflow, провайдера, инструментов или окружения; Host не подменяет нативного исполнителя и модель. Production changes преимущественно в existing decision-instructions/controller-context; adapter/runtime change только при доказанном адресном дефекте. Тестовые subprocess fixtures не являются production mechanism. Реальные LLM не блокируют .0–.6 и не запускаются в GitHub Actions.

## C12R.10R follow-up — Evidence Attribution and ACP Teardown

[Детальный план §13](C12R10_CONTROLLER_CONTRACT.md#13-c12r10r-follow-up--evidence-attribution-and-acp-teardown); следующий шаг — [STATUS](STATUS.md). Локальное инженерное исправление, не новый runtime workflow и не переоткрытие завершённых этапов. 

| Шаг | Назначение |
|---|---|
| F0 | Актуальный baseline, адресное воспроизведение |
| F1 | P2: корректная Host provenance в matching Outcome refs |
| F2 | P3: ACP intentional close и teardown/cancellation diagnostics |
| F3 | Регрессии, docs, STATUS и engineering handoff |
| F4 | Продолжение существующей C12R.10R.7 / C12R.10.7 native acceptance |

Сохранять trusted attribution/exit/attempt identity, реальный transport failure, ownership/SIGKILL, deadlines/detach, model-first/provider/workflow/environment-agnostic. Никаких новых обязательных runtime проверок, retrieval, permissions, изоляции или Controller schema/prompt/scheduler изменений. Реальные LLM не обязательны для CI. 

## C12 — реализованные инженерные шаги и открытая приёмка

| Шаг | Содержание | Завершение |
|---|---|---|
| C12.0.1 | Baseline и карта old path → new disposition | Завершён, commit d9645c5 |
| C12.0.2 | Консолидация текущих продуктовых контрактов | Завершён, commit 87b79a1 |
| C12.0.3 | Активный roadmap, status, матрица, changelog | Завершён, commit 1d9963d |
| C12.0.4 | Инструкции .agents/ и AGENTS.md | Завершён, commit ad9fdba |
| C12.0.5 | Перенос tests/fixtures/scripts, npm/checkJs | PASS run 42878217644 |
| C12.0.6 | Обязательный CI и locked Nix/npm | PASS run 42878217644 |
| C12.0.7 | Установленная поставка без dev tools | PASS run 42878217644 |
| C12.0.8 | Удаление legacy development/, полная регрессия/handoff | PASS run 42878217644 |
| C12.1 | Трассировка R01–R33 ↔ A01–A54 ↔ tests/evidence | Выполнено, CI source 1341d75 |
| C12.2 | Clean full regression | PASS 302/302, run 42878217644 |
| C12.3 | Два реальных независимых исполнителя, CLI/ACP | Протокол готов; **real native UNVERIFIED** |
| C12.4 | Настоящий Zed/ACP, session/load/permissions | Протокол готов; **Zed native UNVERIFIED** |
| C12.5 | Mutable workspace acceptance | PASS automated, real provider UNVERIFIED |
| C12.6 | Clean installation outside checkout | PASS npm/Nix synthetic, run 42878217644 |
| C12.7 | Архитектурный audit | Static paths reviewed; no reproduced defect |
| C12.8 | Release комплект/changelog/diagnostics | PASS reproducible npm artifact / SHA-256 |
| C12.9 | Nix/NixOS/CI acceptance | PASS Linux CI/NixOS eval; native boot UNVERIFIED |

Полные критерии C12.0.1–C12.9: [C12 acceptance and delivery](C12_ACCEPTANCE_DELIVERY.md). Не отмечать недоступные native пробы как PASS; implementation, regression, native readiness различаются. Каждый шаг отдельным коммитом и фактическим обновлением STATUS.

## Нативные блокеры финальной приёмки

C12.0–.2 и C12.5–.9 имеют отдельные implementation commits и обязательные CI, но **C12 как целое не закрыт**: C12.3 требует двух независимых реально работающих моделей/провайдеров, C12.4 — живой Zed/ACP-клиент; реальная NixOS эксплуатация тоже не проверена. Детальный безопасный план выполнения: [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md). После получения доказательств обновить единственную [матрицу](../../tests/ACCEPTANCE_MATRIX.md) и [STATUS](STATUS.md), повторить clean full CI. Нельзя преобразовывать UNVERIFIED в PASS из GitHub Actions fixtures.
