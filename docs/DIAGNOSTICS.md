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
