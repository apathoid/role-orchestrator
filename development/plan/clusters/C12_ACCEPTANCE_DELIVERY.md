# C12 — Полная приёмка и поставка

Вход: C11/C11R с исправлениями ревью; требования и матрица приёмки, включая A44–A54. **Следующий этап — C12.0**, затем C12.1–C12.9. C12.0 пока только запланирован; наличие кода, regression verified и native verified не эквивалентны.

## C12.0 — Реорганизация репозитория и инженерных знаний (PLANNED)

**Назначение:** после C11R, до C12.1, привести исходный репозиторий к постоянно сопровождаемой структуре. Удалить отдельное `development/` из **исходного дерева** после содержательного переноса, сохранив всю регрессионную защиту и инженерные знания. Не менять product semantics, Controller/Host/ProviderPort, evidence/recovery, полномочия, единственный coordinator, provider-owned tools, отсутствие Host isolation и обязательного Git. Никаких новых runtime gates, обязательного fixed workflow или второй системы координации.

**Цель:** `src/` — исполняемый код; `tests/` (включая `fixtures/`) — регрессия; `scripts/` — инструменты; `docs/` — нормативные продуктовые знания; **`docs/roadmap/` — активный план, текущий статус и оставшиеся обязательства**; `.agents/` — инструкции coding-агентов; `AGENTS.md` — корневой контракт; `CHANGELOG.md` — значимые продуктовые изменения; `CONTRIBUTING.md` — разработка/проверки; `.github/` — CI. Не создавать пустые каталоги, не копировать исторические отчёты целиком. Независимость продукта от dev tooling обеспечивать import graph, конфигурацией сборки и установленным пакетом, не физической изоляцией исходников.

### C12.0.1 — Baseline, инвентаризация и карта переноса

