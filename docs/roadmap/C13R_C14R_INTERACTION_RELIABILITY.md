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
