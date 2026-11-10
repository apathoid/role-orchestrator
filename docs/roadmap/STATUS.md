# Role Orchestrator — оперативный статус

| Показатель | Состояние |
|---|---|
| Ветка | `greenfield/model-first-core` |
| Исходный HEAD для C12 | `cbd8e70baca3ab380a2ed3d43ae1fdd667616412` |
| Последний выполненный этап | C12.0.6 — CI обязательные root suites и обновлён Nix npmDepsHash (CI pending) |
| Следующий этап | **C12.0.7** — независимость установленного package, затем C12.0.8 и C12.1–C12.9 |
| Implementation complete | C00–C11R реализованы; C12 пока **NO** |
| Regression verified | OBSERVED baseline CI [42868825084](https://github.com/apathoid/role-orchestrator/actions/runs/42868825084) — SUCCESS на `cbd8e70` (до миграции); для текущего коммита **PENDING** |
| Detailed suites baseline | 298/298 (4+25+52+217) на `949292a`, [CI 42821614211](https://github.com/apathoid/role-orchestrator/actions/runs/42821614211); исторический результат |
| Native integration verified | **UNVERIFIED**: реальный Codex CLI/ACP model, Zed, NixOS и adaptive reasoning |
| Production ready | **NO / NATIVE ACCEPTANCE PENDING** |

## Выполненные шаги C12.0

- **C12.0.1**, `d9645c5`: полный Git inventory 128 development files; реестр перехода, baseline, known gaps; старые файлы не удалялись.
- **C12.0.2**, `87b79a1`: текущие ограничения ProviderPort, native Codex CLI HTTP 401, ACP 2.5.0 session/new deadline, C11R и доказательства различены в предметных docs.
- **C12.0.6**: убраны conditional skips development, root suites обязательно исполняются в GitHub Actions, hash Nix npm-deps пересчитан по OBSERVED hash mismatch на CI run 42872888360 (`got: sha256-zVo+cwI0Sj/6Es/PhL7VOyTo/IeIWqPUTg+7yOX3a54=`). Полный новый CI ещё не проверен.
- **C12.0.5**: 54 test files, 20 fixtures, 7 scripts перенесены с path changes; корневой npm+lock/JS config. Обязательные npm/CI прогоны на новом дереве ещё не подтверждены, SHA и результаты сверить на C12.0.6.
- **C12.0.4**: перенесены instructions в `.agents/`, root AGENTS и CONTRIBUTING ведут к активному roadmap, правила консолидации не меняют runtime.
- **C12.0.3**: единственная актуальная матрица [tests/ACCEPTANCE_MATRIX](../../tests/ACCEPTANCE_MATRIX.md), план и текущий статус здесь, [CHANGELOG](../../CHANGELOG.md). Legacy `development/STATUS.md` — архив перехода, не текущий STATUS.

## Проверки и недоступность

В доступной среде поддерживается прямое чтение/публикация файлов GitHub, но не исполнение Node 24/Nix тестов в checkout. Подтверждение новых commits требует GitHub Actions: checkJs, spec/links, boundaries, foundation, core, contracts, integration, pack/removal, Nix. Нельзя объявлять `npm test` выполненным локально без запуска. Параллельно должны быть сохранены имена и observable assertions каждой прежней проверки (M02).

Native CLI native probe: HTTP 401 Unauthorized, `turn.completed` отсутствовал. Codex ACP 2.5.0: initialize ответил ACP v1; `session/new` истёк по deadline. Эти пробы не являются успешными model prompts. Zed live client/NixOS evaluation отсутствуют. Новые native проверки при наличии реального доступа; при недоступности обозначить UNVERIFIED, а не PASS.

## Правило прогресса

Каждый C12.n — отдельный commit; после публикации фиксировать sha и фактические exit/check results. Если требуемая проверка не выполнена, указать UNVERIFIED с причиной; не заменять code/test run документами. Для деталей criteria см. [план](C12_ACCEPTANCE_DELIVERY.md); исторические отчёты C00–C11R доступны через Git.
