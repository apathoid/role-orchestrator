# Контракты ядра и портов

## Общие правила

Все wire/persisted записи имеют `schemaVersion: 1`. Идентификаторы непрозрачны, назначаются владельцем; текст модели не создаёт trusted id или authority. Время нужно для истории/дедлайна, порядок обеспечивает sequence. Никакие данные модели не интерпретируются как команда Host вне явно валидируемого сообщения.

В первой реализации использовать discriminated unions, централизованный runtime decoder на внешних границах, результат `accepted | rejected` с типизированной причиной. Внутри core не перепарсивать уже проверенные данные на каждом слое. Не использовать `any`, JSON stringification или исключение без классификации как замену контракту.

## Основные записи

| Запись | Обязательные поля / смысл |
|---|---|
| Request | requestId, text, attachments[], optional workspaceContext, userConstraints[], trusted configuration reference |
| Operation | operationId, requestId, revision, status, transcript refs, authority reference, plan/action records, attempts, budget ledger, result reference |
| Authority | authorityId, trusted origin, permitted provider/tool resources, applicable scope expressed by available enforcement contract, standing decisions, revoked flag; без исходных секретов |
| Profile | profileId, providerId, model selector, native execution settings, declared/negotiated capabilities |
| Role | roleId, purpose, instructions, optional preferred profiles; роль не выдаёт capabilities или authority |
| Decision | decisionId, operationId, contextCursor, additions[], cancellations[], waitPolicy, optional clarification или finalAssessment |
| Action | actionId, kind=`delegate`, objective, profileId, optional roleId/skills[], contextRefs[], dependsOn[], expectedResult, optional continuationReference |
| Attempt | attemptId, actionId, operationId, generation, lifecycle status, dispatch certainty, effect knowledge, timestamps, reservation, terminal outcome reference |
| Invocation | attemptId, task/handoff, profile, workspace context, context bundle, effective authority reference, resource envelope, cancel signal |
| Observation | observationId, attemptId/source identity, source kind, received sequence/time, payload reference, completeness; optional source-reported time/version/location |
| Finding | findingId, author, claim, subject, supports[], uncertainties[], optional supersedes; статус/важность — оценка модели |
| Assessment | model author, requirement results[] со статусом `fulfilled \| partial \| unverified \| unavailable`, observation/finding refs, unresolved questions, user-facing answer; overall=`complete \| partial \| unresolved`; user acceptance хранится отдельным событием |

Handoff — материализованная часть Invocation: задача, назначение специалиста, применимые инструкции, буквальные ограничения пользователя, релевантный контекст, ожидаемая форма результата. Не копировать весь журнал каждому специалисту. Controller может делегировать исполнителю исследование/изменение/проверку в одной задаче; Host не раскладывает её на фиксированные подэтапы.

Контракт `delegate` вызывает исполнителя, который сам применяет инструменты. Для зарегистрированного внешнего tool, доступного через bridge, используется отдельный тип `tool_call` с toolId/typed arguments; он необязателен для coding-сценариев и не заменяет native terminal/edit. Tool-result имеет ту же корреляцию attempt, но capability/effect описание относится к конкретному tool, а не угадывается из имени.

## Decision: валидация и применение

- `decisionId + actionId` идемпотентны внутри operation. Повтор с тем же содержимым возвращает прежнее решение; другой payload под тем же id — `IDENTITY_CONFLICT` без повторного dispatch.
- Новые зависимости ссылаются на существующие либо добавляемые actions; циклы и отсутствующие ссылки отклоняются локально до dispatch. У action нет скрытой зависимости от обязательного review.
- Зависимость указывает `after_terminal` или `after_model_acceptance`. Первое означает получение любого terminal outcome, включая failure. Второе требует явной оценки Controller указанного результата. Host не считает exit 0 семантическим успехом.
- `contextCursor` показывает, какие события видел Controller. Новый unrelated event не делает proposal автоматически недопустимой. Обязательные проверки относятся к актуальному cancel, revocation, лимиту, id и уже изменённым адресуемым actions.
- Незапущенный action можно отменить/заменить. Изменять содержимое уже отправленного attempt нельзя; создаётся новое намерение с новым id. Для running action сначала отправляется cancel request; эффект может остаться неизвестным.
- `waitPolicy`: `all_requested` или `next_completion`, с явным набором attempt/action ids. Невозможная ссылка возвращает ошибку. Controller получает snapshot завершённых результатов и перечень pending; Host не запускает бесконечный polling Controller при отсутствии новых событий.
- `finalAssessment` допустима без specialists. Если есть активные actions, Controller указывает дождаться либо отменить их. Host не скрывает незавершённый эффект за окончательным ответом; после cancel с неизвестным исходом итог может быть частичным с явным unknown.
- Clarification и finalAssessment взаимоисключающие в одном Decision. Новые additions не совмещаются с finalAssessment; cancellations допускаются для завершения. При clarification независимая уже запущенная работа продолжается, если модель не попросила её отменить. Пустой Decision без действия, ожидания, вопроса или итога — INVALID_PROPOSAL, а не повод для busy loop.
- Невалидный ответ модели возвращается тому же Controller как структурированная ошибка с допустимой схемой. Повтор потребляет общий бюджет. Нет regex fallback, синтетического плана или отдельной бесконечной correction-петли.

## Outcome и ошибки

`Outcome` содержит attemptId, terminal=`completed | failed | cancelled | unknown`, `effect=none | possible | confirmed | unknown`, diagnostics, output refs, usage. Completed означает завершение исполнителя, а не успешность пользовательской задачи. `confirmed` подтверждает наличие наблюдённого эффекта, а не его корректность.

