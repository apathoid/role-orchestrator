# C15R-GUI — Graphical ACP Presentation Refinement

**Статус:** IMPLEMENTED; exact final-SHA engineering CI pending; external native Zed acceptance — UNVERIFIED.
**Ветка:** `feature/interactive-ux`. **Planning baseline:** `420358abeea67a4cf40cfb7ae4fa433cd34914e9` (includes approved planning document).
**Область:** standard external ACP Host presentation, необходимые tests/docs. CLI и execution не перерабатывать. **Не merge в master.**

## Цель и исходный контракт

Улучшить графический ACP transcript Role Orchestrator: читаемая атрибуция Controller/Workers, фактический технический progress, модельный native plan, действительные findings, нативные вопросы/permissions и оригинальный final. Не создавать отдельный GUI, Zed extension, новые сущности Host или искусственный workflow. Пиксельное сходство с макетами не является критерием.

Перед изменениями прочитать `AGENTS.md`, `.agents/REASONING.md`, применимые `.agents/engineering/`, `docs/roadmap/STATUS.md`, `IMPLEMENTATION_PLAN.md`, `C15_PRESENTATION_EXPERIENCE.md`, `C15R_PRESENTATION_QUALITY.md`, `C15R_TRANSCRIPT_EVIDENCE.md`, `C14_CLIENT_UX.md`, `C13R_C14R_INTERACTION_RELIABILITY.md`, `NATIVE_ACCEPTANCE.md`; нормативные `docs/PRODUCT.md`, `ARCHITECTURE.md`, `CONTRACTS.md`, `EXECUTION.md`, `PROVIDERS_AND_CONFIGURATION.md`, `CONTEXT_AND_RECOVERY.md`, `DIAGNOSTICS.md`, `DECISIONS.md`; единственную `tests/ACCEPTANCE_MATRIX.md`. Актуальные владельцы определять по текущему checkout.

**Подтверждённая база на planning SHA (перепроверить):**
- `src/hosts/presentation.js`: `acpActivity()` пропускает Controller `plan` только в `mode !== 'compact'`; `acpOwnMessage()` создаёт собственные `agent_message_chunk` с `RO ·` и Markdown escaping; `acpExecutionInline()` отображает lifecycle и registered findings.
- `src/hosts/acp.js`: native activity и own progress отправляются через один bounded delivery transport; есть prompt/turn fencing и cancellation/finish.
- `src/hosts/acp-history.js`: user turns из `session.requests`, technical facts из имеющегося journal; ephemeral native Thinking/tools/plan не реконструируются.
- `src/application/execution-facts.js`: read-only trusted historical execution attribution.
- `@agentclientprotocol/sdk@2.4.0` и ACP v1: сверить реальные typed updates и client capabilities, не предполагать ACP v2.

## Архитектурные инварианты

1. **Model-first:** модель определяет смысл, стратегию, план, специалистов, tools/skills, findings, interpretation evidence и качество результата. Host только координирует и отображает существующие факты. Прямой ответ без плана/Workers — нормальный путь.
2. **Provider-, workflow-, environment-, client-agnostic:** никаких assumptions о Git, FS/OS, типах работ, именах ролей/моделей, последовательности стадий или Zed внутри core. Модель естественно исследует реальную изменяемую среду; native AGENTS.md, skills, scripts, MCP/tools и provider subagents не подавляются. Нет Host isolation, workspace scanning или дополнительных permissions.
3. **Presentation-only:** не менять prompts, Decision/Outcome/Invocation, reasoning mapping, Coordinator, scheduling/budgets, context/evidence, grants/ACK, cancellation/recovery, provider-native output и адаптеры ради UI. Изменения вне hosts presentation допустимы только по отдельно доказанному transport defect, а не ради красивой карточки.
4. **Никакого synthetic content:** не создавать Host plan, fake native tool/thought/call, forced reporting, guessed finding, искусственный global Worker plan, event-based workflow или второй UI journal. Не извлекать семантику regex/ключевыми словами из текста модели.
5. **Native fidelity:** оригинальный model-authored Markdown, `Assessment.answer`, explicit public messages, native tools/thinking/plan, permissions/forms передаются без анализирующей переработки. Compact ограничивает только собственные RO technical messages, не доступность нативных возможностей.
6. **Truthful provenance:** terminal `completed` не равен model success; unknown сохраняется; author/profile не равен произвольно угаданной роли; claim — утверждение модели, не Host verdict. Пустые uncertainties не означают подтверждения.
7. **Bounded transport:** не блокировать Coordinator, Workers или provider slots; никакой renderer ACK, unbounded cache, нового scheduler/replay. Live best-effort и durable history принципиально не одинаковы.

## GUI.0 — Reality check: standard ACP, Markdown и Zed до форматтера

