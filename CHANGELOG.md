# Changelog

Публичные изменения и основные продуктовые вехи (не журнал всех коммитов). Текущий operational status и доказательства исполнения — [roadmap STATUS](docs/roadmap/STATUS.md).

## Unreleased — C12–C18 integration and delivery

### C19 — Answer guidance (partial implementation; engineering/native UNVERIFIED)

- Clarify the actual user-facing `finalAssessment.answer` for Decision and ControllerIntent, including action/artifact outcomes and limitations; distinguish observation capture completeness from tool success. No change to answer decoding, admission or presentation. C20 is not implemented by this checkpoint.
- Add optional native event metadata from ACP tool events and Codex completed command records to existing observation capture, live and historical projection; no inherited or synthesized status. Preserve existing source identity, provenance, original body and retrieval choice. Engineering/native verification pending.

### C18N-R — External ToolPort and live discovery corrective fixes (engineering CI PASS at 0687a40; real native UNVERIFIED)

- Remove the hidden cumulative 32-call limit from the **registered** External ToolPort while retaining input/output sizes, permissions, cancellation, late receipts and source provenance; >64 real external invocations are now covered by integration regression.
- Make optional Controller preflight reuse invocation-scoped historical/live identity indexes and check only referenced entries, instead of copying/scanning every prior observation per correction; the authoritative Decision remains unchanged.
- Allow external tools to register names colliding with RO MCP built-ins, using existing deterministic aliasing; add `evidence_list.resumeCursor` and explicit omission/gap markers for oversized metadata so later captured observations remain discoverable.


### C18N — Live evidence discovery and ordinary MCP simplification (engineering CI PASS on 42293b6; real native UNVERIFIED)

- Introduce optional invocation-local `evidence_list/evidence_fetch` over already accepted observations with stable canonical refs, bounded paging/bytes, actual provenance and no early durability claim; historical context cursors are unchanged.
- Add nonblocking advisory reference preflight **after** proposal registration with independently copied reference indices. Controller correction stays in the same native turn; the final journal admission remains sole authority.
- Remove the cumulative 64 ordinary MCP calls limit and release completed ordinary request results. Concurrent same-ID calls remain correlated, but post-completion same-ID redelivery can run anew. Preserve strong `submit_decision` identity/last-wins/finality and durable unknown-effect handling.
- Alias all colliding built-in MCP tools instead of shadowing extension names; general evidence guidance does not restrict model strategy or provider-native tools. Add live-HTTP and ACP SDK regressions; actual independent-provider/native model verification remains separate.


### C18R — ControllerIntent corrective reliability (engineering CI PASS at `fab92fd037a0`; native UNVERIFIED)
- An independently completed MCP ControllerIntent survives auxiliary ACP observation-capture overflow while truncation remains visible and incomplete native text is never promoted to full evidence.
- Rejected explicit replacements from a known JSON-RPC request-ID conflict invalidate the selected lineage; successful same-turn correction remains available, and unresolved transport faults receive technical outcomes.
- External MCP tools named `submit_decision` remain reachable via dynamic collision-free control-tool naming reflected in the Controller prompt.
- Stronger original-attempt receipt identity and crash-gap/near-2-MiB/cancellation/namespace regressions. Real-model native quality and tool autonomy remain UNVERIFIED.


### C18 — ControllerIntent & deferred Controller admission (engineering verification pending; native UNVERIFIED)
- Opt-in model-owned ControllerIntent with trusted technical Decision v1 binding and unchanged single admission/journal. The old Decision v1 provider path remains the default.
- Negotiated ACP MCP `submit_decision` accepts proposal-only submissions, supports same-turn correction and explicit same-lineage last-wins after normal native completion. Text fallback works without a second invocation; native tools are not disabled.
- Bounded independent control-tool capacity and technical failure classification; added core/bridge/Operation/ACP subprocess regressions. Real model/provider performance and native skill/subagent behavior are not yet verified.

