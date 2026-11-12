# C12R.10 — устойчивый модельный интерфейс Controller

**Статус:** инженерная реализация .0–.6 выполнена; фактическая проверка и оставшиеся обязательства — в STATUS. Первоначальный documentation baseline `0117f845c0a9647342279d9ab631c978fd08092d`, фактический implementation baseline `d73974c8789c68be9850cb162e518ceaf80f0a24`. Текущий статус и следующий шаг — [STATUS](STATUS.md). Инженерный scope, а не новый runtime workflow.

## 1. Основание и цель

После нативных запусков Role Orchestrator и прямых запусков OpenCode обнаружены проблемы на границе модели и Decision. Ornith 9B в отдельных запусках знала правильный ответ, но возвращала невалидный Decision (в том числе пропуск `finalAssessment.requirements[].findingRefs`, неверное `assessment`, выдуманное Action kind). GPT-OSS 20B ошибочно указывала native skill в `Action.skills`. В прямом OpenCode обе модели использовали native skills; нежелательная запись и недостоверное описание коммита наблюдались также без оркестратора. Эти данные мотивируют адресное исправление интерфейса, но не доказывают, что все ошибки, задержки или различия вызваны Host: мало повторов, CLI и ACP могут различаться, точный runtime SHA/полный provider prompt и usage не для всех запусков установлены.

SUPPORTED по исходникам baseline: `src/adapters/invocation-prompt.js` содержит числовые cursor/workCursor и повторное устаревшее описание refs; `src/application/controller-context.js` содержит актуальные structured cursors, но формулировку "Use an assessment"; `src/core/contracts.js` задаёт `finalAssessment` и structured positions; legacy numeric cursors декодируются для сохранённых записей, ненулевые отклоняются ContextPort. `parseDecisionText()` сводит malformed JSON, слишком глубокий JSON и некоторые валидные non-object values к неразличимой диагностике. Различие Host Catalog/native skills уже закреплено в docs и prompt; требуется проверить и сделать точным представление конкретного отказа, а не создавать новую capability.

Цель: снизить техническую нагрузку передачи модельного решения, сохранить свободу стратегии, нативные возможности, качество и эффективность координации. Не обещать улучшение реальной модели до измерений.

## 2. Границы и источники требований