- Зафиксировать текущий HEAD/diff, расположение владельцев: `presentation.js`, `acp.js`, `acp-history.js`, `acp-relay.js`, actual SDK/fixtures, resource lifecycle.
- Сопоставить исходные типы: Controller/Worker dispatch, native Thinking/tools/plan, explicit message, recorded finding, question/permission, waiting/cancel/unknown, final, history → standard ACP update → реально наблюдаемое client UI. Для каждого указать provenance/capability/сохраняемость и ограничения.
- При доступном реальном Zed изучить `dev: open acp logs`, capabilities и redacted `session/update`; проверить native `plan`, `messageId`, `_meta.roleOrchestratorSource`, `inline/notices`, **неизменённый model-authored Markdown** и очень простую trusted Markdown-разметку *собственных* RO messages. При наличии второго совместимого ACP-клиента сравнить.
- **Пока польза форматирования не подтверждена, не разрабатывать Markdown builder/parser.** Если клиент ничего не выигрывает, оставить безопасный plain text. Никогда не обрабатывать модельный Markdown ради UI.
- Сохранить redacted before screenshots/protocol evidence. Если реальный клиент недоступен, отметить native visualization UNVERIFIED, а не считать SDK fixture графической приёмкой.

**Выход:** обоснованная минимальная change map. Не добавлять proprietary ACP extension.

## GUI.1 — Controller native plan в compact (узкий P1 fix)

Снять только фильтр `mode !== 'compact'` для действительно полученного typed Controller native `plan` в существующем `acpActivity()`. План должен идти через прежний standard ACP `plan` при `compact`, `detailed`, `debug`; исходные entries/statuses/order/scoped provenance и один Controller plan slot сохраняются.

Не искать plan в обычном тексте; не делать Host plan из Actions/dependencies; Worker plans не объединять; отсутствие плана не компенсировать; никаких prompt/schema изменений. На повторной попытке не приписывать прошлый план новому Controller; проверить фактическую клиентскую семантику slot/retry, не симулировать unsupported reset.

**Regression:** plan present/absent, Worker-only plan, updates/retries, missing IDs, session/load, three modes; ни одного дополнительного model call/Decision.

## GUI.2 — Короткие собственные ACP progress messages

Показывать факты из существующих typed execution/journal records: accepted, actual dispatch с objective когда доступен, значимые waiting/error/rejection, terminal/late/cancel/unknown, recorded finding, operation status. Не выдавать `reported terminal=...`, все UUID/reasonCode и `Invocation dispatched` как непрерывный технический лог в compact; неизвестность/ошибки не скрывать.

Использовать минимальную pure projection по **типу структурированного факта**, не по строкам `formatExecution()` и не по тексту модели. `detailed` — больше полезных исходных атрибутов; `debug` — выборочные ID/reason/sequence, но не копия inspect/trace/export и не raw provider dump. Без нового event/state type, синтетических «важных» стадий, severity inference или принудительных отдельных карточек. `Assessment.answer` не дублировать.

Own message stable identity использовать только из фактических trusted refs; `profile/role/model selector/effort` писать только когда известны; requested model/effort не считать actual provider confirmation.

## GUI.3 — Максимально тонкий Markdown, только RO-owned text

Проверка GUI.0 определяет, нужен ли вообще форматтер. Если нужен, допустимы **малые фиксированные trusted templates** (например, источник + технический факт) с контекстным escaping недоверенных `objective`, `role/profile labels`, `claims`, `errors`, `paths`, HTML/links/control/bidi и явной display-only truncation.

**Запрещены Markdown parser/AST, распознавание headings/lists/findings/semantic blocks, разбор, повторная сборка или усечение model-authored ответа**, в том числе raw `Assessment.answer` и explicit native messages. Это самостоятельные данные модели; Host их не интерпретирует, не теряет и не меняет. Не создавать универсальный renderer. Проверить multiline/code fences/backticks/spoofed source/links/Unicode и original byte equivalence на wire/output/journal.

## GUI.4 — Правдивая attribution Controller/Workers

Использовать существующие `ExecutionFact` / historical Attempt / native activity scope: invocation kind, arbitrary roleId (если есть), actual profileId, attempt identity/ordinal, модельный objective, request route и effort с точным provenance. Два Workers одной роли/profile должны быть различимы, retry и возвращение источника не создают нового факта dispatch.

Сохранять `_meta.roleOrchestratorSource`. Допустим короткий own message на **реальный dispatch**, но не перед каждым Thinking chunk; Thinking/tool fragment не переписывать и не изображать Worker через fake tool_call. В графическом клиенте, игнорирующем metadata, чередующиеся мысли могут остаться визуально разобщёнными — **client limitation**, не повод переделывать исполнение.

Attempt outcome — технический результат попытки, а не проверка корректности решения/кода.

## GUI.5 — Findings без собственной semantic authority Host

Отображать только model-authored live reports (когда тип действительно подтверждён) и/или recorded durable findings с исходными author/claim/subject/uncertainties/supports/supersedes/provenance. Краткий нейтральный заголовок **«Находка · автор»**; author является actual field (возможно profile ID), не придуманной Reviewer-role. «Зарегистрирована» обозначает только confirmed journal commit, не семантическую проверку.

**Не повышать и не понижать** уверенность/категоричность утверждения, не назначать severity/confidence/verified, не толковать пустые uncertainties как проверку, не смешивать finding с Controller Assessment. Не извлекать finding из Thinking/произвольного Markdown; не дедуплицировать по совпадению текста, а только по реальному identity. Отображать original uncertainties без Host интерпретации.

