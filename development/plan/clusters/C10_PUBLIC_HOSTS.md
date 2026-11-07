# C10 — Публичный API, CLI и внешний ACP Host

Вход: C09. Hosts используют одно application API; не создают собственные workflow/бюджеты.

## C10.1 — Composition root

Создать один владеющий контейнер зависимостей без обязательного DI framework: config -> catalog -> store -> adapters -> coordinator -> host. Запуск не вызывает модель до submit. Shutdown прекращает новые dispatch, отменяет/закрывает owned resources, сохраняет результаты по доступным гарантиям. Tests: startup partial failure освобождает ранее приобретённые ресурсы.

## C10.2 — Программный API

Экспортировать submit/resume/inspect/cancel и подписку на типизированные события. Никакого импорта CLI, глобального cwd или env при импорте модуля. Tests: две независимые instances с разными state directories, duplicate requestId, unsubscribe cleanup, result/error type stability.

## C10.3 — CLI команды

Реализовать `run`, `resume`, `inspect`, `cancel`, `diagnose`, `trace`, `export-diagnostics` с явными args и help. `run` принимает text/stdin, optional cwd/config/profile/skill и output text/json. Не вводить mandatory mode. Tests: argument errors, stdin, unicode, пустой запрос, отсутствие Git; stderr не загрязняет JSON stdout.

## C10.4 — CLI interactive permissions

Показывать реальный subject/options, учитывать standing decisions, отменять prompt при cancellation. Noninteractive mode не auto-allow; возвращает понятное awaiting-input/unavailable и доступный прогресс. Tests: deny, EOF, signal interrupt, повтор ответа; уже разрешённая работа не требует дублирующего approval.

## C10.5 — CLI process/control transport

Реализовать local control contract из ARCHITECTURE: живой Host владеет endpoint и store; последующие CLI команды соединяются с ним, не создавая второго writer. Endpoint только локальный, version/requestId/session token проверяются, payload проходит application API. При отсутствии владельца run/resume приобретает store, cancel сообщает отсутствие живого выполнения и сохраняет unknown для recovery. SIGINT foreground run передаёт cancel своей operation. Tests: два процесса, неверный token/version, concurrent owner startup, lost response с тем же requestId, stale descriptor, shutdown cleanup. Не добавлять скрытый daemon, network listener или глобальный supervisor.

## C10.6 — Внешняя ACP сессия

По проверенной версии протокола реализовать initialization, session create/load, prompt, progress и cancel. Session identity не выводится из Git root. Внешние client ids не совпадают с внутренними provider session ids. Tests: create в non-Git cwd, reconnect/load, several sessions, capabilities mismatch, корректная сериализация без stdout noise.

## C10.7 — Permission и tools relay

Связать внутренний provider request -> PermissionPort -> внешнего клиента -> выбранный option; invalid/late responses не дают разрешения. Client tool bridge из C08 маршрутизируется по правильной внешней сессии. Tests: два параллельных запроса разных operations, отказ клиента, disconnect во время permission, missing terminal/file capability.

## C10.8 — Disconnect и supersession

Выбрать документированную политику: disconnect прекращает доставку, но не означает user cancel; явный cancel останавливает operation. Для нового prompt клиент может явно продолжить прежнюю operation или начать другую; supersession отменяет только обозначенное старое выполнение. Tests: lost ACK, reconnect without replay, новые cwd/context внутри разрешённой среды не запускают source reconciliation.

## C10.9 — Сквозная проверка поверхностей

Одни acceptance scenarios через API/CLI/ACP fixture: direct answer, delegation, permission, cancel, resume, partial result. Различия только в presentation/transport. Затем настоящий Zed при доступности; не объявлять native по fixture. Закрыть A06/A07/A16/A20/A24/A38/A40.

## C10.10 — Устанавливаемый Nix package и apps

Добавить реальный package bin для JavaScript CLI, `buildNpmPackage` с Node 24/вычисленным npmDepsHash и named/default packages/apps по NIX_AND_CI. Не включать development в source closure или runtime dependencies. Выполнить `nix build`, `nix run ... -- --help`, установку в временный profile и запуск вне репозитория. Проверить immutable store, внешний state/logs, сохранение cwd/PATH и нативные binaries adapters на NixOS. Добавить package/CLI smoke в CI; A42 остаётся незавершённой до этих фактических проверок.
