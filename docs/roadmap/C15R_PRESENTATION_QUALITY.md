# C15R — Presentation Quality & Fidelity

**Задание агенту-исполнителю.** Ветка feature/interactive-ux; актуальный следующий шаг — [STATUS](STATUS.md). Review baseline: 0aee345c9833ec741b6cd8e622c39c1c7c6b88ce; C15 verified implementation/handoff SHA e3020ee94a8750704259d16bb488922f6c49de4d, [CI 43710522394](https://github.com/apathoid/role-orchestrator/actions/runs/43710522394), 466/466 root + 5/5 actual Linux PTY, full Nix/package/release PASS. Эти результаты сохраняются как историческое evidence, но не подтверждают исправления C15R или полную UX acceptance. Не merge в master без отдельного поручения.

## 1. Цель и основания

C15 инженерно реализован, однако пользовательская визуальная приёмка compact CLI не пройдена. В реальном пользовательском запуске 2026-11-15 (Operation 15389b4c-5656-491e-b32c-e11f5510de0a, Controller local-small, selector llamacpp/small, запрос использования changed для описания последнего коммита Engee frontend) видны цветные lifecycle/tool строки, но интерфейс остался техническим логом: повторяется полный префикс, pending/in_progress/повтор in_progress/completed, частичный update называется tool_call_update, thinking не имеет визуального блока, весь текст почти одного уровня. Отмена Ctrl+C была действием пользователя, не доказательством failure модели. Native ID в изображении не виден; конкретную идентичность повторов подтвердить fixture/native trace, не угадывать по тексту.

| ID | Приоритет, основание | Исправление |
|---|---|---|
| C15R-F1 | P2 OBSERVED / SUPPORTED: presentation.js:95–125 и cli-presentation.js:19–40 форматируют отдельные activity events; ACP adapter provider.js:219–226 уже даёт native toolCallId | CLI tool projection: одна identity, sparse updates, отсутствие повторных одинаковых строк, meaningful lifecycle |
| C15R-F2 | P2 OBSERVED / SUPPORTED: thinkingFragment и cli-input.js:160–170 — styled prefix, body без визуальной структуры; compact/detailed tool mapping почти одинаков, tests закрепляют это | Rich append-only transcript, различимые источники/blocks, реальные различия режимов |
| C15R-F3 | P2 SUPPORTED: acp-history.js:110–119 берёт event.kind и journalReasonCode; core/operation.js:324–352 классифицирует тот же attempt.outcome как обычный, late или discrepancy | Историческая достоверность classification/provenance; exact when supported, neutral otherwise |
| C15R-F4 | P3 SUPPORTED: presentation.js:195–210 считает Worker attempts как workers и все reserved attempts как invocations; main/cli.js вызывает finish до печати authoritative ответа в hosts/cli.js | Точные названия counts и concise final status; на общем human TTY ответ предшествует summary |
| C15R-F5 | P2 SUPPORTED: presentation/PTY tests проверяют строки, наличие ANSI, delivery, но не композицию полного transcript | Red-first representative fixture + complete transcript acceptance, actual PTY and regression |

Отдельная HYPOTHESIS / UNVERIFIED: Controller сообщил о наличии changed в available_skills, не нашёл файл и выбрал mr-description. Причина не установлена (provider-native skill discovery/tool, Host Catalog metadata vs instructions, source mismatch или model behavior). Это не renderer defect. Проверка C15R.5; не менять runtime skill mechanism на основании одного скриншота.

## 2. Неизменяемые границы и решение о владении

Прочитать AGENTS.md, .agents/REASONING.md, применимые engineering docs, [C15](C15_PRESENTATION_EXPERIENCE.md), [C13](C13_INTERACTION_PROTOCOLS.md), [C14](C14_CLIENT_UX.md), [C13R/C14R](C13R_C14R_INTERACTION_RELIABILITY.md), PRODUCT, ARCHITECTURE, CONTRACTS, EXECUTION, PROVIDERS_AND_CONFIGURATION, CONTEXT_AND_RECOVERY, DIAGNOSTICS, DECISIONS и единственную acceptance matrix. C15R уточняет CLI fidelity и history, не отменяет C15.

- Модель владеет стратегией, планом, tools/skills/subagents, interpretation, evidence/findings, acceptance. Host не классифицирует задачи/команды, не анализирует thinking, не извлекает findings и не создаёт отчёты за модель. Не меняются prompts, Decision/Outcome, routing, reasoning, retries, waitPolicy, scheduling, budgets, invocation/context/evidence/permissions или provider-native capabilities.
- CLI renderer владеет только **эфемерной проекцией отображаемых полей** native tool и текущим визуальным источником. Истина — исходное ActivityEvent, bound attempt + native ID, committed execution facts. Это не новый execution state, permission registry, journal, replay store или общий ACP tool cache. Не персистировать, не отдавать в модельный контекст, не использовать для dispatch/authority. Обычный tools/skills/project discovery в реальном mutable dirty/non-Git workspace сохраняется; no sandbox/virtual checkout/host scan.
- Сохранять существующие bounded delivery, scopes, accepted hook, commit/publication/dispatch/launch order. Renderer не задерживает Coordinator/provider slot. No additional model calls, no mandatory reporting, no timer-based semantic grouping. CLI только append-only scrollback: no live status line, alternate-screen TUI, persistent REPL, cursor redraw старых tool rows, новые readers/pollers. Existing readline may own and redraw only its active input line.
- External ACP default inline + explicit notices compatibility сохраняются. Native ACP tool updates, thinking, plan, public messages, permission/forms не проходят CLI filtering; клиент владеет UI. History читает existing session.requests/journal, не хранит новый поток. Model-native skills/tools/scripts/AGENTS.md не меняются ради presentation.
- JavaScript ESM/checkJs, existing ports/boundaries, no new provider/client-specific core logic. Изменения минимальные целостные; новые abstraction/metadata только при demonstrated need.

## C15R.0 — Baseline, red fixture and transcript contract

1. Взять актуальный HEAD; сравнить с review baseline, подтвердить STATUS и фактические источники: hosts/presentation.js, cli-presentation.js, cli-input.js, local-control/control-streams/attached-input/cli-owner, main/cli.js, hosts/cli.js, acp-history.js/acp.js, application/events.js/activity.js/delivery.js, core/operation.js, actual ACP/Codex adapter activity mapping. Проверить actual native identities, sparse fields, delivery scopes/gaps, write confirmation, terminal result order, existing source/escape state. Не предполагать provider payload.
2. До исправления добавить детерминированный red regression (или зафиксировать red на временном тестовом checkout, затем сохранить fixture и тест в implementation commit): actual SDK fixture с native tool_call pending shell, update title/command + in_progress, identical in_progress, update completed без title, вторым независимым read/tool и failed update, fragments thinking до/после, same native ID у разных Attempts, interleaving, final answer/cancel. Не использовать текст скриншота как источник неизвестных native IDs. Описать exact input events, ожидаемые transcript boundaries, что baseline нарушает. Не оставлять рабочую ветку с намеренно красным CI; красное доказательство отдельно.
3. Golden transcript: проверить не только строки/ANSI, но порядок, line boundaries, count/repetition, indentation, real source attribution, отсутствие скрытого thinking loss, final once и отдельный summary. Normalize только непредсказуемые ID/time, terminal line endings/ANSI для plain comparison; отдельно проверить trusted styles. Не нормализовать повторы, порядок или структуру, которые являются предметом теста.
4. Зафиксировать source → compact/detailed/debug и ownership; измерить baseline representative fixture (первый useful output, lines/bytes, total, history); не принимать предыдущий CI за новый baseline runtime run. Если native trace unavailable — explicit UNVERIFIED, fixture не блокирует инженерное исправление.
**Exit:** red evidence + проверяемый transcript target, следующий C15R.1; не останавливаться на документах.

## C15R.1 — Native tools: bounded identity-aware presentation

1. В CLI consumer reuse actual operation/attempt/native tool identity (ACP toolCallId; Codex item identity только если реально доступен). Scope collision-proof; не группировать по title/command/text, времени или provider name. Merge только supplied display fields по фактическому protocol contract: sparse update без title/status сохраняет известное поле, explicit clear/null — согласно actual semantics. Не копировать raw result/output/schema в cache; title/command/locations/status и rendered fingerprint — bounded display-only. Не выдумывать tool kind, exit, file path, result, success. Native kind tool_call_update — имя wire event, не имя инструмента.
2. Compact: одно краткое объявление о фактическом действии, когда получено start/pending/running с полезными полями; если ранний pending содержит только generic title, можно не печатать отдельную пустую строку, но не ждать timer/будущего события и не скрывать pending permission/interaction/failure. Первый содержательный title/command немедленно показать; значимое изменение, completion/failure/cancel/unknown — отдельная короткая строка с тем же читаемым identity/label. Если был только pending, не назвать его dispatched/running. Для обычной последовательности generic pending → meaningful in_progress → identical in_progress → sparse completed target: две строки (start + completion), без искусственного completed до события. Если раннее полезное объявление уже показано, дополнительная строка о реальном изменении допустима; не печатать каждую идентичную update. Если нет terminal update, не создавать его при finish/eviction/gap. Независимые инструменты с одинаковой командой не склеивать.
3. Detailed: сохраняет реальные transitions (pending/running/terminal и значимые изменения title/description/location), больше доступного ограниченного detail; identical no-op updates можно не повторять. Debug: все доставленные исходные технические events, source/native ID/status/seq и safe bounded metadata; no raw huge output/secrets by default. Explicit plan modes unchanged. Не менять native stream/adapters ради CLI; если нужен normalization helper, располагать у владельца provider mapping, не в core.
4. Unknown native identity: безопасное отдельное отображение факта, без объединения и синтеза идентификатора; после missing/evicted prior — update without earlier details/unknown tool, не wire event как title. Gap инвалидирует затронутый display cache/continuity, сообщает неполноту; при неизвестной области очистить весь соответствующий consumer scope. Late/out-of-order status не присваивать новым calls; уважать фактическую identity и delivery sequence, показать conflicting/unknown transition как report, не утверждать rollback или завершение. Не создавать отдельную semantic state machine.
5. Ограничить retained entry count и bytes, включая длинные titles/IDs и rendered fingerprint; использовать existing delivery bounds как ориентир, обосновать конкретные размеры. Eviction безопасен; cleanup при end/close/disconnect/cancel/gap, no timers or unbounded promises. Не добавлять execution quota. Никаких per-event inspect или дополнительных provider calls. Не фильтровать ACP updates.
**Tests:** actual SDK sparse title/status, repeated identical, different IDs same text, same ID different attempts, failed/unknown, missing ID, out-of-order, gap/eviction, huge fields, attached/direct, actual Codex mapping where supported. Проверить сохранение original activity и Invocation/evidence/outcomes.

## C15R.2 — Rich CLI blocks and interaction-safe output

Визуальный ориентир (plain scrollback; иллюстративные labels только из fixture facts, не требовать конкретных glyph/colors как API):

    Role Orchestrator · compact · 15389b4c

    ● Controller #1
      local-small · llamacpp/small · native effort

      Thinking
      Let me understand the task...

      ◇ Read · skill instructions
      ✗ Read · failed
      ◇ Shell · git show HEAD
      ✓ Shell · git show HEAD · completed

      Thinking
      The last commit only bumps the version...

    [authoritative answer, if completed]

    ✓ Operation complete
      1 Controller attempt · 0 Worker attempts · 0 recorded findings

Для параллельных Attempts (каждый header появляется по actual dispatch, не ждать остальных):

    ● Controller #1 · primary
      Thinking
      ...

      ├─ Explorer #2 · worker
      │  Objective: [actual Action objective]
      └─ Reviewer #3 · worker
         Objective: [actual Action objective]

    Explorer #2
      Thinking
      ...
      ◇ Read · src/editor/history.js

    ◆ Recorded finding · Reviewer #3
      [actual claim and uncertainty]

    ✓ Reviewer #3 · outcome reported: completed
    Controller #1
      Thinking
      ...

Символы ветвления только visual affordance, не обещание числа будущих Workers, их зависимости/порядка/иерархии или принятого плана; не объявлять последний Worker до факта. Не имитировать skill title/description, если provider дал лишь read/shell.

1. Создать видимую иерархию: header при accepted boundary (short Operation ID in compact, full debug/inspect); distinct actual Attempt header, route/profile/role/effort and objective when known; separate source block on switch, resumed source clear, not every line [Controller #1...]. Tool/finding/interaction/lifecycle blocks with consistent indentation, spacing, restrained styles; plain fallback structurally readable. Unique aliases per Operation incl retries/same role/profile; historical model selector not actual model. No fabricated source or aggregation of future events.
2. Thinking: reuse current native stream continuation, do not parse/summarize/trim meaning or aggregate whole reasoning. Adjacent actual same-source fragments continue block, separate on actual source/type/tool/finding/interaction/gap; maintain line-start display state across chunks, indent each displayed line consistently, style body (dim/italic where supported), reset ANSI per write. Preserve all native text modulo established sanitization and display-only indentation, including whitespace/newlines/Unicode and split fragments. No added newline per token. No buffering until full response, no grouping by textual similarity; native summary remains summary. Gap/unknown source resets continuity; no fictitious end of thought.
3. Style after sanitize (OSC/CSI/bidi/split, bounded state per source), no-color/TERM=dumb/non-TTY; narrow PTY wrap/Unicode not corrupted. Preserve native command/output text as source; only bounded labels, do not infer action semantics. Existing permission/form identity/options, exact answer owner, pending labels, deadlines, cancellation, observer/reconnect, unsupported/unknown ACK preserved. Use existing readline owner; no overwriting typed input; status lines append only. Direct/attached same renderer contract. Cross-stream arrival order only; no invented chronology; if two existing consumers can interleave writes, use minimal bounded output serialization only as necessary, no unbounded queue.
4. Findings: separate visible recorded/reported labels and author; do not imply model claim confirmed. Show uncertainty and available supports/supersedes in existing mode policy. Error/cancel/unknown distinct from success; compact human wording, debug exact reason/IDs. Preserve native model public messages, not interpret Decision envelope. Summary/final addressed in .3.
**Tests/exit:** full representative compact/detailed/debug golden transcripts + actual Linux PTY direct/attached and narrow/color/no-color, interleaved thinking/tools/findings/permissions, fragments during input, Ctrl-C/EOF, slow/broken output, gap, unknown identity. Compare with approved structure; test line counts and source boundaries, not just ANSI presence. No live redraw.

## C15R.3 — Authoritative final answer and truthful summary

1. Use existing authoritative response path in hosts/cli.js and main/cli.js, never print Assessment.answer twice or rewrite it. Human text shared terminal: final answer/clarification/status first, then concise separate technical summary; ensure ordering at actual output owner using existing bounded finish/confirmation only as needed. Machine JSON, redirected stdout bytes, exit code unchanged; stderr presentation remains independent best effort. If stdout/stderr are separate sinks do not promise cross-sink display ordering; preserve machine contract. Broken/slow stdout/stderr, cancellation, close and final answer availability must not wait on renderer or trigger re-execution. No new execution lifecycle.
2. Counts from existing authoritative state: distinguish Controller/Worker attempts from unique delegated Actions, reserved vs dispatched (actual recorded dispatch, not merely attempt count), and consumed budget (resourceSnapshot/ledger semantics). Choose short honest labels in compact; detailed/debug can retain actual IDs/routes/budget. Do not call all attempts invocations or unique Workers. No new execution counters/index. Findings count = recorded reports, not verified findings. Report actual assessment overall and unresolved/partial/unknown effects, cancellation source when available; don't equate transport success with task completeness. No fake final answer on cancel.
3. Test successful direct answer, delegated/retry with reserved/not_sent, partial/technical waiting/question, cancel/late unknown, redirected/headless/JSON and shared actual PTY; assert final exactly once, summary follows response when both human on same TTY, exact counts and no duplicate cancel prose beyond distinct necessary status. Verify existing result/error/exit contract and bounded writes.
**Exit:** C15R-F4 closed on observable transcripts, not merely string changes.

## C15R.4 — ACP transcript outcome fidelity

1. Existing live diagnostic classification is not identical to journal Event.kind. Reproduce with actual reducer-produced transitions: ordinary terminal, late report after cancellation/generation change or already terminal, compatible late enrichment, contradictory terminal/effect (attempt.outcome_discrepancy), and exact duplicate (not a new journal fact). Check source IDs, actual reported fields vs accepted state, stable own messageId. Test live/reload comparison on the same journal, including A→B→A and background records.
2. Keep existing session.requests/Request/operation.continued/responseEventId ordering, old-request retry, one snapshot at a time and abortable streamed history. Never label a conflicting provider report as accepted completion. Prefer exact historical classification via existing authoritative transition information/reducer semantics and actual historical prefix when recoverable. Inspect initial limits/authority and continuation/recovery changes before considering read-only reduction: current snapshot is not historical pre-state; do not replay with today's config, invoke effects/dispatch/intent handlers, write state, emit diagnostics or introduce a second reducer/state machine. Avoid per-event full inspect and quadratic whole-history replay; measure real cost. If exact classification cannot be recovered from existing durable records, use explicit neutral “historical outcome report · acceptance/classification not recorded” with actual terminal/effect and late marker only when supported, no guessed discrepancy or success. Define precise fallback with test and docs; don't use neutral fallback to erase classification that is actually available. Live classification remains precise.
3. Keep same stable own IDs for same durable event/finding, actual source metadata and recovered attribution. Transient diagnostics/activity gaps are not history; never reconstruct raw thinking/tools or fabricate missing reports. No extra execution journal, new durable UI state or model-context coupling. If source-contract improvement is needed, justify minimum within existing authoritative journal contract separately; no schema changes just for UI without demonstrated need and explicit scope review.
4. Preserve default inline, explicit notices mode and native widgets. Run SDK history test for discrepancy/late/duplicate, background old Worker, repeated load, old retry, legacy ambiguous boundary, missing data/disconnect/large Unicode/history. Compare exact chronology and identity, no double final/no false state acceptance. Benchmark against C15; bounded memory and time.
**Exit:** C15R-F3 closed with accurate classification or explicit tested limitation, no new authority/state.

## C15R.5 — Full engineering verification, native re-acceptance and separate skill diagnosis

1. Full unchanged mandatory CI: locked npm, spec/checkJs/import boundaries, foundation/core/provider/integration/acceptance/root suites, actual Linux PTY, package/public import/clean installed package, Nix flake/build/install/NixOS evaluation, release/lock checks. Existing C15/C13/C14/C12 regressions retained. Update single acceptance matrix A82–A86 and exact SHA/counts/CI in STATUS; no weakened tests. Compare deterministic full Operation/Invocation/diagnostics headless/CLI/ACP/slow/throwing/disconnected with original execution behavior (ignore only presentation metadata and nondeterministic values where justified).
2. Measure identical baseline vs C15R fixture: first useful output, total latency, compact tool lines/bytes, detailed/debug, large text/parallel/many tools/slow/broken output, cache size/eviction, history load and resource bounds. Reuse scripts/c15-presentation-benchmark.mjs and current delivery tests; add narrow representative comparison if necessary. Distinguish fixture/provider time and noise; no artificial performance target or new runtime budgets. Fix material regression, not merely report.
3. Native CLI: reproduce exact user's task/settings (local-small, native effort, Engee frontend, changed) on installed RO; capture redacted actual terminal transcript/screenshot and compare to .2. Also model-selected parallel Workers (do not force), permission/form, Ctrl-C, narrow/no-color/redirect, direct/attached. Native Zed/standard ACP: inline default, native thinking/tools/Controller plan/forms/permissions and session reload incl historical outcome reports; record actual client/provider versions. Compare real quality/usage/latency only with equivalent settings and sufficient runs; preserve F4/C12/C13/C14/C13R/C14R/A81 obligations. If unavailable, explicit UNVERIFIED with exact reason and commands; engineering may finish, product visual/native acceptance not claimed from CI alone. User screenshot is observed baseline only.
4. Independent changed diagnosis (no runtime changes in C15R): compare exact same task/model/effort/cwd/config/native skill availability/permissions through actual provider directly vs RO. Identify origin of available_skills (native vs Host Catalog), actual native tool capabilities and working directory, whether actual skill resource exists/loads and selected skillInstructions are delivered (Controller metadata vs Worker selection). Inspect only redacted relevant diagnostics/trace/config and native provider output; do not expose credentials/full prompts or assume missing file from model thinking. Distinguish native discovery failure, missing resource, Host delivery mismatch and model not choosing skill tool. No automatic Host skill scan, keyword detection, fallback substitution, compulsory delegation, prompt rewriting or provider-specific policies. If confirmed defect outside presentation, record evidence, owner and minimal separate follow-up proposal; no unrelated production changes. If data/native environment missing, UNVERIFIED; not a C15R engineering blocker.
5. Handoff: exact implementation commits + final verified SHA, full CI, representative actual fixture transcript incl plain and color, measured overhead/line counts, live/history fidelity, actual native evidence/limitations, architectural audit and remaining obligations. Update normative docs only when behavior lands (CONTRACTS, PROVIDERS_AND_CONFIGURATION, CONTEXT_AND_RECOVERY, DIAGNOSTICS, DECISIONS, README/CHANGELOG as applicable); not prematurely claim implementation. STATUS per logical checkpoint. No merge master.

**Completion:** C15R.0–.5 implementation checkpoints in order, separate logical commits, STATUS after each; do not stop at baseline or documentation. Engineering complete requires red/green full transcript and full CI, native visual acceptance remains separate. No second execution lifecycle or semantic Host responsibilities.

---

## C15R.6 — CLI Interaction Safety & Presentation Refinement (PLANNED; NOT STARTED)

**Corrective implementation assignment, approved 2026-11-16.** Continue on feature/interactive-ux from the actual HEAD. Previous C15R.0–.5 engineering baseline: implementation 9c09318f729b20fa989e1d4c6474a7eea7c0eff5, documentation handoff 55624ebe30901fa5b2737ae8ff6f877cb288861c, CI 43713292671: 476/476 root, 7/7 Linux PTY. Those results **do not verify** C15R.6. C15R native/comparative A86 remains UNVERIFIED, baseline visual acceptance NOT ACCEPTED. This section is a plan, not implemented code or a runtime workflow. Follow the live next step in STATUS.

### Why this follow-up exists

Observed latest native CLI: a model's question is displayed as transport fields q0/q0_custom, with raw request IDs/deadline and an input prompt requiring JSON. Ordinary text and choices are not usable to a human; the precise original requestedSchema of that run is UNVERIFIED. Static source review additionally supports: permission selection collision (displayed position versus native optionId), missing human-readable oneOf choices/validation, generic invalid-input errors, repeated Thinking header for short fragments while readline is active, insufficient compact tool identities/details, and a legacy history fallback that loses known records without session turn association. These are technical presentation/input defects; a model asking before giving its answer or choosing a different native skill is not by itself an RO defect.

**Goal:** natural, safe interaction with model-native permissions/questions and a readable append-only CLI transcript, with unchanged model/execution semantics and original native ACP capabilities.

### Required context and ownership before changes

Read AGENTS.md; .agents/REASONING.md and applicable .agents/engineering/; STATUS, IMPLEMENTATION_PLAN, C15, this C15R plan and C15R_TRANSCRIPT_EVIDENCE; C13/C14/C13R/C14R; PRODUCT, ARCHITECTURE, CONTRACTS, EXECUTION, PROVIDERS_AND_CONFIGURATION, CONTEXT_AND_RECOVERY, DIAGNOSTICS, DECISIONS; the sole tests/ACCEPTANCE_MATRIX and NATIVE_ACCEPTANCE. Inspect actual HEAD and pinned @agentclientprotocol/sdk 2.4.0 protocol types/schemas, not an assumed newer ACP dialect.

Likely boundaries to inspect (verify owner in current code): src/hosts/cli-input.js, cli-owner.js, attached-input.js, cli-presentation.js, cli-tools.js, presentation.js, cli.js, src/main/cli.js, src/hosts/acp.js, acp-relay.js, acp-history.js; existing application interaction/permission/local-control/delivery ports and provider-native ACP activity mapping. Do not prescribe new files/classes when a small modification to an existing owner is sufficient.

**Non-negotiable invariants:**

- Model-first: model determines task, reasoning, planning, delegation, tools, scripts, skills, whether/when to ask, evidence interpretation and Assessment. Host does not answer questions, filter them by semantic content, create findings/plans, interpret thinking, add verification gates or force workflow stages.
- Provider-/workflow-/environment-/client-agnostic: no OpenCode question handler, no q0/_custom naming heuristics, no Git/HEAD/cwd identity requirements, skill scans/substitution, invented project environment, Host filesystem/process isolation or provider-dependent rules in core. Native AGENTS.md, scripts, project files, tools, skills and provider subagents stay available to the executing model according to actual provider environment/permissions.
- Technical Host ownership only: trusted correlation, active owner, authority, deadlines, wire/schema mapping, bounded display state and delivery. No new execution lifecycle, scheduler, registry of grants, durable UI journal, mandatory model call, provider slot hold, unknown-effect replay or Host semantic repair of model/user answers.
- External ACP retains native tools, thinking, plan, permissions/forms, inline progress default, explicit notices compatibility and existing session/load chronology. CLI form rendering must not rewrite the schema delivered to a graphical client.
- CLI remains append-only with one terminal input owner, existing readline limited to its active prompt, no full-screen TUI, persistent REPL, live status line, rewriting old scrollback or unbounded presentation buffers. Preserve stdout/stderr/JSON/headless contracts, actual Writable completion and terminal sanitization.
- Do not move commit/accepted/publication/dispatch order, change Controller prompts/Decision/Outcome, retries, budgets, reasoning settings, context/evidence or permission policy for UI. UI failures must not stall unrelated accepted Workers.

### C15R.6.0 — Baseline, actual protocol and red evidence

1. Record exact branch HEAD, existing installed/package/runtime identities when available, CI baseline and diff. Confirm current behavior in direct and attached CLI, standard ACP and current supportedForm/parse/ask/readline paths. Mark OBSERVED vs SUPPORTED vs HYPOTHESIS vs UNVERIFIED.
2. Inspect **pinned SDK 2.4.0** typed elicitation form contract: which primitives, enums, oneOf label/value choices, arrays/multi-select, required/optional, defaults, validation rules, metadata and response envelope are actually allowed. Distinguish validation constraints from annotations/opaque metadata. Do not infer arbitrary JSON Schema support. Inspect existing AJV 8.20.0 only for a proven compatible use; do not implement another generic JSON Schema interpreter.
3. Attempt to retrieve redacted original native message/requestedSchema of the user-visible q0/q0_custom question from already available trace/inspect/provider observations. No persistent raw prompt/schema capture for this investigation. If unavailable, use an explicitly synthetic **protocol-valid** reproduction without claiming it is the original payload. Verify native tool/skill observations separately rather than trusting text in reasoning.
4. Create red-first SDK/subprocess and actual PTY cases: permission optionId conflicts with displayed numeric selection (including deny-vs-allow, literal numbers, special commands); ordinary free text rejected as JSON; supported oneOf choices invisible; inaccurate form validation; input partially typed while selected request expires and another arrives; many short thinking fragments during input; two same-title native tools with different IDs and sparse completion; history Operation with missing/partial turn associations. Capture full representative transcript, not just matching strings. Preserve red evidence without leaving CI permanently red.
5. Confirm existing trusted owner/deadline/ACK behavior before choosing a fix. If an apparent bug has a different technical cause, record the discriminating evidence and correct the narrow solution, not the model's strategy.

**Exit:** evidence and valid wire/display contract fixed, next C15R.6.1; do not stop at baseline or planning.

### C15R.6.1 — P1 permission and input identity safety

1. Make positional choice unambiguously select **that displayed position** in the original permission options array; native optionId selection, if retained, uses a separate explicit grammar. Avoid collisions with numeric IDs, IDs resembling commands, spaces or the word option. Do not select allow by default or treat unrecognized input as approval.
2. Keep user intent tied to the **request and options actually presented**. Bind active input to its request identity, not a dynamically chosen sole pending request at Enter. A newly pending request cannot receive an already-started line. On expiry/cancel/close/supersession, stale input cannot be reinterpreted as a response to another request. Aliases are locally unique and not silently reused within visible ownership; aliases do not convey trusted authority.
3. Display source (Controller/Worker alias and role/profile if known), actual resource/action, offered options and security-relevant kind/scope (once/always)/detail when supplied. Shorten technical IDs only; do not conceal permission semantics or invent missing metadata. Debug may show original IDs.
4. Keep exactly the existing trusted permission route, one owner, observer isolation, deadline, cancellation, reconnect and unknown/lost/rejected ACK handling. No extra grant, Host shell safety classifier, automatic re-send or changed permission policy.
5. Test direct/attached actual PTY, multiple simultaneous requests, partial typing + timeout + new request, older alias after reconnect, EOF/Ctrl-C/broken output, explicit decline and no cross-request delivery.

**Exit:** one user selection can produce only the original chosen optionId for the still-live request, or an explicit non-approval result; never a different grant.

### C15R.6.2 — Human-readable native questions and forms

1. Build the smallest **CLI presentation-level projection** of the actual supported native form: original message, request/source identity, field key, provided title/description, actual type, required status, offered values and supported constraints. It is ephemeral display/input data, not a general form engine or new broker.
2. For one free-text field, show the actual question, accept ordinary text without JSON and generate the original typed response envelope; for oneOf/enum show actual offered label/title and map a numeric selection to the **original typed value**, never label; support multi-select arrays only to the extent valid in pinned SDK; for multiple fields provide clear sequential input, correction and explicit skip for optional fields. Do not fabricate a "custom answer" option, fields or defaults.
3. Preserve input bytes/meaning: do not trim significant text whitespace; distinguish omitted optional field from empty string, false and zero; do not implicitly apply defaults; ensure cancel/decline and request switching have explicit unambiguous control syntax so literal words such as "cancel" remain possible answers. Do not insert an extra mandatory authorization/approval stage merely for form presentation.
4. q0/q0_custom: inspect the **actual schema**; merge as alternative answer forms only if the protocol explicitly declares that relation. Never infer it from names, provider identity, tool names or model reasoning. If independent, show separate provided field labels/descriptions and restrictions.
5. Validation must follow the **actual advertised form contract**, not arbitrary JSON Schema. Reuse a compatible validator only if supported by evidence. Distinguish malformed provider schema, truly unsupported wire form, missing CLI widget, invalid user data, and failed/unconfirmed delivery. An inconvenient widget is not a reason to narrow native capability: use a correct low-level entry/fallback when available and completely validated, without bypassing unknown mandatory constraints. Unknown optional annotations/opaque metadata alone must not block a valid form.
6. Report concise errors for field/value and let users correct them while preserving valid draft fields. No semantic rewriting, guessed answer, blind JSON repair or automatic retry. Keep drafts only while their original request remains pending; free on timeout/cancel/disconnect/close. Switching pending questions never changes the target of already entered text.
7. Do not change standard ACP native schema, relay, advertised capabilities or source model behavior merely because the CLI has a new presentation path. If a real capability/adapter mismatch is confirmed, address the technical mismatch at its actual boundary, not via a provider-specific heuristic in shared CLI/core.

**Exit:** ordinary form use needs no knowledge of JSON, q0, UUIDs or ACP; valid values/types arrive unchanged at the original live request. PTY/SDK tests cover single text, actual enum/oneOf, typed numeric/boolean, multi-choice if supported, multi-field required/optional, defaults, unsupported/malformed, timeout, EOF/Ctrl-C, ACK uncertainty, concurrent requests and direct/attached ownership.

### C15R.6.3 — Thinking continuity while readline is active

1. Separate source/block continuity from technical restoration of the terminal input line. Presence of readline must not generate a full Thinking header per native chunk. Allow legitimate source/tool/finding/interaction/gap boundaries; physical single-line continuity is **not** required when events interleave.
2. Reuse the single input owner, active-line redraw and existing serialized/bounded output. Print all **delivered** native fragments in order with established terminal sanitization; no semantic segmentation, semantic compaction, full-reasoning buffering, waiting for model end or new output timers. Small bounded technical coalescing is only an optional last resort if actual PTY evidence proves necessary.
3. After source changes, output gaps, owner close/abort, reset bounded display state correctly. Preserve active typed input amid another Worker's short thinking fragments, tool updates/findings. Do not suspend unrelated Workers, alter provider slots or treat known delivery gaps as complete reasoning.
4. Actual PTY test must check final screen **and scrollback** with concurrent question/permission, partially typed answer, numerous short fragments and new activity; no lost/misattributed reply or repeated headers.

### C15R.6.4 — Readable append-only transcript and truthful final

1. Reuse C15R presentation facts to group per real Controller/Worker Attempt, route/profile/selector and known effort; distinguish selected model from provider-confirmed actual model. Stable source aliases, headers on first display and real switch, nested Thinking/Tools/findings/interactions. No assumed tree/number/type of Workers or fixed tasks.
2. For each native tool use available genuine identity and display fields (title/kind/command/locations/description/status and safe native error). Give short local aliases scoped by operation/attempt/native ID; independent identical-title calls stay distinct. Do not invent correlation when native ID is absent, after gap/eviction, or from similar title/timestamp/command. No requirement of native ID for tool execution. Cache remains bounded in entries **and bytes**; aliases must not be misleadingly reused and must not require an unbounded lifetime registry.
3. Avoid repeating long command/details on unchanged status events; show original detail once on first meaningful update and the corresponding alias on completion/failure. Bound and explicitly mark display truncation, preserve existing sanitization/redaction. Do not parse arbitrary rawInput, reveal unredacted secrets or classify shell commands. Debug can retain safe technical metadata; no full raw tool output by default.
4. Preserve actual model-reported findings without extracting or confirming them from thinking. One original Assessment.answer through authoritative final stdout; separate human-only result boundary and technical summary, with actual Assessment complete/partial/unresolved distinct from lifecycle finished and effect unknown/possible. No duplicate answer, inferred success, altered Markdown or decoration in machine/redirected stdout.
5. Verify representative long transcript with many tools/sources, retries, failed read, sparse completion, optional native skill, reasoning, permission/form, recorded finding, Markdown final and unknown effects in compact/detailed/debug, narrow/color/plain PTY and direct/attached. No cursor rewrite of previous scrollback.

### C15R.6.5 — Historical ACP recovery of known records

1. Keep session.requests ordered turns, exact initial Request/operation.continued association and responseEventId; preserve A→B→A, repeated requestId and known history classification. Reuse the existing journal; no extra persistent transcript, state migration, replay, model calls or invented chronology.
2. Improve fallback beyond whole-Operation seen/unseen: a recorded Operation may contain **some associated and some unassociated** Requests/continuations. Show known missing records as explicitly attributed **recovered information**, not ordinary chronological user_message_chunk or a fabricated native client message. Never resend a historical Assessment as the answer of an unknown specific turn.
3. Unknown response boundary, order across Operations, missing thought/tool bytes and transient events remain unknown; do not sort timestamps as if authoritative. Use only the exact established historicalReply/boundary criteria where recoverable.
4. Test one old Operation without session.requests, mixed associated/unassociated turns in one Operation, several Operations, repeated requestId, ambiguous outcome, older Workers, background updates, large history, aborted session/load; bounded snapshot access and no execution effects.

### C15R.6.6 — Regression, architecture audit, resource checks

1. Add regression coverage to the **existing** acceptance matrix (allocate next IDs when implementing and mark actual status; do not predeclare PASS). Keep existing A77–A86, C12–C15R and F1/F2/teardown/gap/outcome contracts. Actual SDK/subprocess and Linux PTY tests are required in addition to pure unit tests.
2. Verify original answer authority, owner isolation, rejection/lost/unknown ACK with no blind resend, cancellation provenance, independent accepted Workers during Controller failure, native plan/skills/permissions, exact history, stdout machine fidelity, one final, bounded delivery and output failure. Do not weaken tests to fit a visual target.
3. Compare headless, CLI compact/detailed/debug, ACP inline/notices and slow/closed consumers using **equivalent scripted capabilities, user inputs and deterministic provider responses**; do not require identical nondeterministic native tool choices, token usage, interleavings or scheduling. No UI-driven model calls or different execution prompts/Decision/Action/provenance/resource ledger for the same inputs.
4. Measure first useful output, total deterministic fixture time, displayed lines/bytes, memory retained in tool cache/form drafts, large forms and many concurrent interactions, long streaming, slow/broken Writable and session/load costs against the verified C15R baseline. Preserve existing limits; add no execution limits for display or performance instrumentation subsystem. Diagnose material regression rather than inventing a target throughput.
5. Run full current mandatory CI: locked npm install, spec/checkJs/boundaries, foundation/core/provider/integration/acceptance suites, actual Linux PTY, Nix flake/build/clean package/public imports/NixOS evaluation/release/checksum/lock integrity. Record exact implementation SHA, run ID/counts, red/green witnesses and exclusions; historical 476/476+7/7 is not evidence on new code.
6. Audit and document runtime ownership: presentation has no effect on invocations, accepted work, native environment/tool inventory/skills, model context, grants, deadlines, budgets, evidence, scheduling or Coordinator lifecycle. Update normative docs/DECISIONS only where changed behavior actually warrants them; no mechanical updates to every file.

### C15R.6.7 — Native re-acceptance, handoff and limits

1. Identify **installed** RO binary and its implementation commit (not merely git checkout), Node/Nix package, active config, actual provider/ACP SDK/OpenCode/Zed versions, model/effort/permissions and workspace. Never publish credentials, private project files or full raw prompts.
2. Repeat user's real CLI scenario (model asked to use native changed skill to describe last commit) in the configured Engee frontend only if authorized and available; collect redacted full visual transcript including actual form/permission flow, ordinary answer and final. Do not force delegation/tool choices or require the model to ask a question.
3. Exercise native form/permission via a genuine available interaction if the model requests one; otherwise use verified actual SDK/PTY scenarios and mark native model question UNVERIFIED, never fake evidence. Run a separate naturally parallel Worker task if achievable; confirm independent progress during interaction. Test installed direct/attached and native Zed/standard ACP: original forms, thinking/tools/native plan, inline default, final once and historical session/load.
4. Separately compare direct provider versus RO for native changed skill availability/actual tool inventory, cwd, configuration, tool request/observations and outcomes. An earlier RO tool id=changed was observed; current identical conditions and exact native request remain UNVERIFIED. Different model tool choices are not by themselves an RO defect. Do not modify skill discovery, replace changed with another skill, force use of skill or alter prompts; confirmed native capability loss is a separate minimal defect with evidence and owner.
5. Preserve independent statuses: engineering implementation, automated regression, installed CLI **visual** acceptance, real model/provider, real graphical client and comparative quality/performance. Unavailable checks remain UNVERIFIED with exact blocker and reproducible command/procedure, not automatically PASS. A86 and prior native obligations remain open until actually tested.
6. Implement .0–.7 as logical commits, STATUS at checkpoints, updated single acceptance matrix and relevant docs/CLI help/CHANGELOG when behavior lands. Final handoff: exact SHAs/CI, protocol mapping, red/green outcomes, full representative PTY transcript, native examples or blockers, measurements and architectural audit. No merge to master without explicit instruction.

**Execution directive:** On receiving this planning checkpoint, start with C15R.6.0 if STATUS still lists it as next; continue all engineering stages through .6, then native acceptance/handoff .7 to the extent the real environment permits. Do not stop after research or document preparation. Do not mark C15R.6 implemented until actual code, tests and evidence exist.


## C15R.6R — CLI Interaction Correctness & Presentation Completion (IMPLEMENTING)

**Review baseline** `804bbaa24f606dc5be79a27db303489dda1dd27f`. **Historical CI** 43957276791 PASS (485 root, 9 real Linux PTY), but code review found an unbounded V8 pattern execution and six presentation/fidelity gaps. Corrective assignment does not authorize new core semantics or an agent execution scheduler.

- **.0 Baseline:** confirm actual HEAD, SDK 2.4.0 restricted ACP form contract, and source/red witnesses for pattern backtracking, >128 fields, compact metadata, notices-orphans, blank Enter, `__proto__`, source attribution.
- **.1 P1 safe validation:** provider-controlled regex runs outside main event loop with bounded per-validation duration/resource/ownership and cancellation, no false accept or mislabeled mismatch, including `:json`.
- **.2 form fidelity:** remove arbitrary field-count UI rejection, sequential bounded display, original typed values including empty/false/zero and special keys; keep native schema and trusted delivery unchanged.
- **.3 tool/question presentation:** compact real locations and descriptions once, native provenance of questions without invented roles/identity; debug retains identifiers.
- **.4 history:** recover known orphan Request and continuations independently of inline/notices, without assuming chronology, answers or execution replay.
- **.5 regression/CI:** targeted negative/positive, SDK, PTY, complete CI and resource/golden audits, extend sole acceptance matrix after A93.
- **.6 native/handoff:** exact implementation and CI SHA, representative PTY, installed client/provider comparison or explicit UNVERIFIED; update STATUS, implementation plan and normative docs only for changed behavior. No master merge.

**Invariants:** model-first; no Host interpretation/answering, provider/tool/skill filtering, extra permissions, secondary workflow lifecycle, synthetic environment or host scheduling of model work. UI uses existing trusted request identity, deadline, cancellation and ACK. Form worker, if used, is an isolated *technical input validation task only*, not an agent or project sandbox.
