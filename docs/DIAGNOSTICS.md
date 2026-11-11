# Диагностика и эксплуатация

Диагностика входит в продукт с первого работающего core. Её задача — объяснить, где находится работа, какое техническое условие мешает следующему действию и какой компонент вернул результат. Лог не принимает решений о качестве работы модели.

## Событие

Обязательные поля: schemaVersion, eventId, receivedAt, sequence, level, component, eventName, operationId при наличии, attemptId/actionId/decisionId при наличии, reasonCode, безопасные details. Времена provider отдельно от receivedAt; duration вычисляется монотонным clock. Корреляция клиентской и внутренней ACP-сессии отдельными id.

| События | Что позволяет увидеть |
|---|---|
| operation.accepted / waiting / finished / cancelled | lifecycle и явную причину ожидания |
| controller.requested / responded / invalid_proposal | длительность решения, ошибку формы, model profile |
| action.accepted / rejected / deferred / cancelled | зависимости, лимит, deny; без семантического verdict |
| attempt.reserved / dispatched / outcome / late_outcome | границу возможного эффекта и результат |
| permission.requested / resolved / expired | конкретный subject и provenance ответа без секретов |
| budget.reserved / settled / exhausted | расход, reservations, недоступные измерения |
| store.committed / conflict / unavailable / recovered | собственную revision и recovery |
| provider.connected / disconnected / protocol_error / cleanup | транспорт и владение ресурсами |
| context.materialized / truncated / unavailable | какие данные действительно доступны модели |
| diagnostic.dropped / export.redacted | предел наблюдаемости самой диагностики |

Для handoff события `context.materialized`, `context.truncated` и `context.unavailable` связывают позицию записи с operationId, actionId и attemptId. `selectedIndex` указывает на позицию ссылки в принятом action, а `sourceRevision` и `sourceIndex` указывают на запись в журнале, если она есть. Лог содержит числовые позиции и техническую причину. Для артефакта отметка `ARTIFACT_REFERENCE` означает передачу ссылки. Доступность байтов определяется при чтении.

`deferred` при занятых слотах и `rejected` при deny — разные причины. Сообщение «waiting» без reasonCode/owner/reference считается дефектом диагностики. Не логировать рассуждения модели как обязательную telemetry; достаточно видимых решений и outputs, если включено согласованное сохранение содержимого.

## По умолчанию

Читаемый progress для пользователя; структурированный NDJSON sink в state directory с rotation; stderr для CLI diagnostics, stdout только выбранного результата/ACP протокола. Redaction до передачи sink: credentials, auth headers, секретные env values и известные sensitive поля удаляются. Произвольный текст может содержать нераспознанный секрет, поэтому полные prompts/tool bodies по умолчанию не логируются. Включение body capture требует явной конфигурации и предупреждения о характере данных, не обещания идеального redaction.

Diagnostic sink best-effort и bounded. Переполнение не блокирует provider stream: счётчик dropped и компактное предупреждение. Durable task outcome не отправляется исключительно в этот sink — StateStore остаётся источником истины. Разные retention для диагностических файлов и task context не смешиваются.

## Команды целевого интерфейса

- `inspect <operationId>`: status/reason, активные actions, pending dependencies, остаток бюджета, последние outcomes, unknown effects и доступный итог.
- `trace <operationId>`: упорядоченные технические события; отсутствие части лога явно отмечается.
- `diagnose`: конфигурация, доступность state directory и настроенных adapter launch paths; без вызова моделей и без Git discovery.
- `export-diagnostics <operationId> --output <path>`: bounded redacted JSON/NDJSON пакет, manifest происхождения и недоступных частей. Экспорт не меняет task state и не отправляется третьим лицам автоматически.

Названия входят в целевой CLI контракт; реализация команд появится в слое Hosts. Программный API возвращает те же структуры без terminal presentation.

## Локализация проблемы