### C17R — Recovery delivery & diagnostic verification
- Reserve actual correlated recovery representation in the existing optional budget before default technical previews, preserve model-requested records/pages and original journal order.
- Optional adapter-owned parsed-source attestation; canonical fallback for unproven raw result refs. Extended persisted restart, correction, and late-result regressions.
- Trusted `diagnostics.promptCaptureMaxBytes` (UTF-8, default 16384, max 1048576); explicit serialized-record limits, private capture metadata and bounded actual NDJSON queue bytes. Diagnostics remain off for body capture by default.
- Expanded deterministic preparation/diagnostics and CLI/ACP regressions, two main native comparison scenarios; native quality and speed remain UNVERIFIED.

### C17 — Controller Context Efficiency & Decision Reliability (native effectiveness UNVERIFIED)
- Sectioned, literal Controller text prompt with one Decision reference, bounded history and separately identified active correction. Decision v1 parser/schema/admission and Worker transport unchanged.
- Receipt-bound rejected-result reference and distinct wire/declared representations support optional addressable recovery without forced retry/reuse or additional body storage. Passive payload/transport/usage observations and bounded private opt-in capture.
- Generic native optional text field affordance with explicit :skip; schema and broker-owned response remain unchanged. Compact CLI summary removes only equivalent terminal decorations and preserves cancellation progress and late/unknown outcomes.
- Baseline comparator and focused regressions; [engineering evidence and limits](docs/roadmap/STATUS.md), [native comparative procedure](docs/roadmap/NATIVE_ACCEPTANCE.md). No native speed/quality claim.

### C16 — Controller Reliability & Decision Recovery (native quality UNVERIFIED)
- Controller Invocation now identifies original and latest accepted user turns by immutable journal ContextItem references and positions. Initial `objective` and literal user messages retain their original text and provenance; Controller decides whether a new message is an answer, clarification, extra context or changed task.
- Rejected Decisions retain the actual parser/decoder/admission category and bounded technical diagnostics. Controller retry automatically enters existing local technical waiting on the fifth identical consecutive or tenth total invalid Decision during the accepted user turn, including crash-gap recovery without extra invocation allowance. Independent accepted Workers, native tools/skills and unknown-effect safeguards are unchanged.
- Model-facing Decision v1 transport reference shortened to one valid shape-only example; no runtime schema relaxation, synthetic planning, user intent classifier, forced workflow, provider-specific rules or active-operation steering. Synthetic tests and engineering CI status are in [STATUS](docs/roadmap/STATUS.md); real provider quality comparison and Zed are UNVERIFIED.

### C15R-GUI-R2F — preserve model partial/unresolved status in compact
- Compact `operation.finished` now omits a redundant notice only for a model-recorded `overall=complete` with nonempty answer. It still displays `partial/unresolved` as a model assessment even with a final response, and preserves known status alongside missing/unconfirmed final text.
- No change to detailed/debug, original `Assessment.answer`/Markdown, native ACP plan/Thinking/tool streams, unknown attempt effect, history journal, provider execution or permissions. Additional ACP updates only when significant model status needs to remain visible.
- Exact RED/GREEN SDK/session-history regressions and mandatory CI are recorded in [STATUS](docs/roadmap/STATUS.md); real Zed visual verification remains UNVERIFIED.

### C15R-GUI-R2 — compact graphical ACP transcript
- Avoid the UUID-heavy initial accepted line and routine completed/confirmed or no-effect attempts in compact; show source/role/profile and attempt retry identity on genuine dispatch. Preserve unknown effects, failed/unknown terminals, late/conflicting outcomes, waiting, cancellation, errors, gaps and committed model findings.
- Do not precede the original model final with `Model assessment recorded` for `overall=complete` when its nonempty text is present; significant model `partial/unresolved` remains visible (R2F). Missing/empty/unconfirmed answers remain explicitly distinguishable; detailed/debug retain their technical facts without a full diagnostics dump.
- Same policy for inline/negotiated notices and `session/load`. No changes to native plans/Thinking/tools/permissions, answer bytes, model strategy, core/Coordinator, bounded transport, provider adapters, CLI or permanent operation journal.
- ACP SDK/history regressions and exact-R1-baseline deterministic throughput comparison added to mandatory CI. Engineering and native limitations are tracked in [STATUS](docs/roadmap/STATUS.md).

