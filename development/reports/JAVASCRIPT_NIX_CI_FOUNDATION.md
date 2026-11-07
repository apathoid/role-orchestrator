# JavaScript, package и Nix/CI foundation

Дата: 2026-11-07. Это уточнение спецификации и настройка инфраструктуры, не реализация бизнес-функций.

## Решения

- Production JavaScript `.js`, ESM, Node 24. JSDoc/checkJs/strict/noEmit задают статическую проверку; TypeScript не становится языком приложения или runtime-зависимостью.
- Исходные dependency версии из пользовательского package.json сохранены: codex-acp 2.5.0 и ACP SDK 2.4.0. Добавлены только package metadata/engines/files и действительный npm lock.
- Nix flake предоставляет devShell/metadata checks. Настоящие packages/apps обязательны в C10.10, когда реализован CLI; заглушка приложения не создаётся.
- CI entrypoint постоянный, development harness удаляемый. Foundation PASS не означает business regression PASS.
- План расширен до 113 шагов в 13 кластерах, 31 требования и 43 acceptance сценариев.

## Локально выполнено

| Проверка | Наблюдение |
|---|---|
| npm view обеих указанных dependency versions | Версии доступны в registry |
| npm install --package-lock-only --ignore-scripts --no-audit --no-fund | exit 0; lockfile v3 с настоящими resolved/integrity |
| npm ci --ignore-scripts --no-audit --no-fund | exit 0 на Node 24.22.1 / npm 11.9.0 |
| check-specification.mjs | PASS: ссылки, нумерация, mapping требований, JSON examples, package/lock |
| npm pack --dry-run --ignore-scripts --json | PASS; development не включён; runtime bin пока отсутствует |
| Упаковка копии без development | PASS для текущего metadata/docs package; не runtime acceptance |
| Workflow structure/action SHA pins | PASS статически |

Lifecycle scripts dependencies не исполнялись; их native работоспособность этой установкой не подтверждена. Nix отсутствует в локальной среде; его выполнение проверяется GitHub Actions, не имитируется локальным скриптом. Business/native model/Zed tests не запускались.

## Проверено в GitHub Actions

[Первый foundation run](https://github.com/apathoid/role-orchestrator/actions/runs/42386793304), commit `d3f354f2b6cf91b8f3ad067988d0a0669a7a5bdc`: SUCCESS. Прошли specification check, npm package listing, установка Nix, разрешение pinned input, `nix flake check --no-update-lock-file --print-build-logs` и `nix develop --no-update-lock-file --command node --version`. Наблюдённая версия Node в devShell: 24.21.0.

Из этого успешного запуска получен настоящий flake.lock для revision `f9a75f41be3a74eab55d3a7679d34ad6cc0da977`, narHash `sha256-Wojg9lIH/hDH91iDVH2/EPw8oDSpxjxhXONbU1yf4Zg=`. После его фиксации workflow больше не создаёт/обновляет lock, а использует committed версию и проверяет отсутствие изменений. Полные raw CI logs не копируются в продуктовые docs.

## Граница последующей работы

C00 должен закончить JS checker/harness; C10.10 — реализовать устанавливаемые Nix packages/apps с настоящим npmDepsHash; C12.9 — проверить установку и запуск, NixOS, удаление development и CI соответствующей стадии. Product readiness остаётся NO.