До изменений прочитать корневой [AGENTS.md](../../AGENTS.md), [STATUS](STATUS.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md), [.agents/REASONING.md](../../.agents/REASONING.md) и применимые .agents/engineering (kernel, hard-invariants, planning/implementation/review/final-validation). Нормативны [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [EXTENSIONS](../EXTENSIONS.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [DIAGNOSTICS](../DIAGNOSTICS.md), [DECISIONS](../DECISIONS.md), единственная [ACCEPTANCE_MATRIX](../../tests/ACCEPTANCE_MATRIX.md). Не восстанавливать историческую реализацию.

- Модель владеет семантикой: задача, scope, стратегия, план/перепланирование, выбор инструментов, специалистов, число стадий, интерпретация observations/findings, проверка и итог. Один Controller с прямым ответом — полноценный путь; ни один путь не обязателен.
- Host владеет техническим контрактом, адресацией, авторизацией явно запрошенных ресурсов, координацией, бюджетом, lifecycle, корреляцией, provenance и recovery. Он не классифицирует запросы на read/write, не выводит permissions из задачи, роли, skill или названия shell-команды.
- Нативный исполнитель и модель работают с реальным окружением и его собственными tools, scripts, skills, project instructions, файловыми конфликтами и настройками permissions. Host не предполагает наличие Git, shell, файловой системы, skill tool, конкретного проекта, провайдера или workflow. Отсутствие наблюдения/metadata не означает отсутствия capability.
- Инструкция пользователя «не изменяй файлы» — содержательное требование модели; только явные доверенные grants и реальные provider permissions определяют технические полномочия. Нет Host sandbox, OS/FS isolation, виртуального workspace, source CAS, clean tree, fingerprint, rollback, обязательного reconciliation, shell interception, автоматического approval или запрета native subagents.
- Без Host discovery native skills/AGENTS.md/scripts, синтеза инструкций окружения, semantic summary/compaction/ranking, обязательного MCP или нового scheduler. Существующие явно выбранные Host Catalog skills и внешние extensions сохраняются.
- Сохранять строгий Decision v1, выразительность, имеющиеся технические границы и ресурсы C12R.9. Не ремонтировать выход модели. Нативный structured output, если уже поддержан, является законным транспортом за adapter; не отключать инструменты ради него. Расширение structured output, изменение Decision schema/lifecycle, defaults budgets и автоматическая смена модели — вне scope. Новый доказанный дефект, требующий изменения контракта, описать с evidence и согласовать отдельный scope, не исправлять профилактически.
- JavaScript ESM, Node 24, JSDoc/checkJs; core не импортирует adapter/prompt renderer и не знает provider-specific wire types. Не добавлять DSL, schema runtime, новый persisted index или дублирующий validator.

## 3. C12R.10.0 — baseline и адресные регрессии

**Обязательная инженерная подготовка, не native benchmark.**

1. Получить актуальный HEAD, сверить документы и применимые tests/fixtures; установить путь Provider response → adapter → decoder → coordinator → correction. Найти все реальные места использования renderInvocationPrompt/parseDecisionText и доставки Controller instructions; учесть Generic ACP, Codex CLI и публичный ProviderPort, включая уже структурированные ответы.
2. Воспроизвести на существующих синтетических provider/adapter fixtures расхождение cursor/ref, точное имя finalAssessment, неоднозначную parsing/depth/type диагностику, missing field и Catalog rejection. Проверить фактический adapter prompt, а не только константы. Если текущий HEAD уже исправляет случай, зафиксировать evidence, не дублировать изменение.
3. Зафиксировать baseline commit, тесты/команды и наблюдённые причины; отличать SUPPORTED исходниками, OBSERVED тестами, HYPOTHESIS и UNVERIFIED. Предыдущие пользовательские native отчёты — диагностическое основание; не переносить приватные traces/исходники, не считать их автоматическим PASS.
4. **Реальные модели, OpenCode, llama.cpp, Zed, их credentials, локальные модели/GGUF/конфигурации не являются prerequisites C12R.10.0, разработки, коммитов или CI.** Не запускать их в GitHub Actions и не создавать benchmark workflow. Точные версии/параметры локальных native runs будут зафиксированы пользователем при последующей приёмке (см. §10). Недоступность этих данных не блокирует воспроизведение технических дефектов.
   
Результат: минимальные красные/подтверждающие regression fixtures и понятный scope; исходные дефекты проверяемы независимо от конкретной LLM или workflow.

## 4. C12R.10.1 — согласованное представление Decision

1. В `src/adapters/invocation-prompt.js`, `src/application/controller-context.js` и других фактических путях доставки устранить противоречия с `src/core/contracts.js` и admission. Decoder и coordinator остаются авторитетами; не создавать второй исполняемый контракт.
2. Использовать точные поля/enum/условия: Decision header/ids/contextCursor; additions/cancellations; Action delegate, dependencies, expectedResult, optional role/profile/skills/capabilities, continuationReference/retryOf/retryBasis; acceptedActionIds, waitPolicy, clarification, finalAssessment, findings; nextController/reasoningLevel/contextRequest. Учитывать ограничения decoder и admission, а не выдумывать новые. Не менять обязательность полей или их значения.
3. Описать действующий cursor для history/workMap: 0 начинает обход, {revision,index} — continuation, копировать nextCursor без изменения; contextCursor — иной числовой идентификатор. refs принимают string/position/byte range selection, offset/nextOffset по существующему контракту. Не рекламировать legacy nonzero cursor как рабочий; не менять чтение persisted Decisions. Не смешивать history и workMap.
4. Консолидировать транспортное описание, удалить дубли и противоречия, сохранить технические coordination semantics (например, зависимости, unknown effects и retry, provenance, различия уровней reasoning). Разделить представление задачи/контекста, фактических invocation facts и формы ответа без классификации содержимого. Выбрать минимальное переиспользуемое описание на подходящем слое, не генерировать новый DSL или всю схему.
5. Добавить краткий полный валидный пример Decision и пример обязательного элемента requirements, включая findingRefs. Полные примеры тестировать актуальным decoder и, где задействованы реальные ids, admission fixture. Демонстрационные значения обозначены явно, реальные operationId/profileId/contextCursor брать из текущего invocation; Host может отображать их в инструкции, но не подставлять в полученный ответ. Не использовать реальные пользовательские задачи. Пример иллюстрирует только форму; не означает, что следует выбирать finalAssessment, complete, пустые requirements или refs. Другие формы сохраняются в полном контракте; добавлять компактные структурные фрагменты при доказанной необходимости, не каталог workflows.
6. Проверить итоговые промпты по адаптерам: отсутствие устаревших типов, дублированных конфликтующих описаний и новой provider-specific семантики. Не сокращать возможности ради меньшего prompt.

Результат: единственное непротиворечивое описание Decision v1, точные идентификаторы, валидные примеры, неизменная выразительность и admission.

## 5. C12R.10.2 — пользовательский результат и транспорт

Коротко объяснить: Decision — транспортный конверт, итоговый пользовательский результат находится в finalAssessment.answer; модель сохраняет запрошенное содержимое/формат, финальное сообщение Controller соответствует Decision. Для text transport — один JSON object без Markdown fences; native structured output — согласно действующему adapter contract. Не запрещать промежуточный текст/нативные tool calls на основании формата итогового сообщения. Worker возвращает результат по собственному task/provider контракту, не Controller Decision.

Проверить Markdown, Unicode, переносы, JSON как строковое содержимое answer через API/CLI/ACP. Host не извлекает разделы, исправляет Markdown/вложенный JSON, проверяет формат skill семантически или дописывает ответ. Применимые project/skill/user instructions продолжают задавать результат; Host не переписывает их и не определяет workflow.

Результат: пользовательский формат не конфликтует с transport; содержимое проходит без смыслового преобразования.

## 6. C12R.10.3 — краткие точные ошибки без ремонта

1. Использовать существующий FieldError/INVALID_PROPOSAL и correction path. Достаточны code, конкретный path, expected; например `$.finalAssessment.requirements[0].findingRefs — expected array`. Не добавлять предположения о намерении, конкретный следующий Action, стратегию или сгенерированный исправленный Decision. Общий валидный пример доступен в инструкции. Не вводить сбор всех ошибок или новую сложную иерархию только ради этих случаев.
2. Различить invalid JSON, valid JSON non-object (включая строку, число, null, array), превышение существующего технического depth bound, schema/field/incompatibility, admission failure и provider/transport/cancel/deadline. В parseDecisionText не превращать все эти случаи в одинаковую ошибку root object. Минимальный технический результат на adapter boundary допустим; не смешивать с Outcome lifecycle. Сохранить raw response/observations согласно действующим capture/retention/provenance; если provider явно сообщил truncation/transport error, сохранить причину, иначе не угадывать первопричину. Не ослаблять depth guard и не допускать произвольный JSON как Decision.
3. Никакого repair: не дописывать скобки/quotes, не извлекать JSON из arbitrary text/fences, не переименовывать поля, не дополнять массивы/id/ref, не синтезировать Assessment. Штатное извлечение структурированного native payload согласно transport — не repair.
4. Доставить ошибку через существующие controller.invalid_proposal/host:decision-error и recovery; проверить путь фактически переданного следующего invocation (в рамках существующего бюджета). Не создавать отдельных correction loops/counters, forced retry, model fallback или новый scheduler.
5. **Невалидная proposal не отменяет уже выполненные native tool effects.** Не dispatch Actions из rejected Decision, не стирать наблюдения/unknown effects, не обозначать invocation как no_effect вследствие невалидного ответа, не replay предыдущий native invocation или принятые Actions. Независимые Workers продолжают по существующему контракту. Recovery/cancel/CAS сохраняют provenance и корреляцию; модель сама решает, нужна ли проверка изменившейся среды.

Результат: точный краткий отказ, строгая validation, неизменные права/lifecycle и сохранность наблюдаемых/неизвестных эффектов.

## 7. C12R.10.4 — Host Catalog и независимые native capabilities

Действующая архитектура skills уже правильна; не добавлять второй механизм. Уточнить модельную инструкцию без увеличения её до сценариев: Action.skills выбирает только Host Catalog IDs для Worker; provider-native capabilities независимы, используются через доступные в реальном окружении механизмы. Не предполагать наличие конкретного skill tool или filesystem path, не предписывать способ загрузки, не заставлять делегировать.

В конкретном CAPABILITY_UNAVAILABLE различить отсутствующий явно выбранный Catalog ID, unavailable registered source, недоступную обязательную provider capability и действительный permission denial. Для missing ID достаточно code/category/resource и «Skill ID is not registered in the Host Catalog. Native capabilities are independent of this catalog.» Не выводить глобальное отсутствие native skill. Сохранить отказ для явно выбранного неизвестного ID, не удалять его и не перенаправлять автоматически. Проверить фактическую доставку admission rejection Controller и сохранение остальной работы.

Запрещены Host discovery/scan skills, AGENTS.md, tools/scripts, automatic registration/copy/loading native skills, принудительная bridge/MCP, skill-specific runtime, изменение native permissions. Существующие configured Catalog skills/loader, role/skill instructions и trusted plugins сохраняются. Модель выбирает сама, доступные инструменты остаются нативными.

Результат: точный отказ Host Catalog, отсутствие новых посредников и ограничений; существующий Catalog и независимое native execution подтверждены тестами.

## 8. C12R.10.5 — архитектурная нейтральность и сохранение возможностей

Проверить изменённый код и реальные prompts на отсутствие обязательных workflows, классификации задач, предположений о Git/файлах/инструментах или provider/model ID. Не добавлять Host routing по словам, названиям skills, ролям или ожидаемому типу задачи. Не превращать примеры формы в рекомендацию конкретного решения.

Регрессии подтверждают, что технически возможны direct answer, native tool calls Controller, независимое продолжение, один/несколько Workers, parallel/dependencies/wait/acceptance, replan/cancel/clarify, reasoning levels, partial/unresolved assessment, model-selected history retrieval с/без MCP, работа в обычной директории без Git и mutable workspace. Проверки не предписывают выбор модели в каждой задаче. Native permission deny/allow и grants сохраняются, unknown tool visibility не становится deny. Никаких новых ограничений shell/file writes, source reconciliation или sandbox. В fixtures обычный тестовый workspace допустим как изолированное место эксперимента, не runtime requirement.

Не переоткрывать C12R.9 pagination, positional refs, artifact budgets, provenance, cancellation/recovery, independent Workers, unknown effects без конкретного нового воспроизведения. Проверить, что не появился второй scheduler/index/validator или semantic preprocessing. Никаких изменений default limits.

## 9. C12R.10.6 — контрактные/интеграционные проверки и инженерное завершение

Тесты добавлять вместе с исправлениями, а не откладывать до конца. Использовать существующие synthetic adapters, subprocess fixtures и test harness; никакие настоящие LLM/credentials/локальные сервисы не нужны.

| Проверка | Ожидаемый результат |
| --- | --- |
| Decision forms | Полные примеры декодируются; допустимые формы/ids/admission сохранены |
| Actual prompt delivery | Все Controller transports получают актуальное непротиворечивое описание; Worker не получает обязательный Decision |
| Parsing/depth/type | Malformed/fenced JSON отвергнут; valid non-object/depth различимы; native structured output штатен |
| Schema/admission | Адресный field error, enum, unknown field, incompatible fields; admission reasons не смешаны с syntax |
| Correction/recovery | Ошибка доступна в следующем вызове и после восстановления; исходный результат не ремонтируется |
| Effects | Invalid proposal не dispatch additions, не скрывает native effects и не replay; ранее принятые независимые Workers продолжают |
| Output | Точное содержимое answer через API/CLI/ACP |
| Capabilities | Native tools без Catalog, unknown explicit Catalog id reject, configured skills продолжают работать |
| Permissions/coordination | Existing trusted authorization, cancel, dependencies, retry, reasoning, direct/parallel/continue unchanged |
| C12R.9 | Pagination, refs, bounded context/artifacts, unknown effects, recovery and existing regression suite |

Запустить доступные обязательные root npm/checkJs/specification/import-boundary, foundation/core/provider/integration/acceptance, package/install, locked Nix/NixOS module evaluation проверки по текущим package/scripts/CI. CI не менять ради реальных моделей; не пропускать обязательные suites. Исторический SUCCESS 375/375 на 2cff795 не подтверждает новый HEAD. Зафиксировать фактические команды/exits/CI SHA и оставшиеся ограничения, а не просто обещание PASS.

Самостоятельные инженерные изменения публиковать отдельными связными коммитами только в greenfield/model-first-core. Допустимо объединить .1/.2 при едином контракте; тесты и нужная документация в том же изменении. Не требовать искусственного числа коммитов. Обновлять STATUS после каждого самостоятельного результата; CONTRACTS, DIAGNOSTICS, EXTENSIONS, PROVIDERS_AND_CONFIGURATION, DECISIONS, CHANGELOG и ACCEPTANCE_MATRIX только по принадлежности реально изменившегося знания. Не объявлять недоступные native проверки PASS. Инженерная реализация завершена при выполнении .0–.6, подтверждённой регрессии, сохранении инвариантов и актуальной документации. Если код завершён, но CI недоступен/не завершён, различать implementation и regression. После инженерного завершения агент передаёт локальный протокол §10 и фиксирует UNVERIFIED, не ждёт реальных моделей и не блокирует delivery.

## 10. C12R.10.7 — отдельная локальная сравнительная приёмка (не prerequisite разработки)

Протокол пользователя/инженера в реальном доступном окружении; не новый runtime stage, не GitHub workflow, не автоматическое требование к агенту-исполнителю. См. [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md). Прежние C12.3/C12.4/C12R.9/NixOS обязательства сохраняются.

### Группы и метаданные эксперимента

A — прямой OpenCode CLI; B — прямой OpenCode ACP при доступности (опционально, для разделения transport); C — Role Orchestrator до исправления; D — после C12R.10. A/C/D достаточны для первого сравнения; C/D при одинаковом transport — основной тест эффекта изменений. Прямой CLI не является полностью контролируемым эквивалентом ACP. Эти обозначения не заменяют отдельную матрицу C12R.9.

При проведении локальных runs записать фактические build SHA/version Role Orchestrator, adapter/agent/provider/protocol version, model ID/GGUF, sampling/reasoning settings, OpenCode/llama.cpp версии и context windows, Host context/resource settings, исходный user prompt, применимый skill и native permissions, начальное состояние тестовой среды, cold/warm cache. Это метаданные воспроизводимости, не продуктовые настройки, не prereq .0–.6. Не требовать их от GitHub-агента; неизвестное отмечать unknown. Сохранять неизменными существенные условия между C/D, не менять одновременно budgets и prompt. Отдельные эксперименты 256/512 КиБ Controller и 64/128 КиБ fetch остаются C12R.9. Состояние тестовой среды восстанавливает оператор между сравнениями, Host не делает rollback.

### Сценарии и оценка

- Прямой ответ, содержательная задача с инструментами (например, описание последнего коммита), тот же запрос с native skill и вариант с явным scope/no-write/форматом результата. Имена skills/Git — только пример эксперимента, не production logic.
- Нейтральная задача без VCS и без необходимости файловых операций; задача с несколькими разумными стратегиями, независимым полезным делегированием, изменением входных данных/перепланированием, продолжением истории. Не заставлять делегировать простую задачу ради теста; отдельное явное пользовательское поручение допустимо для проверки делегирования.
- Несколько сопоставимых повторов, при возможности 5–10 на ключевой сценарий/конфигурацию как ориентир, не обязательный продуктовый лимит. Отчёт отражает выборку/вариативность и различия транспортов.
- Собирать first Decision acceptance, ошибки syntax/schema/admission, correction turns, end-to-end correctness (scope, фактическая достоверность, требования), wall-clock, native tool calls, Controller/Worker invocations и полезный вклад, неожиданные эффекты, фактические input/output/cache usage при доступности. Не считать exit 0 или valid JSON семантическим успехом; меньше вызовов не всегда лучше. Сравнить сложные задачи на преждевременное завершение и ухудшение координации.
- Использовать существующие context.host_prepared/provider.reply_observed и локальные provider exports/logs. Не выводить token usage из JSON bytes или суммарных cache tokens, не добавлять зависимости от OpenCode DB/llama.cpp/telemetry. Unknown остаётся unknown. Сырые private prompts/skill contents/credentials не публиковать в Git; безопасные метаданные/обезличенное evidence с provenance.
- Оценка качества вне production Host; без нового scoring/ranking/semantic classifier. Если нативные провайдеры недоступны, отметить UNVERIFIED, не синтезировать результаты.

## 11. Условия завершения и последующие решения

| Статус | Условие |
| --- | --- |
| C12R.10 implementation complete | .0–.6 реализованы, технические контракты/возможности сохранены |
| Regression verified | Фактически успешные обязательные проверки на новом SHA |
| Native integration verified | Реальные подтверждённые runs нужного provider/client; отдельно от fixtures |
| Comparative quality/performance verified | Достаточное сопоставимое evidence качества/накладных расходов |
| C12 complete | Закрыты все ранее открытые native C12.3/C12.4/C12R.9/NixOS обязательства |

Не требовать нативной приёмки для завершения инженерной части. Не считать C12R.10 успешной оптимизацией качества только по CI или валидным JSON. Если ошибки остаются после исправлений, отличать слабость модели, конфликт native instructions/transport и избыточность интерфейса. Дальнейшее упрощение schema допустимо лишь как отдельное обоснованное решение, сохраняющее семантику, выразительность и technical invariants (отсутствие vs пустое поле не автоматически эквивалентны). Native structured output исследовать отдельно только при доказанной поддержке tools/agent loop; не вводить обязательный constrained decoding или специальные правила для одной модели. Не начинать новую архитектурную переработку без evidence.
