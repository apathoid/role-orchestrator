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
