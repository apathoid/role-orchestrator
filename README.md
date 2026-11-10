# Role Orchestrator

Role Orchestrator координирует работу одной или нескольких AI-моделей над задачей пользователя. Модель выбирает способ решения; Host обеспечивает передачу задач, доступный контекст, согласованные полномочия, ресурсы, отмену и восстановление исполнения.

**Состояние проекта: реализованы Controller, делегирование, локальное восстановление, адаптеры Codex CLI и Generic ACP, Plugin API v1 и C11R — адаптивный reasoning effort. Доступны программный API, CLI и внешний ACP v1. Нативные проверки моделей/адаптеров и приёмка Zed остаются UNVERIFIED; C12 (сквозная приёмка продукта) ещё не завершён.** Не следует приравнивать прохождение synthetic/CI регрессий к эксплуатационной готовности.

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
- [Текущий план и статус C12](docs/roadmap/README.md) (C12.0 — поэтапный переход).

В этих документах слово MUST означает обязательное свойство. SHOULD допускает обоснованное отклонение, записанное в архитектурном решении. Примеры wire-форматов задают семантику; номера версий внешних SDK не фиксируются без проверки реальной доступности.

Продукт не создаёт sandbox, контейнеры, виртуальные рабочие копии, файловые блокировки исходников или систему глобальной актуальности evidence. Его собственное долговременное состояние не является снимком рабочего проекта.

## Использование

```sh
nix run .#role-orchestrator -- --help
nix profile add .#role-orchestrator
role-orchestrator diagnose --config /path/to/config.json
role-orchestrator run --config /path/to/config.json 'Опиши содержимое проекта'
```

Конфигурация по умолчанию находится в `$XDG_CONFIG_HOME/role-orchestrator/config.json` или `~/.config/role-orchestrator/config.json`. CLI использует отдельный state directory из конфигурации, XDG или `~/.local/state/role-orchestrator`. Для ACP клиента укажите команду `role-orchestrator acp --config /path/to/config.json`.

Для управляемого reasoning effort в `profiles.<id>` задаются `reasoningEffort` (массив `{level,effort}`) и `defaultReasoningLevel`; отсутствие поля или `"native"` сохраняет нативные настройки. Controller может передать `nextController: {continue: true, reasoningLevel: "high"}`, а delegate — `reasoningLevel`. Это необязательные поля прежней config/schema v1. [Пример и ограничения](docs/PROVIDERS_AND_CONFIGURATION.md#reasoning-effort-в-profiles).

Программный клиент вызывает `openOrchestrator({ configuration, stateDirectory })`, где `configuration` содержит доверенный JSON, и передаёт выданный `configurationRef` в `submit`. Операция возвращается после принятия, итог доступен через `completion`. Для остановки экземпляра вызовите `close`.

Обязательные ограничения для работающих в репозитории агентов находятся в [AGENTS.md](AGENTS.md) и связанных инструкциях [.agents/REASONING.md](.agents/REASONING.md); текущий STATUS — [roadmap](docs/roadmap/STATUS.md). Документация описывает самостоятельный новый продукт; знание какой-либо предыдущей реализации не требуется.