## GUI.6 — Native fidelity, performance, history, session lifetime

- Общая bounded ACP transport queue остаётся; нет ожидания рендера/ACK, новых scheduler/queues. Сравнить на одинаковых deterministic fixtures до/после: native events delivered, dropped/unconfirmed/gaps, bytes, first useful update и drain/finish duration при параллельных Thinking/tools, больших own messages, медленном или падающем клиенте. Не допускать material regression из-за декоративного объёма; сначала сокращать own progress, а не менять приоритет исполнения.
- Native plan/thought/public message/tool/permission/form проходят прежний typed путь; mode не влияет на их разрешение/полномочия. `inline` default и capability-gated `notices` не дублируют один факт; notices не являются durable history или actionable result.
- Не менять cancellation/turn fences, operation-scoped old Worker permissions, response boundaries, unknown effects и independent Worker completion.
- `session/load`: прежние `session.requests` + journal; проверить A→B→A, old Worker, late outcomes, repeated load/reconnect, missing boundary, historical classification и no duplicate final. Не reconstruct unpersisted native Thinking/tools/plan, не угадывать global chronology, не replay external actions. История не новый model context/evidence.

## GUI.7 — Regression, CI, actual client acceptance

Единственная матрица `tests/ACCEPTANCE_MATRIX.md`: **A116–A122 PLANNED**. Добавить соответствующие tests/fixtures, не ослаблять C13/C14/C15/C15R/C15R-UX. Сценарии: direct без делегирования/плана; native Controller plan three modes и Worker-only plan; несколько одинаковых Workers, native IDs/thinking/tools; source unknown/retries; original Markdown/long injection; attributed finding without inferred verdict; native question/permissions/ACK; invalid proposal, cancel, supersede, disconnect, gap, unknown/late; inline/notices capabilities; A→B→A session/load, единственный final. Показать before/after execution equivalence: Decisions/Actions/Invocations/Outcomes/ledger/context/evidence/authority unchanged.

Настоящий Zed acceptance: установленная версия, RO exact SHA, pinned SDK, provider/model/capabilities, реальные redacted logs, before/after screenshots для direct/plan/parallel Workers/finding/input/error/final/history. **Разделять:** RO-wire PASS, client-render PASS и client limitation; недоступное — UNVERIFIED с причиной. Второй совместимый client, если доступен. Не требовать от стохастических настоящих моделей идентичных стратегий.

Полный mandatory exact-SHA CI: locked npm/spec/checkJs/import boundary, foundation/core/provider/ACP/integration/acceptance, applicable Linux PTY, clean package/outside-checkout install, Nix flake/build/install/NixOS evaluation, release/checksum/lock checks. Прошлые PASS не подтверждают новый HEAD.

## GUI.8 — Docs, handoff, exit

По итогам реализации обновить `STATUS.md`, `IMPLEMENTATION_PLAN.md`, этот roadmap, actual tests/единственную acceptance matrix, применимые normative docs/DECISIONS/CHANGELOG **только по реальным изменениям**, без дублирующих спек. Приложить baseline/final SHA, commits, changed paths, протокольный mapping, результаты исследования клиентского Markdown (или обоснованный отказ от builder), plan regression, оригинальность model output, provenance findings, queue loss/latency, live/history integrity, exact-SHA CI, Zed/screenshots/second client или UNVERIFIED.

**Exit:** реальный Controller plan доставляется в compact, компактный factual progress, оригинальное model content и native capabilities не изменены, никаких Host semantic gates или выдуманных widgets/планов, существенной transport regression нет. Визуальное поведение конкретного клиента считается подтверждённым только после реального наблюдения. **Без merge в master.**

## Implementation disposition (2026-11-19)

GUI.0 SDK/source inspection: pinned ACP SDK 2.4.0/v1; official v1 `plan` is a standard typed update, not the v2 `plan_update`. Zed Markdown behavior and screenshots were **not** observed; no formatter/parser or Zed-specific branch was introduced. Source events: native Controller `plan` and reasoning/tools/messages via existing scoped ACP updates; own progress via existing execution subscription; finding only from committed record; original final from `operationReply`; history from `session.requests` + journal. Live native events are never recreated on load. Only RO-owned notices/inline messages are escaped. Exact event/source mapping is tested in `tests/integration/presentation.test.js`, `host-acp.test.js`; bounded delivery, cancellation, input, and A→B→A remain covered by existing integration suites.

GUI.1–GUI.5 code: `src/hosts/presentation.js` only. GUI.6: `src/hosts/acp.js`, `acp-relay.js`, `acp-history.js`, `application/execution-facts.js`, provider/core/CLI unchanged. GUI.7: A116–A122 tests and specification range updated, CI link/SHA tracked in [STATUS](STATUS.md). GUI.8: status, single acceptance matrix, architecture decision and changelog updated. A real Zed external-client visual comparison, exact client version/negotiation and redacted before/after wire logs, alternate client, and latency/queue byte-loss measurement remain **UNVERIFIED**. No synthetic ACP plan reset or inferred confirmation is claimed. Native test instructions are in [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md).
