# C15R-UX — CLI Visual Fidelity & Markdown Rendering

**Статус:** ENGINEERING CI VERIFIED ON `7b5a29faf523ffe1652cfaa2f55f4a8b23576254` ([full mandatory CI 44187637516](https://github.com/apathoid/role-orchestrator/actions/runs/44187637516), 505 root, 10 PTY, Nix) / REAL NATIVE UNVERIFIED. **Ветка:** feature/interactive-ux. **Planning baseline:** bf117d405bf31cfc577021cb6cb12e2091df2b4b. **Scope:** только presentation refinement CLI. **Текущий следующий шаг:** installed native visual/ACP acceptance (A108, UNVERIFIED); engineering .0–.7 реализованы и проверены CI, .8 документы/handoff выполнены. Не вливать в master без отдельного поручения.

Этот этап утверждён после ревью визуального состояния C15R.6R и дополняет [C15](C15_PRESENTATION_EXPERIENCE.md), [C15R](C15R_PRESENTATION_QUALITY.md), [C14](C14_CLIENT_UX.md), но не заменяет их контрактов. Предыдущий C15R.6R инженерно проверен на `8b9be91a96f4657dd861647da13808f86f548e93` (CI 44035000221, 500 root / 9 actual Linux PTY); это **не** проверка C15R-UX. A100 и прежние реальные native obligations остаются UNVERIFIED.

## 1. Результат и смысл задачи

Получить читаемый, цветовой и композиционно близкий к принятым макетам **append-only** CLI transcript: различимые Controller/Workers, native streaming thinking, компактные native tools, человеческие native questions/permissions, реальные findings/status и структурированный Markdown authoritative final. Обычный текст модели не получает придуманной Host структуры. Модель может сразу ответить, выбрать любое число/наименования специалистов или не использовать tools — UI не диктует workflow.

Это **только оформление уже существующего исполнения**. Никаких новых model turns, подсистем принятия решений, пересказов reasoning, извлечения findings из текста, обязательной структуры Assessment.answer, заставляющих модель генерировать Markdown инструкций, искусственной среды, workflow stages или Host-классификации shell-команд.

### Обязательный контекст перед кодом

Прочитать `AGENTS.md`, `.agents/REASONING.md`, применимые `.agents/engineering/`, `docs/roadmap/STATUS.md`, `IMPLEMENTATION_PLAN.md`, `C15_PRESENTATION_EXPERIENCE.md`, `C15R_PRESENTATION_QUALITY.md`, `C14_CLIENT_UX.md`, релевантные C13/C13R, `docs/PRODUCT.md`, `ARCHITECTURE.md`, `CONTRACTS.md`, `EXECUTION.md`, `CONTEXT_AND_RECOVERY.md`, `PROVIDERS_AND_CONFIGURATION.md`, `DIAGNOSTICS.md`, `DECISIONS.md`, `tests/ACCEPTANCE_MATRIX.md` и `docs/roadmap/NATIVE_ACCEPTANCE.md`.

Подтвердить реальных владельцев в `src/hosts/cli-input.js`, `cli-form.js`, `cli-presentation.js`, `cli-tools.js`, `presentation.js`, `cli.js`, `src/main/cli.js` и существующих PTY/integration fixtures. Не считать указанные имена файлов требованием создать новый API или переместить код.

## 2. Неизменяемые архитектурные границы

1. **Model-first:** модель определяет стратегию, план, делегирование, использование tools/skills/scripts/subagents, трактовку observations, findings и финальный ответ. Host владеет только технической координацией, разрешениями, provenance и достоверными фактами. UI не влияет на Invocation, Decision, Outcome, evidence/context, budgets, effort, permissions, cancellation или scheduling.
2. **Provider/workflow/environment-agnostic:** нет предположений о Git, shell, файлах, проектной структуре, AGENTS.md в целевом workspace, известных skills, названиях Worker roles или наборах native tool kinds. Не добавлять Host skill scanning, подмену недоступных skills, фильтрацию provider-native capabilities или искусственную среду; не менять нативные subagents.
3. **Один lifecycle:** renderer использует доставленные ActivityEvents, execution facts, trusted source/request identity и authoritative Operation state. Только bounded ephemeral presentation state; никаких новых журналов, durable UI state, второго scheduler, таймеров для семантической группировки, скрытых inspect/provider calls, text-based correlation или повторного исполнения неизвестных эффектов.
4. **CLI transport:** append-only scrollback; один текущий input/readline owner; без full-screen TUI, alternate-screen, REPL, постоянной status line и перерисовки истории. Вывод не блокирует Coordinator и независимых Workers сверх существующих bounded transport guarantees. Сохранить direct/attached, ACK/deadline/cancel/reconnect, stdin/stdout/stderr contracts.
5. **ACP / machine fidelity:** не менять wire protocol, ACP native plan/thinking/tools/forms/permissions, session/load, default inline progress, JSON/machine output, redirected stdout, raw state/context, full исходные provider payloads и authoritative answer. Debug — представление *доступных доставленных данных*, а не обещание полного raw trace.
6. **Достоверность:** tool completed не равен успеху команды; provider report не равен Host-observed proof; delivered reply не равен confirmed ACK; recorded finding не равен доказанной проблеме; finished не равен overall success. Ошибки, gaps, unknown effects, cancellation, unresolved status показывать честно.

## 3. Цвет и visual identity — утверждённое решение

**Единственная заранее известная исполнительская сущность — Controller.** Фиксировать его акцент, ориентир `#86B6FF` (голубой). **Все остальные роли, независимо от имени**, получают цвет из ограниченной предопределённой палитры. Никаких специальных правил для Explorer, Reviewer, Coder, Planner или других строк и никакого исчерпывающего enum ролей.

- Выбор цвета детерминированный по фактически полученному `roleId` (например, небольшой стабильный hash → индекс палитры); не зависеть от порядка появления, номера Worker, конкретного провайдера, языка текста, изменяемой map или семантики имени. Повторное появление той же роли сохраняет цвет. Совпадения цветов между разными ролями допустимы: видимые role labels + уникальные Attempt aliases обязаны различать источники без цвета.
- Признак Controller брать из trusted `invocationKind=controller`, не из сравнения произвольного `roleId` со словом "Controller". Для Worker без подтверждённого roleId нейтральный безопасный fallback; не изобретать роль.
- Ориентиры Worker палитры: `#B9A0F5`, `#7FCEA0`, `#6FCBD4`, `#E3A9E7`, `#D6C582`, `#C4A9F0`; уточнить контраст на тёмном терминале. Палитра — presentation only, не capability, authority, assignment или характеристика профиля.
- Вопросы/permissions/findings: янтарный accent `#F1BC65`; основной текст — нейтральный светлый; labels/metadata/Thinking — приглушённые; ошибки/confirmed success/unknown имеют различимые состояния. Не окрашивать целые формы и ответы цветом заголовка.
- Truecolor / 256 / 16 цветов только при подтверждённой поддержке; `NO_COLOR`, `TERM=dumb` и plain fallback без декоративных escape sequences. Цвет не заменяет текстовые признаки статуса/источника.

## C15R-UX.0 — Baseline, ownership и RED visual contract

**Приоритет P1.** Зафиксировать актуальные branch/HEAD/CI, историю C15R.6R и подтверждённые native gaps; не брать CI на старом SHA за результат новой реализации. Проследить путь ActivityEvents → CLI renderer и отдельно `Assessment.answer → src/hosts/cli.js → stdout`, summary через `src/main/cli.js`. Проверить input owner, sanitization и bounded delivery. Получить baseline transcript direct, two actual concurrently dispatched Workers, interleaved thinking/tools, native multi-field form, permission, recorded finding, unknown/gap, Markdown final; покрыть compact/detailed/debug, color/plain. Создать red/golden assertions, проверяющие композицию, source switching, сегменты, истинность и исходные payloads, не случайные пробелы/цветовые коды каждого терминала. Native недоступность фиксировать UNVERIFIED.

**Exit:** владельцы состояния/вывода ясны, baseline и проверяемые наблюдения сохранены, инженерный scope подтверждён.

## C15R-UX.1 — Minimal trusted styled text segments

**Приоритет P1 UX.** Добавить маленький presentation-level способ выводить сегменты с различными визуальными стилями внутри одного логического сообщения. Reuse существующий terminal writer и readline; не создавать отдельный event bus/dispatcher/renderer lifecycle.

- Разделить нейтральное содержимое, source headers, question/prompt accents, metadata/footer, finding/status и technical detail. Формировать trusted ANSI **после** sanitization каждого недоверенного фрагмента; защищать OSC/CSI/bidi/control injection, включая split chunks; reset стилей корректный.
- Единица атомарности — готовый физический display fragment в существующей точке сериализации terminal writes, **не** накопление всего Thinking, формы или цепочки событий. Не менять event boundaries/chunk identities, не вводить timers, per-Worker очереди или unbounded Promise chains. Сохранить scrollback, input partial typing, bounded failure/drain, fallback.
- Реализовать правила цветов из §3 без hardcoded Worker role names; подтвердить, что попытки одной роли остаются отдельно атрибутированными.

**Exit:** отдельные стили в одном сообщении, нет новых источников истины и нарушений input/streaming.

## C15R-UX.2 — Native questions и permissions

**Приоритет P1 UX.** Отображение: янтарный source/question header и actual prompt, нейтральный original question + options, приглушённые type/required/optional/constraints/help/footer, локальные validation errors, короткое подтверждение **только действительно известного уровня доставки/ACK**.

- Использовать существующие `projectForm`/draft/validation и original field titles, messages, descriptions, typed values, option IDs. Не угадывать связи полей по `q0` / `q0_custom`, не вводить universal forms framework, не менять native schema, не подставлять defaults и не терять пробелы/false/zero/empty/omitted.
- Не скрывать необходимые для корректного ответа ограничения при display truncation. Для длинных описаний доступен безопасный способ увидеть фактически полученную информацию без потери ответа и без дополнительных model calls.
- Сохранить `:back`, `:skip`, `:cancel`, `:decline`, `:json` и существующую маршрутизацию по request identity; команда зависит от действительного типа запроса, а не от имён полей. Permission явно отличается от question; действие, scope, original option labels/IDs всегда различимы. Не подменять разрешения и не давать новых grants.
- Footer только из фактически известных Attempt/request states; "продолжает работу" не выводить из отсутствия terminal event. Gap/stale state показывать как неопределённость или опускать необязательный footer.

**Exit:** вопросы и permissions понятны без знания JSON/ACP, исходные ответы и authority не меняются.

## C15R-UX.3 — Source hierarchy, Thinking и параллельность

**Приоритет P1 UX.** Сделать видимые заголовки Controller/произвольных Workers и реально отличающиеся акценты; source headers при первом dispatch/появлении и фактическом switch, не для каждого native chunk. Не объявлять будущие Workers и не ждать запуска всех перед первым выводом; `2 workers started` только после двух фактических запусков, без Host-generated plan/dependency tree. Сохранять уникальные Attempt aliases, retries, profile/model selector vs provider-confirmed model и known effort vs native/unknown.

Thinking — только реально выданный нативный поток; ни сокращения, ни summary, ни выделения findings из reasoning, ни задержки/искусственного объединения. Поддерживать continuation при произвольных chunk boundaries, межпоточное чередование, gap и readline. Для outputs без native thinking не создавать фиктивный блок.

**Exit:** transcript выглядит как ход действий независимых источников, без нарушения provenance или natural model behavior.

## C15R-UX.4 — Compact tools и lifecycle noise

**Приоритет P2 UX.** Убрать лишние generic pending/дублирующиеся status строки из compact там, где это допускает действующий C15R-контракт. Первый содержательный actual tool update показывать немедленно, без ожидания следующего события. Отображать genuine state transitions и terminal/failure/cancel/unknown, same native IDs; не группировать по title/command/semantic similarity и не создавать completion при отсутствии события.

- Compact command/location/description — коротко, с явной `[display truncated]`; original native payload не изменять. Detailed/debug — больше безопасных **доступных** метаданных, но действующий `boundedText`/cache не обеспечивает гарантии полной команды. Не расширять observation retention ради UI.
- Raw `interaction.requested`, `INTERACTION_ANSWERED`, `permission.resolved`, `Assessment recorded`, event IDs/reason codes — **только debug**, если нормальный пользовательский блок уже передаёт факт. Detailed не должен повторять сырые lifecycle names. В compact оставить meaningful questions/permissions, reply receipt when proven, real starts/outcomes, warnings/gaps/unknown, recorded findings и concise final.
- Любая dedup — исключительно presentation-only по подтверждённой attempt/request/native identity и идентичному уже показанному display transition. Не фильтровать ActivityStream, ACP, evidence или machine data. Проверить isolated generic-only tool, sparse status, missing ID, out-of-order/late/conflict, eviction/gap.

**Exit:** меньше визуальных строк, не меньше исходных событий и не больше ложных утверждений.

## C15R-UX.5 — Safe Markdown rendering authoritative final

**Приоритет P1 UX.** Модель полностью определяет текст/структуру результата. Если в `Assessment.answer` присутствует Markdown, отобразить его в человеческом **TTY** как заголовки, bold/italic, списки, inline/fenced code, цитаты, разделители, ссылки. Если обычный текст — не создавать искусственных headings/findings/tests/recommendations.

- Интегрировать исключительно в действующий authoritative output path `src/hosts/cli.js` и согласовать с deferred summary в `src/main/cli.js`. Не выводить final повторно из `cliPresentation.notice` или другого ActivityEvent. Markdown formatter применяется только к действительному answer, не автоматически к waiting/status/error fallback.
- Не менять `Assessment.answer` в state/context и байты redirected/machine stdout, `--format json`, `--output`, diagnostics, ACP/native tool/Thinking. Учитывать `NO_COLOR` и plain readability в интерактивном терминале.
- Без исполнения HTML/script/terminal escapes/links; sanitize untrusted input до trusted styles, не прогонять styled output через `terminalText` повторно. Code fences и Unicode/переносы сохраняются, malformed markdown → безопасный текст. Выбирать ограниченный, корректный parser вместо хрупких regex, без избыточного framework. Bounded CPU/memory; большой final → безопасный plaintext fallback **без потери ответа**, не display-truncation authoritative answer.
- Итоговый answer печатается **ровно один раз**, перед отдельной сводкой, когда existing terminal/stdout ordering позволяет. Не обещать cross-stream ordering для разных физических устройств, не менять exit/ACK.

**Exit:** human TTY красиво отображает исходную структуру; raw machine output и факт исполнения неизменны.

## C15R-UX.6 — Findings, factual status и final summary

**Приоритет P2 UX.** Для настоящих reported/recorded findings показывать автора, исходный claim, subject/supports/supersedes/uncertainty при наличии, без автоматического severity или status confirmation. Янтарный только акцент, основной текст нейтрален.

Краткие snapshots на границах native question, фактических существенных переходов или completion — только по delivered/authoritative известному состоянию. Без polling, live redraw, предположений об активности Workers из молчания. Finished/assessment/attempt counts различать; `operation.finished` не равно complete success, `tool completed` не равно command succeeded, uncertain effects и unresolved/partial/gap остаются заметными. Не делать Host-generated semantic summaries.

**Exit:** короткая правдивая сводка без технического спама и ложных "success".

## C15R-UX.7 — Regression, resource и архитектурная проверка

**Приоритет P1 correctness.** Узкие red/green fixtures на каждую затронутую поверхность, затем full acceptance.

- Golden transcript/actual Linux PTY: direct Controller, arbitrary-role parallel Workers, source-switch/retry, chunks и newline boundaries, native form с несколькими полями/free text, native permission (scope/ID), concurrent question+Worker, recorded finding uncertainty, same-title different native tools, sparse/unknown/failed/out-of-order, delivery gap/partial/reconnect, answer with Markdown and without Markdown, long code fences/path/command.
- TTY truecolor/256/16, `NO_COLOR`, `TERM=dumb`, narrow/wide, кириллица/Unicode, readline с частично введённым ответом, broken/slow Writable, EOF/cancel, direct/attached and stdin/stdout/stderr ownership. Проверять смысл, прочность структуры и отсутствие ложных статусов, не пиксельное совпадение.
- Deterministic **before/after execution equivalence**: user input, Controller decisions, Invocation/prompt, Actions/Attempts, native options and ACK, skills/tool availability, Outcome/Assessment/evidence, budgets/cancel/unknown, machine bytes; никакого принуждения к model workflows. Отдельный non-Git workspace и **произвольные roleId/native tool kinds**, отсутствующий native reasoning. Две роли могут совпадать по цвету, но не терять текстовую identity.
- Измерить first useful output latency, styled overhead, 1000+ native tool updates, long thinking/Markdown, slow/blocked writer, bounded display cache/cleanup. Измерение не должно вводить model calls или новую обязательную performance infrastructure.
- Запустить полный действующий mandatory CI по AGENTS/STATUS (locked npm, checkJs/import boundaries, suites, actual Linux PTY, package/public imports, Nix flake/build/install/NixOS evaluation/release/checksum). PASS указывать только для exact SHA фактического запуска. Сравнить с историческим baseline, не выдавать его за новый PASS.

**Exit:** A101–A107 подтверждены отдельными тестами/измерениями или точно названы FAILED/UNVERIFIED; execution invariants сохраняются.

## C15R-UX.8 — Native visual acceptance, documentation, handoff

Обновить `STATUS.md`, `IMPLEMENTATION_PLAN.md`, единственную `tests/ACCEPTANCE_MATRIX.md`, применимый `NATIVE_ACCEPTANCE.md` и `CHANGELOG.md`, если действительное поведение для пользователя изменилось; нормативные документы — только при реальном изменении внешнего контракта. Не переписывать историю C15/C15R и не закрывать A100 задним числом.

Запустить установленный CLI на реальном provider/config/workspace, получить redacted визуальный transcript вопроса/permissions/финала, естественно возникающей параллельности (не принуждать модель) и ACP/Zed comparison при доступности. Сравнить с прежними A100/A93/A86 без утверждения, что один синтетический SDK/PTy тест доказывает реальную работу модели. Если среда недоступна, A108 остаётся **UNVERIFIED** с конкретным blocker и исполнимой инструкцией.

Финальный handoff: implementation commits/HEAD, до/после representative transcripts, точный CI run, test matrix, measurement, Markdown/raw fidelity, identity and input safety, архитектурный audit, список native UNVERIFIED. Не merge в master.

## 4. Acceptance / non-regression gate

Проверить: (1) model-first и неизменный Controller prompt/decision; (2) самостоятельность Workers без Host scheduling; (3) skills/tools/scripts/environment discovery без фильтрации/подмены; (4) provider/workflow/environment/client agnosticism; (5) только bounded ephemeral presentation state; (6) exact native permission/form identity & response values; (7) original Assessment.answer, machine byte fidelity и final once; (8) distinction reported/completed/verified/unknown; (9) append-only readline и independent execution при slow renderer; (10) отдельные статусы engineering CI, actual PTY, installed native/provider, graphical ACP и comparative acceptance.

Если review обнаружит реальный дефект **вне** presentation scope, зафиксировать его с provenance и согласовать отдельную работу; не превращать этот UX этап в изменение core/protocol/environment.

**Execution directive для нового агента:** взять **актуальный** HEAD, начать с C15R-UX.0, выполнить технические шаги .1–.7 и документацию/handoff .8, фиксируя фактические результаты. Не останавливаться на чтении плана и не объявлять implementation completed до кода/тестов/наблюдений. Исходный planning commit был docs-only; инженерная реализация и полный CI зарегистрированы в [STATUS](STATUS.md), без master merge.

## Корректирующий follow-up C15R-UX-R1

На исходном code-review baseline `d1f2133a961992dbf988721fdd5949078e5a95db` обнаружены самостоятельные user-visible defects: потеря broker outcome notices в compact/detailed; зелёный `completed` при неизвестном успехе команды; слабая иерархия native fields; unbounded full JSON.stringify и ложное название полного оригинала в `:details`. R1 сохраняет approved C15R-UX как исторический завершённый scope и точечно исправляет только presentation/input. Первое generic `pending` остаётся немедленно отображаемым; нет debounce, ожидания terminal, Host semantic parsing или дополнительных workflow. A101–A108 не переписываются, новые acceptance A109–A115 в [матрице](../../tests/ACCEPTANCE_MATRIX.md). Code/CI/live-native provenance — в [STATUS](STATUS.md). Инженерные A109–A114 подтверждены [mandatory CI 44257161408](https://github.com/apathoid/role-orchestrator/actions/runs/44257161408) на `1820ff700b8e25821597fe761bb52b1ba383cd4f` (514 root, 11 PTY), installed native A115 — UNVERIFIED. Настоящие provider+Zed сценарии остаются UNVERIFIED до фактического исполнения.

## C15R-UX-R2 — final corrective follow-up

Review baseline `8c0e056a279442ff83231af1fc53631d13f4c290`, intended scope is exclusively CLI native input/technical presentation. R2 preserves immediate pending, neutral completed and real broker facts from R1; fixes numeric approval of undisplayed pages (with a bounded 128-page per-request history), actual `PERMISSION_UNAVAILABLE`, bounded recognized-key `:details` (unknown metadata may be omitted with warning), Unicode surrogate/combining-safe label clipping. Exact native option ID and provider authority, single input owner, Controller/Workers independence, ACP/machine output and state remain unchanged. [Implementation, Node24 RED/green performance and full CI](STATUS.md); acceptance [A109/A110/A112/A114](../../tests/ACCEPTANCE_MATRIX.md). The independent installed real-provider/Zed A115 remains UNVERIFIED.

## C15R-UX-R2F — Native choice display confirmation

The CLI initially considers no native numeric choice positions delivered, even for page 1. Initial permission/form, subsequent form field, `:back` and `:choices N` all use the same success-only Writable callback receipt. A local per-form rendering generation avoids a stale callback authorizing a later visit to the *same* field index; closed/aborted requests cannot be reopened by callbacks. This technical display ownership is separate from original typed values, exact provider option IDs, native broker authorization and model strategy. User-supplied real question timeout after no answer is expected and does not justify Controller/operation timeout changes. Existing A110/A114 apply; [current CI evidence](STATUS.md). Installed native model/Zed remains UNVERIFIED.
