# Разработка Role Orchestrator

Начало работы: [AGENTS.md](AGENTS.md) → [reasoning guidance](.agents/REASONING.md) → [текущий roadmap/STATUS](docs/roadmap/STATUS.md) → [план C12](docs/roadmap/IMPLEMENTATION_PLAN.md). Спецификация поведения принадлежит предметным `docs/`; единственная acceptance matrix — `tests/ACCEPTANCE_MATRIX.md`. Не выводить обязательный workflow из исторических планов C00–C11R.

Production — JavaScript ESM, Node 24, JSDoc и checkJs; TypeScript только в devDependencies. `npm ci`, `npm run check`, `npm test`, `npm run check:package` и `npm run check:removal` запускаются из корня и обязательны в CI. Отсутствующий тестовый suite приводит к ошибке, а не к пропуску. Нельзя объявлять пустой acceptance/native suite пройденным. Основные регрессии — foundation, core, contracts, integration, package + clean installation и Nix checks.

При изменении публичного контракта обновить соответствующие docs, executable tests и единственную матрицу. При существенной продуктовой вехе — CHANGELOG; архитектурный выбор и отвергнутую альтернативу — DECISIONS/ADR; фактические проверки, commit/CI/evidence и следующий шаг — roadmap STATUS. Не создавать дубликаты или обязательные записи для чисто внутреннего рефакторинга. Записывать только проверяемые решения/обоснования, а не скрытые рассуждения.

Runtime не должен импортировать, читать или упаковывать `tests/`, `scripts/`, `.agents/`, devDependencies и исторический `development/`. Отсутствие этих каталогов в установленном npm/Nix package проверяется package/install smoke, не Host isolation. В исходном дереве все regression tests должны оставаться доступны.