### C15R-GUI-R1 — ACP presentation corrective fidelity (real Zed UNVERIFIED)
- Debug external ACP transcript now uses the same typed lifecycle selection as compact/detailed; additional IDs/reasons do not replay unfiltered diagnostics into user conversation.
- ACP v1 notices preserve literal punctuation as bounded plain text; RO own inline messages retain separate Markdown-safe escaping. Multiline finding values are visibly nested beneath fixed trusted labels, without inspecting model text semantics.
- Dispatch route labels distinguish a requested model selector/reasoning level from provider-confirmed actual values. No changes to native model output/plans/tools/permissions, core/Coordinator/CLI/transport or saved journal.
- Added RED/GREEN regression and mandatory planning-SHA deterministic bounded transport comparison. Exact CI and remaining real Zed/native verification are tracked in [STATUS](docs/roadmap/STATUS.md).

### C15R-GUI — graphical standard ACP presentation (real Zed UNVERIFIED)
- Forward only actual typed Controller native ACP v1 `plan` in compact/detailed/debug; no synthetic planning or Worker-plan merging.
- RO-owned compact progress now projects journal-backed dispatch/attempt outcomes, errors, waiting and model assessments with true scope. Registered findings retain model authorship, uncertainties and evidence references without inferred severity or verification.
- Preserve original model messages/Markdown, typed Thinking/tools/forms/permissions, bounded ACP delivery, session/load history, CLI and execution. Deliberately **no Markdown builder/parser**; only fixed RO message/notice escaping.
- Protocol and deterministic SDK tests plus exact CI results recorded in [STATUS](docs/roadmap/STATUS.md). Actual Zed client, second client and comparative latency/loss measurement UNVERIFIED.

### C15R-UX-P1 — interactive terminal transcript outer spacing (real native UNVERIFIED)
- Add consistent decorative left margin to interactive CLI progress, native form/permission displays, streaming Thinking, controller/worker blocks, findings/summary and human TTY authoritative final output. Keep existing internal indentation, colors and readline input behavior; adapt margin for 120/80/40/24-column terminals.
- Do not rewrite model Markdown, apply artificial wrapping, promise a fixed right margin, or modify redirected stdout, JSON, ACP, persisted answers, provider tools or execution semantics.
- Full Node 24/Nix integration, 14 actual Linux PTY and exact implementation CI evidence in [STATUS](docs/roadmap/STATUS.md). Real authenticated provider and Zed remain UNVERIFIED.

### C15R-UX-R2F — confirmed native choice display before numeric selection (native UNVERIFIED)
- Initial native permission/form choices, field transitions, `:back`, and paginated `:choices N` can be selected numerically only after successful Writable delivery; stale callbacks do not authorize another request or re-entered field.
- Native option IDs, typed replies, explicit `id:<optionId>`, grants, provider authority, ACP output and execution lifecycle remain unchanged. Historical CLI input regression fixtures now wait for displayed options before selecting them.
- Deterministic delayed Writable tests and full engineering CI are recorded in [STATUS](docs/roadmap/STATUS.md). Installed authenticated provider and Zed remain UNVERIFIED.