| Симптом | Проверить | Чего не делать |
|---|---|---|
| Нет следующего вызова | action decision, зависимости, concurrency, budget, permission | Не предполагать Git drift или плохой reasoning без событий |
| Дважды запущен исполнитель | decision/action/attempt ids, повтор доставки, dispatch log | Не маскировать дополнительным глобальным semaphore |
| Resume остановлен | unknown attempt, config capability, store error | Не перезапускать неизвестный effectful вызов |
| Есть ответ, нет tool proof | visibility capability и provenance | Не считать это доказательством ни PASS, ни FAIL |
| Кажется, потерян finding | contextRefs, truncation, summary coverage, raw availability | Не включать обязательный re-review всего проекта |
| Cancel не завершает процесс | adapter owner, cancel ACK, cleanup deadline | Не убивать процессы пользователя по совпадению имени |

## Граница готовности

Диагностика должна воспроизводимо объяснять failure/cancel/recovery и не менять результат при отключении sink. Native integration отчёт сообщает версии клиента/агента/протокола и фактически проверенные операции. Логи мока не являются доказательством native совместимости. Не включать необязательный внешний telemetry collector или dashboard до реальной потребности.


## Реализованные средства (C10–C11)

CLI: `role-orchestrator diagnose --config FILE --format json`,
`inspect OPERATION_ID`, `trace OPERATION_ID` и
`export-diagnostics OPERATION_ID --output PATH`. `run`, `resume` и
`cancel` используют тот же durable state. Вывод `--format json`
предназначен для обработки программой; ошибки CLI поступают в stderr.
Экспорт в существующий файл отклоняется (exclusive creation, mode 0600).

Operation journal сохраняется в StateStore и остаётся источником истины.
`trace` выводит последние 256 событий журнала с исходными индексами,
`manifest.format = operation-journal-json-v1`, счётчиком пропусков,
статусом, бюджетом и попытками. Для событий сохраняется `eventId`,
технический `reasonCode`, а при наличии — `decisionId` и
`actionId` по связи attempt→action. Применяемые обычные технические
причины принадлежат общей core mapping. В `manifest.missing` перечислены
отсутствующие части; transient diagnostics нельзя восстановить из этого
журнала. `inspect` показывает ожидание, лимиты, исходы и незавершённые
зависимости. Сводка не является доказательством корректности модели.

Файлы технических событий создаются в
`<state directory>/diagnostics/diagnostics.ndjson` при первой записи.
По умолчанию размер каждого файла ограничен 1 МиБ, сохраняются до трёх
пронумерованных архивов; `diagnostics.maxFileBytes` и
`diagnostics.retainedFiles` настраиваются в доверенном config v1.
Очередь ограничена 128 событиями, flush при закрытии — 1000 мс.
Переполнение, ошибка записи и превышение времени flush не изменяют
operation outcome; потери и ошибки подсчитываются. При доступном stderr
пишутся не более одного предупреждения и одной итоговой сводки на flush,
независимо от числа отказов. При backpressure stderr дальнейшие записи
предупреждений прекращаются, поэтому доставка сводки в stderr не гарантируется.
Такой журнал best-effort, а не transactional/audit store.
При позднем завершении операции после отмены следует проверять именно
durable operation journal, а не предполагать replay.

Перед sink, программной подпиской и выводом `trace/export-diagnostics`
известные значения secrets, упомянутые через
`providers.*.launch.env.*.fromEnv`, и чувствительные ключи/заголовки
подвергаются redaction. В trace/export это относится также к идентификаторам
event/attempt/action/profile/provider и прочим строковым полям. Полные поля bodies
не передаются по умолчанию; `diagnostics.captureBodies = true`
разрешает их только как явно выбранный риск. Redaction не может
обнаружить все секреты в произвольном человеческом тексте.
Не пересылайте технические файлы без дополнительной проверки.

