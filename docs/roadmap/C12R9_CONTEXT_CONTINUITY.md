# C12R.9 — Непрерывность контекста Controller без Host-managed knowledge

**Статус:** APPROVED PLAN / NOT IMPLEMENTED. **Рабочая ветка:** `greenfield/model-first-core`. **Baseline подготовки:** `b497b28c145fdbc3b17703e543fece6994ae82a6`. Следующий инженерный шаг — **C12R.9.0**. Фактические HEAD, CI, результаты и незакрытые обязательства — только в [STATUS](STATUS.md).

## 1. Проблема и цель

В предоставленном пользователем разборе реального запуска Controller повторно поручал уже проведённую проверку: содержательные отчёты более ранних исполнителей исчезали из его новых prompt при `context.maxBytes = 65536`, а retrieval через MCP был выключен. Эти наблюдения об исходных JSONL/trace представлены **со слов предоставленного анализа**; оригинальные файлы и реальный native replay не включены в репозиторий и здесь повторно не проверены. Само по себе повторное делегирование не является дефектом модели: новая проверка может быть сознательной. Дефект — отсутствие прозрачной возможности обнаружить и использовать уже полученные результаты.

**SUPPORTED по текущему коду:** `controller-context.js` строит историю с приоритетом более свежих записей; `context-bundle.js` ограничивает необязательную историю по умолчанию 64 КиБ и 128 записями; `host:invocation-context` уже передаёт `outcomes`, `pendingAttempts` и `actions`, но не обеспечивает удобной связки поручения с адресуемыми результатами. Одно `context.maxBytes` также применяется к handoff, `ContextPort.fetch/captureArtifact`, materialized skills и external tools. `ContextPort.list/fetch` существует, но его доступность для модели зависит от фактического adapter/transport и настройки `mcpBridge`. ACP и Codex CLI в текущих адаптерах создают новые native sessions/processes на invocation; native Codex compaction не переносит автоматически историю между этими вызовами.

**Цель C12R.9:** Controller при последующих ходах получает достоверное, ограниченное представление того, *какие действия выполнялись, чем они закончились и какие сохранённые результаты можно получить*, и при необходимости самостоятельно читает их без повторного исполнения исходной работы. Не обещать безусловно показать все тела и все записи за произвольно долгую операцию в конечном prompt; обеспечить обнаружение пропусков, адресуемость и фактически доступный способ получения данных либо честно указанную техническую невозможность.

**Приоритет решения:** устранить подтверждённое ненужное вытеснение и дублирование → проверить достаточность уже имеющихся технических фактов и ContextPort → минимально расширить представление/доступ только по воспроизведённому пробелу → измерить результат. **Новый индекс, дополнительный Decision field, native session persistence, увеличение лимитов и новый retrieval transport — не заранее обязательные deliverables.**

## 2. Архитектурные инварианты и границы

