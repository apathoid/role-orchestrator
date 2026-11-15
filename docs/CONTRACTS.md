# Контракты ядра и портов

## Общие правила

Все wire/persisted записи имеют `schemaVersion: 1`. Идентификаторы непрозрачны, назначаются владельцем; текст модели не создаёт trusted id или authority. Время нужно для истории/дедлайна, порядок обеспечивает sequence. Никакие данные модели не интерпретируются как команда Host вне явно валидируемого сообщения.

В первой реализации описывать tagged/discriminated unions через JSDoc `@typedef`, проверять их `checkJs`, использовать централизованный runtime decoder на внешних границах, результат `accepted | rejected` с типизированной причиной. Внутри core не перепарсивать уже проверенные данные на каждом слое. Не использовать `any`, JSON stringification или исключение без классификации как замену контракту.

## Основные записи

| Запись | Обязательные поля / смысл |
|---|---|
| Request | requestId, text, attachments[], optional workspaceContext, userConstraints[], trusted configuration reference |
| Operation | operationId, requestId, revision, status, transcript refs, authority reference, plan/action records, attempts, budget ledger, result reference |
| Authority | authorityId, trusted origin, permitted provider/tool resources, applicable scope expressed by available enforcement contract, standing decisions, revoked flag; без исходных секретов |
| Profile | profileId, providerId, model selector, native execution settings, declared/negotiated capabilities |
| Role | roleId, purpose, instructions, optional preferred profiles; роль не выдаёт capabilities или authority |
| Decision | decisionId, operationId, contextCursor, additions[], cancellations[], optional acceptedActionIds[], waitPolicy, clarification, finalAssessment, findings[], nextController (совместимость полей проверяет decoder/admission) |
| Action | actionId, kind=`delegate`, objective, profileId, optional roleId/skills[], contextRefs[], dependsOn[], expectedResult, optional continuationReference |
| Attempt | attemptId, actionId, operationId, generation, lifecycle status, dispatch certainty, effect knowledge, timestamps, reservation, terminal outcome reference |
| Invocation | attemptId, task/handoff, profile, workspace context, context bundle, effective authority reference, resource envelope, cancel signal |
| Observation | operation-scoped ref, optional providerRef, attemptId/source identity, source kind, received sequence/time, payload reference, completeness; optional source-reported time/version/location |
| Finding | findingId, author, claim, subject, supports[], uncertainties[], optional supersedes; статус/важность — оценка модели |
| Assessment | model author, requirement results[] со статусом `fulfilled \| partial \| unverified \| unavailable`, observation/finding refs, optional reason по требованию, unresolved questions, user-facing answer; overall=`complete \| partial \| unresolved`; user acceptance хранится отдельным событием |

Handoff — материализованная часть Invocation: задача, назначение специалиста, применимые инструкции, буквальные ограничения пользователя, релевантный контекст, ожидаемая форма результата. Не копировать весь журнал каждому специалисту. Controller может делегировать исполнителю исследование/изменение/проверку в одной задаче; Host не раскладывает её на фиксированные подэтапы.

Контракт `delegate` вызывает исполнителя, который сам применяет инструменты. Зарегистрированный внешний инструмент вызывается через bridge с toolId и типизированными аргументами; он необязателен для coding-сценариев и не заменяет native terminal/edit. Tool-result имеет ту же корреляцию attempt, но capability/effect описание относится к конкретному tool, а не угадывается из имени.

## Decision: валидация и применение

