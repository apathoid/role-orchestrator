# C13R / C14R — Interaction Reliability & Presentation Completeness

Corrective follow-up only, baseline `31bfc6ee3e43149a6d155aecb9e9670bb8d61424`. See [STATUS](STATUS.md) for exact execution evidence, [C13](C13_INTERACTION_PROTOCOLS.md), [C14](C14_CLIENT_UX.md), [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md), [single matrix](../../tests/ACCEPTANCE_MATRIX.md). No changes to model semantics, prompts, context, coordinator, grants, budgets, native environment or active-time accounting. No replay of unknown effects.

## C13R.0 — baseline

GitHub compare of review SHA and feature/interactive-ux: identical. CI [43651466835](https://github.com/apathoid/role-orchestrator/actions/runs/43651466835) job 132620692113 SUCCESS on exact baseline; 432 root + 2 PTY, all Nix/package/lock checks. Local Node 22.16.0, git 2.47.3, no nix/codex/codex-acp/opencode/zed, GitHub DNS unresolved, no OPENAI_API_KEY/ANTHROPIC_API_KEY (presence only). Native and comparative UNVERIFIED; F4/C12/A61/A66 remain open. Connector Git tree/commits and CI available.

| Step | Finding and evidence at baseline | Minimal correction / acceptance |
|---|---|---|
| C13R.1 | SUPPORTED: main/cli.js shown retains id after rejected or lost answer, swallowed polling errors | local transport delivery states; pending recheck, report uncertainty, no automatic new answer; actual socket fixtures |
| C13R.2 | SUPPORTED: local-control reconnect returns key but never reattaches cliOwner; duplicate request can receive key | existing token + original answer binding, original interactive capability, detach/reconnect future requests; no dispatch |
| C13R.3 | SUPPORTED: delivery.close discards queued items/gap; ACP stopDisplay before final; review reproduced separately | bounded presentation finish vs immediate close, no provider/slot wait; direct/attached/ACP fixtures |
| C13R.4 | SUPPORTED: capturePrefix is parser input, STDOUT_LIMIT protocol error; review observed long stream failure | incremental bounded frame parse independent of capture; bounded execution state and explicit evidence omission; subprocess before/after |
| C14R.1 | SUPPORTED: anonymous thoughts lose attempt identity, Codex summary loses item id | pinned SDK _meta probe, preserve native IDs and existing source identity, no invented message boundaries |
| C14R.2 | SUPPORTED gap: route returns session for old operation; GUI misattribution HYPOTHESIS | actual SDK concurrent A/B/return-A probe; preserve scoped source where contract allows, no blanket rejection |
| C14R.3 | SUPPORTED: repeated Thinking header | immediate consecutive native fragments same source, newline on switch/input; PTY/golden |
| C14R.4 | SUPPORTED repeated full reads; material cost UNVERIFIED | measure calls/bytes/cache; minimize only proven overhead, no parallel index |
| C14R.5 | SUPPORTED: raw final TTY stdout | sanitize human TTY only; JSON/redirect/transcript unchanged |
| C14R.6 | SUPPORTED omission; independent standard notice channel UNVERIFIED | inspect pinned SDK, actual probe; no synthetic events, optional extension only if negotiated and useful; otherwise explicit limitation |

Separate commits and STATUS checkpoints. Engineering exit: full current SHA CI, address findings or document evidence for no change, matrix updated, native/comparative probes or exact UNVERIFIED. No merge.


## Implementation checkpoints

| Step | Commit(s) | Addressed regression and disposition |
|---|---|---|
| C13R.0 | `1b5be0fe` | Exact review baseline CI; source-supported defects, no later baseline changes |
| C13R.1 | `1db12a56`, audit follow-up | Actual socket reply accepted/rejected, pre-send failure, accepted/lost ack, timeout, parallel pending, polling failure, EOF without automatic retry. Pending disappearance never implies acceptance. |
| C13R.2 | `c25dd539`, audit follow-up | Socket disconnect/old key reconnect/new request, old reply rejected, observer denied key, presentation vs interactive capability separate. Existing live work binding only, no dispatch/replay. |
| C13R.3 | `3196b1eb`, audit follow-up | Bounded delivery finish vs immediate close; ordered queued completion, pending gap, blocked/throwing consumer, no reconstruction, final independent. ACP/CLI/socket tests. |
| C13R.4 | `4540b1dd`, `7f8231c3`, audit follow-up | Actual long Codex subprocess with >1 MiB reasoning/tool events and terminal result, malformed/oversize/incomplete/missing terminal/nonzero exit regressions retained. Raw capture independent; bounded execution facts and latest declared result/error slots; explicit omitted evidence and declined command count. |
| C14R.1 | `b86f5e86` | Standard ACP _meta source, no invented anonymous messageId; scoped native IDs, Codex item ID, actual SDK/golden tests. |
| C14R.2 | `1e83005b` | Actual SDK A clarification/old Worker and B prompt concurrently, permission/form/FS/extension request+notification, B result and return to A; typed permission/form source metadata. Opaque extension contracts unchanged. |
| C14R.3 | `67b60358` | Golden adjacent native text fragments and actual Linux PTY parallel Worker+permission. No semantic grouping/aggregation. |
| C14R.4 | `0c4e1502` | Measured representative fixture and removed repeated full presentation reads. Existing bound action/kind and committed finding records; no persisted UI index. |
| C14R.5 | `97be9d4d` | Actual PTY final/clarification controls removed; redirected/JSON original text preserved. |
| C14R.6 | `f80faa1f` | Standard SDK 2.4.0 session/update notice negotiated by client session.notices. Actual capability on/off and accepted finding/lifecycle/load/new prompt. No custom extension or new message history. |
| Audit | `79e9bb7a`, `09b2babe` | Callback failure unconfirmed; no terminal replay; original input binding independent from mode, input-only CLI, EOF no retry, immediate ACP display stop; late declined evidence and slow/fast modes. |

**C14R.4 measured OBSERVED**: CI [43687881957](https://github.com/apathoid/role-orchestrator/actions/runs/43687881957), integration/root suite at `0c4e1502`, 32 full inspect calls / 35,138,688 serialized bytes vs 3,276 bytes of committed finding facts; heap delta 71,628,968 bytes, wall 728.74 ms (single synthetic fixture run; heap GC-dependent, not native model measurement). Replaced per-plan inspect with bound invocation kind; per-finding inspect with committed immutable records delivered only to scoped subscribers, not diagnostics sink or unscoped subscriber. No model context changes.

**C14R.6 transport finding**: pinned SDK v2.4.0 generated SessionUpdate union includes notice with title/description/severity/_meta. ClientCapabilities.session.notices is opt-in; notices explicitly not history. Use that standard route only on active prompt and only if declared. Typed request and update metadata preserves source; raw extension payloads remain opaque (session mapping only). No assumption about GUI rendering or out-of-prompt support. For clients without notices, accepted finding/lifecycle/gap remain available in CLI or explicit inspect, not fake native events. Explicit native public/live-finding channel still unverified.

**Limits**: 250 ms presentation-only finish; existing 128 / 1 MiB delivery bounds; 256 KiB Codex wire frame, 1 MiB raw stdout, 64 KiB stderr unchanged; bounded evidence prefix 1 MiB / 1024 frames and latest declared result/error slots. Evidence omission is explicit and does not claim completeness. No new provider/operation deadlines or slot accounting. No automatic answer replay/new reply after uncertain delivery; reconnect same live owner/request binding at most once, no restore of already settled input. No UI-driven model invocations.

**CI:** implementation checkpoint `f80faa1f1c87ada0079289407f94068691f475dc` [43688137847](https://github.com/apathoid/role-orchestrator/actions/runs/43688137847) full SUCCESS (445 root + 4 PTY, all mandatory checks). Final audit + docs implementation SHA `bd2c93333e1f1d7851ad4b2d5955236c4f43b89e` [CI 43688606063](https://github.com/apathoid/role-orchestrator/actions/runs/43688606063) SUCCESS, 448/448 root + 4/4 PTY, zero failed/skipped/cancelled, all locked/package/Nix/release checks. A67–A76 engineering PASS. See STATUS for final acceptance and native blockers.

**Native/comparative**: unchanged UNVERIFIED, no real model/client available in local environment. See [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md#c13rc14r--corrective-native-and-comparative-probes). F4/C12/A61/A66 remain open. No master merge.

**Actual baseline red reproduction:** extracted review SHA parser run locally against actual spawned child stream with same long reasoning/tool/final pattern: exit 0, 5,056,795 received bytes, 1,048,576 retained, 251 frames, no final message or turn.completed; PROTOCOL_ERROR/STDOUT_LIMIT line 252. This was a parser extraction, not native model/full baseline checkout. Corrected adapter actual subprocess integration passes with all consumer modes and explicit omission/late denial. Final CI repeats snapshot measure 35,138,688 vs 3,276 bytes, heap delta 70,872,080 bytes, wall 615.93 ms (fixture only). Engineering handoff complete; next review and actual native/comparative probes, no master merge.

## C13R.4R / C14R.5R — final narrow review corrections

Baseline `de839991ca65d580b78dced35ee732d01e20772c`, CI 43688894342 SUCCESS. P2: current 1024 evidence frame cap drops otherwise previously available small results; actual subprocess/journal/context red fixture, remove count cap if byte-derived bound sufficient, measure overhead, keep terminal/result/omission contracts. P3: CLI write success currently ignores actual failures; confirm only successful write callback, fail closed/throw/callback/stream error, bounded finish, best effort local messages without unhandled rejection. Separate implementation commits, exact SHA full CI, native UNVERIFIED unchanged.
