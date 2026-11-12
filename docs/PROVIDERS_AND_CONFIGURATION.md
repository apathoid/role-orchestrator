# Провайдеры, конфигурация и расширяемость

## Независимость от провайдера

Core получает ProviderPort, Profile и capabilities. Он не импортирует ACP SDK, не знает специальных CLI flags и не выбирает fallback по строке имени модели. Адаптер не определяет стратегию всей пользовательской задачи. Нет обязательного provider-native multi-agent режима.

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

Controller требует структурированный Decision. При native structured output использовать его; при обычном тексте использовать объявленный адаптером полный JSON envelope и schema validation. Не извлекать скрытую семантику регулярными выражениями из произвольного ответа. Worker может возвращать обычный текст с provenance. Ошибка Controller schema возвращается модели по общему циклу и бюджету.

## Инструменты и полномочия

Нативные tools остаются исполнителю. Host не предоставляет собственные read/edit/git/shell, если provider уже исполняет работу. Внешние tool extensions доступны через явно подключённый bridge (например MCP, если подтверждён контракт транспорта); зарегистрированный tool имеет id, input schema, описание, effect metadata и способ permission. Инструменты, о которых Host не получает подробных событий, не считаются отсутствующими или безвредными.

Настроенная доступность среды — верхняя граница, а не требование перечислить в каждом prompt все системные исполняемые файлы. Каталог сообщает возможности; модель исследует среду собственными tools. Orchestrator не сканирует PATH для обнаружения Git и не делает registry любого системного бинарника.

Permission prompt провайдера связывается с attempt/providerRequestId и передаётся пользователю. Используется существующее standing approval, если применимо. Deny/revoke сохраняется, late approval для уже отменённого запроса не исполняется. Программный API принимает доверенный grant с явным набором profile ids. Grant проверяется перед открытием сессии и отправкой вызова. Bridge предоставляет адаптеру функцию запроса, привязанную к attempt; доверенный клиент отвечает по host request id, attempt id, native request id и одной из предложенных опций. Действующее standing decision применяется в рамках профиля и ресурса. Если adapter не контролирует внутренние tools, его гарантия так и описывается. Не эмулировать enforcement через diff/rollback или обязательный fingerprint до запуска.

Если ACP-исполнитель требует клиентские filesystem/terminal инструменты, adapter использует явно предоставленный внешний client-tool port и согласованные capabilities. Это маршрутизация реального клиентского инструмента, не собственный файловый runtime Host. При отсутствии такого клиента исполнитель должен иметь собственные tools либо сообщить конкретную недоступную возможность. Нельзя рекламировать клиенту несуществующий bridge или реализовывать shell/file engine внутри core ради совместимости.

### Generic ACP через stdio

Программный Host регистрирует `createAcpProvider({ providerId, configuration })` из пакета `role-orchestrator`. Адаптер запускает агент из доверенного `launch` в рабочем каталоге задачи на Linux и открывает новую сессию ACP v1 для каждой попытки. Для `profiles.<id>.model` указывается идентификатор из model select option агента. Если выбор нельзя подтвердить, prompt не отправляется. Опциональный `nativeSettings.mode` задаёт объявленный агентом режим.

Вложения требуют доверенного `resolveAttachment` и согласованного формата ACP. Файловые и terminal RPC доступны через явно переданные обработчики `bridge`. Продолжение нативной сессии недоступно. Retrieval использует отдельно настроенный HTTP MCP.

### Controller text result: границы ACP v1 и Codex CLI JSONL