### C15R-UX-R2 — bounded native choice selection and technical preview (native UNVERIFIED)
- Numeric permission/form choices accept only displayed positions belonging to the same live request/field. Recently shown pages are remembered with a bounded UI-only cache; exact `id:<optionId>` remains an explicit selection of the original native ID and provider broker/authority is unchanged.
- Existing `PERMISSION_UNAVAILABLE` is displayed accurately in compact/detailed, keeping source correlation at trusted attempt scope, not inventing an ACK.
- `:details` avoids unbounded object-key enumeration on extremely wide native metadata. The recognized-key projection is explicitly partial with original provider data untouched; accessors are not invoked. Display clipping preserves emoji/surrogate pairs and combining boundary.
- Node24 resource benchmark, RED→GREEN integration, actual Linux PTY and exact mandatory Nix CI are recorded in [STATUS](docs/roadmap/STATUS.md). Real authenticated provider/Zed acceptance remains UNVERIFIED.

### C15R-UX-R1 — truthful native input and tool outcomes (corrective; native UNVERIFIED)
- Visible compact/detailed broker interaction/permission outcomes including timeout, unavailable, denied, invalid and cancellation; attempt attribution only, no invented native request IDs or provider acknowledgement.
- Native `completed` tool status now neutral rather than a green success claim. First generic pending remains visible with native identity-scoped dedup.
- Structured source/question/field/options/meta segments from the original ACP schema; bounded preview of current field/permission metadata with explicit omissions, emoji-safe pages and large permission option pagination; unchanged typed replies, permissions authority, ACP and machine output.
- RED regression, SDK/integration/actual Linux PTY and exact CI results tracked in [STATUS](docs/roadmap/STATUS.md). Installed native and graphical Zed comparison remain UNVERIFIED.

### C15R-UX — CLI visual fidelity and Markdown presentation (engineering, native UNVERIFIED)
- Fixed Controller source accent, deterministic predefined palette for arbitrary Worker roleIds, no role-name heuristics; trusted per-segment ANSI after untrusted sanitization, terminal 24-bit/256/16 and plain fallbacks.
- Compact native tools now show even the only generic pending report; duplicate transitions remain identity-scoped. Native source switching, actual streamed Thinking, recorded finding accent and debug-only redundant lifecycle notices are presentation-only.
- Human TTY authoritative Assessment.answer renders a bounded safe Markdown subset; malformed/excessive markup and unsupported terminal environments fall back to complete sanitized plain output without potentially quadratic parsing. Ordinary identifiers/arithmetic with `_`/`*` stay literal and unsupported `~~` is not misrepresented as bold. Non-TTY/stdout JSON/ACP/state and original assessment remain unchanged. Forms/permissions can reveal actual current request data via `:details [page]` without altering answers, authority, or ACK.
- Added integration and actual Linux PTY regression. Exact CI status and UNVERIFIED native/Zed acceptance are tracked in [STATUS](docs/roadmap/STATUS.md).


### C15R.6R-Final — Native form cancellation while validating

- `:cancel` and `:decline` now preempt in-flight provider-controlled form pattern validation on the original correlated terminal request. Finishing a request aborts its technical worker; late results cannot send `accept`, mutate form drafts, report stale errors or answer subsequent requests. No orchestration/permissions/provider changes. Red/green baseline probe and full CI; real native client acceptance remains UNVERIFIED.

### C15R.6 — CLI interaction safety and native question UX

- CLI permission selection now distinguishes displayed positions from explicit native IDs and binds partially typed input to its original live request, even during concurrent requests and expiry.
- ACP restricted native forms are displayed as readable sequential fields: oneOf/enum/anyOf, plain text, typed values, required/optional and constraints; no JSON required for normal use.
- Readline Thinking streams retain one semantic block; native tools have bounded distinct short aliases and non-repeating details; ACP recovery discloses orphan recorded turns without inventing answers.

### C15R — Presentation quality and fidelity

- CLI: bounded native tool identity/sparse updates, compact/detailed/debug distinction, append-only source/Thinking blocks, truthful summary after authoritative response on shared TTY.
- ACP: journal-derived ordinary/late/discrepancy classification with explicit unavailable fallback; native widgets, inline default and explicit notices unchanged.
- Full transcript/SDK/PTY regressions and baseline measurements; native visual and skill diagnosis remain separate.


