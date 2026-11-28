# Role Orchestrator

Role Orchestrator координирует работу одной или нескольких AI-моделей над задачей пользователя. Модель выбирает способ решения; Host обеспечивает передачу задач, доступный контекст, согласованные полномочия, ресурсы, отмену и восстановление исполнения.

Архитектурные принципы — **model-first, provider-first и provider-agnostic**. RO стремится сохранять привычное взаимодействие с нативным провайдером: передавать поддерживаемые возможности клиента и исполнителя, не воспроизводя их и не ограничивая модель собственной семантикой. Оркестратор добавляет только необходимые функции координации. Это целевое направление, а не заявление о полной нативной совместимости; см. [архитектуру](docs/ARCHITECTURE.md#принципы-владения-и-provider-first).

**Состояние проекта: реализованы Controller, делегирование, локальное восстановление, адаптеры Codex CLI и Generic ACP, Plugin API v1 и C11R — адаптивный reasoning effort. Доступны программный API, CLI и внешний ACP v1. В ветке feature/interactive-ux инженерная реализация C13 (activity/interaction) и C14 (CLI/ACP presentation) завершена, полная регрессия пройдена. Нативные проверки моделей/адаптеров, сравнительная оценка качества/производительности и приёмка Zed остаются UNVERIFIED; C12 (сквозная приёмка продукта) ещё не завершён.** Не следует приравнивать прохождение synthetic/CI регрессий к эксплуатационной готовности.

Язык — **JavaScript (ESM), Node.js 24**. JSDoc и `checkJs` используются для проверки контрактов без транспиляции приложения. Репозиторий является **Nix flake**; flake предоставляет devShell, CLI package/apps и smoke checks.

Рабочая среда может быть обычной директорией, Git-репозиторием, проектом с другой VCS или контекстом без файлов. Проверку наличия VCS и работу с ней выполняют модель и инструменты исполнителя. Нативный multi-agent режим провайдера не требуется.

## Спецификация продукта

- [Продукт и требования](docs/PRODUCT.md).
- [Архитектура и владение](docs/ARCHITECTURE.md).
- [Типы и контракты](docs/CONTRACTS.md).
- [Модельное исполнение и сценарии](docs/EXECUTION.md).
- [Адаптивный reasoning effort — реализованные контракты и границы native-проверки](docs/REASONING_EFFORT.md).
- [Контекст, findings и recovery](docs/CONTEXT_AND_RECOVERY.md).
- [Провайдеры, конфигурация и расширения](docs/PROVIDERS_AND_CONFIGURATION.md).
- [Диагностика и эксплуатация](docs/DIAGNOSTICS.md).
- [Архитектурные решения](docs/DECISIONS.md).
- [Nix, установка и CI](docs/NIX_AND_CI.md).
- [Текущий план и статус C12](https://github.com/apathoid/role-orchestrator/tree/greenfield%2Fmodel-first-core/docs/roadmap) (C12.0 завершён, C12.3/4 native pending).

В этих документах слово MUST означает обязательное свойство. SHOULD допускает обоснованное отклонение, записанное в архитектурном решении. Примеры wire-форматов задают семантику; номера версий внешних SDK не фиксируются без проверки реальной доступности.

Продукт не создаёт sandbox, контейнеры, виртуальные рабочие копии, файловые блокировки исходников или систему глобальной актуальности evidence. Его собственное долговременное состояние не является снимком рабочего проекта.

## Проверка поставки

Сборка и проверка воспроизводимого npm-архива: `node scripts/prepare-release.mjs release-artifacts`. В успешном [GitHub Actions](https://github.com/apathoid/role-orchestrator/actions) выпускается отдельный артефакт `release-evidence-<commit>`, содержащий архив, `manifest.json` (SHA-256/размер/commit/Node) и Nix store `narHash`/path-info. Это evidence для dev package 0.1.0-dev.0, **не** подписанный production release и не подтверждение нативной модели.

## Использование

```sh
nix run .#role-orchestrator -- --help
nix profile add .#role-orchestrator
role-orchestrator diagnose --config /path/to/config.json
role-orchestrator run --config /path/to/config.json 'Опиши содержимое проекта'
```

Конфигурация по умолчанию находится в `$XDG_CONFIG_HOME/role-orchestrator/config.json` или `~/.config/role-orchestrator/config.json`. CLI/ACP выбирают Store: `--state-dir DIR` > `storage.directory` > автоматический каталог. Для стандартного config остаётся `$XDG_STATE_HOME/role-orchestrator` или `~/.local/state/role-orchestrator`; прочие логические пути выбирают независимые подкаталоги `configurations/`. Содержимое config не меняет автоматический путь. Для ACP клиента укажите `role-orchestrator acp --config /path/to/config.json` (при необходимости `--state-dir DIR`). Для просмотра точного пути используйте `diagnose --config FILE --format json`.

Старую историю дополнительного config можно открыть явно, без миграции. При `--state-dir` команды управления не требуют валидной конфигурации:

```sh
role-orchestrator inspect OPERATION_ID --state-dir /path/to/old/state
role-orchestrator cancel OPERATION_ID --state-dir /path/to/old/state
role-orchestrator trace OPERATION_ID --state-dir /path/to/old/state
role-orchestrator export-diagnostics OPERATION_ID --state-dir /path/to/old/state --output trace.json
```

Независимые Stores допускают параллельные CLI/ACP экземпляры, один физический Store — одного writer. При отсутствии доступного endpoint inspect/trace/export читают сохранённый snapshot без writer lock, не обязательно последнюю revision; offline cancel отдельно проверяет ownership. После обновления RO штатно перезапустите ранее запущенные ACP runtime: mixed-version execution и административный control могут быть несовместимы. RO не блокирует workspace или внешние инструменты. Trace/export сохраняют базовую redaction, дополняют её доступными текущими известными значениями секретов и сообщают coverage; перед передачей проверяйте данные.

Для управляемого reasoning effort задайте `features.reasoningEffort.<template>` с `default` и `options` (`{id,nativeValue}`), а в `profiles.<id>.features.reasoningEffort` — имя template. Отсутствие ссылки или явно объявленный `native` сохраняет нативные настройки. Старая декларация в profile больше не принимается. Controller может передать `nextController: {continue: true, reasoningLevel: "high"}`, а delegate — `reasoningLevel`. Config/schema остаётся v1; миграции нет. [Пример и ограничения](docs/PROVIDERS_AND_CONFIGURATION.md#reasoning-effort-в-profiles).

Программный клиент вызывает `openOrchestrator({ configuration, stateDirectory })`, где `configuration` содержит доверенный JSON, и передаёт выданный `configurationRef` в `submit`. Операция возвращается после принятия, итог доступен через `completion`. Для остановки экземпляра вызовите `close`.

Обязательные ограничения для работающих в репозитории агентов находятся в [AGENTS.md](https://github.com/apathoid/role-orchestrator/blob/greenfield/model-first-core/AGENTS.md) и связанных инструкциях [.agents/REASONING.md](https://github.com/apathoid/role-orchestrator/blob/greenfield/model-first-core/.agents/REASONING.md); текущий STATUS — [roadmap](https://github.com/apathoid/role-orchestrator/blob/greenfield/model-first-core/docs/roadmap/STATUS.md). Документация описывает самостоятельный новый продукт; знание какой-либо предыдущей реализации не требуется.

## Интерактивное представление (C13–C15)

```sh
role-orchestrator run --presentation compact 'Проверь изменения'
role-orchestrator run --presentation detailed --format json 'Проверь изменения'
role-orchestrator resume OPERATION_ID --presentation debug
role-orchestrator acp --config /path/to/config.json --presentation detailed
```

Режимы compact/detailed/debug управляют только отображением; интерактивный text TTY по умолчанию compact, non-TTY/headless по умолчанию не добавляет stream. CLI activity и технические сообщения идут в stderr, stdout сохраняет прежний финальный текст/JSON. В терминале при реальном permission/form отображаются исходные варианты или schema; при нескольких запросах введите `#REQUEST_ID OPTION_ID` либо `#REQUEST_ID {"field":"value"}`. Один запрос можно ответить без label. Для native form доступны `decline`/`cancel`; сложные формы, URL/auth и отсутствие TTY явно unavailable. Ctrl-C отменяет foreground operation по существующему контракту, EOF не выдаёт разрешений. CLI peer, подключённый к writer через local control, отвечает только своим pending requests; disconnect не отменяет независимые operations.

В ACP сохраняются standard native thinking/tool/Controller plan, existing permission/elicitation и final/clarification. C15: inline RO progress по умолчанию (standard agent_message_chunk), читаемое авторство; `--progress-display notices` — отдельный capability-gated режим. История session/load восстанавливает принятые turns в порядке session.requests и факты Operation journal, без реконструкции transient activity. Реальный Zed, реальные модели и comparative quality/performance — UNVERIFIED до native acceptance; SDK/subprocess и PTY fixtures этого не доказывают.

### Интерактивный вывод (C13R/C14R)
`role-orchestrator run --presentation compact|detailed|debug` и `role-orchestrator acp --presentation compact|detailed|debug` меняют только presentation. В CLI — нативные thinking fragments, события исполнения, принятые findings и доступные интерактивные запросы; final/clarification в человекочитаемом TTY очищается от управляющих последовательностей, JSON/redirected stdout сохраняются. Attached input при потере ответа проверяет pending state, не повторяет автоматически ответ; reconnect только исходного live binding. В ACP SDK 2.4.0 default inline показывает accepted findings/lifecycle/gaps в transcript; explicit `--progress-display notices` показывает стандартные notices при объявленной client session.notices. Нет искусственных thinking/tool events. Реальная поддержка и визуализация Zed/native quality остаются UNVERIFIED. [Подробнее](docs/roadmap/C13R_C14R_INTERACTION_RELIABILITY.md).

## C24 — Настройки, shortcuts и вложения

~~~sh
role-orchestrator settings --config config.json --format json
role-orchestrator skills --format json
role-orchestrator run "Проверь изменения" --profile primary --reasoning-effort high --agent-skill changed --attachment ./notes.md
role-orchestrator resume OPERATION_ID "Уточнение" --approval-mode review
~~~

Флаги используют логические IDs, объявленные в trusted config. Plain technical resume не принимает новые settings. `--attachment PATH` передаёт file URI (не читает/копирует внешний файл); возможность обработки зависит от выбранного провайдера. `--agent-skill` выбирает обнаруженный shortcut/точный абсолютный путь к SKILL.md, не заменяет зарегистрированный `--skill`. В ACP стандартные configOptions и commands появляются при new/load; известный slash shortcut сохраняет provenance. Unknown slash prompt остаётся обычным текстом. Ordered text/image/audio/resource/link и replay поддерживаются мостом ACP; конкретные capabilities проверяются на native invocation. Реальные Zed/LLM сравнения остаются UNVERIFIED. [Конфигурация](docs/PROVIDERS_AND_CONFIGURATION.md#c24--общие-настройки-пользователя).