- `decisionId + actionId` идемпотентны внутри operation. Повтор с тем же содержимым возвращает прежнее решение; другой payload под тем же id — `IDENTITY_CONFLICT` без повторного dispatch.
- Новые зависимости ссылаются на существующие либо добавляемые actions; циклы и отсутствующие ссылки отклоняются локально до dispatch. У action нет скрытой зависимости от обязательного review.
- Зависимость указывает `after_terminal` или `after_model_acceptance`. Первое означает получение любого terminal outcome, включая failure. Второе требует явной оценки Controller указанного результата. Host не считает exit 0 семантическим успехом.
- `contextCursor` показывает, какие события видел Controller. Новый unrelated event не делает proposal автоматически недопустимой. Обязательные проверки относятся к актуальному cancel, revocation, лимиту, id и уже изменённым адресуемым actions.
- Незапущенный action можно отменить/заменить. Изменять содержимое уже отправленного attempt нельзя; создаётся новое намерение с новым id. Для running action сначала отправляется cancel request; эффект может остаться неизвестным.
- `waitPolicy`: `all_requested` или `next_completion`, с явным набором attempt/action ids. Невозможная ссылка возвращает ошибку. Controller получает snapshot завершённых результатов и перечень pending; Host не запускает автоматический polling Controller при отсутствии новых событий. Это правило ожидания не запрещает явно запрошенный моделью новый самостоятельный ход по расширению ниже.
- `finalAssessment` допустима без specialists. Если есть активные actions, Controller указывает дождаться либо отменить их. Host не скрывает незавершённый эффект за окончательным ответом; после cancel с неизвестным исходом итог может быть частичным с явным unknown.
- Clarification и finalAssessment взаимоисключающие в одном Decision. Новые additions не совмещаются с finalAssessment; cancellations допускаются для завершения. При clarification независимая уже запущенная работа продолжается, если модель не попросила её отменить. Пустой Decision без действия, ожидания, вопроса или итога — INVALID_PROPOSAL, а не повод для busy loop. Утверждённое расширение ниже добавляет явное самостоятельное продолжение как ещё одно действительное решение модели.
- Невалидный ответ модели возвращается тому же Controller как структурированная ошибка с допустимой схемой. Повтор потребляет общий бюджет. Нет regex fallback, синтетического плана или отдельной бесконечной correction-петли.

### Controller transport

