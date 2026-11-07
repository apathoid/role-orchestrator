# C07 — CLI/headless provider adapter

Вход: C06, PROVIDERS_AND_CONFIGURATION. Первый реальный execution adapter; core остаётся неизменным по провайдерской семантике.

## C07.1 — Launch contract

Проверить официальные возможности одного доступного CLI исполнителя. Зафиксировать trusted command/argv/stdin/output format/cwd/native settings. Пользовательский prompt передавать как данные, не shell source. Не угадывать flags. Не вводить host sandbox или очистку environment, которая неявно убирает настроенные пользователем инструменты; environment/credentials задаются доверенным launch profile.

## C07.2 — Process ownership

Реализовать start, streams, close, deadline, signal/cancel и cleanup owned descendants доступным платформенным способом. Не завершать чужие процессы по имени. Tests: ENOENT, stdin EPIPE, выход до ответа, долгий процесс, partial output, timeout и orphan prevention. Platform support заявлять только проверенный.

## C07.3 — Framing и bounded output

Для structured output использовать документированный формат конкретного adapter profile. Plain text worker output допустим с provenance. Лимиты stdout/stderr не обрывают protocol frame без объяснения; oversized message -> protocol diagnostic + available output. Tests: chunk boundaries, UTF-8 split, stderr noise, malformed envelope, output limit.

## C07.4 — Controller и Worker

Проверить полный JSON Decision для Controller, обычный/structured текст для Worker. CLI exit и tool exit различны. Tests: exit 0 + task failure text не semantic PASS; schema invalid не превращается в fabricated plan; output после transport error доступен с uncertainty.

## C07.5 — Permissions и capabilities

CLI native permission profile задаёт оператор, adapter сообщает поддерживаемый bridge/interactive behavior. При невозможности интерактивного ответа headless invocation сообщает конкретное ограничение. Нельзя автоматически включать dangerous bypass flags ради продолжения. Tests: denied/unavailable, standing configured permission, нет автоматически выбранного read-only по роли.

## C07.6 — Общий ProviderPort suite

Прогнать тот же contract suite, что у controlled provider: event order, terminal, cancel, id, usage unknown, multiple calls, sessions optional. Real process fixtures живут в development. Product не включает fake executables или тестовые ответы.

## C07.7 — Сквозной native-like run

Service -> CLI adapter -> synthetic child -> durable result, затем crash/restart и cancel. Это интеграция с реальным OS process, но не native evidence AI-провайдера. Проверить workspace без Git и изменения cwd contents во время исполнения; нет автоматических preflights.

## C07.8 — Настоящий исполнитель при наличии

Минимальный реальный запрос, уточнение/продолжение, доступный tool, denial/cancel. Записать версии/команды/границы. Если binary/account отсутствуют, оставить native acceptance pending, продолжить независимые C08–C11. Закрыть adapter части A18/A20/A38; новых production semantic gates быть не должно.