Generic ACP v1 (`@agentclientprotocol/sdk@2.4.0`): [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) описывает `agent_message_chunk` с optional `messageId` (идентичность сообщения, не признак финальности), отдельные tool updates и `session/prompt` stopReason. При `end_turn` адаптер передаёт накопленный текст последнего сообщения; смена ID начинает новый текст, новый tool call для анонимных Controller chunks разделяет накопление, tool updates могут перемежаться с chunks. Это существующее правило адаптера, не универсальная гарантия ACP о намерении модели. Если после tool call нет нового текста, именованное сообщение остаётся result; анонимное, сброшенное новым tool call, даёт пустой текст и обычную INVALID_PROPOSAL correction. Tool-only turn без текста также даёт пустой текст. `outputObservationRef` очищается вместе со сброшенным текстом; прежние observations сохраняются. Отсутствие нового сообщения само по себе не доказывает, что сохранённое сообщение было progress.

Codex CLI (`exec --json`): [JSONL event types, rust-v0.167.0](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/exec/src/exec_events.rs) определяют `item.completed` / `agent_message` (text) и `turn.completed` (usage), без указателя на отдельное итоговое сообщение. Адаптер выбирает последнее завершённое agent_message только после успешного turn и process exit; если нового сообщения после tool call нет, остаётся предыдущее. При отсутствии любого agent_message с завершённым turn результат недоступен: существующий PROTOCOL_ERROR, terminal unknown/effect unknown, technical waiting; не INVALID_PROPOSAL correction и не fallback на tool. Конкретный исполняемый Codex CLI выбирается конфигурацией, не зафиксирован npm SDK; версия 0.167.0 здесь источник wire contract, не подтверждённый native run.

Ни один из этих транспортов не предоставляет достоверной семантической классификации progress/final по расположению tool calls. На arrival нет Decision submission; только declared result завершённого invocation поступает в decoder/admission. Отдельное более позднее сообщение заменяет предыдущее, tool payload никогда не становится результатом. Не искать валидный JSON в истории и не добавлять ограничения на порядок инструментов. Реальные версии исполнителей и поведение моделей остаются частью локальной native acceptance.

### Codex CLI в headless-режиме

Оператор выбирает нативный профиль в доверенном `providers.<id>.nativeSettings.profile`. Адаптер передаёт имя через `--profile`. Политика исполнения и заранее разрешённые действия применяются самим Codex. Программный grant оркестратора по-прежнему разрешает запуск выбранного профиля. Controller и Worker, включая Reviewer, используют профиль без автоматической смены нативных настроек.

В headless CLI нативное `permissions.interactive` недоступно. Без явной настройки MCP `tools.bridge` недоступен. Запрос обязательной недоступной возможности возвращает `CAPABILITY_UNAVAILABLE` с причиной до запуска. Для обычного вызова действуют нативные правила headless Codex. Сообщённый Codex статус команды `declined` сохраняется как отказ команды. Общие ошибки инструмента сохраняют статус, который сообщил провайдер. Отчёты о завершении команд обеспечивают частичную видимость инструментов.

## Конфигурация v1

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
  "resources": {"maxConcurrentInvocations": 2, "maxInvocationsPerOperation": 40, "invocationTimeoutMs": 180000},
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

[Действующий контракт](REASONING_EFFORT.md) расширяет **config schemaVersion 1** без обязательной миграции. Отсутствие `reasoningEffort` эквивалентно `"native"`: adapter не получает override. В selectable-профиле задаётся непустой массив `{level, effort}`. Для нескольких уровней обязателен `defaultReasoningLevel`, для единственного можно его опустить.

Пример **только секции profiles** (заменить провайдеры/модели и native values на значения своих исполнителей):

```json
{
  "primary": {
    "provider": "codex", "model": "configured-model",
    "reasoningEffort": [
      {"level": "low", "effort": "low"},
      {"level": "high", "effort": "high"}
    ],
    "defaultReasoningLevel": "low"
  },
  "reviewer": {
    "provider": "acp-agent", "model": "agent-published-model",
    "reasoningEffort": [
      {"level": "high", "effort": "high-native"},
      {"level": "xhigh", "effort": "ultra-native"}
    ],
    "defaultReasoningLevel": "high"
  },
  "legacy": {"provider": "codex", "model": "configured-model", "reasoningEffort": "native"}
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
