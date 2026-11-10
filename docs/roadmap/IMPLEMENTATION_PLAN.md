# Активный план реализации и приёмки

**Источник требований:** [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [единственная матрица R01–R33/A01–A54 и M01–M04](../../tests/ACCEPTANCE_MATRIX.md).

Ранее реализованы C00–C11 и C11R с исправлениями ревью. Эти кластеры — история реализации, а не обязательный runtime workflow. Старые cluster plans и отчёты остаются **только в Git history** после удаления `development/`; актуальное поведение задают предметные `docs/` и тесты. Текущее положение и CI provenance — исключительно в [STATUS](STATUS.md).

## Следующие этапы

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
