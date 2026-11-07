# C06 — Контекст, findings и acceptance

Вход: C05, CONTEXT_AND_RECOVERY и EXECUTION. Цель — помогать моделям использовать знания без самостоятельного Host adjudication.

## C06.1 — Provenance

Реализовать разные типы user/model/provider_tool/host_transport observation. Сохранить source id, received sequence/time и available output. Tests: agent exit 0 не становится exit вложенного test; сообщение «проверки прошли» остаётся provider/model reported.

## C06.2 — Findings и revisions оценок

Хранить claim, subject, supports, author, uncertainty и optional supersedes. Модель объединяет/оспаривает находки; Host только проверяет references и структуру. Tests: два противоречивых вывода сосуществуют, новая оценка не стирает raw, одинаковый путь не вызывает автоматический merge.

## C06.3 — Context materialization

Сформировать компактный bundle по выбранным Controller refs и технически обязательным ограничениям/unknown. Объём конфигурируем, oversized records представлены excerpt+ref. Tests: явный truncation, missing data, никакой молчаливой потери user constraints или uncertainty.

## C06.4 — Retrieval и summary

Context fetch возвращает bounded artifacts; доступ проверяется по operation/разрешённому sharing. Summary создаёт модель и указывает covered observation ids. Tests: request детали, недоступный artifact, cross-operation ссылка без разрешения, summary не заменяет raw и не получает host-observed статус.

## C06.5 — Mutable environment

Передать модели новые observations об изменении файла/контекста без автоматического stale transition. Tests: unrelated edit сохраняет finding; существенный edit доступен модели, которая решает re-read; смена index/branch не запускает обязательный вызов. Проверять отсутствие лишних dispatch, а не просто статус final.

## C06.6 — Assessment по требованиям

Controller формирует fulfilled/partial/unverified и основания. Проверяется форма/refs; Host не вычисляет semantic score. Explicit required check остаётся в контексте до оценки моделью; нельзя подставлять PASS. Tests: известно «проверка до изменения», запрос требует «после изменения» — итог fixture указывает unverified; Host не создаёт synthetic proof.

## C06.7 — История и retention

Сохранить удобный inspection finding -> evidence -> attempt -> result. Retention удалённых завершённых артефактов помечает unavailable, не переписывает вывод. Tests: удалённый по политике output не выдаётся за пустой; активные unresolved эффекты не пропадают при routine cleanup.

## C06.8 — Проверка качества контекста

End-to-end fixtures: reuse finding без повторного исследователя, спор двух моделей, новый targeted check, недоступный source, частичный итог. Это проверяет доставку/контракты, не доказывает реальную способность LLM рассуждать — native review проверяется позднее. Закрыть A29, A33–A36; trace связывает данные с конкретным handoff.
