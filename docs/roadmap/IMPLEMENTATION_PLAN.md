# Активный план реализации и приёмки

**Источник требований:** [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [единственная матрица R01–R33/A01–A54 и M01–M04](../../tests/ACCEPTANCE_MATRIX.md).

Ранее реализованы C00–C11 и C11R с исправлениями ревью. Эти кластеры — история реализации, а не обязательный runtime workflow. Старые cluster plans и отчёты сохраняются в Git истории до C12.0.3; подтвердить актуальное поведение нужно через предметные docs/и тесты. Текущее положение и CI provenance — исключительно в [STATUS](STATUS.md).

## Следующие этапы

| Шаг | Содержание | Завершение |
|---|---|---|
| C12.0.1 | Baseline и карта old path → new disposition | Завершён, commit d9645c5 |
| C12.0.2 | Консолидация текущих продуктовых контрактов | Завершён, commit 87b79a1 |
| C12.0.3 | Активный roadmap, status, матрица, changelog | Завершён, commit 1d9963d |
| C12.0.4 | Инструкции .agents/ и AGENTS.md | Завершён |
| C12.0.5 | Перенос tests/fixtures/scripts, npm/checkJs | Реализован, CI pending |
| C12.0.6 | Обязательный CI и locked Nix/npm | Реализован, CI pending |
| C12.0.7 | Установленная поставка без dev tools | Реализован, CI pending |
| C12.0.8 | Удаление legacy development/, полная регрессия/handoff | **Следующий** |
| C12.1 | Трассировка R01–R33 ↔ A01–A54 ↔ tests/evidence | После C12.0 |
| C12.2 | Clean full regression | После C12.1 |
| C12.3 | Два реальных независимых исполнителя, CLI/ACP | После C12.2; недоступные native честно UNVERIFIED |
| C12.4 | Настоящий Zed/ACP, session/load/permissions | После C12.3; без клиента UNVERIFIED |
| C12.5 | Mutable workspace acceptance | После C12.4 |
| C12.6 | Clean installation outside checkout | После C12.5 |
| C12.7 | Архитектурный audit | После C12.6 |
| C12.8 | Release комплект/changelog/diagnostics | После C12.7 |
| C12.9 | Nix/NixOS/CI acceptance | После C12.8 |

Полные критерии C12.0.1–C12.9: [C12 acceptance and delivery](C12_ACCEPTANCE_DELIVERY.md). Не отмечать недоступные native пробы как PASS; implementation, regression, native readiness различаются. Каждый шаг отдельным коммитом и фактическим обновлением STATUS.
