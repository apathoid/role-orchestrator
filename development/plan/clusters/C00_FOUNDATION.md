# C00 — Основа проекта и harness

Вход: корневой AGENTS, PRODUCT, ARCHITECTURE, LAYOUT_AND_RETENTION. Результат: сборка и проверяемые границы; runtime-функциональности пока нет. Не запускать реальные модели ради bootstrap.

## C00.1 — Зафиксировать технологическую базу

Проверить официальную поддержку выбранной Node LTS, TypeScript, нужного package manager и ACP SDK. Выбрать одну поддерживаемую минимальную Node version и сохранить engines/lock. Не добавлять SDK в core и не устанавливать все потенциальные provider packages заранее. В report указать проверенные первичные источники и версии, не обещать будущие версии.

Проверка: чистая установка в заявленной версии Node; неподдерживаемая версия даёт ясную диагностику. Недоступность registry фиксировать отдельно от дефекта проекта.

## C00.2 — Создать продуктовый пакет

Создать root package/build config: TypeScript strict, ESM, build в `dist/`, явные public exports, исходные слои `core/application/adapters/hosts/main`. Включить ровно необходимые compile/runtime зависимости. Не создавать пустой класс на каждый термин спецификации; достаточно directories и начальных contracts.

Проверка: clean build, импорт публичного entrypoint не открывает файл, процесс, соединение или провайдера. Product package не содержит development.

## C00.3 — Создать независимый harness

В `development/` отдельный package/lock и scripts: `check`, `test:core`, `test:contracts`, `test:integration`, `test:acceptance`, `test:native`, `check:boundaries`, `check:package`, `check:removal`. Harness использует product build; root scripts/tsconfig не ссылаются на development. Пока suites пусты, обозначать их NOT IMPLEMENTED, а не успешными тестами.

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

Выполнить build, boundary/package/removal smoke и зафиксировать результат в STATUS. Проверить, что documentation-only обещания всё ещё помечены как target. Следующий шаг C01.1; отсутствие provider binary не блокирует core.

Выход: готовые команды разработки, выбранные версии, явные слои и пустые переносимые порты. Acceptance: A01, A37 (частично до окончательного C12).
