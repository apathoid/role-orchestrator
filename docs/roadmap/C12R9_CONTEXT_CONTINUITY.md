# C12R.9 — Исправление непрерывности контекста Controller

**Статус: исторический нормативный план реализован исходно на `1633a30`; инженерные review P1/P2, включая history directory, завершены и подтверждены CI. Native acceptance остаётся UNVERIFIED.** Ветка: `greenfield/model-first-core`. Фактический следующий шаг — по [STATUS](STATUS.md). План задаёт **обязательные результаты текущей итерации**, а не список гипотетических механизмов. Детали размещения функций и внутренние алгоритмы исполнитель выбирает самостоятельно, не меняя наблюдаемые контракты и инварианты.

## 1. Цель, доказательства и границы

**Цель:** при очередном Controller invocation модель должна иметь достоверную картину уже порученных и завершённых действий, адресуемые ссылки на их результаты и возможность по собственному решению получить сохранённые данные, которые не помещаются в текущий prompt. Controller не должен повторно запускать работу *из-за скрытой потери сведений*; он вправе сознательно поручить дополнительную проверку.

**SUPPORTED исходным baseline до C12R.9:** `src/application/context-bundle.js` ограничивает необязательную историю 64 КиБ по умолчанию и **128 optional records**; `controller-context.js` выбирает новые события прежде старых; `host:invocation-context` уже несёт `outcomes/pendingAttempts/actions`, но не даёт компактного, адресного представления исходного поручения и его результатов; этот обязательный технический payload может расти отдельно от лимита истории. Один `context.maxBytes` подаётся в Controller history, Worker handoff, `ContextPort.fetch/captureArtifact`, selected skill instructions и external-tool output. `ContextPort.list/fetch` существует, но доступ модели к нему не универсален и в исходном описанном запуске был выключен MCP. Текущие CLI/ACP адаптеры создают новые native invocation sessions/processes — native Codex compaction между ними не гарантирует перенос истории.

**Сообщено пользователем, не перепроверено по исходным JSONL здесь:** прежние полные Worker-отчёты исчезали из фактических промптов Controller, последний отчёт дублировался, после чего Sol поручал схожую работу повторно. Достоверно воспроизводить локальными synthetic fixtures; native cause/quality comparison остаются UNVERIFIED до оригинальных данных и реальных прогонов. Не выдавать поведение Sol за дефект модели.

**Обязательный итог данной итерации:**
1. Устранены технически доказанные дубликаты доставки одного результата и молчаливое вытеснение сведений о существовании старых работ.
2. Настройки/лимиты Controller history, Worker handoff, history fetch, artifact capture, selected skills и external tools **разделены**; default Controller inline budget увеличен до **256 КиБ**, без синхронного увеличения остальных бюджетов.
3. Добавлена **компактная техническая карта завершённой и незавершённой работы** как вычисляемая проекция существующего operation state; никакого нового indexed/mutable/persistent registry.
4. Исправлено смешение `terminal/status` и `effect uncertainty` в `unresolvedAttempts`.
5. Есть модельно-инициируемый способ открыть сохранённую историю **без обязательного MCP** (через обычное продолжение Controller, подробнее в C12R.9.4), при сохранении всех trusted authority и ресурсных границ. Native ContextPort/MCP продолжает работать.
6. Пройдены доступные автоматизированные проверки и документированы ограничения и нативная приёмка; готовность реальных моделей не выдумывается.

## 2. Неизменяемые инварианты

