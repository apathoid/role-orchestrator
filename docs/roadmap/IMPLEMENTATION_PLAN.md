# Активный план реализации и приёмки

**Источник требований:** [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [единственная матрица R01–R33/A01–A54 и M01–M04](../../tests/ACCEPTANCE_MATRIX.md).

Ранее реализованы C00–C11 и C11R с исправлениями ревью. Эти кластеры — история реализации, а не обязательный runtime workflow. Старые cluster plans и отчёты остаются **только в Git history** после удаления `development/`; актуальное поведение задают предметные `docs/` и тесты. Текущее положение и CI provenance — исключительно в [STATUS](STATUS.md).

## C12R — корректирующий этап и приёмка

**Актуальный следующий шаг определяется [STATUS](STATUS.md).** Единый детальный план: [C12R — стабилизация](C12R_STABILIZATION.md). C12R устраняет подтверждённые дефекты нативной эксплуатации до окончательной приёмки C12; это корректирующий инженерный этап, не новый runtime workflow.

| Шаг | Назначение |
|---|---|
| C12R.0 | Baseline, evidence, воспроизведение дефектов |
| C12R.6.0 | Instruction scope и фактическая доставка skills |
| C12R.1 | Независимость Controller/Workers, fairness и recovery |
| C12R.2 | Reasoning provenance |
| C12R.3 | Адресная диагностика |
| C12R.4 | Context/evidence/findings |
| C12R.5 | ACP, частичные observations и lifecycle ресурсов |
| C12R.6.1–6.4 | Проверка и точечная оптимизация модельной координации |
| C12R.7 | Регрессия, native acceptance и сравнение качества |

Порядок инженерный, может уточняться по зависимостям; статус каждого шага и фактические результаты — только в [STATUS](STATUS.md). Каждый самостоятельный шаг отдельным коммитом. Context compaction и изменение native skill discovery исключены. После инженерных исправлений сохраняются незакрытые C12.3/C12.4 и native NixOS acceptance.

## C12R.8 — новая корректирующая диагностика и условные исправления

[**Детальный инженерный план C12R.8**](C12R8_RELIABILITY.md) исполнен в подтверждённом инженерном scope: C12R.8.0 проверил доступный baseline, C12R.8.1–.6 условно оценены (runtime изменение обосновано только для рекомендаций optional retrieval; инфраструктурные лимиты отдельно протестированы), C12R.8.7 завершён автоматизированной регрессией. Подробности, коммиты и CI provenance — в [STATUS](STATUS.md). Это не новый runtime workflow и не автоматическое переоткрытие закрытых C12R.4/.5/.6/.7.

Реальная native acceptance [C12.3/C12.4/C12R.7/NixOS](NATIVE_ACCEPTANCE.md) по-прежнему не закрыта. Текущее выполнение, проверки и оставшиеся gaps — только в [STATUS](STATUS.md).

## C12R.8R — адресные исправления по ревью

На актуальном implementation HEAD `4c3f324e11b8d7ab851f893bafcbd492fd03f26d` завершена доступная инженерная часть [C12R.8R](STATUS.md): восстановлена post-execution MCP provenance при response overflow, исправлен byte check полного JSON-RPC envelope и non-finite id, проверены общий tool/history budget, bounded cache, cancellation/late receipts, durable reopen и optional direct Controller без retrieval. **CI 324/324 PASS**; реальный Zed/ACP, независимые модели, native NixOS и качество сравнительных retrieval A/B прогонов остаются UNVERIFIED. C12R.8R не меняет обязательные runtime workflow, Host semantics, permissions или лимиты.

## C12R.9 — обязательные исправления непрерывности контекста

**Исторический план C12R.9.0–.7 реализован; текущая готовность и review-fixes определяются [STATUS](STATUS.md).** [**Нормативный инженерный план C12R.9**](C12R9_CONTEXT_CONTINUITY.md) определяет обязательные результаты (а не гипотетические возможности). Предыдущие шаги C12R.0–.8R инженерно закрыты в доступном scope, реальная native acceptance остаётся открытой.

| Этап | Обязательный результат |
|---|---|
| C12R.9.0 | Воспроизвести loss/duplication/size проблемы на synthetic fixtures, зафиксировать actual baseline |
| C12R.9.1 | Удалить технически доказанную повторную inline-доставку одного результата, сохранив raw history |
| C12R.9.2 | Разделить бюджеты Controller/handoff/fetch/capture/skills/tools, default Controller = 256 КиБ, убрать отдельный фиксированный 128-record guard и ограничить dynamic technical context |
| C12R.9.3 | Добавить компактную **производную**, не persisted, карту Action→Attempt→Outcome→refs и разнести terminal completion/effect uncertainty |
| C12R.9.4 | Сохранить MCP ContextPort и добавить **необязательный модельный** запрос refs/cursor в обычном `nextController` для случаев без retrieval tools; не создавать новый host index или workflow |
| C12R.9.5 | Уточнить Host Catalog vs native skills, не сканируя проект и не ограничивая provider-native tools |
| C12R.9.6 | Добавить техническую диагностику реальной границы доставки, без сбора bodies по умолчанию |
| C12R.9.7 | Полная регрессия, comparative native acceptance (либо честный UNVERIFIED), документация и STATUS |

**Границы:** Model-first, provider-agnostic, unconstrained native execution в пределах настоящих permissions, отсутствие фиксированных workflows, Host compaction/summary/relevance scoring, нового indexed store, второго scheduler, Host файлового runtime, обязательного MCP/Worker/Controller turn или persistent native session. Эти шаги — этапы инженерной реализации, не новые runtime stages. Бюджеты по фактическим техническим ресурсам и все ссылки/исходные наблюдения сохраняют provenance. Сначала проверка на fixture, затем минимальное адресное изменение; новые возможности реализуются только для воспроизведённого случая, который не устраняется одной корректной inline-доставкой.

**Историческая запись плана: первоначально runtime implementation не начиналась; C12R.9.0–.7 затем реализованы.** NATIVE C12.3/C12.4/Zed/NixOS и comparative quality остаются UNVERIFIED. Действующие результаты и следующий шаг — только в [STATUS](STATUS.md).

## C12 — реализованные инженерные шаги и открытая приёмка

| Шаг | Содержание | Завершение |
|---|---|---|
| C12.0.1 | Baseline и карта old path → new disposition | Завершён, commit d9645c5 |
| C12.0.2 | Консолидация текущих продуктовых контрактов | Завершён, commit 87b79a1 |
| C12.0.3 | Активный roadmap, status, матрица, changelog | Завершён, commit 1d9963d |
| C12.0.4 | Инструкции .agents/ и AGENTS.md | Завершён, commit ad9fdba |
| C12.0.5 | Перенос tests/fixtures/scripts, npm/checkJs | PASS run 42878217644 |
| C12.0.6 | Обязательный CI и locked Nix/npm | PASS run 42878217644 |
| C12.0.7 | Установленная поставка без dev tools | PASS run 42878217644 |
| C12.0.8 | Удаление legacy development/, полная регрессия/handoff | PASS run 42878217644 |
| C12.1 | Трассировка R01–R33 ↔ A01–A54 ↔ tests/evidence | Выполнено, CI source 1341d75 |
| C12.2 | Clean full regression | PASS 302/302, run 42878217644 |
| C12.3 | Два реальных независимых исполнителя, CLI/ACP | Протокол готов; **real native UNVERIFIED** |
| C12.4 | Настоящий Zed/ACP, session/load/permissions | Протокол готов; **Zed native UNVERIFIED** |
| C12.5 | Mutable workspace acceptance | PASS automated, real provider UNVERIFIED |
| C12.6 | Clean installation outside checkout | PASS npm/Nix synthetic, run 42878217644 |
| C12.7 | Архитектурный audit | Static paths reviewed; no reproduced defect |
| C12.8 | Release комплект/changelog/diagnostics | PASS reproducible npm artifact / SHA-256 |
| C12.9 | Nix/NixOS/CI acceptance | PASS Linux CI/NixOS eval; native boot UNVERIFIED |

Полные критерии C12.0.1–C12.9: [C12 acceptance and delivery](C12_ACCEPTANCE_DELIVERY.md). Не отмечать недоступные native пробы как PASS; implementation, regression, native readiness различаются. Каждый шаг отдельным коммитом и фактическим обновлением STATUS.

## Нативные блокеры финальной приёмки

C12.0–.2 и C12.5–.9 имеют отдельные implementation commits и обязательные CI, но **C12 как целое не закрыт**: C12.3 требует двух независимых реально работающих моделей/провайдеров, C12.4 — живой Zed/ACP-клиент; реальная NixOS эксплуатация тоже не проверена. Детальный безопасный план выполнения: [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md). После получения доказательств обновить единственную [матрицу](../../tests/ACCEPTANCE_MATRIX.md) и [STATUS](STATUS.md), повторить clean full CI. Нельзя преобразовывать UNVERIFIED в PASS из GitHub Actions fixtures.
