# Разработка Role Orchestrator

Начало работы: [AGENTS.md](AGENTS.md) → [reasoning guidance](.agents/REASONING.md) → [текущий roadmap/STATUS](docs/roadmap/STATUS.md) → [план C12](docs/roadmap/IMPLEMENTATION_PLAN.md). Спецификация поведения принадлежит предметным `docs/`; единственная acceptance matrix — `tests/ACCEPTANCE_MATRIX.md`. Не выводить обязательный workflow из исторических планов C00–C11R.

Production — JavaScript ESM, Node 24, JSDoc и checkJs; TypeScript только в devDependencies. `npm ci` и `npm test` из корня станут обязательным путём с C12.0.5; до выполнения C12.0.5 действующий test harness ещё выполняется через `npm --prefix development`. Нельзя объявлять пустой acceptance/native suite пройденным. Основные регрессии — foundation, core, contracts, integration, package + clean installation и Nix checks.

При изменении публичного контракта обновить соответствующие docs, executable tests и единственную матрицу. При существенной продуктовой вехе — CHANGELOG; архитектурный выбор и отвергнутую альтернативу — DECISIONS/ADR; фактические проверки, commit/CI/evidence и следующий шаг — roadmap STATUS. Не создавать дубликаты или обязательные записи для чисто внутреннего рефакторинга. Записывать только проверяемые решения/обоснования, а не скрытые рассуждения.

Runtime не должен импортировать, читать или упаковывать `tests/`, `scripts/`, `.agents/`, devDependencies и исторический `development/`. Отсутствие этих каталогов в установленном npm/Nix package проверяется package/install smoke, не Host isolation. В исходном дереве все regression tests должны оставаться доступны.
