# C09 — Plugins, skills и внешние инструменты

Вход: C08, PROVIDERS_AND_CONFIGURATION. Цель — реальные расширения, без абстракции для каждого гипотетического scenario.

## C09.1 — Plugin API v1

Определить manifest и exports для provider factory, external tool definition/bridge, skill source loader. Plugin получает только нужные порты, не mutable coordinator state. Доверенный код всё равно имеет права процесса; не обещать isolation. Tests: несовместимая version, duplicate id, invalid factory return.

## C09.2 — Explicit loading

Загружать только paths/packages из trusted config. Проектные файлы не включают новый executable plugin автоматически. Ошибка одного disabled/неиспользуемого extension не отменяет unrelated operations; необходимый broken provider даёт локальный отказ. Tests: malicious project preference cannot add plugin, init cleanup, load failure diagnostics.

## C09.3 — Provider plugin conformance

Создать минимальный test plugin с новым provider id, прогнать ProviderPort suite без правок core. Fixture хранится в development и не поставляется пользователю. Tests: каталог видит capabilities, Controller выбирает plugin profile, invocation/cancel/result идут общим путём.

## C09.4 — Skill source и metadata

Определить id/version/description/resource refs/instructions. Загружать инструкции по выбору Controller; показать unavailable или truncation. Skills не исполнить как JS и не считать trusted authority. Tests: отсутствующий ресурс, одинаковые ids, изменившаяся версия, oversized instructions.

## C09.5 — Семантика skill restrictions

Ограничения skill передаются модели вместе с явным приоритетом пользовательских требований/действительных permissions. Host не распознаёт запреты regex по словам multi-agent. Tests проверяют faithful delivery и отсутствие privilege escalation; содержательное соблюдение проверяется отдельной native задачей/assessment, не keyword engine.

## C09.6 — External tool contract

ToolId, schema, resource/effect metadata, invoke/cancel и provenance. Expose через bridge/declared tool_call только при наличии реального потребителя. Не дублировать native terminal/edit/git. Tests: input invalid до invoke, permission denial, unknown effect после timeout, output correlation и ограниченный размер.

Предоставить модели вызовы существующего `ContextPort.list/fetch` через явно подключённый адаптерный bridge. Для CLI и ACP проверить доступный модельный transport (например MCP) отдельно. Объявлять `context.retrieval` поддерживаемой только при рабочем канале. Без канала сообщать об ограничении в capabilities и модельном контексте. Сохранить привязку к живой попытке, видимость выбранных ссылок, ограничения объёма и действующие разрешения на доступ между операциями. Bridge работает с записями ContextPort и не предоставляет операции над файловой системой.

Критерий приёмки для каждого заявленного канала — через штатный путь адаптера модельный сценарий обнаруживает запись, исключённую из краткого контекста, получает доступный payload через fetch и использует ссылку в результате. Проверить отказ для чужой ссылки, закрытой попытки и превышения бюджета. Нативную проверку учитывать отдельно от тестового транспорта.

## C09.7 — Каталог и config compatibility

Проверить project selection только установленных extensions, unknown major error, optional new fields, отключение на resume. Не терять сохранённый finding из-за отсутствия plugin; недоступен только новый вызов/ресурс. Tests: uninstall/disable с доступной историей, несовместимый profile без глобальной остановки.

## C09.8 — Документация расширения

Добавить продуктовую инструкцию написания минимального adapter/plugin и подключения skill с фактическими контрактами. Не ссылаться из docs на test fixtures/development. Закрыть A31/A32/A39; проверить product package без harness и без engineering policy runtime injection.