Применять [AGENTS.md](../../AGENTS.md), [.agents/REASONING.md](../../.agents/REASONING.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [EXECUTION](../EXECUTION.md), [EXTENSIONS](../EXTENSIONS.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [DECISIONS](../DECISIONS.md) и единственную [матрицу приёмки](../../tests/ACCEPTANCE_MATRIX.md).

1. **Model-first:** модель выбирает стратегию, глубину исследования, исполнителей/модели/effort, декомпозицию, повторную проверку и завершение. Нет обязательного Worker, Reviewer, review-progress, acceptance quorum, модельного summary, retrieval перед Decision или Host-вердикта о полезности результата. Повторное исследование может быть разумным решением модели, даже когда предыдущий результат доступен.
2. **Host технически достоверен:** собственные Action/Attempt/Outcome/Observation identities, ссылки, происхождение, полнота, бюджеты, permission, cancellation, durable state и no-blind-replay unknown. Никаких Host semantic relevance, приоритетов по роли/модели/«важности» findings или автоматического планирования.
3. **Единый источник истины:** использовать существующий Operation/Event/Observation/Outcome и `ContextPort`. Любая компактная карта — вычисляемое представление, а не новый mutable registry/index, параллельная история, materialized knowledge store или workflow state.
4. **Provider-agnostic:** Core и application-контракты не зависят от Codex, ACP, MCP, имен моделей, вида задачи, cwd, Git, каталога проекта или формата skills. Adapter-specific возможности и native session handling остаются в adapters. Не обязать MCP и не создавать искусственную файловую/terminal среду.
5. **Реальное окружение:** skills, AGENTS-like файлы, скрипты, repository files и native tools доступны модели естественным способом через её провайдера и его permissions; Host не сканирует project files, не подменяет native capabilities и не заставляет Controller перечислять обнаруженные skills. `Action.skills` — только явно выбранные Host-managed каталожные skills.
6. **Честность данных:** отдельные состояния «ссылка существует», «result/receipt наблюдался», «байты реально сохранены полностью/частично», «transport разрешает fetch», «конкретный fetch успешен». Сохранённая ссылка не обещает исходные байты. `completed` не равно `effect: none`; неизвестный эффект не меняется на известный.
7. **Технические пределы — по ресурсу:** защищать реальные bounded ресурсы и явно сообщать причину; нельзя использовать одинаковый лимит для разных целей лишь по инерции или превращать техническую выборку в семантическую стратегию. UTF-8 bytes не равны token budget/window модели. Нельзя полагаться на auto-compaction конкретного провайдера между независимыми invocations.
8. **Mutable workspace и восстановление:** никакого Git/source freshness gate, forced reconciliation, Host isolation, автоматического повторения попытки с unknown effect или блокирования независимой разрешённой работы.
9. **Наблюдаемость:** telemetry не источник истины; не хранить приватные bodies по умолчанию, не обещать наблюдение внутреннего prompt провайдера. Не раскрывать chain-of-thought.

Это инженерные шаги разработки, **не** runtime workflow, стадии Controller или обязательная последовательность для моделей. Исполнитель вправе уточнять границы шагов при доказанных зависимостях, фиксируя причины, но не расширять scope новым абстрактным механизмом без наблюдаемого требования.

## 3. План реализации

### C12R.9.0 — Baseline, причинная карта и регрессии до изменений (P1)

- Прочитать актуальный HEAD и применимые инструкции. Проверить, какие C12R.4/C12R.8/C12R.8R исправления уже действуют; не реализовывать их повторно.
- Изучить `controller-context.js`, `context-bundle.js`, `context-access.js`, `handoff.js`, `orchestrator.js`, `operation.js`, `local-store.js`, ACP/CLI prompt adapters и конфигурационные default/schema. Карта: provider output → adapter observation/capture → durable operation → operationHistory → compacted Controller context → provider payload → optional retrieval.
- На обезличенных **синтетических** fixtures воспроизвести два/несколько завершённых делегирования, содержательно разные и большие результаты, >64 КиБ истории, 128+ records, новый Controller turn, retrieval выключен/включён, повторяющееся представление одного результата, `completed + effect: unknown`. Тест фиксирует фактическую видимость/доступность, а не «модель должна закончить review».
- До исправления измерить размер **всего** materialized invocation и отдельных частей: user text, instructions, catalog, operation facts, history, observations/output, selected skills; количество duplicate copies, included/excerpted/omitted records и доступность refs. Раздельно фиксировать payload captured, stored, sent, fetched.
- Пробные 64/256/512 КиБ проводить контролируемо; **существующая общая `context.maxBytes` меняет одновременно несколько механизмов**, поэтому пометить этот конфаундер. Не считать численные размеры лучшими defaults без сравнительных данных.
- Отдельно характеризовать на CI действительный лимит 128 optional records и размер обязательного `host:invocation-context` за пределами лимита необязательной history. Проверить возможный неограниченный рост структурных metadata.
- Native JSONL/trace пользователя использовать только при фактическом доступе; не коммитить приватные prompt, конфиги, секреты или исходные логи. Если их нет, факт native causality отмечать UNVERIFIED.

**Exit:** воспроизведён конкретный механизм потери видимости, известен владелец каждого ограничения; регрессии фиксируют нарушаемые технические инварианты до исправления. Возможен переход непосредственно к меньшему исправлению, если тесты исключат часть гипотез.

### C12R.9.1 — Устранение доказанных дубликатов и технически неоправданного усечения (P1)

- Проверить происхождение повторов между raw provider messages, `attempt.outcome.observations`, `outputRefs`, `attempt-output:*` и прочими context records. Устранять в **представлении очередного Invocation** лишь достоверно идентичные копии одной записи/результата с известной identity/provenance; не сливать независимые findings, разных Workers или совпадающие текстом, но разные по происхождению утверждения.
- Оригинальные observations, outcome links, receivedSequence, completeness и durable payload сохранять без изменения. Если техническая идентичность не доказана — оставить раздельными.
- Проверить `compactContext()`: старые записи и их доступные ссылки не должны молча исчезать так, будто работы не было. Явно отличать included, excerpted, omitted, unrepresented. Не объявлять excerpt полным.
- Не добавлять Host content summarization, semantic filters, приоритеты по роли/model/workflow и квоты на Worker. Детерминированная техническая упаковка допустима, если она не претендует на содержательную важность.

**Exit:** нет ненужной полной дубликации одного result в Controller payload; в state ничего не теряется; регрессии identity и provenance зелёные.

### C12R.9.2 — Пересмотр контекстных и payload budgets по реальным границам (P1)

- Развести концептуально: (a) необязательная inline-history Controller; (b) выбранный handoff; (c) per-fetch response; (d) artifact capture/storage prefix; (e) Host-managed skill materialization; (f) external-tool output; (g) фактический provider/transport payload/window. Не увеличивать одним изменением все границы из-за потребности Controller.
- Проверить, какие лимиты действительно нужны для памяти, безопасности и транспорта и почему. Сохранять bounded consumption, explicit truncation/unavailable и ранее принятые права. **Не заменять 64 КиБ/128 записей на неограниченное включение истории** и не объявлять 64 КиБ универсальным пределом модели.
- Если выборка исторических записей всё ещё обрезает необходимые данные, выбрать самое простое доказанное решение: другой проверенный размер/правило, прозрачные references/omission, возможность адресного fetch. Менять default и/или добавлять отдельную пользовательскую настройку **только по необходимости**; предпочесть сохранение config v1 без изменения схемы, если возможно. `null`/«без лимита» не вводить без точного технического контракта.
- Независимо проверить 128-item guard и длинные обязательные `outcomes/actions`. Любое изменение должно иметь bounded поведение и корректное сообщение о пропуске, даже при очень длинной операции; не создавать неограниченный обязательный prompt.
- Не подменять данные, потерянные на capture/store boundary, обещанием retrieval. Если необходимо изменить хранение, отдельно подтвердить размер, retention, integrity, crash/cancel и стоимость; не строить второй storage/runtime.
- Нативный compaction провайдера — отдельная, необязательная capability; не полагаться на неё для сохранения истории межвызовных операций.

**Exit:** границы и их назначение объяснимы; длинная история не исчезает молча, ресурсные пределы остаются обоснованными, нет неконтролируемого prompt/tool/storage growth.

### C12R.9.3 — Минимальная техническая непрерывность Action → Attempt → Outcome → Result (P1)

- Сначала проверить достаточность существующих `host:invocation-context.outcomes/pendingAttempts/actions`, `operationHistory()` и `ContextPort.list()`. Эти структуры уже являются частью решения; не вводить новый `workerResults` registry автоматически.
- Если тест подтверждает смысловой пробел между «вызов завершён» и «что именно было поручено и где результат», минимально дополнить **производное** представление связями identity, исходной model-authored задачей/её адресом без Host paraphrase, terminal/effect и outcome/output/observation refs, completeness и реальной доступностью. Нельзя выдавать отсутствие результата за отсутствие работы; `acceptedActionIds` не является условием существования технического результата.
- Применять к произвольным Actions/Attempts/Controller observations, не только к review и «Worker report». Порядок и лимит технические, без host relevance scoring, ranking, per-model fairness и специальных workflow assumptions.
- Не пытаться гарантировать, что неограниченное множество Actions умещается в каждый prompt: ограниченный обзор + честный счётчик/курсор и фактически доступная адресация. Обязательно проверить, что при отключённом retrieval у модели не возникает ложной уверенности в полноте карты.
- Исправить `coordinationFacts().unresolvedAttempts`: различить реально pending/unknown terminal, **completed с доступным результатом** и отдельно uncertain effect/dispatch. Сохранить `effect: unknown/possible` и no-blind-replay.
- Долговременная идентичность/reopen и permission scope не должны изменяться из-за сокращения model-facing representation.

**Exit:** при двух и более завершённых задачах Controller технически может различить поручения и существование результатов; завершённый `unknown effect` не представлен как отсутствие completed outcome; новая независимая истина не создана.

### C12R.9.4 — Retrieval по выбору модели, без обязательного MCP (P1; расширение условно)

- Проверить реально работающий `ContextPort.list/fetch` через действующие CLI/ACP bridges, наличие `mcpBridge`, negotiation и фактическую доступность инструментов в конкретном Controller invocation. Опубликованная capability ≠ успешный fetch; `context.maxBytes` может ограничивать сам fetch. Сохранить `missing/payload/budget/retention/denied/closed/integrity_error`.
- Если текущая доставка + техническая карта + поддерживаемый retrieval решают воспроизведённую проблему, **не создавать нового** Decision field, special Controller turn, fetch engine или adapter protocol.
- Если значимый подтверждённый сценарий **без native tool retrieval** остаётся неразрешимым, отдельно спроектировать минимальный provider-independent model-initiated запрос *конкретных historical refs* для следующего обычного Controller invocation через существующий coordination loop/ContextPort. Это **условное** изменение контракта по тесту, без повторного Worker, Host selection, обязательного enumeration и скрытого вызова модели. Сохранить обычный invocation budget и explicit unavailable. До реализации сравнить с возможностью адаптера использовать существующие native инструменты.
- Не делать MCP обязательным, не вводить native-session persistence как гарантию корректности, не реализовывать универсальный Host file reader, проектный индекс файлов, vector search или собственный shell runtime. Если провайдер не имеет ни tool retrieval, ни поддерживаемого способа самостоятельного следующего запроса, указать предел явно; не обещать невозможную доступность.
- Проверить permissions и visibility для Worker-selected `contextRefs`, cross-operation shares, cancel, resume, late results и неизвестные effects. Не расширять scope history из текста модели.

**Exit:** модель может получить сохранённый выбранный результат, когда transport/contract это реально позволяет, без повторного исполнения, либо видит точное ограничение; direct answer без fetch остаётся допустим.

### C12R.9.5 — Native skills и project environment: только предотвращение подавления (P2, адресно)

- Зафиксировать в model-facing контракте при доказанной неоднозначности: `Action.skills` выбирает только Host-managed Catalog entries; отсутствие там native skill **не** означает его отсутствия у провайдера. Отказ `CAPABILITY_UNAVAILABLE` должен адресно указывать именно на каталожный запрос.
- Оставить Host-managed skill version/status/provenance validation и user/native permissions. Не автоматически регистрировать `.agents/skills`, не парсить `AGENTS.md`, не искать проектные скрипты Host и не переписывать native tool/skill discovery. Не требовать перечисления навыков в `objective`.
- Если действующая формулировка уже достаточна по тестам, **NO CHANGE**; этот шаг не должен разрастаться в самостоятельную систему расширений.

**Exit:** native skill/script discovery исполнителя не зависит от каталога Host; явный ошибочный запрос Host-managed skill по-прежнему корректно отвергается.

### C12R.9.6 — Диагностика доставки и воспроизводимые измерения (P2)

- По умолчанию без bodies: operation/action/attempt correlation, размер собранного optional history и **всего** адаптерного payload по известной границе, included/excerpted/omitted/unrepresented, result refs, доступный retrieval mode/negotiation/actual fetch, stored/captured completeness и технические причины. Избегать повторной записи полного контекста в логи.
- Опциональное `diagnostics.captureBodies` можно улучшить, если нужен фактический материал диагностики: отдельно Host Invocation, payload на контролируемой Adapter boundary, provider-observed outputs. Не выдавать это за весь внутренний контекст модели. Учитывать redaction, секреты, retention, bounded sink, explicit opt-in; диагностика не изменяет execution outcome.
- Отдельно измерять фактические provider tokens/cost, если сообщены, wall-clock, Tool/ContextPort calls, число Controller turns, размеры, качество requirement/evidence и сохранённую полезную работу. Не считать число Workers, длину prompt или «не было повторов» самостоятельным критерием качества.

**Exit:** инженер может локализовать потерю информации по слоям без просмотра приватных provider logs; sink fail/drop не влияет на операцию.

### C12R.9.7 — Регрессия, native acceptance, документация и handoff (P1)

**Автоматизированные тесты** в существующих `tests/` (подобрать текущие suite owners, включая context, context-quality, evidence-addressing, handoff, retrieval-guidance, mcp-context, skills/extensions, recovery, diagnostics и coordination):

- Две и более завершённые разные задачи с большими результатами и накопленной историей >64 КиБ: обнаруживаются факты выполнения и разрешённые result refs; не путаются авторы и Attempts.
- Доказанный duplicate в prompt исчезает; независимые однотекстовые observations не объединяются; original state/provenance остаются.
- 128+ records, большой последний result, большой `host:invocation-context`: bounded поведение без молчаливой ложной полноты.
- 64/256/512 КиБ как **экспериментальные** конфигурации; capture/fetch/tool/skill limits не меняются непреднамеренно.
- MCP off/on, provider without MCP, доступный/недоступный fetch, отказ, отсутствие байтов, retention, truncation; прямое завершение без retrieval.
- `completed + effect: unknown`, pending, cancel/late/restart/reopen, unknown-dispatch no blind replay, independent Actions.
- Native skills/scripts через provider, Host Catalog не обязателен, запрет несуществующего Host skill остаётся.
- Никакой обязательной проверки, Reviewer, semantic Host selection, Git gate, source reconciliation, Host filesystem runtime или обязательного нового Controller turn.

**Нативная приёмка** — по [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md) с дополнительным сравнительным сценарием C12R.9: одна и та же задача, исходное состояние, модели/effort, permissions, config и версии; A = исходная реализация, B = изменённое только `context.maxBytes` (64/256/512 KiB, измерить побочные изменения связанных лимитов), C = исправленный код. Сопоставить реально доставленные отчёты, re-fetch, reasoning/Assessment, качество, tokens/cost, latency, duplicate work. Учитывать конфаундеры, случайность и недоступные данные. Если оригиналов нет — native cause/comparison **UNVERIFIED**. Не считать CI fixtures нативным PASS.

**Документация после изменений:** только затронутые нормативные `docs/CONTEXT_AND_RECOVERY.md`, `PROVIDERS_AND_CONFIGURATION.md`, `EXTENSIONS.md`, `DIAGNOSTICS.md`, при значимом компромиссе `DECISIONS.md`, `CHANGELOG.md` при продуктовой вехе, единственная `tests/ACCEPTANCE_MATRIX.md`, `docs/roadmap/STATUS.md` и при необходимости этот план. Не создавать второй roadmap/матрицу, не вводить новые нормативные утверждения до реализации.

**Статусы:** Implementation complete / Regression verified / Native integration verified / Performance & quality comparison verified — независимы; не выполненная native проверка = UNVERIFIED. Полное инженерное завершение C12R.9 не означает закрытия C12.3/C12.4/Zed/NixOS.

## 4. Порядок работы агента-исполнителя

1. Обновить локальный checkout до актуального `greenfield/model-first-core`, прочитать AGENTS/STATUS/IMPLEMENTATION_PLAN/REASONING и нужные инженерные инструкции. Источник требований — актуальная ветка, **не** старый `development/` или исторические сценарии как новый контракт.
2. Начать с **C12R.9.0** и фиксировать подтверждённые технические пробелы. **Не выполнять заранее все условные расширения.** После каждой проверки выбирать минимальное достаточное исправление, сохраняющее инварианты.
3. Каждый самостоятельный инженерный шаг — отдельный commit с регрессиями и необходимой документацией; обновлять STATUS по фактам, а не заранее выставлять PASS. Не коммитить приватные native traces.
4. После доступных проверок завершить инженерный scope без дополнительного запроса на продолжение. Не симулировать реальные Codex/Zed/NixOS и не объявлять native PASS, если доступных authenticated сред нет.
5. Публиковать изменения **только** в `greenfield/model-first-core`; перед записью учитывать изменение HEAD и не переписывать чужие коммиты.

## 5. Явно исключено

Автоматическая смысловая компактизация/Host summaries, Host relevance scoring, vector search, второй индекс или второе хранилище, fixed workflow, Host review sufficiency/automatic re-review, обязательный MCP, обязательные дополнительные Controller turns, native-session persistence как обязательство, выбор провайдера/effort по эвристикам, project-skill scanning, Host FS/shell/VCS/sandbox, source freshness/reconciliation, искусственное ограничение числа Workers и произвольное увеличение всех бюджетов разом.

**Ключевой критерий успеха:** исправлена техническая причина, по которой уже состоявшаяся работа становится невидимой или недоступной модели; сама модель по-прежнему решает, когда использовать старые результаты и когда обоснованно исследовать повторно.