Просмотреть все материалы `development/`: планы, STATUS, инженерные инструкции, тесты/fixtures, scripts, матрицу требований, reports, runs, воспроизводимые наблюдения и устаревшие материалы. Для каждого зафиксировать `old path → destination / disposition / dependent links`, единственный источник истины и необходимость сохранения. Сопоставить пересечения с README/AGENTS/docs; отделить действующие ограничения от исторических гипотез. До изменения инфраструктуры сохранить commit, test inventory с именами/смыслом сценариев, counts, применимые команды, CI и native gaps. Последний ранее подтверждённый baseline: 298/298 на `949292a` (CI #42821614211); повторно подтвердить актуальность относительно HEAD, не выдавая его за результат новой структуры.

**Выход:** реестр миграции, baseline и список пробелов знаний; до этого ничего не удалять.

### C12.0.2 — Консолидация продуктовой документации

Перенести подтверждённые знания из reports/plan в существующие предметные `docs/PRODUCT.md`, `ARCHITECTURE.md`, `CONTRACTS.md`, `EXECUTION.md`, `CONTEXT_AND_RECOVERY.md`, `PROVIDERS_AND_CONFIGURATION.md`, `REASONING_EFFORT.md`, `DIAGNOSTICS.md`, `DECISIONS.md`. Из C07/C08/C11R сохранить существенные ограничения CLI/ACP/permissions/error/unknown с датой и версией; не превращать исторический результат native probe в безусловную спецификацию. Устранить устаревшие формулировки C11R, R25, D10/D11/D14/D15; сопоставить A01/A37/A42/A43. По необходимости создать краткий `docs/CAPABILITIES.md` как навигационную карту, не вторую нормативную спецификацию.

**Выход:** текущее поведение понятно без чтения C00–C11R; различаются implementation, regression, native readiness; нет противоречащих источников истины.

### C12.0.3 — План, статус, матрица, история

Перенести **активный** `development/plan/IMPLEMENTATION_PLAN.md`, невыполненный C12 и зависимости в `docs/roadmap/`; `development/STATUS.md` → `docs/roadmap/STATUS.md`. Новый roadmap обязан показывать completed/next/verified/UNVERIFIED, контракты R01–R33, сценарии A01–A54, test paths, CI/commit и оставшиеся C12.1–C12.9. Сохранить единственную актуальную матрицу, например `tests/ACCEPTANCE_MATRIX.md`, с явным указателем из roadmap; не размещать независимую копию в docs. `docs/VERIFICATION.md`, если нужен, описывает классы доказательств и правила оценки, не копирует статус и матрицу.

Создать `CHANGELOG.md` с осмысленными продуктовыми вехами, не копией STATUS/commit log. Ключевые причины и отвергнутые альтернативы — в DECISIONS/ADR; исторические подробности — в Git. Настоящие evidence фиксировать с HEAD, командами, версиями, exits и границами применимости. Поддерживать одну оперативную точку входа в roadmap; после миграции новый агент не должен восстанавливать следующий шаг по старой истории.

### C12.0.4 — Инструкции coding-агентов и маршрутизация знания

Перенести `development/agent/` → `.agents/` с сохранением проверяемых критериев и объединением дублей. `AGENTS.md` — обязательная точка входа и ссылки на применимые документы, так как `.agents/` не обнаруживается всеми coding-агентами автоматически. Зафиксировать назначения: публичное поведение/контракты → предметные docs и tests; существенные изменения → CHANGELOG; важные архитектурные решения, альтернативы и компромиссы → DECISIONS/ADR; текущие задачи, выполненные проверки и native gaps → roadmap STATUS; одноразовые логи → CI/evidence. Не требовать отдельной записи при внутренней правке без изменения контракта. Инструкции coding-агентов не являются runtime prompts/permissions и не требуют отдельного Reviewer/Planner/Validator.

### C12.0.5 — Тесты, scripts, JS checker и корневой npm

`development/quality/tests/` → `tests/`; `quality/fixtures/` → `tests/fixtures/`; `quality/scripts/` → `scripts/`. Сохранить foundation/core/contracts/integration, а также только реально существующие acceptance/native suites; отсутствие обязательного suite не может означать PASS. Перенести `development/jsconfig.json` и TypeScript devDependencies в корневую npm-конфигурацию/lock, оставить JS ESM/Node 24/JSDoc/checkJs без runtime транспиляции. Обеспечить корневые команды `npm test`, `npm run check`, `test:core`, `test:contracts`, `test:integration`, `check:package` и применимые другие.

Не ограничиваться исправлением путей: `check-specification.mjs` читает старые пути плана/матрицы и проверяет непрерывность нумерации Cxx.1 (C12.0 требует адаптации); `check-javascript.mjs` запускает checker из старого cwd; `owned-run.mjs` создаёт `development/runs/`. Проверить `run-suite.mjs`, `check-boundaries.mjs`, `check-package.mjs`, fixtures/relative imports и все другие path assumptions. После переноса tools не должны заново создавать `development/`; временные файлы — в игнорируемом/временном месте. Не ослаблять assertions и не добавлять test-only пути в production.

**Выход:** сохранён каждый прежний сценарий, а не только общее число; одна корневая система тестирования; manifest и lock согласованы.

### C12.0.6 — CI, Nix и обязательность проверок

Убрать из GitHub Actions условные пропуски обязательных suites по наличию `development/package-lock.json`. Из корня реально выполнять specification/links, checkJs, import boundaries, core/contract/integration, package/removal-equivalent, Nix and lock verification. Отсутствие обязательного suite = FAIL, отсутствие native доступа = честный UNVERIFIED с известной областью, не искусственный PASS. После слияния npm manifests пересчитать `npmDepsHash` в `flake.nix`, проверить locked npm/Nix build/flake check/CLI package. Build dependencies (включая TypeScript checker) допустимы при сборке, но не как обязательная runtime dependency. Держать коммиты самодостаточными: миграция путей не должна временно отключать проверки без явного объяснения.

### C12.0.7 — Независимость установленной поставки

Проверять npm tarball и установленный Nix package **вне checkout**, без `tests/`, `scripts/`, `.agents/`, devDependencies, `.git` и исходного дерева: package contents, clean install, публичный import, CLI help/diagnose, контролируемый end-to-end, runtime dependencies и отсутствие чтения coding-agent instructions. Проверить `package.json.files` и Nix `productSource`. Наличие regression tests в *исходном* Git необходимо, но они не должны попадать в runtime-пакет. Synthetic success не доказывает живую native интеграцию.

### C12.0.8 — Удаление старого дерева, полная регрессия и handoff

Удалять `development/` только после переноса действующих знаний, активного плана, матрицы, сценариев, fixtures/scripts и CI. Обновить README, AGENTS, CONTRIBUTING, docs/DECISIONS, npm/Nix/CI, markdown links, absolute/relative paths, specification checker, критерии R25/A01/A37/A42/A43. D10/D14 сохранить как исторические решения, обозначив замену новым принципом. Проверить, что scripts не воссоздают `development/`; старые пути разрешены только как явно исторические упоминания.

**Завершение:** полный applicable regression и CI с сопоставлением каждого scenario до/после (не только 298), успешно установленный продукт без dev tooling, соответствие документации фактическому коду, независимая проверка нового coding-агента по `AGENTS.md → docs/roadmap/`, критерии миграции M01–M04 без ложного PASS, native gaps сохранены. Каждый самостоятельный шаг — отдельный коммит, перемещения по возможности отдельно от содержательных исправлений; функциональные дефекты фиксировать адресно с regression. Только после этого следующий шаг — C12.1.

## C12.1 — Матрица требований

Связать R01–R33 с выполненными A-сценариями, тестами и реальными run ids. Найти пробелы, противоречия и проверки, которые подтверждают лишь внутренний helper. Для каждого существенного требования нужен observable результат или честный UNVERIFIED. Исправить найденные дефекты в слое-владельце.

После C12.0 использовать единственную постоянную матрицу; проследить R01–R33 ↔ A01–A54 ↔ tests ↔ наблюдаемые результаты. Подтвердить M01–M04 и отсутствие потерь знаний/проверок; исторические implementation reports не являются самостоятельными действующими требованиями.

## C12.2 — Общий regression run

Clean install/build, boundaries, core, contract, integration, acceptance. Failure фиксируется отдельно от unavailable tool/environment. Не ослаблять assertion, если он выражает действительный контракт. После изменения повторить затронутый набор и итоговую проверку; не перепроверять бесконечно без новых изменений.

Запускать все применимые suites из корня; сравнивать с baseline по смыслу сценариев и assertions, не только по числу тестов. Отсутствующий прежний harness не может скрывать пропущенные проверки.

## C12.3 — Реальная provider-agnostic проверка

Два различных доступных исполнителя, хотя бы один ACP и один CLI либо эквивалентно подтверждённые независимые adapters. Один профиль -> direct answer; совместная задача -> последовательное/параллельное делегирование; denied tool, cancellation, disconnect. Версии и native configurations сохранить в development evidence, секреты исключить. Включить native/no override, выбранный effort worker и самостоятельный ход Controller с новым effort, ошибку его неподдерживаемого выбора и отсутствие acknowledgment без блокировки. Раздельно отметить применение настройки и качество решения; возможности конкретного ACP агента не обобщать на все ACP.

## C12.4 — Native Zed/ACP

Регистрация, start session без Git, prompt, progress, permission allow/deny, cancel, load/resume после перезапуска. Проверить различие внешних/внутренних ids и честность unknown effects. Если клиент/доступ отсутствует, статус NATIVE ACCEPTANCE PENDING с точными сценариями; не заменять настоящую проверку mock log.

## C12.5 — Mutable workspace acceptance

Во время активного исследования пользователь/fixture меняет файл, индекс, branch или содержимое рабочей директории. Проверить, что Host не делает дополнительный reconcile/review/cancel. Отдельно смоделировать действительную tool error: модель получает observation и выбирает дальнейшее действие. Сравнить traces, не только финальный текст. Проверка Git-сценария сама может использовать Git как test fixture, но продукт не становится от него зависимым.

## C12.6 — Независимость установленного продукта от средств разработки

В отдельной чистой установке npm/Nix вне checkout проверить package/import/CLI help/diagnose/контролируемый end-to-end без tests/, scripts/, .agents/, devDependencies, исходного Git и runtime-чтения coding instructions. Регрессионный harness при этом **сохраняется в исходном репозитории** и обязательно работает в CI. Не путать это с прежним удалением development во временной копии или с native-проверкой.

## C12.7 — Содержательная архитектурная проверка

Проверить нет ли скрытых fixed workflow, provider strings в core, обязательного Git, source fingerprint gate, автоматической invalidation finding, host filesystem enforcement, двойного ledger или второго scheduler. Называть конкретные code paths. Наличие сложного кода не доказывает дефект; найденное отклонение оценивается по контракту и эффекту.

## C12.8 — Финальный комплект

Обновить README от «спецификация» к фактическому статусу, продуктовые docs к реализованным API. STATUS и отчёт содержат implemented/verified/native состояния, команды, exits и remaining limits. Подготовить воспроизводимый product package с checksums; не включать secrets/development traces. Полное завершение — все обязательные сценарии подтверждены либо явно согласован ограниченный статус поставки. Никаких скрытых TODO вместо заявленной функции.

Проверить фактическую полноту CHANGELOG, DECISIONS/ADR, AGENTS/.agents/, предметных docs и docs/roadmap/ (активный план и STATUS), а также воспроизводимость доказательств. Разработчик должен понимать продукт и следующий C12.x без старого каталога.

## C12.9 — Nix/NixOS и CI приёмка

Проверить lock-preserving Nix build/check, named/default apps, temporary profile installation и интеграцию package в NixOS evaluation/среду с реальным запуском. В отдельной копии удалить development и повторить package/CLI проверки без иных правок. Проверить JS исходники, отсутствие транспиляции и development checker в runtime. Сопоставить зелёные CI jobs с фактически выполненными suites; foundation PASS не заменяет regression/native readiness. Закрыть A41–A43 и R29–R31 либо явно зафиксировать недоступные проверки.

Проверить корневые npm scripts и Nix после объединения lock-файлов и пересчёта npmDepsHash; обязательный suite не может пропускаться из-за отсутствия прежнего harness. Native недоступность остаётся явно UNVERIFIED.
