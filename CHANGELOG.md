# Changelog

Публичные изменения и основные продуктовые вехи (не журнал всех коммитов). Текущий operational status и доказательства исполнения — [roadmap STATUS](docs/roadmap/STATUS.md).

## Unreleased — C12 integration and delivery

### C12R.9 — контекст и история, review P1/P2 (engineering changes; native UNVERIFIED)

- Controller, handoff, fetch, artifact capture, host-managed skill instructions и external tool output имеют независимые config budgets с controller-only legacy alias.
- Устранён artificial 128-entry cap; технический `workMap` вычисляется из исходной Operation, с сохранением refs/provenance и отличием terminal uncertain effect от in-flight.
- Добавлен optional `nextController.contextRequest` (refs/cursor) для следующего обычного Controller без MCP/нового Worker, с неизменными permission и recovery правилами.
- Добавлены технические body-free метрики доставки; provider-native files, skills, scripts, terminal и MCP остаются средствами провайдера.
- Review P1/P2: убрана лишняя копия Worker final output на проверенном пути Codex CLI/ACP → Controller; все исходные refs/provenance остаются durable.
- Контролируемые технико-исторические omissions снабжены полной статистикой, model-selected workCursor, явным invalid cursor и счётчиками недоставленных materialized/presented исторических запросов.
- ContextPort/MCP/contextRequest поддерживают позиционные refs и lossless byte-offset чтение фактически сохранённых результатов больше fetchMaxBytes без нового хранилища; регрессии включают restart, permission/ambiguity, byte-count precision, UTF‑16 surrogate, cancel/retention/integrity.
- Реальная model/Zed native comparison не заменяется автоматическими fixtures.



- C12.0: инженерные знания и тесты перенесены из временного `development/` в `tests/`, `scripts/`, `.agents/`, `docs/roadmap/`, корневые npm/Nix/CI. Runtime semantics не изменены.
- C12.1–C12.2: трассировка R/A, добавлены обязательные acceptance smoke (non-Git CLI/API и сохранность переноса). C12.5–C12.6: живая правка ветки/index при запущенном worker и clean tarball E2E без dev tools; C12.7: статический audit границ Host и model-first.
- C12.8: воспроизводимая сборка npm tarball (двойной pack), SHA-256 manifest и Nix path-info как CI artifact без публикации production release.
- C12.9: CI проверяет вычисление NixOS module graph с установленным пакетом; это не запуск на NixOS и не нативное подтверждение модели.
- C12R.1: локальный технический отказ Controller не отменяет ранее принятые Workers; готовые reservation requests обслуживаются без starvation, durable recovery сохраняет unsent attempts и не повторяет unknown effects.
- C12R.2–.5: усилена проверка explicit reasoning provenance в snapshot; сохранены адресные admission/Decision причины; различается context payload/ambiguity/retention/budget; ACP output limit отделён от protocol error, сохранены частичные observations и cleanup/slot evidence.
- C12R.6.0: исправлена доставка выбранных skills в CLI/ACP, атрибуция inline/loaded, недоступность и scope; idempotency identity учитывает исправленный контракт доставки.
- C12R.8: восстановлен проверяемый handoff STATUS, убрана обязательная рекомендация перебирать историю: Controller решает, нужен ли optional ContextPort/MCP retrieval. Фактическая доступность MCP осталась, новые тесты фиксируют технические лимиты/идемпотентность и prompt policy без нового Host workflow. Подтверждена автоматизированная регрессия; влияние на качество native reasoning не измерено.
- C12R.8R: MCP при превышении response budget сохраняет известные effect/status и correlation ref, отмечая ошибку доставки; ограничение проверяет весь JSON-RPC envelope. Неожиданный oversized result не превращается в ложный no-effect, поздние tool receipts и durable history остаются неизменными; повторный MCP request ID не запускает новый эффект. Усилено покрытие общего budget, lifecycle/cancel/cleanup, id-validation и optional retrieval при прямом Controller-ответе; Resource/Host/model-first границы и лимиты не изменены.
- Реальная CLI/ACP/Zed/NixOS интеграция и подтверждение native effort пока не завершены; не обещается production readiness.

## 0.1.0-dev.0 — функциональные приращения

- C01–C03: provider-agnostic JavaScript ESM core, один model-first Controller cycle, делегирование, параллельная работа, отмена и resource budgets.
- C04–C06: доверенные permissions/configuration, durable snapshots/CAS, безопасная неопределённость внешних эффектов, findings/evidence и model-managed applicability.
- C07–C08: Codex CLI и Generic ACP adapters с корреляцией session/attempt, permission bridge и наблюдаемыми failure paths.
- C09–C10: явные plugins/skills/tools, программный API, CLI, внешний ACP host; npm/Nix package/apps.
- C11: диагностика причин остановки, bounded traces, redaction, sink isolation и recovery.
- C11R: selectable reasoning effort в том же config v1 для Controller и workers, native omission, per-attempt provenance и per-provider adapters без второго scheduler.

Исторические CI результаты относятся к конкретным исходным commit; real model/ACP/Zed native acceptance остаётся отдельно UNVERIFIED.

### C12R.9 — повторное ревью фрагментов и производительности

- У `workMap` не показывается `nextCursor` после последней страницы; нулевой прогресс помечается `budget`.
- Для `ContextPort.fetch({offset,maxBytes?})` введён независимый per-call byte ceiling, ограничивающий весь chunk envelope. В Controller крупный base64 payload может быть без потери данных уменьшен до фактического свободного бюджета с пересчитанным `nextOffset`. MCP ограничивает конкретный fetch собственной транспортной границей, не увеличивая `fetchMaxBytes` или другие defaults.
- Local StateStore может выдавать диапазоны из одного ограниченного в памяти SHA‑256-verified образа, проверяя метаданные backing-файла перед повторным использованием; избегаются повторные полные дисковые чтения при длинной последовательности страниц, сохраняются integrity/retention/cancel semantics. Нового persistent store или Host runtime не добавлено.
