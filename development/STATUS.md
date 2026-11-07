# Состояние реализации

| Показатель | Значение |
|---|---|
| Specification prepared | YES |
| Production implementation started | YES, диагностические порты |
| Последний локально проверенный шаг | C00.10, конфигурация CI |
| Следующий шаг | C01.1, идентичности и декодеры |
| Functional implementation complete | NO |
| Local regression verified | OBSERVED для C00 foundation |
| Native integration verified | UNVERIFIED |
| Production ready | NO |

## C00 — foundation

- C00.1, C00.8 — Node 24.22.1, npm, TypeScript 5.9.3 и типы Node 24.10.0. Корневые версии ACP и npm/Nix locks сохранены. TypeScript проверяет JS только в harness. Отрицательная fixture возвращает TS2322 для несовместимого `Clock`.
- C00.2–C00.5 — ESM entrypoint, независимый harness, проверка графа импортов и инъецируемые диагностические порты. Тесты проверяют корреляцию и изоляцию отказа sink от вызывающего кода. Пустые наборы тестов возвращают NOT IMPLEMENTED.
- C00.6–C00.7 — синтетические runs со временем, командами, кодами выхода и cleanup. Отдельная копия продукта прошла npm install из lock, упаковку и импорт из tarball без Git, development и TypeScript.
- C00.9 — OBSERVED в [baseline Linux CI](https://github.com/apathoid/role-orchestrator/actions/runs/42387065141) для `e33733a`: flake check, devShell Node и npm ci. Локальный Nix отсутствует.
- C00.10 — CI подключает проверки JS, boundaries, foundation, package и removal под Node 24 из flake. Продуктовые проверки выполняются независимо от harness. Результат нового GitHub Actions run фиксируется после его выполнения.

Локальные команды с exit 0: `npm ci --ignore-scripts --no-audit --no-fund`, `npm --prefix development ci --ignore-scripts --no-audit --no-fund`, `npm --prefix development run check`, `test:foundation`, `check:package`, `check:removal`. C00 проверяет только инфраструктурные части A01/A37/A41–A43. CLI, NixOS и реальные провайдеры UNVERIFIED.
