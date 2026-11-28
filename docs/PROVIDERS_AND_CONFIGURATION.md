# Провайдеры, конфигурация и расширяемость

## Независимость от провайдера

Core получает ProviderPort, Profile и capabilities. Он не импортирует ACP SDK, не знает специальных CLI flags и не выбирает fallback по строке имени модели. Адаптер не определяет стратегию всей пользовательской задачи. Нет обязательного provider-native multi-agent режима.

В соответствии с [provider-first](ARCHITECTURE.md#принципы-владения-и-provider-first) адаптер предоставляет нативные возможности выбранного исполнителя через поддерживаемые контракты, не воспроизводя их семантику. Для пользовательского ввода, вложений, ресурсов, контекстных действий, режимов и нативных взаимодействий предпочтителен сквозной мост с минимально необходимой адаптацией. Клиентский UI, внутреннее поведение провайдера и способность модели использовать данные остаются у соответствующих владельцев. Не ограничивать одного исполнителя из-за отсутствия той же возможности у другого.

| Категория | Владелец деталей | Контракт реализации |
|---|---|---|
| Generic ACP agent | ACP adapter | initialization/negotiation, provider session, prompt, события, permissions, cancel и cleanup согласно проверенной версии протокола |
| CLI/headless | CLI adapter + доверенный launch profile | argv без shell interpolation, cwd/env, stdin, structured output либо атрибутированный текст, exit/timeout, owned process cleanup |
| Text/model API | Дополнительный adapter plugin | тот же порт; отсутствие tools честно объявляется; необязательная интеграция после основных adapters |

Первый обязательный поставляемый набор: generic ACP и CLI/headless. Чтобы заявить provider-agnostic readiness, провести реальные сценарии с двумя различными доступными исполнителями; выбор конкретных подписок/бинарников зависит от среды пользователя. Моки подтверждают порт, но не реальную интеграцию.

## Capability negotiation

`tools.bridge` describes bridging through this integration (including configured ACP client FS/terminal or MCP as applicable), not an inventory of the executor's native tools. `supported`, `unsupported` and `unknown` retain their configured/negotiated scope; native availability and permissions are determined by the provider/environment. Native subagents do not become Host Actions/Attempts merely by returning results.

Capabilities имеют explicit `supported | unsupported | unknown`, источник `configured | negotiated` и область действия. Минимум: input modalities, structured controller output, tool visibility, permission mediation, cancellation, usage reporting, session continuation, status lookup и допустимая concurrency. Не объявлять произвольный provider `read-only` лишь потому, что его роль Reviewer.

`unknown` не означает запрет любого вызова. Проверяется именно обязательная для запрошенной операции возможность. Отсутствие streaming, tool details или точного usage допускает деградацию с честными метаданными. Невозможность передать обязательное изображение, получить требуемую техническую гарантию или выполнить выбранную функцию возвращает адресную ошибку и каталог альтернатив.

Различать возможность приёма данных внешним endpoint RO, способ их передачи конкретным адаптером, объявленную нативную поддержку и способность модели содержательно использовать данные. Не выводить последнюю из имени модели, MIME type или успешного transport acknowledgment. Необъявленная возможность не означает запрета нативной работы; явный отказ необходим, когда не удаётся передать обязательные данные или выполнить требуемый технический контракт. Не терять контент молча и не компенсировать неподдерживаемый формат собственным OCR, конвертацией, выбором другого исполнителя или эмуляцией нативных режимов. Это направление развития интеграций, не декларация уже реализованной поддержки всех видов ввода.

Controller требует структурированный Decision. При native structured output использовать его; при обычном тексте использовать объявленный адаптером полный JSON envelope и schema validation. Не извлекать скрытую семантику регулярными выражениями из произвольного ответа. Worker может возвращать обычный текст с provenance. Ошибка Controller schema возвращается модели по общему циклу и бюджету.

## Инструменты и полномочия

Нативные tools остаются исполнителю. Host не предоставляет собственные read/edit/git/shell, если provider уже исполняет работу. Внешние tool extensions доступны через явно подключённый bridge (например MCP, если подтверждён контракт транспорта); зарегистрированный tool имеет id, input schema, описание, effect metadata и способ permission. Инструменты, о которых Host не получает подробных событий, не считаются отсутствующими или безвредными.

Настроенная доступность среды — верхняя граница, а не требование перечислить в каждом prompt все системные исполняемые файлы. Каталог сообщает возможности; модель исследует среду собственными tools. Orchestrator не сканирует PATH для обнаружения Git и не делает registry любого системного бинарника.

Permission prompt провайдера связывается с attempt/providerRequestId и передаётся пользователю. Используется существующее standing approval, если применимо. Deny/revoke сохраняется, late approval для уже отменённого запроса не исполняется. Программный API принимает доверенный grant с явным набором profile ids. Grant проверяется перед открытием сессии и отправкой вызова. Bridge предоставляет адаптеру функцию запроса, привязанную к attempt; доверенный клиент отвечает по host request id, attempt id, native request id и одной из предложенных опций. Действующее standing decision применяется в рамках профиля и ресурса. Если adapter не контролирует внутренние tools, его гарантия так и описывается. Не эмулировать enforcement через diff/rollback или обязательный fingerprint до запуска.

Если ACP-исполнитель требует клиентские filesystem/terminal инструменты, adapter использует явно предоставленный внешний client-tool port и согласованные capabilities. Это маршрутизация реального клиентского инструмента, не собственный файловый runtime Host. При отсутствии такого клиента исполнитель должен иметь собственные tools либо сообщить конкретную недоступную возможность. Нельзя рекламировать клиенту несуществующий bridge или реализовывать shell/file engine внутри core ради совместимости.

### Generic ACP через stdio

Программный Host регистрирует `createAcpProvider({ providerId, configuration })` из пакета `role-orchestrator`. Адаптер запускает агент из доверенного `launch` в рабочем каталоге задачи на Linux и открывает новую сессию ACP v1 для каждой попытки. Для `profiles.<id>.model` указывается идентификатор из model select option агента. Если выбор нельзя подтвердить, prompt не отправляется. Опциональный `nativeSettings.mode` задаёт объявленный агентом режим.

Вложения требуют доверенного `resolveAttachment` и согласованного формата ACP. Файловые и terminal RPC доступны через явно переданные обработчики `bridge`.

Внешний ACP Host хранит принятую raw декларацию clientCapabilities отдельно от нормализованных SDK capabilities. Наличие декларации не предоставляет полномочий. Для неизвестных session-scoped extension methods используется явная opt-in настройка запуска `--relay-client-extension METHOD` (повторяемая) и декларация клиента `clientCapabilities._meta.roleOrchestratorExtensions: { requests: [...], notifications: [...] }`. Внутреннему agent передаётся только пересечение этих списков. Допустимы только extension names с префиксом `_`; стандартные permission/FS/terminal и административные методы не проходят generic relay. Переносится только верхнеуровневый sessionId по этому контракту, вложенный payload непрозрачен. SDK связывает request/response/error, отмена и disconnect прекращают ожидание без replay или утверждения effect none. Без явной настройки extension relay недоступен; `--relay-client-tools` по-прежнему управляет только FS/terminal. Иные raw metadata не рекламируются внутреннему agent как поддержка. Это transport opt-in, не новая модель permissions, не инвентаризация native tools и не гарантия поддержки конкретным клиентом. Продолжение нативной сессии недоступно. Retrieval использует отдельно настроенный HTTP MCP.

### Native ACP interaction

SDK 2.4.0 supports typed elicitation/create. Only session-scoped form mode is negotiated when an actual configured interaction owner is available and (for external ACP) the client declares elicitation.form. URL, request-scoped authentication and custom modes are not advertised. The adapter preserves message/requestedSchema/options/metadata; outer relay rewrites only known sessionId and scopes an optional toolCallId by attempt. No host forms framework or semantic answers. Existing permission and clarification are unchanged. Actual native client support beyond SDK fixtures remains UNVERIFIED.

### Native activity (optional)

ACP thought chunks, native plan и tool_call/tool_call_update передаются в optional activity callback в момент получения, отдельно от parser/observations. Payload сохраняет исходный typed update и optional native ID. Codex exec JSONL documented item.started/updated/completed для reasoning (native summary), todo_list, command_execution, file_change, mcp_tool_call, web_search и collab_tool_call передаются после декодирования полного frame до process exit; payload сохраняет native event. Не рекламируется доступность каждого вида у конкретного агента. Unknown/malformed events и ambiguous agent_message не становятся public activity; никаких host findings. Accepted findings/assessment остаются в execution. Activity не меняет capture/result budgets, не реконструирует пропуски и не меняет provider settings. Codex JSONL incremental parser continues after raw stdout capture limit (1 MiB); frame limit remains 256 KiB, stderr 64 KiB. Execution evidence retained separately: 1 MiB of retained wire-frame bytes, plus the existing latest declared result/error slots (each bounded by the 256 KiB wire-frame limit). No separate arbitrary count cap; each retained envelope is at least 16 bytes, hence at most 65536 prefix entries plus two reserved frames. This bounds wire data, not JS heap bytes. Omission is explicitly reported; omitted evidence is not available for retrieval unless independently retained by an existing evidence path. No reconstruction: valid later frames are read directly from transport. Terminal event, process exit and malformed-frame checks unchanged.

### Controller text result: границы ACP v1 и Codex CLI JSONL

Текстовые адаптеры представляют Controller Invocation отдельными секциями: identity, исходная цель/ограничения, инструкции и единственная читаемая Decision v1 reference, записи контекста и отдельно переданная техническая коррекция. Произвольные значения остаются JSON-данными с экранированием; это структурная граница, а не защита от prompt injection. Все ранее доставляемые поля сохраняются; Worker и native structured Invocation не меняются. Формат пользовательского ответа по-прежнему принадлежит модели, отделён от внешнего Decision envelope.

Generic ACP v1 ([SDK v2.4.0 types](https://github.com/agentclientprotocol/typescript-sdk/blob/v2.4.0/src/v1/schema/types.gen.ts)): [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) описывает `agent_message_chunk` с optional `messageId` (идентичность сообщения, не признак финальности), отдельные tool updates и `session/prompt` stopReason. При `end_turn` адаптер передаёт накопленный текст последнего сообщения; смена ID начинает новый текст, новый tool call для анонимных Controller chunks разделяет накопление, tool updates могут перемежаться с chunks. Это существующее правило адаптера, не универсальная гарантия ACP о намерении модели. Если после tool call нет нового текста, именованное сообщение остаётся result; анонимное, сброшенное новым tool call, даёт пустой текст и обычную INVALID_PROPOSAL correction. Tool-only turn без текста также даёт пустой текст. `outputObservationRef` очищается вместе со сброшенным текстом; прежние observations сохраняются. Отсутствие нового сообщения само по себе не доказывает, что сохранённое сообщение было progress.

Codex CLI (`exec --json`): [JSONL event types, rust-v0.167.0](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/exec/src/exec_events.rs) определяют `item.completed` / `agent_message` (text) и `turn.completed` (usage), без указателя на отдельное итоговое сообщение. Адаптер выбирает последнее завершённое agent_message только после успешного turn и process exit; если нового сообщения после tool call нет, остаётся предыдущее. При отсутствии любого agent_message с завершённым turn результат недоступен: существующий PROTOCOL_ERROR, terminal unknown/effect unknown, technical waiting; не INVALID_PROPOSAL correction и не fallback на tool. Конкретный исполняемый Codex CLI выбирается конфигурацией, не зафиксирован npm SDK; версия 0.167.0 здесь источник wire contract, не подтверждённый native run.

Ни один из этих транспортов не предоставляет достоверной семантической классификации progress/final по расположению tool calls. На arrival нет Decision submission; только declared result завершённого invocation поступает в decoder/admission. Отдельное более позднее сообщение заменяет предыдущее, tool payload никогда не становится результатом. Не искать валидный JSON в истории и не добавлять ограничения на порядок инструментов. Реальные версии исполнителей и поведение моделей остаются частью локальной native acceptance.

### Codex CLI в headless-режиме

Оператор выбирает нативный профиль в доверенном `providers.<id>.nativeSettings.profile`. Адаптер передаёт имя через `--profile`. Политика исполнения и заранее разрешённые действия применяются самим Codex. Программный grant оркестратора по-прежнему разрешает запуск выбранного профиля. Controller и Worker, включая Reviewer, используют профиль без автоматической смены нативных настроек.

В headless CLI нативное `permissions.interactive` недоступно. Без явной настройки MCP `tools.bridge` недоступен. Запрос обязательной недоступной возможности возвращает `CAPABILITY_UNAVAILABLE` с причиной до запуска. Для обычного вызова действуют нативные правила headless Codex. Сообщённый Codex статус команды `declined` сохраняется как отказ команды. Общие ошибки инструмента сохраняют статус, который сообщил провайдер. Отчёты о завершении команд обеспечивают частичную видимость инструментов.

## Конфигурация v1

### Выбор State Store (C23)

CLI и ACP выбирают каталог в порядке: явный `--state-dir DIR` (относительно cwd запуска процесса), затем доверенный `storage.directory` (относительно логического каталога конфигурации), затем автоматический Store. Программный API сохраняет существующий контракт `stateDirectory` / `storage.directory`, без автоматической CLI-идентичности. Если объект storage задан, его directory по-прежнему обязателен.

Стандартный config — `$XDG_CONFIG_HOME/role-orchestrator/config.json` (fallback `~/.config/role-orchestrator/config.json`); его автоматический Store — `$XDG_STATE_HOME/role-orchestrator` (fallback `~/.local/state/role-orchestrator`). Для других config paths Store равен `<state-root>/configurations/<safe-basename>-<sha256>`. Хеш вычисляется по нормализованному абсолютному логическому пути, не содержимому и не realpath. Имя ограничено 48 ASCII-символами, хеш полный. Изменение JSON и retarget symlink не меняют Store; разные логические пути могут иметь отдельные Stores даже с одинаковым содержимым. Относительные XDG пути нормализуются относительно cwd запуска. `diagnose` сообщает stateDirectory и stateDirectorySource без создания Store.

Явно выбранный общий физический Store сохраняет одного writer. История прежних дополнительных конфигураций не переносится: выберите старый каталог через `--state-dir`. Нет discovery или fallback в другие Stores. При restart ACP перечитывает конфигурацию; при неизменном Store сохранённые сессии доступны. Hot reload отсутствует. После обновления RO штатно перезапустите ранее запущенные ACP runtime: новый клиент и старый владелец (или наоборот) могут не совпасть по execution compatibility reference; новый клиент также может получить отказ административного запроса от старого владельца, ожидающего обязательный configurationRef. Обновление установленного RO не изменяет уже запущенный процесс. Не предусмотрены protocol negotiation, автоматический replay или takeover. Параллельное использование одного workspace не создаёт workspace locks и не координирует внешние providers/plugins/tools.

Формат — UTF-8 JSON. [Схема конфигурации v1](../src/application/configuration/config-v1.schema.json) применяется при runtime validation. Доверенный пользовательский файл задаёт providers/profiles, controller, ресурсы, лимит истории, state/diagnostics и установленные plugins. Проектный файл необязателен, читается только из явно выбранного cwd или явно переданного пути; поиск Git root и обход родителей для обнаружения конфигурации не нужны.

Приоритет: built-in defaults < доверенный user config < разрешённые project preferences < явные доверенные параметры запуска. Project preferences могут выбрать существующий профиль/role/skill и уменьшить лимит; не могут добавлять исполняемый plugin, endpoint, secrets, расширять permissions или повышать пределы. Merge выполняется по описанным полям, не generic deep merge массивов. Неизвестные поля — ошибка с JSON path. Отсутствие поля отличается от `null`. По умолчанию используются 2 одновременных вызова, 40 вызовов на operation и 180 000 мс на вызов. Проектный файл `.role-orchestrator.json` читается в явно выбранной директории или по явно переданному пути. Он может задать `controllerProfile`, `preferredRole`, `preferredSkills` и сниженные `resources`. При принятии и явном продолжении операции CLI и ACP разрешают preferences по рабочему каталогу этой операции. Предпочтения передаются новым вызовам. Уже запущенные вызовы сохраняют параметры запуска. Ограничение параллельности проекта применяется к его операции в пределах общего лимита владельца.

Иллюстрация целевой структуры (пути/модель являются примерами и требуют замены):

```json
{
  "schemaVersion": 1,
  "providers": {
    "agent": {
      "adapter": "acp",
      "launch": {"command": "/path/to/agent", "args": [], "env": {}},
      "nativeSettings": {}
    }
  },
  "profiles": {"primary": {"provider": "agent", "model": "configured-model"}},
  "controllerProfile": "primary",
  "roles": {"reviewer": {"instructions": "Проверь указанный результат и основания вывода.", "preferredProfiles": ["primary"]}},
  "resources": {"maxConcurrentInvocations": 5, "maxInvocationsPerOperation": null, "invocationTimeoutMs": null},
  "context": {"maxBytes": 65536},
  "storage": {"directory": "/path/to/orchestrator-state"},
  "diagnostics": {"level": "info", "maxFileBytes": 10485760, "retainedFiles": 3, "captureBodies": false},
  "plugins": [],
  "skills": [],
  "tools": []
}
```

Числа в примере — ресурсная конфигурация, не обязательное число стадий. Значения defaults выбрать и обосновать при реализации; таймаут одной попытки не обязан совпадать с бюджетом operation. В `launch.env` значение задаётся ссылкой `{"fromEnv":"VARIABLE_NAME"}` на переменную окружения доверенного процесса. Secrets не сохраняются в snapshot. В диагностике отображаются источник и fingerprint конфигурации без значений секретов. Fingerprint конфигурации не является fingerprint workspace.

На resume immutable snapshot запуска доступен для объяснения истории; текущие доверенные запреты и отключённые endpoints применяются к новым actions. Изменение необязательного параметра не инвалидирует историю. Пропавший выбранный профиль даёт локальную ошибку с возможностью нового выбора моделью.

Необязательная настройка `storage.artifactRetention` включает очистку опубликованных артефактов при открытии локального store. Можно задать `maxAgeMs`, `maxBytes` или оба предела. Область применения описана в [правилах хранения](CONTEXT_AND_RECOVERY.md#retention).

Доверенный пользовательский конфиг может задать `permissions.standing` как список записей `{ "profileId": "primary", "resource": "fixture:read", "optionId": "deny", "kind": "deny" }`. Каждая пара profile/resource уникальна. Брокер сверяет действующий grant и предложенные варианты. Standing allow применяется при совпадении option id и его типа. Standing deny остаётся отказом, если соответствующий вариант отсутствует. Project preferences не задают эти правила.

## Plugins, skills и MCP

Доверенный пользовательский конфиг перечисляет модули и доступные ресурсы. Проект может выбирать установленные профили, роли и skills в рамках этого списка. Он не загружает код и не предоставляет разрешения. Практический пример подключения, контракт фабрики, жизненный цикл и формат skill описаны в [руководстве по расширениям](EXTENSIONS.md).

Опциональное `providers.<id>.mcpBridge: true` включает канал для `context_list`, `context_fetch` и настроенных внешних инструментов. Generic ACP передаёт HTTP endpoint в `session/new` после согласования `mcpCapabilities.http`. До согласования возможность помечена `unknown`. Если агент не поддерживает HTTP MCP, модель получает сообщение о недоступности retrieval. Обязательная возможность в таком случае даёт адресный отказ. Codex CLI получает MCP endpoint в аргументах конкретного `exec` и требует готовности сервера. При выключенном bridge модель получает только переданный контекст.

Контекстный bridge пользуется видимостью и лимитами текущего вызова. Выбранные ссылки специалиста и разрешения на обмен между операциями проверяет `ContextPort`. Внешние инструменты используют отдельные ресурсные решения доверенного permission broker.

Для MCP `tools/call` транспортное ограничение ответа отделено от состояния выполнения. Если действующий `AttemptTools` вернул результат, не помещающийся в MCP response budget, bridge передаёт компактные `status`, `effect`, `callId` и `ref` (когда представлены корректными значениями), отмечает `outputUnavailableReason: budget` и MCP `isError: true`. Это **ошибка доставки исходного output**, а не отказ до запуска; исходный `ToolReceipt` не изменяется, вызов автоматически не повторяется. Для нестандартного результата без полного `ToolResult` форма ограничивается `unavailable/budget` с консервативным `effect: unknown` (либо известным допустимым эффектом) и сохраняемыми `callId/ref`, если они даны; это не утверждение об отсутствии выполнения. Если даже метаданные не помещаются, транспорт отвергает ответ по лимиту (HTTP 413) вместо подмены provenance. Штатный `ToolPort` независимо ограничивает output 64 КиБ и обычно возвращает уже компактный `truncated` с исходным effect — MCP не дублирует его усечение. Интерактивное разрешение инструмента bridge не меняет нативную политику headless CLI.

## Версионирование

Неизвестная major config/plugin/schema version отвергается с понятной причиной. Добавление необязательного поля — совместимое изменение только если старое поведение сохраняется. Secrets и live permission tokens не сериализуются. В этой greenfield-реализации нет обязательной совместимости со схемами другого продукта или его историей.

## Reasoning effort в profiles

[Действующий контракт](REASONING_EFFORT.md): config schemaVersion 1, без миграции. Общие trusted templates задают logical IDs, native values и обязательный default; профили явно подключают template. Отсутствие ссылки не ограничивает нативную возможность. Старые inline mapping/default отклоняются.

Пример фрагмента (native values иллюстративны):

```json
{
  "features":{
    "reasoningEffort":{
      "standard":{"default":"low","options":[
        {"id":"native"},{"id":"low","nativeValue":"low"},{"id":"high","nativeValue":"high"}
      ]}
    }
  },
  "profiles":{
    "primary":{"provider":"codex","model":"configured-model","features":{"reasoningEffort":"standard"}},
    "reviewer":{"provider":"codex","model":"configured-model","features":{"reasoningEffort":"standard"}},
    "unmanaged":{"provider":"codex","model":"configured-model"}
  }
}
```

Controller или специалист выбирают **логический идентификатор**, не непосредственное значение провайдера. Controller может завершить сразу, самостоятельно продолжить с `nextController: {continue:true, reasoningLevel:"high"}`, делегировать со своим `Action.reasoningLevel` либо сменить план после observations; Host не сортирует уровни и не требует внешнего события между самостоятельными ходами. Mapping внутри catalog/route доверенный; project preferences не могут его расширить.

Codex CLI передаёт per-invocation значение аргументом `-c model_reasoning_effort=<JSON-quoted value>`, не изменяя `--profile`. ACP использует только опубликованный конкретной сессией однозначный `select` option категории `thought_level`, выполняет `session/set_config_option` и проверяет возвращённую текущую настройку. Если агент не публикует такой option, этот ACP-адаптер отказывает selectable до prompt. Native сохраняет прежние правила выбора/сессии. Для plugin providers `supportsReasoningSelection: true` — обязательная декларация поддержки selectable (прежний native путь не требует её).

Факт выбранного уровня, adapter submission и доступный configuration acknowledgment различаются; отсутствие ACK не запрещает работу. Неподдерживаемый Controller уровень даёт видимую technical error `CAPABILITY_UNAVAILABLE`, без silent fallback. Изменение mapping не переписывает прошлые attempts и не открывает слепой retry. Встроенные автоматические тесты пройдены; версия фактического Codex/ACP агента и native applied-value остаются **UNVERIFIED** до live probe.

## Подтверждённые границы нативной совместимости (10 ноября 2026)

Реализация generic ACP v1 использует `@agentclientprotocol/sdk@2.4.0`, а CLI-путь — установленный `@agentclientprotocol/codex-acp@2.5.0` в качестве зависимости упаковки. Протокольные fixtures и Node 24/Linux CI проверяют разбивку messages без `messageId`, model/session option negotiation, permissions, поздние tool outcomes и shutdown; ни один из этих результатов не доказывает работу реальной модели. Codex CLI native probe завершилась HTTP 401 без `turn.completed`; для Codex ACP 2.5.0 `initialize` вернул ACP v1, но `session/new` завершился по deadline. Эти пробы не подтверждают успешный prompt, tool permission, cancel или resume в реальном Zed. Возможность выбора `thought_level` является session-specific и не обобщается на ACP в целом. Для production необходима отдельная проверка конкретных версий, настроек и credentials; чувствительные значения не фиксируются.


## C12R.9 — независимые границы контекста

В доверенном `context` schema v1 доступны положительные числовые параметры в байтах: `controllerMaxBytes` (262144 по умолчанию), `handoffMaxBytes` (65536), `fetchMaxBytes` (65536), `captureMaxBytes` (65536), `skillInstructionsMaxBytes` (65536), `toolOutputMaxBytes` (65536). Для прямого программного API действуют те же поля; каждое ограничено 16 МиБ как техническая защита от неограниченных allocations. Legacy `context.maxBytes` действует **только** как alias `controllerMaxBytes` и не может использоваться вместе с ним. Изменение Controller бюджета не поднимает лимиты fetch, capture, skills, Worker или внешних tools; если тест или потребитель требует старого совместного поведения, необходимые границы задаются отдельно и явно. Эти параметры не определяют собственное context window/число токенов провайдера.

`Action.skills` ссылается только на явно зарегистрированные Host-managed Catalog ids. Отсутствие id в каталоге не ограничивает provider-native tools, skill discovery, `AGENTS.md`, проектные файлы, terminal или scripts; ошибочный *явно выбранный* Catalog id отклоняется только как Host capability. ACP и CLI сохраняют свои native механизмы без host filesystem runtime и без обязательного MCP.


### C12R.9 review — scoped chunk response

Нативный MCP tool `context_fetch` принимает optional `offset` (safe nonnegative integer) как обычный аргумент. `ContextPort` возвращает origin/provenance и метаданные source completeness вместе с байтовым `base64`; `nextOffset` разрешает модели по желанию запросить следующую часть. Нет увеличения общего лимита MCP calls, response cap или изменения permissions. Без MCP тот же запрос можно выразить через `nextController.contextRequest.refs:[{ref,offset}]`. Legacy вызовы без `offset` сохраняют прежнее поведение. Полностью сохранённый artifact и ранее усечённый artifact различаются по receipt size/originalSize/truncated. Лимиты `controllerMaxBytes=262144`, `fetchMaxBytes=65536`, `captureMaxBytes=65536` не изменены; например, для хранения исходных 120 КиБ требуется отдельный доверенный `captureMaxBytes` не меньше фактического размера.

### C12R.9 review P2 — ограничение конкретного транспорта

MCP `context_fetch` принимает `offset` и optional `maxBytes` для конкретного ответа. В адаптере per-call budget автоматически ограничивается половиной максимума MCP response 256 КиБ, чтобы оставалось место для двойной JSON-сериализации RPC. Проверка полного JSON-RPC envelope по-прежнему обязательна. Если `fetchMaxBytes=512 КиБ`, это **не** означает, что MCP может передать 512-КиБ chunk одним ответом; модель запрашивает следующий `nextOffset` по желанию. Controller при `controllerMaxBytes=8192`, `fetchMaxBytes=65536` получает меньшие фрагменты с корректным offset, без повторного запроса того же недоставляемого 64-КиБ тела. Ни дефолт 256-КиБ Controller, ни независимые trusted budgets не повышены.

### Client presentation flag

CLI run/resume и `role-orchestrator acp --presentation compact|detailed|debug` select renderer only. No provider/model setting changed. ACP maps native thought/tool updates and Controller plan (detailed/debug), Codex completed reasoning summary only. ACP defaults to standard agent_message_chunk for compact attributed RO lifecycle/accepted finding/gap; --progress-display notices selects the existing capability-gated standard notice route (omit when session.notices is absent). No duplicate delivery. CLI styles are trusted ANSI on interactive stderr only, NO_COLOR/dumb/non-TTY plain; native text is streamed, final stdout/JSON unchanged. Explicit live public/finding messages still require actual provider channel, never ambiguous agent output. Native tools/skills/settings/permissions/elicitation are not suppressed by mode. CLI supports session form primitive fields and primitive arrays as explicit JSON, not URL/auth or arbitrary complex forms. Actual graphical rendering/out-of-prompt activity and native providers remain UNVERIFIED.


C15R CLI presentation: compact shows native tool actions and terminal updates without identical repeats; detailed adds meaningful transitions and available display details; debug includes delivered native event identity/sequence. Sparse updates retain prior fields only within actual native tool/attempt identity. Native source and thinking remain incremental, no full response buffering or live status line. Unknown identity/gap/eviction is explicit or uses standalone fallback. Shared human TTY prints the model answer before the summary; JSON and redirected stdout are unchanged. ACP inline default and native widgets/explicit notices are unchanged.


### C15R-UX CLI visual rendering

CLI run/resume may style native sources with a fixed Controller accent (trusted invocationKind) and stable deterministic palette for any Worker roleId; role names never select special permission/capability rules. Human TTY final from actual `Assessment.answer` gets safe Markdown visual formatting only when terminal color styling is active; other text is left as supplied. Embedded control sequences are sanitized for display; source payload/Assessment in state and redirected/machine/JSON stdout are unchanged, and ACP native update protocol is not transformed by CLI. Large Markdown falls back to complete sanitized plaintext. Sources and findings are not synthesized from model reasoning. `:details [N]` shows **bounded current-field or permission-metadata preview**, not the entire original native request. Omitted/deep/long data is labeled; the native schema, answer, grants and provider payload are unchanged. Permission options and form choices display in bounded pages (`:choices N`) without limiting the number of native options. Numeric selection accepts only previously displayed options for that **specific active request/field**, retaining at most 128 recent displayed page offsets; forgotten pages can be displayed again. Initial page 1–20 is presented immediately; additional pages count as shown only after the terminal Writable callback. Explicit `id:<exact native option ID>` remains a deliberate direct choice, distinct from numeric position and checked by the original broker. The limited `:details` preview now reads only a fixed set of known native JSON fields rather than enumerating all object keys, which keeps preparation bounded for ordinary decoded JSON even with very wide metadata. Unknown fields may be omitted and that limitation is disclosed; original constraints/permissions/typed values are not altered. Native Unicode strings are clipped before sanitization without splitting UTF-16 emoji or a base from a following combining mark. Compact/detailed suppress redundant request/finish technical names, **but not delivered meaningful broker resolution events**: the reason gives an attempt-scoped outcome without requestId or provider ACK; debug retains raw event/reason IDs. Native tool `completed` is neutral and does **not** prove command success. Generic `pending` remains visible immediately even when it is the only event; only repeated identical updates by native identity are suppressed. Native real-model/Zed corrective acceptance remains UNVERIFIED. Actual installed model/Zed fidelity is UNVERIFIED.

### C15R.6 CLI native input

CLI interactive form supports the restricted ACP SDK v2.4.0 stable-v1 form subset (flat primitive fields, single-/multi-select, required/optional, bounded display constraints). It displays original message and provided labels, asks for each field's normal text/typed value and maps numbered choices to actual native values; `:skip` omits an optional field, `:back` edits, `:decline`/`:cancel` return native form actions, `:json {...}` is an explicitly validated low-level fallback. Literal strings such as `cancel` remain text; prefix `::` escapes a literal `:` command. Permission options select numbered displayed positions or `id:<native ID>`; no bare native ID grants. Reply aliases are monotonic per terminal ownership and do not change trusted request identity. Unsupported form variants stay available to native graphical ACP clients; CLI does not infer relationships between field names or alter provider discovery/tools/skills.

C17/C17R text-adapter diagnostics use the existing trusted `diagnostics.captureBodies` option (default off) and optional `diagnostics.promptCaptureMaxBytes` (integer UTF-8 bytes, default 16384, maximum 1048576). Example for a controlled diagnostic run: `{"captureBodies":true,"promptCaptureMaxBytes":262144,"maxFileBytes":4194304,"retainedFiles":3}` as the diagnostics object. File/queue and redacted serialized record limits still apply; large captures can be partial/unavailable. Older configs remain valid; no new requirement for providers/skills, no default context/resource change. See [DIAGNOSTICS](DIAGNOSTICS.md) for actual measurement boundaries and opt-in capture.

## C18 — Optional ControllerIntent delivery

Provider settings may specify `controllerIntent: "text"` or `controllerIntent: "prefer_mcp"`; **absent** retains legacy Decision v1 behavior and does not change Worker output. With `text`, the model returns the full semantic ControllerIntent JSON as the completed Controller final message. In ACP `prefer_mcp`, the adapter checks actual `agentCapabilities.mcpCapabilities.http` **before** prompt dispatch and exposes an invocation-scoped MCP `submit_decision` when negotiated; otherwise it falls back to text ControllerIntent in the **same invocation**, not an extra provider call. The Codex CLI path uses text intent when opted-in, without claiming native structured enforcement or negotiated ACP MCP. `mcpBridge` controls ACP bridge availability; no provider name check is performed in Core.

A valid `submit_decision({intent,replaces?})` yields a `proposalRef` that is **pending**, never an admitted/started Action. Explicit known-lineage replacements can override a previous proposal in registration order, with temporary last-wins only between competing explicit replacements; unrelated proposals produce a model-visible recoverable conflict. Finality occurs only after trusted native `end_turn` and accounting for all previously registered Decision calls. Blank or ordinary native final text is valid in MCP mode and **must not be parsed** for a second Decision; provider-disconnect/cancel/unknown completion cannot admit pending content. The MCP URL is a scoped bearer capability, **not proof of root native agent identity** and not a new authorization channel. Native skills/tools/subagents remain independent of Host Catalog registration and Controller submission.

### C18R — ACP capture, MCP control naming and rejected deliveries

For `controllerIntent:"prefer_mcp"` with negotiated HTTP MCP, `submit_decision` is a separate, bounded control transport. After native `end_turn`, a fully received valid control submission remains eligible even when ordinary ACP event capture exceeded its 1 MiB **aggregate** bound. The adapter records the output limit and truncation; it does **not** claim that incomplete native message text is complete or parsed. For legacy or text ControllerIntent, incomplete native output remains `RESOURCE_LIMIT`. An actual refusal, cancellation, unsupported stop reason or protocol failure still forbids admission.

The built-in tool is advertised under `submit_decision` by default. If external tool metadata contains that name, the bridge deterministically selects `role_orchestrator_submit_decision` or the first free numbered suffix, includes the chosen name in the Controller prompt, and routes both functions distinctly. Existing external tool ID, granted permissions and native operations remain available. A JSON-RPC request id reused with different payload still returns `-32602`; when it is an attributable explicit replacement of a known selected proposal, that observed rejected mutation is forwarded to the invocation-local pending registry. It cannot silently preserve the superseded candidate. Uncorrected request-ID conflict is a technical failure; identical replay is not an additional submission.

## C18N — Optional captured-evidence MCP tools and request lifetime

When the existing ACP HTTP MCP negotiation succeeds, an invocation with `evidenceAccess` advertises `evidence_list` and `evidence_fetch` along with any available historical context, external tools and opted-in Controller `submit_decision`. Tools appear only when actually negotiated/available. Conflicting configured external names are preserved; each built-in receives the first free deterministic `role_orchestrator_<name>[_N]` alias and the Controller sees the **actual** name. This catalog is captured RO evidence, not a provider-native skill/tool/subagent inventory. The general Controller evidence instruction does not mandate retrieval or encode task-specific filename/tool heuristics. Existing text/legacy delivery remains supported without live MCP discovery.

Ordinary `tools/call` requests have bounded input/output bytes, a maximum of four simultaneous executions, active-request correlation and normal signal/close/deadline handling, without a cumulative 64-call cutoff or completed-result retention. Identical concurrent IDs share the active result; conflicting active IDs produce a transport error. A request ID repeated after active state is freed can run again; no exactly-once or effect-based exception is provided. This does not authorize an automatic Host replay after an unknown outcome. `submit_decision` retains stronger request-ID/lineage/finalization guarantees with the separately bounded 128 control-call ceiling and registered-Intent byte ceiling. Its preflight is advisory and bounded; a warning cannot revoke registration. Native provider tools, skills, files, scripts and subagents retain their original permission/runtime behavior.


### C20 resource defaults and time ownership

Omitted resource fields inherit their trusted value or default: 5 concurrent invocations, no cumulative invocation ceiling (`maxInvocationsPerOperation: null`), no hard invocation deadline (`invocationTimeoutMs: null`). Concurrency and finite cumulative limits must be positive safe integers; finite deadlines must be integers in 1..2147483647 ms. Explicit null is disabled, not absence. Project settings may narrow a trusted unlimited field to finite, or reduce a finite ceiling, but cannot widen a finite ceiling with null or a larger value. Trusted launch may override. A finite hard deadline applies to a single invocation from its original owner boundary; no independent adapter/startup/tool/interaction/recovery deadline. Native provider policies remain independent. Activity is presentation only. Configuration is resolved for new submissions and trusted continuation/resume as before; changed trusted defaults do not widen previously saved finite cumulative/concurrency limits, even when a project preference narrows the new default. Explicit trusted user or launch resource settings retain existing ResumeAuthority behavior, including an intentional null cumulative override. The resolver carries only technical provenance of whether a trusted ceiling was defaulted; this is not an additional user configuration field. No automatic activity monitoring.

### ACP result capture (C20-R)

ACP history retains up to 1 MiB of encoded relevant native updates. Current native text has an independent 1 MiB UTF-8 bound. History overflow alone does not reject a complete text/legacy/Worker result after native end_turn; MCP still requires its separate finalized declaration. A result that itself exceeds the bound or lacks a provable anonymous message boundary remains incomplete. Tool IDs are retained within a separate byte budget, not unlimited payload retention. Existing ACP SDK per-frame 1 MiB and downstream context/artifact bounds remain. No changes to resource defaults, timers, provider-native tools or settings.

After history overflow, later tool payload/metadata may be omitted (including previous details used in permission display); actual native request payload, granted options and authority are unchanged. Identity-only retention uses 1 MiB serialized-ID-plus-overhead accounting, not a total heap bound. Exact-SHA engineering evidence and native limitations are in [STATUS](roadmap/STATUS.md).

## C24 — Общие настройки пользователя

Схема v1: `features.<kind>.<template>` содержит `default` (logical ID) и `options` (id, необязательные name/description, nativeValue). `profiles.<id>.features.<kind>` ссылается на template, `providers.<id>.featureBindings.<kind>` явно задаёт транспортный selector. Виды: reasoningEffort, collaborationMode, approvalMode. Отсутствующая feature не требует selector; объявленная опция `{ "id": "native" }` оставляет native configuration без override. Старые inline reasoning mappings не принимаются, миграции нет.

Проверенный на ACP fixture (не идентификаторы реальных агентов) пример:

~~~json
{
  "schemaVersion": 1,
  "controllerProfile": "primary",
  "providers": {
    "fixture": {
      "adapter": "acp",
      "launch": {"command": "node", "args": ["/path/to/c24-native-agent.js", "controller"]},
      "featureBindings": {
        "reasoningEffort": {"kind":"configOption","id":"arbitrary-thought-id"},
        "collaborationMode": {"kind":"configOption","id":"opaque-collaboration"},
        "approvalMode": {"kind":"configOption","id":"opaque-approval"}
      }
    }
  },
  "profiles": {
    "primary": {"provider":"fixture","model":"fixture","features":{"reasoningEffort":"shared","collaborationMode":"plans","approvalMode":"review"}}
  },
  "features": {
    "reasoningEffort": {"shared":{"default":"low","options":[{"id":"native"},{"id":"low","nativeValue":"native-low"},{"id":"high","nativeValue":"native-high"}]}},
    "collaborationMode": {"plans":{"default":"default","options":[{"id":"default","nativeValue":"native-default"},{"id":"plan","nativeValue":"native-plan"}]}},
    "approvalMode": {"review":{"default":"review","options":[{"id":"review","nativeValue":"native-review"},{"id":"open","nativeValue":"native-open"}]}}
  },
  "input": {"maxBytes":16777216}
}
~~~

ACP binding configOption использует точный id, optionType (select по умолчанию, boolean при соответствующем nativeValue), наблюдаемые options и подтверждение после setConfigOption. Legacy sessionMode — точный ID mode без предположения о readback. Без явного reasoning binding сохраняется прежний уникальный thought_level selector. Codex CLI использует прежний native argv reasoning contract; явный поддержанный binding — kind codexConfig/id model_reasoning_effort. Другие CLI features/селекторы не эмулируются. Конфликтующие активные bindings отклоняются. Нативные permissions, sandbox и plan принадлежат провайдеру.

`settings` и ACP configOptions читают общий logical descriptor без открытия native session. При смене profile пересчитываются доступные options, ранее явно выбранный ID переносится только при его наличии, иначе применяется default. Пользовательский reasoning default относится к Controller; модели по-прежнему выбирают reasoning для следующих turns/Workers. Collaboration только Controller; approval передаёт логический ID Worker только по его собственной объявленной mapping. Недоступная обязательная настройка даёт адресный технический отказ, а не fallback. Нативная совместимость конкретной версии агента проверяется отдельно.

`input.maxBytes`: trusted decoded ordered input budget, default 16 MiB, максимум 64 MiB. External ACP receive-frame ceiling is fixed at 91,575,640 bytes (the former maximum supported limit, `4 * ceil(64 MiB / 3) + 2 MiB`), independent of the current decoded admission limit. This finite wire ceiling is not a universal bound on JSON expansion, block envelopes, or process memory. Frames above it are rejected by the transport before request identity/admission; same-frame read-only redelivery after lowering `input.maxBytes` is not blocked by that lower setting. Historical projection расходует тот же input budget, outgoing provider prompt не ограничивается этим расчётом. Это технический предел, не запрет модели использовать файлы/tools.

### Effective accepted settings (C24 corrective contract)

Each new accepted generation records its effective Controller profile and logical/native settings, even when the profile was selected by default. Technical recovery checks that effective selection, including settings first recorded by legacy recovery, not a global fingerprint of approval mappings. A newly admitted Worker records only its applicable approval choice and effective mapping (including absence); recovery compares that action's recorded mapping to the current trusted configuration. A changed mapping fails that Worker before provider dispatch, without rejecting unrelated profiles or silently using either stale or changed permission settings. Legacy actions without this record remain legacy; no retrospective mapping is invented. Explicit continuation establishes new accepted settings for new actions. Unavailable current profiles/settings are represented explicitly with available alternatives; a known but currently unavailable project preference remains visible at configuration inspection and can be overridden explicitly by an available authorized profile. Unknown profile IDs, invalid project preferences, resource increases and unavailable preferred skills remain rejected. No implicit profile fallback; execution still checks availability and authority. An explicit configured native (no override) option remains selectable without native selector support. No speculative native probing or policy emulation.

### C24-R3 — accepted Worker and input limits

Snapshot validation checks present Worker approval admission choice against the accepted generation setting, the mapped logical choice against the Action, and recorded dispatch route against the admitted mapping/profile. Legacy records without approval facts remain readable; offline inspection requires no current configuration. The decoded input limit controls new input and historical native projection, not the assembled outgoing provider request. ACP SDK maxMessageBytes is a receive-side contract; no synthetic outgoing frame gate derived from decoded input. Provider transport/model limits remain provider-owned.
