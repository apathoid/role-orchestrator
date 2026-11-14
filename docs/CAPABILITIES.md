# Обзор реализованных возможностей и границ проверки

Эта страница — навигация, не новая нормативная спецификация и не оперативный статус.

| Возможность | Нормативный контракт | Подтверждение |
|---|---|---|
| Model-first решение/делегирование и единый coordinator | [PRODUCT](PRODUCT.md), [EXECUTION](EXECUTION.md) | Synthetic core/integration; live-model acceptance отдельно |
| Runtime authority, grants, permissions | [PROVIDERS_AND_CONFIGURATION](PROVIDERS_AND_CONFIGURATION.md) | Contract/CLI/ACP fixtures; native permissions pending |
| Durable operation/recovery/unknown effects | [CONTEXT_AND_RECOVERY](CONTEXT_AND_RECOVERY.md) | File-backed regression; live provider failure pending |
| CLI, Generic ACP, внешний ACP host и plugin API | [ARCHITECTURE](ARCHITECTURE.md), [CONTRACTS](CONTRACTS.md) | Process/SDK fixtures; real Zed pending |
| Adaptive reasoning Controller/Workers | [REASONING_EFFORT](REASONING_EFFORT.md) | A44–A54 automated; native effort pending |
| Diagnostics and bounded export | [DIAGNOSTICS](DIAGNOSTICS.md) | Synthetic failure/race tests; native traces pending |
| Installable npm/Nix package | [NIX_AND_CI](NIX_AND_CI.md) | CI on source-layout HEAD; migrated package must be reverified |

См. [архитектурные решения](DECISIONS.md), [текущий план и доступные проверки](https://github.com/apathoid/role-orchestrator/blob/greenfield/model-first-core/docs/roadmap/README.md). Нативные версии Zed/ACP/CLI, подтверждение поведения реальной модели и проверка NixOS не заявлены как PASS.
