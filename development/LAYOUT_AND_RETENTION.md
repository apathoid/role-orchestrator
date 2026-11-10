# Размещение и удаляемость материалов

**Статус: описание действующей структуры до C12.0.** Реорганизация в постоянные каталоги утверждена и описана в [плане C12.0](plan/clusters/C12_ACCEPTANCE_DELIVERY.md), но пока не выполнена. Отдельная физическая изоляция инженерных материалов — временное решение, а не долгосрочный контракт runtime.

## Постоянная часть

`src/` — бизнес-логика и production adapters. `docs/` — актуальная спецификация и эксплуатационные контракты. `README.md`, `AGENTS.md` — продукт и неизменяемые инженерные границы. Root package manifest и Nix flake уже задают базовую инфраструктуру; lock-файлы и packaging завершаются в C00/C10. Эти файлы нужны для поставки и не ссылаются на development. Product distribution включает только объявленный runtime/build output и продуктовые документы.

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

Tests импортируют публичные JavaScript entrypoints из `src/` и testable ports; копия в `dist/` не требуется. Production никогда не импортирует tests/fixtures/harness или reasoning-файлы. Нет root test script, workspace package linkage, обязательной ссылки на конфигурацию JS type-checker, startup read, runtime prompt или package export, требующего `development/`.

Нужные продукту инструкции Controller/roles оформляются как самостоятельные runtime ресурсы в `src/`/поставке. Они не читают reasoning качества coding-агента из development. Тестируемость достигается ports/Clock/IdFactory и контролируемыми adapters в harness, не условными ветками `if test` в production.

Harness запускается отдельно: `npm --prefix development ci`, затем предусмотренные им scripts. Точный набор scripts устанавливается C00; документация продукта не должна зависеть от их наличия. Автоматизация проверки хранится здесь; если позднее подключается внешний CI entrypoint, он должен допускать отсутствие development без необходимости редактировать product files. Текущий `.github/workflows/ci.yml` проверяет спецификацию при её наличии и Nix metadata независимо от development. При удалении development его проверки явно пропускаются; продуктовые проверки не пропускаются.

JavaScript исполняется напрямую, без компилятора в runtime-поставке. TypeScript checker и его конфигурация принадлежат development harness. Root lock и Nix packaging относятся к постоянной продуктовой инфраструктуре; CI entrypoint остаётся тонкой автоматизацией, допускающей отсутствие harness. Удаляемый harness не участвует в разрешении production dependency graph. Не использовать общий workspace lock, который требует package из development.

## Проверка удаления

В C12 и после изменений packaging создать временную копию **самого продукта**, удалить из неё development, выполнить clean install/build/package и запуск CLI/API с контролируемым внешним исполнителем. Такой временный checkout для проверки поставки — действие разработчика, не виртуальный workspace runtime пользователя. Сравнить включённые файлы и public exports. Никакие core/config/docs edits ради этой проверки не допускаются.

Удаление development не должно ломать сборку, запуск или продуктовую документацию. Корневой AGENTS содержит только условную ссылку на наличие инженерных инструкций, не обязательную runtime-зависимость. Удаление уничтожит локальные regression tests и evidence разработки; поэтому сохранять дерево на протяжении сопровождения предпочтительно. «Удаляемый» не означает «бесполезный».

Runtime state/logs по пользовательской конфигурации находятся отдельно от репозитория и не удаляются вместе с development. Тестовые runtime state directories всегда создаются под runs/tmp и не используют реальные пользовательские данные.

## Целевая структура после C12.0 (ещё не реализована)

- `tests/` (включая fixtures) сохраняет всю regression protection; `scripts/` и корневые npm/checkJs/CI выполняют её без отдельного harness.
- `docs/roadmap/` — **активный** план, STATUS, remaining acceptance и зависимости; Git history сохраняет устаревшие планы, а предметные `docs/` описывают текущий продукт.
- `AGENTS.md` направляет к `.agents/`; `CHANGELOG.md` фиксирует продуктовые изменения; `CONTRIBUTING.md` описывает разработку.
- `development/` удалён из исходного дерева, но регрессия остаётся в Git и CI. npm/Nix package не включает tests/scripts/.agents и не требует devDependencies, Git или исходного checkout.
- После выполнения миграции этот документ перестаёт быть нормативной инструкцией. Смысл и исторические причины старой архитектуры сохраняются в `docs/DECISIONS.md` (D10/D14/D16).
