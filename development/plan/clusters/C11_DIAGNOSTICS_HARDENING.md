# C11 — Диагностика и эксплуатационная устойчивость

Вход: C10. Все базовые events уже реализованы. Здесь проверяются полнота, удобство локализации и пределы в реальных transports.

## C11.1 — Event taxonomy audit

Для каждого await/defer/reject/cancel/recovery проверить event owner, operation/attempt id, reasonCode и доступный следующий путь. Удалить двусмысленное «blocked» без subject. Tests: golden semantic trace для direct answer, параллельности, denial, unknown; не фиксировать случайные timestamps/UUID.

## C11.2 — NDJSON sink

Bounded queue, rotation, max size/files, flush deadline и stderr summary. Ошибка sink не изменяет outcome/ресурсный ledger. Tests: disk full, slow sink, invalid path, burst, shutdown flush timeout; count dropped отображается.

## C11.3 — Redaction и body capture

Удалять known secrets до sink/export, по умолчанию не писать prompts/tool bodies. Проверить nested payload/error strings/env. Не заявлять полную автоматическую очистку произвольного текста; config и help объясняют ограничение. Tests с synthetic secrets во всех каналах; capture off гарантирует отсутствие raw body.

## C11.4 — Inspect/trace/export

Дать пользователю один путь от симптома к конкретному event/attempt/adapter: текущий статус, ожидания, budget, unknown, последний итог. Export включает manifest форматов и missing portions, не mutates state. Tests: runtime log отсутствует, artifacts truncated/retained, частичная запись, корректный output path.

## C11.5 — Diagnose без побочных действий

Проверить config/versions/state access/launch path и declared capabilities. Не вызывать модели, Git и неизвестные CLI commands для автоматического probe без явного выбора пользователя. Tests: отсутствует provider, недоступен каталог state, capabilities unknown; диагноз не изменяет workspace.

## C11.6 — Cleanup и race stress

Многократно выполнить start/cancel/error/reconnect с контролируемыми barriers; проверить handles/listeners/processes/temporary artifacts. Использовать ограниченный stress для конкретных races, не бесконечный fuzz ради отчёта. Tests: late terminal, concurrent permission, shutdown во время commit, unreachable provider.

## C11.7 — Ресурсные и контекстные пределы

Large tool output, большое число findings, несколько operations, длинная history. Проверить bounded memory/context и честные unavailable/truncation. При исчерпании ресурса выдаётся прогресс, не fabricated success. Нельзя добавить semantic timeout «нет полезного прогресса» с heuristic scoring.

## C11.8 — Операционная документация

Обновить продуктовые docs фактическими командами, поддержанными платформами, форматами и ограничениями. Не включать туда development logs или отчёт итерации. Закрыть A21/A22/A27–A29/A34/A36/A40. Незапущенные native проверки остаются отдельными.