### C15 — Rich presentation and ACP transcript

- CLI: trusted TTY color, source/route/effort labels, native streaming tools/thinking, readable permission/form blocks; unchanged machine stdout and ownership.
- ACP: default attributed inline standard messages, explicit capability-gated notices compatibility; bounded per-turn transport and existing native widgets/permissions/forms.
- History: exact ordered session requests and journal response boundary, historical retry, recovered durable facts without replaying native activity or adding execution state.

### C13R/C14R — interaction reliability and presentation completeness

- Final narrow review corrections C13R.4R/C14R.5R: remove arbitrary 1024-frame Codex evidence ceiling; retain the existing 1 MiB wire-byte budget and bounded latest result/error slots, preserve previously available small command observations, explicit omissions and provenance. CLI presentation confirmation now requires a successful Writable callback; errors/close/timeout remain unconfirmed, no replay or fabricated input, durable result and final stdout independent. Exact engineering CI and separate native UNVERIFIED in STATUS.

- Addressed attached reply uncertainty and original work binding reconnect without redispatch or capability escalation; no automatic new answer after lost acknowledgement.
- Bounded normal presentation drain, immediate disconnect/cancel; explicit gaps, no replay.
- Codex incremental JSONL parse independent of raw capture; bounded execution evidence, explicit truncation/omission and latest declared result, unchanged terminal/exit checks.
- Scoped ACP source metadata, concurrent old/new prompt interaction fixture, native thinking fragments in CLI, no repeated presentation snapshot reads, safe human TTY final/clarification.
- Standard ACP notices for committed findings and lifecycle when negotiated; no fake native events or history. Actual SDK/subprocess/PTY engineering regression separate from real native/comparative UNVERIFIED.

### C12R.10R follow-up — evidence attribution and ACP teardown

- Preserve trusted Host transport attribution in matching Outcome refs without relaxing exit/attempt identity or rewriting historical evidence.
- Distinguish intentional ACP connection close from real stdout errors by exact per-invocation error identity. Record first intentional teardown and actual process exit facts separately from provider stop and cancellation. Preserve genuine stream/cleanup errors and existing ownership/deadlines/slots. Regression and native acceptance tracked separately in STATUS.

### C12R.10R — Controller submission clarity (engineering; native UNVERIFIED)

- Clarified declared-result submission versus native tool observations, Action admission/dispatch/completion, bridge scope, optional history and nested Assessment fields without changing Decision v1 or coordination.
- Added actual ACP/CLI synthetic subprocess regressions for Decision-shaped tool output A versus final A/B/invalid, including an ACP observation gate, journal lifecycle and attributed outcomes. Native subagent reports, missing refs and ordinary correction remain independent of Host delegation. See STATUS for actual CI evidence and separate local comparative acceptance.
- Review follow-up: fixed stale ACP result observation identity on message reset; clarified prior-message/no-message transport boundaries and exact optional non-empty Assessment reason. Extended real-adapter synthetic regressions and structural prompt delivery checks. Full review CI 398/398; native comparative acceptance remains open.

### C12R.10 — Controller contract (engineering; native comparison UNVERIFIED)

- Единое Decision v1 описание для прямого ProviderPort и CLI/ACP, точные history/workMap cursors, валидный пример и явная граница transport / finalAssessment.answer. Сохранены native tools и отдельный Worker result.
- Различимые malformed JSON, non-object и depth ошибки используют существующий INVALID_PROPOSAL/correction без ремонта ответа или изменения Outcome/effect.
- Точный отказ по незарегистрированному Host Catalog skill не ограничивает native capabilities. Новые synthetic regression fixtures проверяют доставку, точный ответ, независимые Workers и сохранение effects; фактическая готовность и CI — в STATUS. Native сравнительная приёмка C12R.10.7 и прежние обязательства остаются открытыми.

