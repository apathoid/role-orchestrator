# C02 — Один сквозной цикл исполнения

Вход: C01, EXECUTION. Использовать controlled ProviderPort fixtures, не реальную модель. Цель — доказать orchestration mechanics, а не качество LLM.

## C02.1 — Application service

Реализовать submit/resume/inspect/cancel API поверх coordinator. RequestId повторно доставленного идентичного запроса возвращает тот же operation; другой текст с тем же id даёт конфликт. Точка входа принимает необязательный workspace, не вызывает VCS. Tests: работа без cwd и в обычной директории.

## C02.2 — Контекст первого Controller

Материализовать буквальный запрос, ограничения, минимальный каталог и ресурсы. Инструкции допускают direct answer и модельный выбор метода, не требуют классификации по mode/complexity. Tests: текст пользователя сохранён, skill/provider output не получает trusted status.

## C02.3 — Dispatch Controller

Controller идёт через ProviderPort как обычный attempt с корреляцией/reservation. Не создавать скрытый отдельный счётчик router calls. Пока store in-memory в harness, используемый service не предполагает файловый backend. Tests: один вопрос -> один Controller -> final, никаких обязательных специалистов.

## C02.4 — Decision parsing

Принять структурированный результат через decoder. Для malformed ответа вернуть Controller точные schema errors и прежний контекст. Correction — новый обычный attempt, расходует общий бюджет. Tests: invalid -> valid; постоянный invalid заканчивается ресурсным пределом/частичным итогом, без fallbackPlan.

## C02.5 — Final и requirement assessment

Сохранить Assessment и user-visible answer. Проверить форму/существование refs, не семантику текста. Завершение Controller не равно user acceptance. Tests: direct answer, partial/unresolved, отсутствие tool evidence не подменяется PASS; не требовать специальных review полей.

## C02.6 — Уточнение пользователя

Создать questionId и waiting reason; ответ добавляется в ту же operation с новым requestId. Нет скрытого обнуления ресурсов. Tests: повтор ответа, ответ к чужому/закрытому вопросу, cancel в ожидании, отсутствие автоматического вызова Controller без новых событий.

## C02.7 — Сбои одиночного пути

Provider start failure, timeout, schema failure, user cancel переводятся в адресные outcomes. Controller получает доступный результат/ошибку и может выбрать следующий шаг. Не добавлять automatic retry effectful attempt. Tests: cancel до dispatch не отправляет запрос; timeout после отправки сохраняет uncertainty.

## C02.8 — Сквозная демонстрация core

Harness сценарии запускают service с fake ports и проверяют timeline, state и emitted answer. Demonstration находится в development, не является production fake mode. Закрыть A04–A07 и базовую A24. Проверить диагностический путь request -> decision -> outcome -> final по одному operationId.
