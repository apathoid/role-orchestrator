# JavaScript, Nix и CI

**Текущее состояние: C12.0.6 — обязательные проверки запускаются из корня; npm/Nix lock, JS checker и CI перенесены. Итог новой CI регрессии подтверждается отдельно по SHA в roadmap STATUS. Native acceptance не подтверждена.**

## Язык и manifest

Production-код пишется на JavaScript `.js` с ESM (`type: module`), Node.js 24. Для типов портов использовать JSDoc `@typedef`, `@template`, `import(...)` и `checkJs`, `strict`, `noEmit`. TypeScript compiler здесь — только инструмент статической проверки; runtime не требует TypeScript/tsx или генерации `dist/`. Внешние JSON/протоколы по-прежнему требуют runtime validation: JSDoc не валидирует поступившие данные.

В `package.json` сохранены версии, предоставленные пользователем: `@agentclientprotocol/codex-acp` 2.5.0 и `@agentclientprotocol/sdk` 2.4.0. Их наличие не делает Codex обязательным исполнителем или допустимой зависимостью core. Конкретные imports и нативные особенности остаются в adapters. `package-lock.json` фиксирует действительное дерево npm dependencies.

Стартовый manifest содержит ESM, Node engines, metadata и allowlist поставляемых файлов. `private: true` защищает от случайной npm-публикации на стадии разработки; это не запрет локальной/Nix-установки. Manifest экспортирует реализованные контракты JavaScript через `src/main/index.js`. Исполняемый entrypoint `role-orchestrator` указан в `bin`. Для импорта и исполнения JavaScript не нужна компиляция.

## Flake и устанавливаемый продукт

В корне находятся `flake.nix` и `flake.lock`, полученный настоящим Nix на CI-раннере. Nixpkgs input указывает точную upstream revision; lock хранит результат её разрешения с настоящим narHash. Lock-файлы не составляются из придуманных hashes. При изменении dependency обновить lock явно и проверить воспроизводимость.

Flake предоставляет Node 24 devShell, package, apps, проверку metadata и CLI smoke. Объявлены x86_64/aarch64 Linux и Darwin; наличие output не является заявлением о native проверке каждой платформы. CI первоначально выполняет Linux-проверку.

Команды для стартовой инфраструктуры после установки Nix с включёнными `nix-command` и `flakes`:

```sh
nix develop
nix flake check --no-update-lock-file
```

Обычный CI использует committed lock без обновления. Для осознанного обновления Nixpkgs изменить pinned input, разрешить его настоящим Nix, сохранить новый flake.lock и выполнить проверки. CI сам не обновляет зависимости.

Flake публикует следующие outputs.

| Output | Назначение |
|---|---|
| `packages.<system>.role-orchestrator` | Воспроизводимый устанавливаемый продукт |
| `packages.<system>.default` | Тот же derivation |
| `apps.<system>.role-orchestrator` и `.default` | Настоящий CLI из package, не wrapper-заглушка |
| `devShells.<system>.default` | Инструменты разработки |
| `checks.<system>` | Metadata и package/CLI smoke; корневые regression suites и CI checks обновляются в C12.0 |

Пакет собирается через `buildNpmPackage` с Node 24, реальным `package-lock.json` и вычисленным `npmDepsHash`. Для прямого JS использовать `dontNpmBuild = true`, если настоящая сборка ресурсов не требуется. Manifest указывает `bin`, derivation задаёт `meta.mainProgram`. CLI smoke проверяет запуск wrapper.

Source closure продукта MUST исключать тесты, инженерные scripts, coding instructions, node_modules рабочего checkout, runs и CI evidence (в исходном дереве они находятся в tests/scripts/.agents). Runtime dependencies не заимствуются из development harness. Проверить platform-specific transitive binaries, install scripts и dynamic linking на NixOS. Если конкретный провайдер требует отдельного бинарника, оформлять это через adapter/явную конфигурацию; не скачивать его скрыто при запуске и не требовать Codex для обычного core.

State, логи, secrets и конфигурация пользователя MUST располагаться вне read-only Nix store. Рабочий каталог остаётся выбранным пользователем, не каталогом установки. Wrapper не сбрасывает cwd и не уничтожает доступ к инструментам окружения. Никакого требования `.git` в каталоге пользователя.

## Установка

Из checkout выполните следующие команды.

```sh
nix build .#role-orchestrator
nix run .#role-orchestrator -- --help
nix profile add .#role-orchestrator
```

Для NixOS добавить flake проекта во входы системной конфигурации и включить `inputs.role-orchestrator.packages.${pkgs.stdenv.hostPlatform.system}.role-orchestrator` в `environment.systemPackages`. Для Home Manager тот же package добавляется в `home.packages`. Отдельный NixOS service/module не требуется: продукт запускается пользовательским процессом. Для приватного репозитория доступ настраивает пользователь обычными средствами Nix; токены не фиксируются в flake/lock/log.

Nix-сборка и immutable store не меняют архитектурный запрет Host isolation. Orchestrator не создаёт Nix окружение для каждой задачи и не запускает модели через `nix develop` автоматически. Пользователь может запускать установленный продукт в выбранном окружении. Git transport для получения flake не является runtime-зависимостью ядра от VCS пользовательского проекта.

## GitHub CI

Постоянный entrypoint — `.github/workflows/ci.yml`; permissions `contents: read`, Actions закреплены полными commit SHA. Проверки CI запускаются из корня без conditional skip: обязательные `npm ci`, `npm run check` (спецификация/ссылки, checkJs и границы импортов), foundation/core/contracts/integration, `npm test`, package/clean install, `nix flake check`, Nix install вне checkout и lock verification. При отсутствии обязательного test suite checker/runner завершает шаг ошибкой. Acceptance/native suite без реализованных тестов не объявляется PASS и остаётся отдельным обязательством. Последний фактически подтверждённый run и границы применимости — в roadmap STATUS.

Native model/Zed tests отдельно opt-in с явным доступом и бюджетом; отсутствие credentials не должно выдавать PASS и не должно раскрывать secrets в PR из внешнего источника. CI не делает auto-merge, auto-publish или изменения пользовательского проекта.

## Первичные справочники

- [TypeScript checkJs](https://www.typescriptlang.org/tsconfig/checkJs.html) и [JSDoc reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html).
- [Nix flakes](https://nix.dev/concepts/flakes) и [nix profile add](https://nix.dev/manual/nix/2.30/command-ref/new-cli/nix3-profile-add.html).
- [Nixpkgs buildNpmPackage](https://github.com/NixOS/nixpkgs/blob/master/doc/languages-frameworks/javascript.section.md).

Точные SDK/API детали проверяются при реализации адаптера; наличие стартового npm dependency не подтверждает работоспособность провайдера.