Нормативные источники: [AGENTS](../../AGENTS.md), [.agents/REASONING](../../.agents/REASONING.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [EXECUTION](../EXECUTION.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [EXTENSIONS](../EXTENSIONS.md), [DECISIONS](../DECISIONS.md), [DIAGNOSTICS](../DIAGNOSTICS.md), [текущая acceptance matrix](../../tests/ACCEPTANCE_MATRIX.md).

- **Model-first:** решение о стратегии, числе моделей/исполнителей, effort, проверках, retrieval, достаточности и завершении принадлежит модели. Ни Host, ни этот план не требуют review workflow, определённого числа Workers, обязательного запроса истории или повторного хода Controller.
- **Provider-agnostic:** универсальные контракты не знают Codex, ACP/MCP, форматов native skills, названий моделей, Git, cwd, файловой структуры проекта, конкретного workflow. Adapter-specific wire/transport — только в адаптере.
- **Инструменты/окружение принадлежат исполнителю:** project files, skills, scripts, Git, edit/terminal и tool permissions используются естественно через провайдера. Host не ищет project instructions, не строит свой filesystem/terminal runtime, не создаёт sandbox/изоляцию, не ограничивает toolkits по роли.
- **Техническая достоверность:** Operation/Action/Attempt/Outcome/Observation/ref/provenance/permission и raw durable records остаются источником истины. Host не генерирует semantic summaries, relevance/rank/coverage scores и не объединяет findings по тексту. Не превращать `unknown` в `none`, не повторять unknown effects автоматически, не вводить source freshness/reconciliation gate.
- **Никаких Host compaction и automatic model summarization.** Нативная compaction конкретного провайдера не является механизмом сохранения межвызовной истории. Сохранение одной native Controller session — **вне scope**; в будущем только необязательная provider-specific оптимизация при отдельном подтверждении.
- **Нагрузка bounded и наблюдаема:** доступность ссылки, наличие полного/усечённого payload, доступность инструмента retrieval и результат реального fetch — разные факты. UTF-8 bytes не равны tokens/window. Сокращение prompt не оправдывает потерю исходных записей в state.

Инженерные C12R.9.0–.7 — **шаги разработки, не runtime workflow**. Каждый имеет обязательный результат. Если проверка обнаруживает, что требуемый эффект уже реализован, исполнитель фиксирует тест и `NO CODE CHANGE` с доказательством; это не освобождает от приёмочного требования.

## 3. Конкретный контракт бюджетов C12R.9

В `context` доверенной user config v1 и соответствующем API реализовать **независимые** positive safe-integer поля (байты UTF-8 сериализованного представления, где применимо):

| Поле | Default | Назначение |
|---|---:|---|
| `controllerMaxBytes` | **262144 (256 КиБ)** | Общий бюджет **необязательной** истории Controller и производных динамических технических records, включая карту выполненных Actions; не предел всех system/user instructions |
| `handoffMaxBytes` | **65536** | Только выбранные `Action.contextRefs` и их представление в Worker handoff |
| `fetchMaxBytes` | **65536** | Размер одного ответа `ContextPort.fetch`; действительные protocol limits дополнительно учитываются |
| `captureMaxBytes` | **65536** | Сколько исходных байтов `captureArtifact` вправе сохранять; факт truncation обязателен |
| `skillInstructionsMaxBytes` | **65536** | Только выбранные Host-managed skill instructions, не native skill discovery |
| `toolOutputMaxBytes` | **65536** | Бюджет output внешнего ToolPort, **не** новый способ расширить его существующий жёсткий cap 64 КиБ |

**Совместимость без повышения schemaVersion:** существующий `context.maxBytes` сохранять как явно задокументированный **устаревающий alias только для `controllerMaxBytes`** (на этом этапе не удалять). При одновременном задании обоих имён возвращать адресную ошибку конфигурации вместо неявного приоритета. Значение старого поля больше **не меняет** handoff/fetch/capture/skills/tool; это намеренное устранение ошибочной связи, явно описать в документации и regression tests. При отсутствии обоих полей действует новый default 262144. В остальных сферах действуют независимые defaults, даже если указан `maxBytes`.

Не добавлять конфигурацию `unlimited`/`null`, вычисление «доступного окна модели» по её имени или автоматическое повышение budget по reasoning effort. Не увеличивать MCP request/response/call/concurrency limits и не обходить hard caps ToolPort. Разделение должно работать также через прямой программный `createOrchestrator`, а не только CLI.

**Обязательные ограничения:** валидация новых полей и безопасных верхних границ, обусловленных реализованным allocation/transport; адресная диагностика при невозможности доставки; `maxBytes` выше лимита adapter не обещает успешный transport. Изменения лишь в user-config/configuration API, не вводить project-owned способ увеличения budgets/permissions. Сохранять текущее правило trusted project preferences не расширять полномочия.

**Контекст Controller:** удалить независимый фиксированный guard `maxOptionalRecords=128` как безусловную причину потери записей. Ограничивать *фактически включаемые* необязательные records общим byte budget, сохраняя bounded вычисления и честные omitted/excerpted/unrepresented. Динамические массивы `outcomes/actions/uncertainties` больше не должны обходить `controllerMaxBytes`: представлять их внутри общего бюджета, с total/represented/omitted и адресуемым курсором/страницей для недостающих записей. Буквальные пользовательские инструкции, trusted restrictions и остальные обязательные поля не сокращать без сообщения о реальном transport failure; общий итоговый размер provider payload отдельно диагностировать.

## 4. Этапы исполнения

### C12R.9.0 — Baseline и воспроизводимые проверки (P1)

1. Зафиксировать актуальный HEAD, открыть AGENTS/STATUS/IMPLEMENTATION_PLAN и engineering hard invariants. Построить корреляцию provider observation → outcome → persisted state → `operationHistory` → Controller context → adapter payload → optional ContextPort.
2. Создать синтетическую регрессию: два разных завершённых Actions с большими результатами; >64 КиБ и >128 исторических записей; **отдельно >256 КиБ суммарной истории с нужным старым результатом вне inline-предела и выключенным MCP**; новый Controller invocation; исходные результаты durable. Последний случай доказывает, почему одно увеличение даже до 256 КиБ не решает задачу произвольно долгой истории и почему требуется необязательный model-requested ref/cursor path без нового knowledge store. Отдельные fixture: последний output дублирован как model observation и attempt-output, `completed + effect: unknown`, большая обязательная техническая история. Никаких real/private JSONL в Git.
3. Измерить baseline по слоям: общий Adapter payload, bytes и counts optional history, динамические technical metadata, количество **полных копий одного результата**, omitted refs, stored/captured bytes, доступность fetch.
4. Зафиксировать тестами ожидаемое C12R.9 поведение сначала в воспроизводимых red/green regressions; не требовать имитации LLM reasoning. Пробные 64/256/512 КиБ использовать как измерения, не как замену исправлений.

**Готово:** есть regression fixtures и причинная карта всех потерянных/дублированных данных; исторический native claim помечен UNVERIFIED там, где не подтверждён непосредственно.

### C12R.9.1 — Каноническая доставка результатов без повторов (P1)

1. В invocation presentation передавать полный payload одного и того же исходного результата не более одного раза, если его тождество технически доказано посредством `attemptId`, correlation/ref и одинаковых оригинальных байтов. Отдельные ссылки на тот же результат можно оставить без повторной полной копии.
2. Не объединять независимые observations/findings только потому, что тексты похожи или идентичны. Не стирать исходные записи, references, provenance, completeness или outcome links в durable state.
3. Все excerpt/omissions маркировать честно. Упаковка не должна скрывать существование старого Action или выдавать усечённый payload за полный.

**Готово:** duplicate fixture имеет одну полную копию в отправляемом Controller payload при исходном числе durable records; разные источники остаются различимыми.

### C12R.9.2 — Независимые бюджеты и снятие искусственных ограничений (P1)

1. Реализовать **ровно контракт раздела 3** в schema, decode/resolve config, public API, orchestration composition, Controller context, Worker handoff, ContextPort, skill materialization и external ToolPort. Удалить общий провод `contextMaxBytes` как управление всеми областями.
2. Установить default Controller inline budget 256 КиБ, независимо от других defaults 64 КиБ. Старый `maxBytes` — только alias Controller, без schemaVersion bump и без неявного приоритета.
3. Устранить жёсткое отсечение после 128 optional entries; замещать bounded byte-only delivery, explicit omission/cursor и технически согласованное представление динамического `host:invocation-context`.
4. Проверить exact JSON/UTF-8 envelope, длинные refs, граничные значения (включая 1 байт и большие допустимые значения), malformed config, независимость custom budgets, retention и MCP/tool hard caps; не допускать бесконечного CPU/memory growth при большой истории.
5. Не делать semantic selection of «лучшие» reports или автоматическое модельное summary.

**Готово:** изменение `controllerMaxBytes`/legacy `maxBytes` не меняет реальный capture/fetch/handoff/skill/tool ceiling; необязательная история и техническая карта ограничены и имеют честный учёт omitted; при увеличенном бюджете >128 малых записей реально передаются, если помещаются.

### C12R.9.3 — Компактная техническая карта Actions/Attempts/Results (P1)

1. **Реализовать**, а не только исследовать, компактную **derived projection** в уже существующем `host:invocation-context` (или заменяющем его эквивалентном model-facing представлении из Operation); **не** создавать новое persisted/indexed store, второй writable registry или параллельную историю.
2. Для каждой представленной записи сообщать `actionId`, исходный `Decision`/ссылку на model-authored objective без Host paraphrase, `attemptId`, lifecycle/terminal, `effect` и `dispatchCertainty`, проверяемые `outcome/output/observationRefs` и известные признаки сохранности/полноты. Не придумывать доступность raw bytes или semantic status. Поддерживать также Controller responses/observations как существующие context refs, без требования Worker.
3. Карта должна иметь технически стабильный порядок, **total/represented/omitted**, cursor/position в существующей истории для просмотра старых записей, ограниченный размер **внутри `controllerMaxBytes`**. При многих Actions давать paging по запросу модели (C12R.9.4), а не всё перечисление без потолка. Никаких per-role quotas, ranking, «review complete» или Host-generated summary.
4. Исправить `coordinationFacts().unresolvedAttempts`: не включать completed attempts только потому, что `effect=unknown/possible`; отдельно отображать действительно pending/unknown-dispatch и неопределённость эффекта уже завершённой работы. Исторические `effect`/outcome не переписывать; no blind replay.
5. Не делать `acceptedActionIds` условием видимости уже завершившегося факта. Проверить restart/reopen, отмену, late outcomes, multiple attempts per Action, permission scopes и длинные операции.

**Готово:** Controller различает, что были два разных поручения, какие результаты существуют и где находятся, даже если оба full bodies не поместились в очередной prompt; для каждого видимого результата нет ложных обещаний полноты/доступности.

### C12R.9.4 — Model-initiated history access без обязательного MCP (P1)

1. Сохранить действующие `ContextPort.list/fetch` и native MCP/ACP/CLI путь, когда он реально доступен. Не делать MCP обязательным для обычного Controller Decision. **Основание расширения:** регрессия C12R.9.0 с результатом вне конечного inline budget и без MCP должна быть красной до этого шага, зелёной после; простой подъём лимита или компактная карта не могут доставить исходное тело произвольно большой истории сами по себе.
2. **Добавить универсальный необязательный путь для Controller без tool retrieval:** в существующем `Decision.nextController` поддержать **`contextRequest`** с `refs` (точно выбранные моделью historical refs) и/или `cursor` (страница технической истории с существующей моделью cursor/position). Применять только при `continue: true`; если нет `contextRequest`, обычный Controller путь неизменен. Пустой/invalid запрос — адресная ошибка Decision; не включать ссылки другой операции без действующей trusted share.
3. Accepted Decision со ссылками уже хранится в operation journal. На **следующем обычном Controller invocation** Host материализует только явно выбранные refs или страницу из существующего `Operation/ContextPort`, применяет `controllerMaxBytes` и действительную видимость/permission, помечает `complete/truncated/unavailableReason`; при исчерпании бюджета сообщает реальную неполноту. Не создавать второй workflow, registry, scheduler, mandatory turn, невидимые automatic tool calls или отдельную квоту на «reasoning requests».
4. Если model-selected ref существует, но байты не были captured/stored, вернуть `payload`/другую точную причину; недоступность HTTP MCP не должна уничтожать исходные refs. Не выполнять заново внешний Worker ради retrieval; не расширять worker-selected `contextRefs` и cross-operation scope.
5. Сохранить существующие `nextController.reasoningLevel`, cancel/recovery, correction, idempotency, operation budget и возможность завершить задачу напрямую без history request. Проверить новый запрос по literal schema, replay accepted Decision, snapshot/restart и несанкционированный ref.

**Готово:** fixture без MCP делает (a) direct completion без fetch, (b) модельно выбранный запрос старого результата/страницы и (c) продолжение с доставленными разрешёнными данными **без повторного Worker**. Провайдер со включённым MCP сохраняет native инструменты и может ими пользоваться без этого поля. Способность просматривать бесконечную историю не требует помещения бесконечной карты в prompt.

### C12R.9.5 — Native skills и проектное окружение (P2)

1. Уточнить model-facing описание `Action.skills`: только идентификаторы **Host-managed Catalog**. Отсутствие skill там **не** означает, что provider-native skill/скрипт отсутствует или запрещён. Исправить адресное сообщение `CAPABILITY_UNAVAILABLE`, если оно утверждает больше, чем установлено.
2. Сохранить выбранные Host skill version/status/provenance и trust/permission. Не внедрять Host discovery project files/`.agents/skills`/`AGENTS.md`, автоматическую регистрацию или требование перечислять native skills в objective.
3. Проверить без Host skill catalog native tool/skill/script у провайдера и отказ по явно ошибочному Host-managed skill; никакого role-based suppression.

**Готово:** не обнаружена ни одна зависимость нативной работы от Host Catalog, ошибочный явный catalog ID по-прежнему отклоняется адресно.

### C12R.9.6 — Диагностика границы и учёт стоимости (P2)

1. Добавить bounded technical observations: total Controller context bytes и компоненты, техническая карта total/represented/omitted, retained/present/absent refs, excerpt/truncation, результат retrieval, фактически advertised/negotiated capabilities, correlation operation/decision/action/attempt, причины отсутствия.
2. Разделить измерение **Host Invocation**, **Adapter submitted payload** и **фактический provider ACK/output**, когда они действительно наблюдаемы. Не утверждать, что Host знает внутренний context window/компактизацию провайдера.
3. По умолчанию не писать приватные тела. Опциональная `diagnostics.captureBodies` должна сохранять только действительно доступные копии с explicit opt-in, redaction/limits/secure state directory; bounded diagnostic sink не влияет на outcome и не является knowledge store.
4. Фиксировать сообщённые provider tokens/cost, latency, Controller turns, fetch calls и объём копий. Отсутствующие usage — `unknown`, а не оценка по UTF-8 bytes.

**Готово:** диагностика различает вытеснение на сборке, усечение при capture, storage absence и отсутствие retrieval transport; отключённый sink не меняет результат операции.

### C12R.9.7 — Полная регрессия, сравнительная приёмка и documentation (P1)

**Обязательные automated scenarios**, расширяя существующие suites в `tests/`:
- 2+ завершённых разных Actions, 64 КиБ+ истории, 128+ малых records, крупный последний output и multiple Controller turns; факты предшествующей работы обнаруживаемы.
- Duplicated final output — только одна inline full copy при сохранении двух оригинальных refs; независимые одинаковые строки не склеиваются.
- Раздельные config budgets/legacy alias; 64/256/512-КиБ Controller context, точный учёт overflow, большой `host:invocation-context`, непустые/пустые cursors и ограниченное представление.
- Без MCP: direct completion, `nextController.contextRequest` по refs и cursor, forbidden/unknown/missing/retained/truncated/huge result, restart/replay/permission checks.
- С MCP: прежние `context_list/fetch` и optional direct path без обязательного prefetch; hard limits/late outcomes/unknown effect не ослаблены.
- Вся нативная деятельность провайдера (project files, skills, scripts, terminal) без Host file discovery; non-Git и mutable workspace; нет workflow/Reviewer/Host semantic gate.

Выполнить доступные `npm run check`, `npm test`, package/CI/Nix проверки по AGENTS и текущей acceptance matrix. При непрохождении исправить, не ослабляя тесты. **Нативная сравнительная проверка обязательна как требование приёмки**, но при отсутствии authenticated models/Zed оформляется **UNVERIFIED с точной причиной** и не блокирует отдельную завершённость инженерных regression-исправлений.

**Сравнение на реальных моделях:** A — прежний baseline 64 КиБ; B — прежний код с 256/512 КиБ (фиксировать факт совместного изменения старых budgets); C — новый код с разделёнными бюджетами и компактной технической картой. Сохранять одинаковые задачи, workspace, permissions, model/effort, actual adapter versions и реальные tool capabilities; фиксировать размер prompt/необязательной истории, доступность старых результатов, fetch, качество Assessment, корректность evidence, число *ненужных* повторных работ, latency и реально сообщённые tokens. Нельзя считать уменьшение числа Workers самостоятельным PASS. Провайдерская стохастичность и confounders должны быть обозначены. [Native protocol](NATIVE_ACCEPTANCE.md).

По факту реализации обновить затронутые нормативные `docs/CONTEXT_AND_RECOVERY.md`, `PROVIDERS_AND_CONFIGURATION.md`, `CONTRACTS.md`, `EXECUTION.md`, `DIAGNOSTICS.md`, `EXTENSIONS.md` (по изменившемуся поведению), значимые решения в `DECISIONS.md`, `CHANGELOG.md`, **единственную** `tests/ACCEPTANCE_MATRIX.md`, `docs/roadmap/STATUS.md`. Не объявлять будущие контракты действующими до кода. Никакого второго roadmap/матрицы.

## 5. Порядок передачи исполнителю и условия завершения

1. Взять **актуальный HEAD** только `greenfield/model-first-core`; прочитать корневой AGENTS, STATUS, IMPLEMENTATION_PLAN, .agents/REASONING и применимые инженерные документы, затем этот план. Старые шаги C12R.0–.8R уже закрыты в доступном scope; не переигрывать их без регрессионных оснований.
2. Реализовать **все обязательные результаты C12R.9.0–.7**, а не останавливаться после диагностики. Выбирать минимальную инженерную реализацию, которую можно проверить; не спрашивать о каждом следующем шаге. «Условность» допустима лишь для несущественных внутренних рефакторингов, а не для результата из раздела 1.
3. Каждый самостоятельный инженерный шаг фиксировать отдельным коммитом с соответствующими тестами и документацией, обновлять STATUS и фактические commands/exits/CI; проверять изменения рабочего HEAD перед публикацией. Публиковать **только** в эту ветку.
4. Отделять **Implementation complete**, **Automated regression verified**, **Native integration verified**, **Performance/quality comparison verified**. Не проведённые native пробы = `UNVERIFIED`; старый успешный CI не доказывает новую реализацию. Сохраняются C12.3/C12.4/Zed/NixOS native obligations.
5. Не коммитить private JSONL, prompts, секреты или сырые диагностики. Не расширять scope до native session persistence, Host compaction, project-indexing, vector retrieval, второго storage, нового runtime workflow или универсального telemetry collector.

**Итоговый контракт C12R.9:** Controller сохраняет техническую непрерывность прежних действий, может использовать сохранённые результаты без повторного исполнения, а семантические решения остаются целиком модельными. Это достигается раздельными бюджетами, устранением дубликатов, ограниченной производной картой и необязательным модельным запросом истории, **не** новой системой знаний Host.
