# C00 — Основа проекта и harness

Вход: корневой AGENTS, PRODUCT, ARCHITECTURE, LAYOUT_AND_RETENTION. Результат: сборка и проверяемые границы; runtime-функциональности пока нет. Не запускать реальные модели ради bootstrap.

## C00.1 — Зафиксировать технологическую базу

Проверить Node 24, npm, TypeScript checker для JS и указанные пользователем ACP dependencies. Сохранить Node 24 engines и создать package-lock с реальными integrity hashes; не менять версии зависимостей автоматически из-за недоступности registry. Не добавлять SDK в core и не устанавливать все потенциальные provider packages заранее. В report указать проверенные первичные источники и версии, не обещать будущие версии.

Проверка: чистая установка в заявленной версии Node; неподдерживаемая версия даёт ясную диагностику. Недоступность registry фиксировать отдельно от дефекта проекта.

## C00.2 — Создать продуктовый пакет

Дополнить root package config: JavaScript `.js`, ESM, прямые public exports в `src/`, исходные слои `core/application/adapters/hosts/main`. Описать JSDoc-контракты и включить checkJs/strict/noEmit в отдельном harness. Не добавлять обязательную транспиляцию или фиктивный build script. Runtime dependencies должны соответствовать действительным потребителям. Не создавать пустой класс на каждый термин спецификации; достаточно directories и начальных contracts.

Проверка: syntax/type checks и чистая упаковка JS; импорт публичного entrypoint не открывает файл, процесс, соединение или провайдера. Product package не содержит development.

## C00.3 — Создать независимый harness

В `development/` отдельный package/lock и scripts: `check`, `test:core`, `test:contracts`, `test:integration`, `test:acceptance`, `test:native`, `check:boundaries`, `check:package`, `check:removal`. Harness использует product JavaScript entrypoints; root scripts/package exports не ссылаются на development. Пока suites пусты, обозначать их NOT IMPLEMENTED, а не успешными тестами.

Проверка: удаление harness из временной копии не ломает root install/build. Команда пустого обязательного suite не должна ложно сообщать «вся функциональность проверена».

## C00.4 — Установить правило импорта

Проверка границ: core не импортирует Node I/O, SDK, adapters/hosts, Git wrappers; product files не импортируют development. Сделать проверку реальных import dependencies через compiler graph или поддерживаемый анализатор, а не совпадение слов `git` в комментариях. В fixtures добавить намеренно запрещённый импорт только для отрицательной проверки harness.

Проверка: валидный graph проходит, запрещённый import обнаруживается с парой paths; слова из продуктовой документации не дают false positives.

## C00.5 — Согласовать диагностический skeleton

Ввести DiagnosticEvent/DiagnosticPort и no-op sink, Clock/IdFactory ports. Не писать логгер с глобальными mutable singleton. Поздние adapters смогут подключать sinks через composition. Severity — технический log level, не severity finding.

Проверка: fake sink получает correlation fields; throwing sink не меняет результат чистой операции. Секретные payloads не являются обязательной частью event.

## C00.6 — Зафиксировать development evidence convention

Создать runs/tmp из harness; все fixtures синтетические. Для run report достаточно command, start/end, exit, relevant check ids, limitations. Не сохранять user secrets и не считать отсутствие отчёта PASS. Определить cleanup временных процессов/каталогов после failure.

Проверка: авария fixture не оставляет owned process и не удаляет путь вне test-owned tmp.

## C00.7 — Закрыть bootstrap

Выполнить syntax/type checks, boundary/package/removal smoke и зафиксировать результат в STATUS. Проверить, что documentation-only обещания всё ещё помечены как target. Продолжить C00.8–C00.10, затем C01.1; отсутствие provider binary не блокирует core.

Выход: готовые команды разработки, выбранные версии, явные слои и пустые переносимые порты. Acceptance: A01, A37 (частично до окончательного C12).

## C00.8 — JavaScript и lock-файлы

Проверить предоставленные package.json/package-lock; `npm ci` должен использовать заявленную Node 24. Создать JSDoc types для первых портов и development-only checker config с allowJs/checkJs/strict/noEmit. Добавить отрицательную fixture несовместимого контракта: checker обязан её обнаруживать. Product imports исполняются без TypeScript. Не менять зависимости молча при registry/network ошибке.

## C00.9 — Nix foundation

Проверить committed flake.lock, `nix flake check --no-update-lock-file` и `nix develop --command node --version`. При отсутствии lock сгенерировать настоящим Nix, не писать narHash вручную. Node должен соответствовать engines. Проверки metadata не требуют development. До настоящего CLI не создавать fake packages/apps. Прочитать NIX_AND_CI и проверить обещания относительно текущего состояния.

## C00.10 — GitHub CI

Проверить реальный run foundation workflow. Подключить Node syntax/checkJs и уже существующие suites, сохранив явный статус незавершённых. Actions pin, read-only permissions и отсутствие secrets в logs обязательны. npm/Nix locks не меняются скрыто в постоянном CI. Проверить, что без development пропускаются только dev checks, а metadata/package checks работают. Выходы C00 теперь включают A41 и foundation-части A42/A43.
