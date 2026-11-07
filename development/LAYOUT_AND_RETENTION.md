# Размещение и удаляемость материалов

## Постоянная часть

`src/` — бизнес-логика и production adapters. `docs/` — актуальная спецификация и эксплуатационные контракты. `README.md`, `AGENTS.md` — продукт и неизменяемые инженерные границы. Root package manifest/lock/build config, которые появятся в C00, нужны для сборки/поставки и не ссылаются на development. Product distribution включает только объявленный runtime/build output и продуктовые документы.

## Удаляемая часть

| Путь | Назначение |
|---|---|
| `development/plan/` | План реализации, детализация кластеров |
| `development/agent/` | Reasoning-инструкции агента разработки |
| `development/quality/tests/` | Unit/contract/integration/acceptance/regression tests |
| `development/quality/fixtures/` | Fake providers, scenario inputs, безопасные synthetic data |
| `development/quality/scripts/` | Проверки границ, упаковки, deletion smoke, evidence сбор |
| `development/experiments/` | Одноразовые исследования SDK/протокола |
| `development/reports/` | Решения, findings, итог проверки шагов |
| `development/runs/` | Сгенерированные логи, traces, temporary workspaces, native evidence |
| `development/package.json` и lock | Самостоятельный harness проверок и его зависимости |

В этой поставке созданы инструкции/матрицы, не исполняемые tests. Каталоги tests/fixtures/scripts появятся при реализации соответствующего кластера.

## Направление зависимости

Tests могут импортировать публичный product output `../../dist/...` и testable ports. Production никогда не импортирует tests/fixtures/harness или reasoning-файлы. Нет root test script, workspace package linkage, TypeScript project reference, startup read, runtime prompt или package export, требующего `development/`.

Нужные продукту инструкции Controller/roles оформляются как самостоятельные runtime ресурсы в `src/`/поставке. Они не читают reasoning качества coding-агента из development. Тестируемость достигается ports/Clock/IdFactory и контролируемыми adapters в harness, не условными ветками `if test` в production.

Harness запускается отдельно: `npm --prefix development ci`, затем предусмотренные им scripts. Точный набор scripts устанавливается C00; документация продукта не должна зависеть от их наличия. Автоматизация проверки хранится здесь; если позднее подключается внешний CI entrypoint, он должен допускать отсутствие development без необходимости редактировать product files. Не добавлять такую CI конфигурацию автоматически в documentation-only поставке.

Product build использует свои необходимые devDependencies (например compiler); они не являются временным исследованием. Удаляемый harness не участвует в разрешении production dependency graph. Не использовать общий workspace lock, который требует package из development.

## Проверка удаления

В C12 и после изменений packaging создать временную копию **самого продукта**, удалить из неё development, выполнить clean install/build/package и запуск CLI/API с контролируемым внешним исполнителем. Такой временный checkout для проверки поставки — действие разработчика, не виртуальный workspace runtime пользователя. Сравнить включённые файлы и public exports. Никакие core/config/docs edits ради этой проверки не допускаются.

Удаление development не должно ломать сборку, запуск или продуктовую документацию. Корневой AGENTS содержит только условную ссылку на наличие инженерных инструкций, не обязательную runtime-зависимость. Удаление уничтожит локальные regression tests и evidence разработки; поэтому сохранять дерево на протяжении сопровождения предпочтительно. «Удаляемый» не означает «бесполезный».

Runtime state/logs по пользовательской конфигурации находятся отдельно от репозитория и не удаляются вместе с development. Тестовые runtime state directories всегда создаются под runs/tmp и не используют реальные пользовательские данные.