### C12R.9 — контекст и история, review P1/P2 (engineering changes; native UNVERIFIED)

- History directory uses journal-prefix `{revision,index}` cursors across Controller/MCP retrieval (0 starts fresh; legacy nonzero offsets explicitly return invalid_cursor). Structured partial pages advance by actual delivered count, end/errors survive omitted page envelopes, late observations preserve event-local positional identity; independent budgets unchanged.

- WorkMap pagination uses a stable journal-prefix `{revision,index}` cursor across Controller turns (0 starts a fresh traversal; legacy nonzero offsets explicitly report `invalid_cursor`); first Attempt retains the accepted Action's position, while lifecycle and refs remain live. Accepted-only rows distinguish cancellation, execution rejection and deferral without changing admission or dispatch semantics.

- Controller, handoff, fetch, artifact capture, host-managed skill instructions и external tool output имеют независимые config budgets с controller-only legacy alias.
- Устранён artificial 128-entry cap; технический `workMap` вычисляется из исходной Operation, с сохранением refs/provenance и отличием terminal uncertain effect от in-flight.
- Добавлен optional `nextController.contextRequest` (refs/cursor) для следующего обычного Controller без MCP/нового Worker, с неизменными permission и recovery правилами.
- Добавлены технические body-free метрики доставки; provider-native files, skills, scripts, terminal и MCP остаются средствами провайдера.
- Review P1/P2: убрана лишняя копия Worker final output на проверенном пути Codex CLI/ACP → Controller; все исходные refs/provenance остаются durable.
- Контролируемые технико-исторические omissions снабжены полной статистикой, model-selected workCursor, явным invalid cursor и счётчиками недоставленных materialized/presented исторических запросов.
- ContextPort/MCP/contextRequest поддерживают позиционные refs и lossless byte-offset чтение фактически сохранённых результатов больше fetchMaxBytes без нового хранилища; регрессии включают restart, permission/ambiguity, byte-count precision, UTF‑16 surrogate, cancel/retention/integrity.
- Реальная model/Zed native comparison не заменяется автоматическими fixtures.



- C12.0: инженерные знания и тесты перенесены из временного `development/` в `tests/`, `scripts/`, `.agents/`, `docs/roadmap/`, корневые npm/Nix/CI. Runtime semantics не изменены.
- C12.1–C12.2: трассировка R/A, добавлены обязательные acceptance smoke (non-Git CLI/API и сохранность переноса). C12.5–C12.6: живая правка ветки/index при запущенном worker и clean tarball E2E без dev tools; C12.7: статический audit границ Host и model-first.
- C12.8: воспроизводимая сборка npm tarball (двойной pack), SHA-256 manifest и Nix path-info как CI artifact без публикации production release.
- C12.9: CI проверяет вычисление NixOS module graph с установленным пакетом; это не запуск на NixOS и не нативное подтверждение модели.
- C12R.1: локальный технический отказ Controller не отменяет ранее принятые Workers; готовые reservation requests обслуживаются без starvation, durable recovery сохраняет unsent attempts и не повторяет unknown effects.
- C12R.2–.5: усилена проверка explicit reasoning provenance в snapshot; сохранены адресные admission/Decision причины; различается context payload/ambiguity/retention/budget; ACP output limit отделён от protocol error, сохранены частичные observations и cleanup/slot evidence.
- C12R.6.0: исправлена доставка выбранных skills в CLI/ACP, атрибуция inline/loaded, недоступность и scope; idempotency identity учитывает исправленный контракт доставки.
- C12R.8: восстановлен проверяемый handoff STATUS, убрана обязательная рекомендация перебирать историю: Controller решает, нужен ли optional ContextPort/MCP retrieval. Фактическая доступность MCP осталась, новые тесты фиксируют технические лимиты/идемпотентность и prompt policy без нового Host workflow. Подтверждена автоматизированная регрессия; влияние на качество native reasoning не измерено.
- C12R.8R: MCP при превышении response budget сохраняет известные effect/status и correlation ref, отмечая ошибку доставки; ограничение проверяет весь JSON-RPC envelope. Неожиданный oversized result не превращается в ложный no-effect, поздние tool receipts и durable history остаются неизменными; повторный MCP request ID не запускает новый эффект. Усилено покрытие общего budget, lifecycle/cancel/cleanup, id-validation и optional retrieval при прямом Controller-ответе; Resource/Host/model-first границы и лимиты не изменены.
- Реальная CLI/ACP/Zed/NixOS интеграция и подтверждение native effort пока не завершены; не обещается production readiness.

