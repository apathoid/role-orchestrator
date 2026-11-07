# C03 — Delegation, параллельность, ресурсы и отмена

Вход: C02, CONTRACTS/EXECUTION. Scheduler исполняет предложенный граф; не придумывает семантических стадий.

## C03.1 — Handoff

Реализовать worker Action и Invocation context: цель, выбранный профиль, role/skills refs, ограничения, ожидаемый результат и supports. Никакого обязательного Planner. Tests: специалист получает только выбранный релевантный контекст и ограничения; роль не расширяет полномочия.

## C03.2 — Граф зависимостей

Проверить известные ids и отсутствие cycles. Поддержать `after_terminal` и `after_model_acceptance` отдельно. Tests: chain, diamond, независимые actions, цикл, пропавшая ссылка, failure terminal доступен модели и не считается автоматически успешным dependency result.

## C03.3 — Scheduler

Запускать ready actions в пределах maxConcurrentInvocations и резерва. Одна operation serializes state events, но не блокирует параллельные provider awaits. Tests с barriers, без sleep: два ready action идут параллельно; третий ждёт слот; две operations не блокируют друг друга.

## C03.4 — Возврат результатов

Реализовать waitPolicy next_completion/all_requested. Controller получает completed и pending ids; повтор delivery не создаёт новую оценку/вызов без нового события. Tests: обратный порядок завершения, один failure, завершение сразу после регистрации ожидания, нет busy loop.

## C03.5 — Перепланирование

Добавлять новые actions; отменять/заменять незапущенные по id; для running использовать cancel. Не требовать всего нового плана после каждого результата. Tests: появляется новая информация -> добавляется проверка; прежний завершённый результат переиспользуется; старый action payload не мутируется.

## C03.6 — Дубликаты и конкурирующие события

Dedup decisionId/actionId и attempt events. Новый unrelated event после contextCursor не отвергает всё решение Controller. Актуальные cancel/revocation/изменение адресуемого action проверяются. Tests: terminal event и replan в обоих порядках, duplicate callback, conflicting terminal -> discrepancy.

## C03.7 — Отмена

Operation cancel останавливает новые dispatch и передаётся активным attempts; action cancel не отменяет соседей. Зафиксировать provenance user/client/shutdown/superseded/provider. Tests: cancel до reservation, между reservation/dispatch, во время callback и после результата; late result сохраняется, работа не возобновляется.

## C03.8 — Ресурсы во всём графе

Включить Controller, workers, correction и failed attempts в общий ledger. Указать точный момент списания invocation и освобождения slot. Tests: расход при падении, параллельные reservations не превышают limit, resume позже не reset; unknown costs не становятся нулём.

## C03.9 — Завершение с pending

Controller явно выбирает дождаться/отменить активное. Финал отражает unknown при неясном cancel; Host не заявляет, что все эффекты прекращены. Tests: partial answer с pending effects, бессмысленный wait id, отказ одного action не превращается в глобальную ошибку.

## C03.10 — Проверка model-first

Сценарии: одна модель; два последовательных специалиста; два параллельных и возврат к одной модели; disagreement без majority vote; verification failure -> модель выбирает исследование без Host fix-route. Закрыть A08–A14, A19–A22. Диагностика должна объяснять каждый deferred action конкретной зависимостью/ресурсом.
