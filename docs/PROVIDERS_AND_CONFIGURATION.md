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

Вложения требуют доверенного `resolveAttachment` и согласованного формата ACP. Файловые и terminal RPC доступны через явно переданные обработчики `bridge`. Продолжение нативной сессии и вызов retrieval через этот адаптер недоступны.

### Codex CLI в headless-режиме

Оператор выбирает нативный профиль в доверенном `providers.<id>.nativeSettings.profile`. Адаптер передаёт имя через `--profile`. Политика исполнения и заранее разрешённые действия применяются самим Codex. Программный grant оркестратора по-прежнему разрешает запуск выбранного профиля. Controller и Worker, включая Reviewer, используют профиль без автоматической смены нативных настроек.

У адаптера `permissions.interactive` и `tools.bridge` имеют статус `unsupported`. Если действие требует одну из этих возможностей, оно получает `CAPABILITY_UNAVAILABLE` с указанием причины до запуска. Для обычного вызова действуют нативные правила headless Codex. Сообщённый Codex статус команды `declined` сохраняется как отказ команды. Общие ошибки инструмента сохраняют статус, который сообщил провайдер. Отчёты о завершении команд обеспечивают частичную видимость инструментов.

## Конфигурация v1

Формат — UTF-8 JSON. [Схема конфигурации v1](../src/application/configuration/config-v1.schema.json) применяется при runtime validation. Доверенный пользовательский файл задаёт providers/profiles, controller, ресурсы, лимит истории, state/diagnostics и установленные plugins. Проектный файл необязателен, читается только из явно выбранного cwd или явно переданного пути; поиск Git root и обход родителей для обнаружения конфигурации не нужны.

Приоритет: built-in defaults < доверенный user config < разрешённые project preferences < явные доверенные параметры запуска. Project preferences могут выбрать существующий профиль/role/skill и уменьшить лимит; не могут добавлять исполняемый plugin, endpoint, secrets, расширять permissions или повышать пределы. Merge выполняется по описанным полям, не generic deep merge массивов. Неизвестные поля — ошибка с JSON path. Отсутствие поля отличается от `null`. По умолчанию используются 2 одновременных вызова, 40 вызовов на operation и 180 000 мс на вызов. Проектный файл `.role-orchestrator.json` читается в явно выбранной директории или по явно переданному пути. Он может задать `controllerProfile`, `preferredRole`, `preferredSkills` и сниженные `resources`.

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

## Plugin и skill

Plugin manifest: id, version, apiVersion=1, типы exports, совместимые capabilities. Подключение явно из trusted config; загрузка происходит в composition root. Plugin — доверенный код с правами процесса, не изолированный tenant. Нельзя обещать защиту от злонамеренного plugin при запрете isolation.

Первоначально предусмотрены только реальные extension points: provider factory, external tool definition/bridge, skill source loader. Diagnostic sink может быть внедряемым портом без отдельной публичной plugin категории, пока нет потребителя. Plugin не может регистрировать скрытую workflow state machine или mutation hook на core state. Collision id, несовместимая major API и ошибка initialization диагностируются до использования расширения; посторонние профили сохраняют работоспособность.

Skill содержит id/version, описание применимости, инструкции и необязательные ссылки на ресурсы. Skill не является executable plugin и не выдаёт разрешения. Controller выбирает skills; их требования передаются как инструкции. Если инструкции запрещают конкретный способ делегирования, модель соблюдает смысл запрета; Host не делает вывод по слову multi-agent. Крупные инструкции загружаются по необходимости, лимиты контекста явны.

## Версионирование

Неизвестная major config/plugin/schema version отвергается с понятной причиной. Добавление необязательного поля — совместимое изменение только если старое поведение сохраняется. Secrets и live permission tokens не сериализуются. В этой greenfield-реализации нет обязательной совместимости со схемами другого продукта или его историей.