## 0.1.0-dev.0 — функциональные приращения

- C01–C03: provider-agnostic JavaScript ESM core, один model-first Controller cycle, делегирование, параллельная работа, отмена и resource budgets.
- C04–C06: доверенные permissions/configuration, durable snapshots/CAS, безопасная неопределённость внешних эффектов, findings/evidence и model-managed applicability.
- C07–C08: Codex CLI и Generic ACP adapters с корреляцией session/attempt, permission bridge и наблюдаемыми failure paths.
- C09–C10: явные plugins/skills/tools, программный API, CLI, внешний ACP host; npm/Nix package/apps.
- C11: диагностика причин остановки, bounded traces, redaction, sink isolation и recovery.
- C11R: selectable reasoning effort в том же config v1 для Controller и workers, native omission, per-attempt provenance и per-provider adapters без второго scheduler.

Исторические CI результаты относятся к конкретным исходным commit; real model/ACP/Zed native acceptance остаётся отдельно UNVERIFIED.

### C12R.9 — повторное ревью фрагментов и производительности

- У `workMap` не показывается `nextCursor` после последней страницы; нулевой прогресс помечается `budget`.
- Для `ContextPort.fetch({offset,maxBytes?})` введён независимый per-call byte ceiling, ограничивающий весь chunk envelope. В Controller крупный base64 payload может быть без потери данных уменьшен до фактического свободного бюджета с пересчитанным `nextOffset`. MCP ограничивает конкретный fetch собственной транспортной границей, не увеличивая `fetchMaxBytes` или другие defaults.
- Local StateStore может выдавать диапазоны из одного ограниченного в памяти SHA‑256-verified образа, проверяя метаданные backing-файла перед повторным использованием; избегаются повторные полные дисковые чтения при длинной последовательности страниц, сохраняются integrity/retention/cancel semantics. Нового persistent store или Host runtime не добавлено.

### C13 — Interaction protocols and model activity (feature branch)

- Optional invocation-bound provider activity, bounded scoped subscriptions and delivery gaps; native ACP reasoning/plan/tool and Codex JSONL item events independent of final output.
- Raw ACP capability declarations separated from negotiated routes and authority; explicit per-method extension relay, existing client-tools/permissions preserved.
- Optional native input broker with correlated manual/handler owner, deadline/cancel and standard ACP session form elicitation where available.
- Bounded execution notice delivery and existing local control v1 scoped stream/pending/answer routes; no new model calls, replay, writer or scheduler.
- Native model/client quality and performance remain UNVERIFIED unless actual native evidence is recorded; see STATUS.

### C14 — CLI and standard ACP presentation

- Compact/detailed/debug client modes, stderr activity and technical display, unchanged stdout/final/exit codes; recorded findings, explicit delivery gaps and correlated terminal permission/form replies for direct and attached CLI.
- Standard ACP native thinking/tool updates and Controller plan only; removed synthetic Controller progress, scoped native tool IDs, existing prompt/load/permission/elicitation and background operation route retained.
- Added presentation golden, input owner, SDK and actual Linux PTY transport regressions. Native model and real graphical client acceptance remains separately UNVERIFIED.
