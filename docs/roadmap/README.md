# Role Orchestrator — активный roadmap

**Единая оперативная точка входа** — [STATUS](STATUS.md) и [план C12](IMPLEMENTATION_PLAN.md). До полного завершения C12.0 в Git может временно сохраняться старый `development/`, но он не является вторым источником требований. Следующий шаг определяется исключительно здесь.

- [Полные шаги C12.0–C12.9](C12_ACCEPTANCE_DELIVERY.md).
- [Единственная матрица R01–R33, A01–A54, M01–M04](../../tests/ACCEPTANCE_MATRIX.md).
- [Карта переноса C12.0.1](https://github.com/apathoid/role-orchestrator/blob/d9645c569bbc48ccd9cd042d06b0ea7aa7174714/development/reports/C12/MIGRATION_REGISTER.md) — исходный immutable inventory (Git history), а не действующий план.
- [Предметная спецификация](../PRODUCT.md), [навигация возможностей](../CAPABILITIES.md), [архитектурные решения](../DECISIONS.md).

Ранее завершённые C00–C11R являются историей в Git; активные контракты находятся в предметных `docs/`, проверки — в `tests/`. Implementation и CI regression не эквивалентны native acceptance. Зелёный CI на предыдущем commit не доказывает текущий HEAD.