Decision v1 — транспортная форма, а не пользовательский формат. Модель помещает требуемое содержимое в строку `finalAssessment.answer`, включая Markdown, Unicode и вложенный JSON как текст; Host не интерпретирует и не изменяет эту строку. Text adapters принимают один JSON object в итоговом Controller message без fences; нативный structured output остаётся допустимым по контракту адаптера. Обычные tool results и файлы не являются submission Decision. Сообщение модели не является submission в момент его получения: только declared result завершённого Controller invocation поступает в decoder/admission. Text adapter может выбрать ранее переданное сообщение при отсутствии последующего текста; `messageId`/item identity не являются признаком финальности. См. [точные границы ACP/CLI](PROVIDERS_AND_CONFIGURATION.md#controller-text-result-границы-acp-v1-и-codex-cli-jsonl). Additions — предложения Host-managed Actions; admission, reservation/dispatch и completion различны, принятая работа может быть отложена, dispatch не доказывает успех. Промежуточные сообщения, tools и Worker result не ограничены форматом Controller Decision. Каждая запись `finalAssessment.requirements[]` требует собственные `observationRefs` и `findingRefs` (пустые массивы допустимы); наличие массивов Assessment не заменяет их. Optional `reason` — непустая строка (после trim остаётся хотя бы один символ) либо отсутствие поля; null, пустая и whitespace-only строки отклоняются. Единственное модельное описание формы передаётся в Invocation.instructions; decoder/admission остаются авторитетом.

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
| Orchestrator API | submit(Request), resume(operationId, userInput?), inspect(id), inspectFinding(id, ref), cancel(id, source) | requestId dedup; одинаковая семантика CLI/ACP |
| ProviderPort | describe(), open(profile), invoke(Invocation), cancel(attemptId), close(session) | callback/AsyncIterable событий + один logical outcome; одновременность явно объявлена |
| StateStore | open(retention?), load(id), commit(id, expectedRevision, nextSnapshot), list(), close() | атомарность snapshot, чтение результата неизвестного commit по attemptId |
| Catalog | list(), resolve(profile/role/skill/tool) | immutable versioned config snapshot на запуск; явная переоценка на resume |
| External ToolPort | `bind` для попытки, `list()`, `call(toolId, input)` | schema validation, проверка permission, коррелированный receipt и ограниченный результат |
| ContextPort | invocation-bound list(cursor?), fetch(ref, sourceOperationId?) и captureArtifact(bytes) для доверенного адаптера | выбранные ссылки специалиста, точное разрешение на обмен между operations, bounded output, explicit unavailable |
| PermissionPort | request(attemptId, providerRequestId, options, action?), cancel(requestId) | решение пользователя связано с живым запросом; неизвестный option не принимается |
| DiagnosticPort | emit(event), flush() | best-effort, bounded, не source of truth и не источник семантических переходов |
| Clock / IdFactory | now(), monotonic deadline support, newId() | тестируемость без настоящего ожидания и случайных гонок |

Опциональное `action` запроса разрешения содержит описание провайдера с источником `provider_reported`, названием, видом действия, местами и подробностями при наличии. Клиент может показать их вместе с вариантами ответа. Полномочия определяются доверенным grant и решением по коррелированному запросу.

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

Coordinator ограничивает ожидание открытия сессии и вызова, даже если адаптер игнорирует abort. После abort решение Controller из этого вызова не исполняется. При возможной отправке coordinator сначала фиксирует неизвестный исход. Пока соединение принадлежит вызову, поздние валидные outcome, observations и usage сохраняются по исходному attemptId и могут уточнить ledger без нового хода Controller. Подтверждённое отсоединение завершает приём событий сессии. Сессия, полученная после дедлайна открытия, передаётся на cleanup.

Адаптер отвечает за нативную отмену и закрытие сессии. Cancel запрашивает отмену; close должен быть безопасен при незавершённых invoke и cancel и подтверждает отсоединение принадлежащего адаптеру соединения. Отсоединение само по себе не подтверждает внешние эффекты. При ошибке open адаптер освобождает ресурсы, которые ещё не передал coordinator. Coordinator ждёт cleanup до одного дополнительного invocation timeout. Неподтверждённое закрытие занимает слот живого coordinator до подтверждения отсоединения. Если такие слоты исчерпывают доступную конкуренцию, новые запросы получают RESOURCE_LIMIT.

## Реализованное расширение reasoning effort (native-пробы отдельно)

[Полный контракт](REASONING_EFFORT.md) определяет необязательные Profile.reasoningEffort/defaultReasoningLevel, Action.reasoningLevel, Decision.nextController, разрешённый выбор Invocation и дополнение существующего Attempt.route. Config остаётся v1; отсутствие поля в новом config означает native, отсутствие поля в исторической route — not recorded.

nextController.continue разрешает самостоятельный ход без внешнего события. Выбор следующего effort одноразовый, привязан к одной новой попытке; один Controller lifecycle и общий ledger сохраняются. Недоступный собственный effort возвращается пользователю через технический результат без автоматического fallback; для worker отказ адресуется Controller. Observation о настройке не является новым условием допуска, а idempotent retry учитывает эффективный native параметр.

## Граница автоматизированных и native-подтверждений

Синтетический ProviderPort fixture и реальные subprocess/protocol fixtures подтверждают только наблюдавшиеся события адаптера, но не результат внешней модели. `dispatchCertainty: not_sent` после невозможности открыть сессию отличается от `unknown` после потенциального dispatch; Host не повышает неизвестный эффект до `none` и не повторяет его автоматически. Принятый per-attempt reasoning selection фиксируется в immutable route вместе с configurationRef и идентичностью полного материализованного запроса. Корректность применения параметра конкретным LLM не следует из валидности JSON или локального ACP ACK.


## C12R.9 — расширение Decision без отдельного цикла

Существующий version 1 `Decision.nextController` поддерживает optional `contextRequest` вместе с `continue:true` (точные актуальные refs/cursor/workCursor — в разделах review ниже). Достаточно хотя бы одного уникального ref или одного допустимого cursor. `contextRequest` без `continue:true`, пустой и неизвестные поля отклоняются адресно. Контракт не предписывает запрос истории; Controller может закончить напрямую. Принятая запись уже находится в неизменном journal и потребляется ровно следующим Controller invocation; Worker scope не расширяется. Неизвестный или неразрешённый ref не превращается в новое разрешение, повтор Worker или blind retry.

`host:invocation-context.value.workMap` — derived technical projection с `total/represented/omitted`, lifecycle, attributed refs и original objective Decision ref. Недоступность body, отсутствие сохранённого artifact, бюджет и retention не выдаются за семантический результат. Terminal effect uncertainty отделена от in-flight uncertainty. Отклонения Action сохраняются техническим bounded preview; semantic relevance и окончательный Assessment принадлежат модели.


### C12R.9 review — точные расширения доступа

`Decision.nextController.contextRequest` при `continue:true` поддерживает `refs: (string | {revision:number,index:number} | {ref:string|{revision:number,index:number},offset:number})[]`, а также `cursor?:0|{revision:number,index:number}` (страница каталога) и `workCursor?:0|{revision:number,index:number}` (страница workMap). Каждый запрос необязателен. Позиция — существующая revision/index собственной операции. Невалидные отрицательные/дробные offsets и позиции, лишние ключи и дубли адресуются ошибкой schema; cross-operation positional access остаётся запрещённым. История/read permissions/отмена/operation scope/retention проверяются ContextPort при каждом чтении, включая последующие страницы после restart.

`ContextPort.fetch(ref,sourceOperationId?,{offset})` добавляет только явное чтение следующего фрагмента без изменения обычного fetch. `ContextFetch` может вернуть `kind:'chunk'` с base64 raw bytes, `format:'utf8'|'json'|'binary'`, `offset`, `totalBytes`, `nextOffset?` и source-attributed `item`; `invalid_offset` — отдельная причина недоступности. Byte budget проверяется по сериализованному ответу с metadata/base64, в том числе при fetchMaxBytes 64/128 КиБ. Для artifacts существующий store проверяет полный SHA‑256 перед выдачей части. Это чтение, не автоматическое действие/replay и не новый persisted index.

### C12R.9 review P2 — независимый per-call range budget

`ContextPort.fetch(ref,sourceOperationId?,{offset,maxBytes?})` принимает необязательный положительный или нулевой safe-integer `maxBytes` только для range fetch; отрицательные, дробные значения и неизвестные свойства дают `invalid_offset`. Указанный предел ограничивает **весь сериализованный chunk response**, включая attribution/position/metadata/base64, и не может превышать trusted `fetchMaxBytes`. `nextOffset` всегда указывает фактическое число успешно доставленных исходных байтов, а не запрошенный теоретический размер. Если metadata не помещается, результат `unavailable:budget`; нет ложного advancement. MCP и Controller вызывают этот же port с собственной меньшей границей без слияния глобальной конфигурации.

`workMap.nextCursor` опускается на завершённой странице; при нулевом прогрессе из-за bytes `workMap.unavailableReason='budget'` без phantom cursor. Это техническое описание, а не host-managed relevance/ranking.

`workMap.nextCursor` — `{revision,index}` существующего журнала: revision ограничивает членство начатого обхода, index адресует следующую запись в устойчивом порядке admission/reservation. Первый Attempt заменяет accepted-only запись на её исходной позиции; новые Attempts/Actions не входят в начатый обход. Lifecycle/refs всегда актуальны. `total` — размер начатого обхода, `liveTotal` — размер текущей карты; `represented/omitted` относятся к `total`. `workCursor:0` (или отсутствие поля) начинает новый обход. Старые числовые ненулевые offsets декодируются для recovery, но явно возвращают `invalid_cursor`; не переинтерпретируются. Курсор не хранится отдельно от Decision и не требует остановки Workers.

Accepted-only workMap rows reflect execution lifecycle events (`accepted`, `deferred`, `rejected`, `cancelled`) with the recorded technical cause; a rejected admission of a repeated proposal does not change an existing Action. Attempts retain their actual reservation/dispatch/terminal status, cancellation provenance and outcome/effect independently. Deferral is not terminal.

### C12R.9 final P2 — history directory

History directory `ContextPort.list(cursor?)` / MCP `context_list` / `contextRequest.cursor` share the same journal-prefix cursor `{revision,index}`. `revision` selects the original journal prefix (not Decision.contextCursor); `index` is the next offset in its newest-first visible directory (not a positional fetch ref or workCursor). The available reply includes its resolved `cursor`, `items`, and `nextCursor` only when more records remain. A fresh traversal is omission/0. Nonzero legacy numeric cursors decode in v1 but return `invalid_cursor`; malformed/future/out-of-range cursors reject. Visibility remains scoped to the current invocation. A partial Controller page advances only by the number of structured entries actually delivered; no entry fits => unavailable:budget, no continuation cursor. New journal entries are visible on a fresh traversal. No new stored pagination state.

The directory has the existing count/serialization ceilings (32 items, 8192 JSON bytes including cursor). The returned `cursor` is the resolved start position; `nextCursor` advances by exactly the delivered count, even after both materialization and final Controller packing. `ContextList` unavailable reasons: `closed`, `invalid_cursor`, `budget`. Decision schema and MCP argument decoder reject malformed shapes (`INVALID_PROPOSAL` / `invalid_input` respectively); nonzero legacy numeric values remain decodable, not valid continuation positions. End is an available empty page or a delivered last page without `nextCursor`. `historyRequestCoverage.directory` preserves `{kind,end,reason?}` even if the optional page envelope is omitted: known invalid/closed and an empty terminal page are not relabeled budget. If a nonempty page cannot fit, `kind:unavailable,end:false,reason:budget` and no advancement. Scope is the invocation's operation and visible selected refs; a cursor is not a permission grant.

## Model Activity (transient)

Optional fourth argument of ProviderPort.invoke: `activity(item)`, where `item` has kind `reasoning | user_message | tool | plan | finding`, JSON payload, optional nativeId/nativeKind. Only actual declared provider activity is eligible; ambiguous result chunks and host lifecycle are not public messages or findings. The coordinator binds operationId, attemptId, profileId, providerId, source=provider_activity and per-attempt sequence (receipt order, not global causality). This is not durable Observation, Finding, Decision or Outcome; no automatic model context, evidence, diagnostic body or replay. Existing adapters need not implement it. Missing native IDs are legal. Activity after invocation completion/cancellation is ignored independently of late execution evidence.

Trusted in-process `subscribeActivity({operationId, attemptId?}, listener)` returns unsubscribe; hosts must use existing session/operation authority. Enqueue is synchronous, listener delivery asynchronous and isolated. A finite per-subscriber queue (128 notices including delivery, 1 MiB serialized event data) drops on overflow and emits a gap with count/reason and per-attempt sequence range when known. No subscriber means no payload copy/history. Activity does not spend model, tool or context budgets. Terminal state remains inspectable through existing execution APIs.

## Native interaction (transient request/reply)

Optional Invocation.interactions supports(kind)/request(input, requestSignal) is bound to the existing attempt, authority and hard invocation deadline. The minimal neutral input kind carries providerRequestId, nativeKind and opaque JSON payload. PendingInteraction adds host requestId, operationId, attemptId, profileId and deadlineAt; no new Decision or Outcome semantics. A trusted programmatic owner chooses onRequest + respondInteraction, or handleRequest (not both); pendingInteractions(operationId) is inspection, not permission to answer a handler-owned request. Reply must match operation/attempt/request/native identity; identical accepted manual reply is idempotent while its attempt remains live, conflicting/late/foreign reply is rejected. Timeout/cancel/unavailable/invalid/error are explicit technical results. Optional trusted interaction timeout may shorten but not extend the invocation deadline; the existing Clock/scheduler is reused, no active-time accounting change. Pending state and reply receipts are ephemeral, cleared at attempt end, not replayed or durable evidence. Existing PermissionPort and Controller clarification retain their original independent contracts.

## Live execution notice delivery

`subscribeExecution({operationId,attemptId?}, listener)` scopes the existing diagnostic event stream; legacy `subscribe(listener)` remains available. These are delivery views, not authoritative journal replay. Both ActivityStream and Execution Events use per-subscriber FIFO (128 notices including one reserved gap slot and in-flight callback, 1 MiB retained data). Overflow drops new notices while a gap is pending; activity gap carries droppedCount and an attempt-local sequence range when contiguous. Execution delivery gap is a technical `DiagnosticEvent` (`component: delivery`, `eventName: delivery.gap`, `reasonCode: DELIVERY_OVERFLOW`, details.droppedCount). Its sequence is the last dropped diagnostic revision, not a new journal event. Gaps are never emitted to the diagnostic sink. Listener exceptions/slow callbacks do not block or fail execution. Unsubscribe/disconnect clears pending delivery, with no replay. Normal presentation finish may drain already queued notices for up to 250 ms per subscriber after execution completion; returns a count of unconfirmed notices (including callback failures), not a provider deadline or slot wait. Existing terminal result and pending interaction/permission paths are independent. The local control transport is described in [EXTENSIONS](EXTENSIONS.md#local-control-live-notices-and-interactions).

### Client presentation (C14)

`--presentation compact|detailed|debug` — Host-only option, не часть Decision/Outcome/Invocation. CLI machine stdout/exit code сохраняются, stderr incremental best effort; human text stdout on actual TTY strips control sequences only. Native tool ID отображается с scope `[attemptId,nativeToolCallId]`, включая ACP permission toolCallId и form reference, без изменения authority/receipt. `PermissionAction.nativeToolCallId?` — optional provider-reported metadata only. CLI local control `payload.interactive` is optional `yes` on accepted work; pending CLI entries are tagged permission/input, reply payload is explicit `{kind: answered, payload}` or cancelled/unavailable. Existing work answerKey/token/request/operation/attempt/provider correlation remains required; observers do not answer. Handler ownership ends with the last owning work socket; original live work request + original answerKey may reconnect without redispatch or capability change. Settled requests never reopen; observer and input-disabled work receive no answerKey. Stale replies cannot settle another request. ACP ordinary permission and form response contracts unchanged. No replay, synthetic thinking, hidden reasoning extraction or finding inference.

Scoped execution delivery can carry immutable committed model finding records as a second listener argument; unscoped diagnostic subscribers/sinks do not receive bodies. The accepted journal is authoritative. Activity source may include bound actionId/invocationKind, never required native identity. No durable presentation history or replay. Standard ACP notice (client session.notices) carries actual lifecycle/accepted findings and delivery gaps with source metadata, never synthetic thought/tool/history. See [corrective roadmap](roadmap/C13R_C14R_INTERACTION_RELIABILITY.md).