`diagnose` проверяет parse/validation конфигурации, версию Node,
тип и права state directory, а также тип и права объявленных
provider launch paths. Относительная команда, зависящая от будущего
cwd либо относительных элементов PATH, помечается `cwd_dependent`;
обычный файл с правами записи не является доступным каталогом состояния.
Диагноз сообщает `capabilities.status: unknown`, если не было реального
negotiation. Он не запускает модель, не загружает плагины и не создаёт
state directory для несуществующего пути. Нельзя делать вывод
о совместимости провайдера или уровне его возможностей по одному
статическому диагнозу.

Context excerpt ограничен байтовым бюджетом, включая недоступные
записи и ссылочные markers. Опциональные записи дополнительно ограничены
128 элементами; при нехватке байтов для полного идентификатора он
не вставляется в prompt. `host:context-budget` сообщает число
непредставленных записей. Историческая ссылка при этом не удаляется
из StateStore и может быть найдена по позиции через `ContextPort.list`
и запрошена через `fetch` с учётом отдельного бюджета. `host:context-budget`
и обязательный пользовательский текст — служебные исключения из optional
budget; summary имеет фиксированную небольшую форму. Пропущенные данные
никогда не объявляются прочитанными. Буквальные
запросы и ограничения пользователя остаются доступны исполнителю.
Большой исторический журнал в StateStore сам по себе не означает
доставку всего журнала в prompt.

## Эксплуатационная проверка

Поддерживаемый runtime — Node.js 24, JavaScript ESM, Linux x86_64 для
проверенного CI. Nix flake предоставляет пакет и приложения CLI/ACP.
Нативная проверка реальных исполнителей и Zed/NixOS проводится отдельно:
контрактные тесты CLI/ACP с fixture не доказывают успех native
permission, reconnect и cancel. Для сбоев диагностики сначала
сопоставьте `operationId`, `attemptId`, `actionId` и `reasonCode`;
не повторяйте вызов с неизвестным эффектом автоматически.

## Диагностика reasoning effort

В `operationTrace` и экспорте к каждому attempt добавлены `reasoning.requestedLevel`, `source` (`model`/`default`), `effective` (из зафиксированного dispatch route), `configurationRef`, `submission` (достоверность факта отправки) и `nativeConfigAcknowledgment` (`adapter_confirmed` только при проверенном ACP config option; иначе `not_recorded`). Pending/consumed Controller selection связываются с `decisionId` и `attemptId`. Экспорт не выводит сырые model responses и ограничивает последние 256 attempts и 256 events; известные secrets маскируются, а не включаются в контекст модели.

Configured mapping не означает, что provider получил настройку. Запись dispatch intention не является ACK. ACP config-option acknowledgment не доказывает внутреннюю глубину рассуждения и не создаёт blocking gate. Если provider не сообщает статус, следует писать `not_recorded` и сохранять исходную uncertainty, а не интерпретировать её как отказ или запуск с default. Ошибка `CAPABILITY_UNAVAILABLE` своего Controller остаётся видимой в API/CLI/ACP и inspect без нового model invocation.

## Provenance проверок на границе поставки

Implementation complete — наличие проверенного кода заявленного контракта; regression verified — OBSERVED результат конкретных команд/CI на конкретном commit; native integration verified — отдельно OBSERVED исход реального agent/client сценария с версиями. Эти три состояния независимы. Подтверждённая исходная ветка на `cbd8e70` прошла [GitHub Actions run 42868825084](https://github.com/apathoid/role-orchestrator/actions/runs/42868825084); это не проверка новой структуры или конкретной модели. Подробные текущие результаты и открытые обязательства принадлежат единственному STATUS, а не этому нормативному описанию.

### C12R: адресные технические причины

Отказ admission сохраняет категорию (profile/role/skill/reasoning/adapter) и resource; существующие причины без категории остаются unknown. Отклонённый Controller Decision сохраняет `controller.invalid_proposal` с attemptId, доступным decisionId и ограниченным field/expected, но не копией отклонённого тела. Correction восстанавливается из journal после технического recovery; явное пользовательское продолжение или новый принятый Decision её заменяют. Trace отображает эти технические поля с действующей redaction. Это не новый цикл исправления и не изменение бюджета.
