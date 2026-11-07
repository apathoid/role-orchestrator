# C12 — Полная приёмка и поставка

Вход: C11, все строки ACCEPTANCE_MATRIX. Не путать наличие кода с проверенной функциональностью.

## C12.1 — Матрица требований

Связать R01–R31 с выполненными A-сценариями, тестами и реальными run ids. Найти пробелы, противоречия и проверки, которые подтверждают лишь внутренний helper. Для каждого существенного требования нужен observable результат или честный UNVERIFIED. Исправить найденные дефекты в слое-владельце.

## C12.2 — Общий regression run

Clean install/build, boundaries, core, contract, integration, acceptance. Failure фиксируется отдельно от unavailable tool/environment. Не ослаблять assertion, если он выражает действительный контракт. После изменения повторить затронутый набор и итоговую проверку; не перепроверять бесконечно без новых изменений.

## C12.3 — Реальная provider-agnostic проверка

Два различных доступных исполнителя, хотя бы один ACP и один CLI либо эквивалентно подтверждённые независимые adapters. Один профиль -> direct answer; совместная задача -> последовательное/параллельное делегирование; denied tool, cancellation, disconnect. Версии и native configurations сохранить в development evidence, секреты исключить.

## C12.4 — Native Zed/ACP

Регистрация, start session без Git, prompt, progress, permission allow/deny, cancel, load/resume после перезапуска. Проверить различие внешних/внутренних ids и честность unknown effects. Если клиент/доступ отсутствует, статус NATIVE ACCEPTANCE PENDING с точными сценариями; не заменять настоящую проверку mock log.

## C12.5 — Mutable workspace acceptance

Во время активного исследования пользователь/fixture меняет файл, индекс, branch или содержимое рабочей директории. Проверить, что Host не делает дополнительный reconcile/review/cancel. Отдельно смоделировать действительную tool error: модель получает observation и выбирает дальнейшее действие. Сравнить traces, не только финальный текст. Проверка Git-сценария сама может использовать Git как test fixture, но продукт не становится от него зависимым.

## C12.6 — Удаление development и поставка

В отдельной временной копии убрать development целиком, clean install/build/package, API import, CLI help/diagnose и контролируемый end-to-end. Product package содержит только runtime и нужные docs/resources. Проверить отсутствие импортов/обязательных ссылок/скриптов на удалённый harness. После удаления regression-защиты нет — это явно указать, не заявляя её сохранность.

## C12.7 — Содержательная архитектурная проверка

Проверить нет ли скрытых fixed workflow, provider strings в core, обязательного Git, source fingerprint gate, автоматической invalidation finding, host filesystem enforcement, двойного ledger или второго scheduler. Называть конкретные code paths. Наличие сложного кода не доказывает дефект; найденное отклонение оценивается по контракту и эффекту.

## C12.8 — Финальный комплект

Обновить README от «спецификация» к фактическому статусу, продуктовые docs к реализованным API. STATUS и отчёт содержат implemented/verified/native состояния, команды, exits и remaining limits. Подготовить воспроизводимый product package с checksums; не включать secrets/development traces. Полное завершение — все обязательные сценарии подтверждены либо явно согласован ограниченный статус поставки. Никаких скрытых TODO вместо заявленной функции.

## C12.9 — Nix/NixOS и CI приёмка

Проверить lock-preserving Nix build/check, named/default apps, temporary profile installation и интеграцию package в NixOS evaluation/среду с реальным запуском. В отдельной копии удалить development и повторить package/CLI проверки без иных правок. Проверить JS исходники, отсутствие транспиляции и development checker в runtime. Сопоставить зелёные CI jobs с фактически выполненными suites; foundation PASS не заменяет regression/native readiness. Закрыть A41–A43 и R29–R31 либо явно зафиксировать недоступные проверки.
