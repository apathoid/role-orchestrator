# Role Orchestrator — оперативный статус

| Показатель | Состояние |
|---|---|
| Ветка | `greenfield/model-first-core` |
| Исходный HEAD для C12 | `cbd8e70baca3ab380a2ed3d43ae1fdd667616412` |
| Последний выполненный этап | C12.6 — clean install tarball CLI diagnose and controlled E2E outside checkout; CI pending |
| Следующий этап | **C12.7** — structural architecture audit; C12.3/C12.4 native remain UNVERIFIED |
| Implementation complete | C00–C11R и C12.0 реализованы; весь C12 пока **NO** |
| Regression verified | OBSERVED [CI 42874365595](https://github.com/apathoid/role-orchestrator/actions/runs/42874365595) — SUCCESS на `1341d75` после удаления `development`; следующий commit до CI PENDING |
| Detailed suites baseline | 298/298 (4+25+52+217) на `949292a`, [CI 42821614211](https://github.com/apathoid/role-orchestrator/actions/runs/42821614211); исторический результат |
| Native integration verified | **UNVERIFIED**: реальный Codex CLI/ACP model, Zed, NixOS и adaptive reasoning |
| Production ready | **NO / NATIVE ACCEPTANCE PENDING** |

## C12.6 — проверка установленной поставки вне checkout

- Укреплён `scripts/check-package.mjs --removal`: из **распакованного npm tarball** запускается CLI `diagnose` без побочных эффектов и контролируемый end-to-end с внешним fixture plugin; state находится только у consumer. Проверяется отсутствие тестов, скриптов, agents/roadmap, dev deps/Git в установленном пакете.
- Nix install/profile/non-Git public runtime уже **OBSERVED** в [CI 42874365595](https://github.com/apathoid/role-orchestrator/actions/runs/42874365595). Новый tarball E2E на этом commit **UNVERIFIED до CI**; реальная модель native UNVERIFIED.

## C12.5 — изменяемое рабочее окружение

- Добавлен исполняемый regression `tests/acceptance/mutable-workspace.test.js`: реальный Git fixture, внешний branch switch и staging во время запущенного worker, без Host reconcile/cancel, отдельный финальный ход Controller. Требование Git относится только к тестовому fixture.
- Существующие `tests/integration/mutable-context.test.js` проверяют редактирование связанных/несвязанных файлов и модельный выбор targeted re-read; `external-tool-review.test.js` — tool error/late outcomes. **Новый Git-сценарий на текущем commit до CI UNVERIFIED.**

## C12.4 — реальный Zed/ACP client (UNVERIFIED)

- [Проверочный протокол](NATIVE_ACCEPTANCE.md#c124--настоящий-zed-как-внешний-acp-клиент) описывает registration, session/new, prompt, permissions, cancel, load/resume, non-Git, mapping IDs и native effort.
- **BLOCKED / UNVERIFIED:** реальный Zed/внешний интерактивный ACP client недоступен через текущий GitHub tooling. Не было реального client session и нельзя выдавать synthetic ACP тест за native.

## C12.3 — подготовка реальной provider-agnostic приёмки (UNVERIFIED)

- [Точный native-протокол](NATIVE_ACCEPTANCE.md): два независимых исполнителя, permissions, error/cancel/disconnect/resume, native/worker/controller effort и provenance. Никаких ненаблюдённых native результатов не записано.
- **BLOCKED / UNVERIFIED**: эта среда даёт GitHub API и GitHub Actions, но не authenticated model invocations и не внешний ACP client. Имеющиеся C07 CLI 401 и C08 ACP session/new timeout не подтверждают успешный реальный prompt. Продолжение независимых проверок C12.5–C12.9 допустимо; C12 целиком нельзя принять до native evidence.

## C12.2 — root clean regression (2026-11-10)

- Добавлены три acceptance smoke: CLI/ACP help из non-Git каталога, побочно-безопасный public API import, наличие AGENTS → roadmap, обязательных regression suites и отсутствие legacy. Корневые `npm test` и CI требуют acceptance suite; missing suite — FAIL.
- Подтверждено на исходном `1341d75`: [CI 42874365595](https://github.com/apathoid/role-orchestrator/actions/runs/42874365595) SUCCESS: 4 foundation, 25 core, 52 contracts, 217 integration (298/298), `npm test`, `npm ci`, Nix flake/package/apps, clean install. Новая acceptance suite на текущем изменении **CI PENDING**.

## C12.1 — requirements traceability (2026-11-10)

- В единственной `tests/ACCEPTANCE_MATRIX.md` привязаны R01–R33 к A01–A54, текущим test/scripts и ограниченным CI evidence. Real native A38/A54 остаются UNVERIFIED; M01–M04 имеют собственную область.
- Основание: [CI 42874365595](https://github.com/apathoid/role-orchestrator/actions/runs/42874365595), committed `1341d75`, Node24/Linux, exit 0 всех обязательных CI steps, включая `npm test`, npm pack, Nix flake/install, boundaries/checkJs.

## Выполненные шаги C12.0

- **C12.0.1**, `d9645c5`: полный Git inventory 128 development files; реестр перехода, baseline, known gaps; старые файлы не удалялись.
- **C12.0.2**, `87b79a1`: текущие ограничения ProviderPort, native Codex CLI HTTP 401, ACP 2.5.0 session/new deadline, C11R и доказательства различены в предметных docs.
- **C12.0.8**: прежние 128 tracked development files удалены после переноса. CI на C12.0.7: [run 42873650467](https://github.com/apathoid/role-orchestrator/actions/runs/42873650467) — SUCCESS (root specification/checkJs/boundaries, foundation/core/contracts/integration и npm test, Nix install/check и clean product pack), на удалённом дереве CI [42874365595](https://github.com/apathoid/role-orchestrator/actions/runs/42874365595) SUCCESS. Следующий шаг C12.1; native UNKNOWN/UNVERIFIED без реальных исполнителей.
- **C12.0.7**: npm files и Nix productSource являются явным whitelist предметных docs и runtime src; AGENTS/.agents/tests/scripts/roadmap/dev deps исключены из installed package. `check:removal` теперь устанавливает prod-only зависимости. Новый installed/Nix smoke обязателен в CI; результат пока pending.
- **C12.0.6**: убраны conditional skips development, root suites обязательно исполняются в GitHub Actions, hash Nix npm-deps пересчитан по OBSERVED hash mismatch на CI run 42872888360 (`got: sha256-zVo+cwI0Sj/6Es/PhL7VOyTo/IeIWqPUTg+7yOX3a54=`). Полный новый CI ещё не проверен.
- **C12.0.5**: 54 test files, 20 fixtures, 7 scripts перенесены с path changes; корневой npm+lock/JS config. Обязательные npm/CI прогоны на новом дереве ещё не подтверждены, SHA и результаты сверить на C12.0.6.
- **C12.0.4**: перенесены instructions в `.agents/`, root AGENTS и CONTRIBUTING ведут к активному roadmap, правила консолидации не меняют runtime.
- **C12.0.3**: единственная актуальная матрица [tests/ACCEPTANCE_MATRIX](../../tests/ACCEPTANCE_MATRIX.md), план и текущий статус здесь, [CHANGELOG](../../CHANGELOG.md). Legacy `development/STATUS.md` — архив перехода, не текущий STATUS.

## Проверки и недоступность

В доступной среде поддерживается прямое чтение/публикация файлов GitHub, но не исполнение Node 24/Nix тестов в checkout. Подтверждение новых commits требует GitHub Actions: checkJs, spec/links, boundaries, foundation, core, contracts, integration, pack/removal, Nix. Нельзя объявлять `npm test` выполненным локально без запуска. Параллельно должны быть сохранены имена и observable assertions каждой прежней проверки (M02).

Native CLI native probe: HTTP 401 Unauthorized, `turn.completed` отсутствовал. Codex ACP 2.5.0: initialize ответил ACP v1; `session/new` истёк по deadline. Эти пробы не являются успешными model prompts. Zed live client/NixOS evaluation отсутствуют. Новые native проверки при наличии реального доступа; при недоступности обозначить UNVERIFIED, а не PASS.

## Правило прогресса

Каждый C12.n — отдельный commit; после публикации фиксировать sha и фактические exit/check results. Если требуемая проверка не выполнена, указать UNVERIFIED с причиной; не заменять code/test run документами. Для деталей criteria см. [план](C12_ACCEPTANCE_DELIVERY.md); исторические отчёты C00–C11R доступны через Git.