| Код | Смысл | Продолжение |
|---|---|---|
| INVALID_PROPOSAL / IDENTITY_CONFLICT | Неоднозначный/невалидный запрос | Ошибка адресуется Controller; другие actions сохраняются |
| CAPABILITY_UNAVAILABLE | Конкретному запросу нужна недоступная способность | Модель выбирает другой путь; unknown optional metadata не блокирует обычный вызов |
| PERMISSION_DENIED / REVOKED | Действительный отказ доверенной стороны | Сохранить отказ; не повторять автоматически до нового основания |
| RESOURCE_LIMIT | Не хватает остатка известного ресурса | Прогресс/частичный итог или ожидание решения пользователя |
| PROVIDER_START_FAILED / PROTOCOL_ERROR | Ошибка конкретного adapter boundary | Передать стадию отправки и effect certainty, а не общий «task failed» |
| PROVIDER_DISCONNECTED / DEADLINE_EXCEEDED | Нет надёжного конечного ответа | Если dispatch возможен, сохранить unknown; не запускать вызов повторно скрыто |
| STORE_CONFLICT / STORE_UNAVAILABLE | Собственное состояние не сохранено | Перечитать/восстановить commit; без повторного внешнего dispatch |
| CANCELLED | Отмена из client / user / shutdown / superseded / provider | Не путать отмену одного attempt с отменой всей operation |

Provider может сообщить completion без деталей вложенных инструментов. Это допустимый результат с соответствующим provenance; нельзя требовать недоступный «полный execution receipt» для любого продвижения. Если пользователь требует конкретного подтверждения, модель отражает отсутствие его как unresolved.

## Порты

| Порт | Минимальные операции | Важные свойства |
|---|---|---|
| Orchestrator API | submit(Request), resume(operationId, userInput?), inspect(id), cancel(id, source) | requestId dedup; одинаковая семантика CLI/ACP |
| ProviderPort | describe(), open(profile), invoke(Invocation), cancel(attemptId), close(session) | callback/AsyncIterable событий + один logical outcome; одновременность явно объявлена |
| StateStore | open(), load(id), commit(id, expectedRevision, nextSnapshot), list(), close() | атомарность snapshot, чтение результата неизвестного commit по attemptId |
| Catalog | list(), resolve(profile/role/skill/tool) | immutable versioned config snapshot на запуск; явная переоценка на resume |
| ContextPort | materialize(refs, budget), append(records), fetchArtifact(ref) | unavailable/truncated явны; artifacts bounded, refs не раскрывают произвольные secrets |
| PermissionPort | request(attemptId, providerRequestId, options), cancel(requestId) | решение пользователя связано с живым запросом; неизвестный option не принимается |
| DiagnosticPort | emit(event), flush() | best-effort, bounded, не source of truth и не источник семантических переходов |
| Clock / IdFactory | now(), monotonic deadline support, newId() | тестируемость без настоящего ожидания и случайных гонок |

## Жизненный цикл и конкуренция

Operation: `active | waiting | finished | cancelled`. Waiting всегда имеет конкретную причину и references; ожидание результатов — нормальная активная работа, не ошибка. Finished содержит модельную оценку `complete | partial | unresolved`, не автоматический PASS. После нового поручения пользователь может продолжить обсуждение завершённой operation с новым requestId и сохранённой историей; новое выполнение явно фиксируется как продолжение, без возрождения старых attempts.

Attempt: `reserved -> dispatched -> terminal`; crash в reserved не даёт уверенности, что отправки не было, если процесс мог отправить до следующего commit. `dispatchCertainty=not_sent | sent | unknown` — факт транспорта; terminal outcome позднее может уточнить unknown. Cancel requested не является доказательством прекращения эффекта.

Generation относится к модельному решению/продолжению operation, не к версии workspace. Устаревший callback по-прежнему может добавить фактическое observation; он не может отменить более новое пользовательское распоряжение или запустить actions своей заменённой generation. Возобновление завершённой operation новым requestId создаёт новую generation; terminal attempts предыдущей не открываются снова.

Каждая operation обрабатывает входящие события последовательно, но provider attempts выполняются параллельно в пределах лимита. Один writer не означает один активный agent. Controller не имеет двух конкурирующих решений одной generation: события собираются, новый decision начинается после завершения предыдущего. Superseded результат не запускает actions, но его фактические observations сохраняются.

CAS-конфликт собственного state не запускает provider повторно. Coordinator перечитывает snapshot, находит сохранённый attempt/event по id и повторяет только необходимую локальную запись. Никаких source hashes для разрешения такого конфликта.

## Ресурсы

Сначала reserve, затем dispatch. Один ledger содержит фактические измерения и оставшиеся reservations; snapshots derived, отдельные mutable счётчики запрещены. Бюджет invocations целочисленный и точный. Время ограничивается дедлайном, включая ожидание провайдера; ожидание ответа пользователя приостанавливает только специально объявленный active-time budget. Concurrency slot освобождается по факту termination либо потери owned connection с сохранением unknown.

Стоимость/token usage учитывается только если provider предоставляет измерение или объявленную верхнюю границу. Не заявлять жёсткий денежный лимит при неизвестной стоимости: такой лимит либо требует подходящего adapter contract, либо явно отображается advisory. Доступные точные лимиты продолжают действовать. Изменение профиля или retry не обнуляет расход.

Если лимита не хватает даже на следующий Controller, Host возвращает технический progress snapshot и RESOURCE_LIMIT с последним сохранённым модельным итогом при наличии. Он не создаёт новую семантическую assessment сам. Увеличение лимита требует действительного доверенного изменения конфигурации/решения пользователя, сохраняет прошлый расход и не возрождает отменённые attempts.
