# C01 — Контракты и чистые переходы core

Вход: C00, CONTRACTS. Выход: детерминированный доменный механизм без I/O. Diagnostics появились в C00 и дополняются здесь.

## C01.1 — Идентичности и decoder

Определить opaque operation/action/attempt/decision/request ids и versioned discriminated unions. Runtime decoder для Request/Decision/Outcome принимает unknown, возвращает проверенный тип либо ошибку с field path. Не делать семантический анализ текста задачи. Tests: missing id, wrong type, неизвестный variant, неизвестная major version, корректный минимальный direct answer.

## C01.2 — Operation и Attempt

Реализовать состояния из CONTRACTS с явными reason references. Отделить terminal outcome попытки от оценки всей задачи. Cancel requested не равен cancelled outcome; unknown effect не глобальный blocked status. Tests: completed worker с отрицательным результатом оставляет operation active; частичный final не становится success.

## C01.3 — Чистый переход

Ввести небольшую чистую функцию применения технического события к operation snapshot, возвращающую новое состояние и намерения I/O. Не строить generic workflow engine или reducer DSL. Все изменения state идут через один владеющий механизм; callbacks не мутируют его напрямую. Tests: повтор одного события идемпотентен, инварианты revision/id, исходный snapshot не меняется.

## C01.4 — Ledger ресурсов

Модель reservation/settlement для invocation count, concurrency и доступного usage. Reservation атомарна вместе с созданием attempt. Unknown measured usage не заменяется нулём. Tests: две конкурентные reservations при одном слоте, duplicate settlement, failure до/после dispatch, исчерпание не обнуляется при смене роли.

## C01.5 — Ошибки и причины

Типизированные reason codes из CONTRACTS; у ошибки есть scope operation/action/attempt и сведения о dispatch/effect. Общий `Error` адаптера переводится на границе, сохраняя безопасную диагностику. Tests: denied capability отличается от failed tool и cancelled; отказ action не отменяет другую operation.

## C01.6 — Порты

Определить ProviderPort, StateStore, Catalog, ContextPort, PermissionPort. Минимальные in-memory реализации для tests находятся только в harness. Production default storage не должен появляться в core «временно». Tests: core работает с портами без fs/process/network и без установленного Git.

## C01.7 — Технические события

Каждый важный переход формирует событие с component/id/reason, но событие не возвращается обратно как новая бизнес-команда. Не создавать два источника state в logger и reducer. Tests: отказ sink не меняет snapshot, событие без secret body объясняет transition.

## C01.8 — Контрактные отрицательные проверки

Проверить malformed input, дубликаты, события чужого attempt, противоречащие terminal outcomes. Последнее сохраняется как discrepancy и не переписывает историю молча. Не добавлять freshness/version checks исходников в ответ на эти случаи. Закрыть A02, A03 и core-части A19/A22/A29; обновить STATUS.
