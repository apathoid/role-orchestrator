# Role Orchestrator — активный roadmap

**Единая оперативная точка входа** — [STATUS](STATUS.md) и [план C12](IMPLEMENTATION_PLAN.md). До полного завершения C12.0 в Git может временно сохраняться старый `development/`, но он не является вторым источником требований. Следующий шаг определяется исключительно здесь.

- [Полные шаги C12.0–C12.9](C12_ACCEPTANCE_DELIVERY.md).
- [Единственная матрица R01–R33, A01–A54, M01–M04](../../tests/ACCEPTANCE_MATRIX.md).
- [Карта переноса C12.0.1](../../development/reports/C12/MIGRATION_REGISTER.md) — временная ссылка до окончательного handoff C12.0.8; после неё ссылка ведёт на постоянную карту.
- [Предметная спецификация](../PRODUCT.md), [навигация возможностей](../CAPABILITIES.md), [архитектурные решения](../DECISIONS.md).

Ранее завершённые C00–C11R являются историей в Git; активные контракты находятся в предметных `docs/`, проверки — в `tests/`. Implementation и CI regression не эквивалентны native acceptance. Зелёный CI на предыдущем commit не доказывает текущий HEAD.
