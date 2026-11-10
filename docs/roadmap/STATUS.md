# Role Orchestrator — оперативный статус

**Ветка:** `greenfield/model-first-core`. **Baseline перед C12:** `cbd8e70baca3ab380a2ed3d43ae1fdd667616412`.
**Последний полностью выполненный инженерный этап:** C12.9 (Linux Nix и NixOS module evaluation).
**Следующий шаг для закрытия C12:** получить реальные результаты C12.3/C12.4, выполнить native NixOS acceptance и повторить финальную регрессию. Это не запрос на повторную реализацию C12.0.

| Слой готовности | Фактическое состояние |
|---|---|
| Implementation | C00–C11R и инженерные C12.0–C12.2/C12.5–C12.9 реализованы. Нативные критерии C12.3/C12.4 **не выполнены** |
| Automated regression | **OBSERVED PASS 302/302** на `70ababf6d990ce359cce6909e0e0a8febba95d19`: [GitHub Actions run 42878217644](https://github.com/apathoid/role-orchestrator/actions/runs/42878217644), Linux x86_64 / Node v24.21.0 |
| Suite composition | foundation 4/4; core 25/25; contracts 52/52; integration 217/217; acceptance 4/4; root `npm test` тоже PASS |
| Package / clean install | **OBSERVED**: checkJs/spec/boundaries, root locked npm install, `npm pack`, extracted tarball CLI diagnose + fixture E2E, Nix flake/check/build, `nix run`, `nix profile add`, non-Git workspace, lock consistency |
| NixOS | **OBSERVED** `lib.nixosSystem` evaluation включает `environment.systemPackages` с продуктом. Реальный boot/запуск на NixOS **UNVERIFIED** |
| Native providers / Zed | **UNVERIFIED**: два независимых реальных LLM, Codex CLI/ACP успешный prompt, Zed как ACP-клиент, реальные permissions/cancel/resume и native reasoning |
| C12 в целом | **INCOMPLETE — NATIVE ACCEPTANCE PENDING**; production readiness **NO** |

## Реализованные изменения и происхождение

| Этап | Содержание | Commit |
|---|---|---|
| C12.0.1–.4 | Инвентаризация, предметные docs, roadmap/STATUS/matrix/CHANGELOG, инструкции `.agents/` | `d9645c5`, `87b79a1`, `1d9963d`, `ad9fdba` |
| C12.0.5–.8 | 54 test files + 20 fixtures + 7 scripts, root npm/checkJs/CI/Nix, npm/Nix whitelist, удалён `development/` (129 tracked files) | `afc1ebd`, `18dc1bc`, `e9e9b9b`, `1341d75` |
| C12.1 | R01–R33 ↔ A01–A54 ↔ тесты/ограниченные доказательства в [единственной матрице](../../tests/ACCEPTANCE_MATRIX.md) | `8c4a8e0` |
| C12.2 | Три acceptance smoke, обязательные в `npm test` и CI | `0dcfab4` |
| C12.3–.4 | [Протокол нативной приёмки](NATIVE_ACCEPTANCE.md), **без fake PASS**; исполнение требует настоящих агентов/Zed | `da8985d`, `b4936e8` |
| C12.5 | Git branch/index изменяется при активном worker без Host forced reconcile; модель завершает operation | `f44371a` |
| C12.6 | Продукт устанавливается из реального npm tarball в отдельный consumer, `diagnose` и fixture CLI run | `479f6ea` |
| C12.7 | [Архитектурный аудит путей](ARCHITECTURE_AUDIT.md): model-first, provider-agnostic, no source CAS/isolation/Git gate | `834d2db` |
| C12.8 | Дважды собран идентичный npm tarball, SHA-256 manifest, Nix path-info и загруженный CI artifact | `f51fb5e` |
| C12.9 | Настоящее вычисление NixOS `systemPackages`, Linux Nix build/install/CI | `70ababf` |

## Наблюдение CI/поставка

[GitHub Actions 42878217644](https://github.com/apathoid/role-orchestrator/actions/runs/42878217644), commit `70ababf`, concluded **SUCCESS**. В нём:
- `npm ci`, `npm run check`, 302 tests, `check:package`, `check:removal`, Nix/flake/install smoke/NixOS eval — все обязательные jobs/steps PASS;
- `scripts/prepare-release.mjs` дважды собрал идентичный `role-orchestrator-0.1.0-dev.0.tgz`, 74 файла, 166848 байт, SHA-256 `24677ca1cd64a27d761dea2078f4b1d8a93b5fc44d2d1179cee708b9c43e267d`;
- Github artifact [release-evidence-70ababf6…](https://github.com/apathoid/role-orchestrator/actions/runs/42878217644) (artifact id `13792853313`) содержит npm tarball, manifest, Nix metadata. Ничего не опубликовано в registry; package `private: true`.

CI использует synthetic/fake providers и настоящие subprocess/storage tests — результаты **не** доказывают использование реального LLM, Zed или ОС NixOS. Исторические native probes: Codex CLI → HTTP 401 без `turn.completed`; ACP 2.5.0 → initialize v1, `session/new` timeout. Эти результаты оставлены как failed/unknown evidence, не повышены до PASS.

## Открытые обязательства и приёмка

**C12.3:** два независимых настоящих provider/model sessions, transport/tool permissions, side-effects/unknown, cancel, recovery, model-selected effort. **C12.4:** реальный Zed ACP client, session/new/prompt/progress, permission deny/allow, disconnect/load/resume, real external state и per-attempt IDs. **NixOS native:** установка и запуск в действительном окружении, наблюдение native dependencies/linking/state, без требования Git. См. [детальный протокол](NATIVE_ACCEPTANCE.md) и [C12 acceptance criteria](C12_ACCEPTANCE_DELIVERY.md).

Следующее подтверждение должно включить конкретные versions, commit, комманды/exits, редактированные observations, результаты PASS/FAIL и отдельные оставшиеся UNVERIFIED в [матрице](../../tests/ACCEPTANCE_MATRIX.md). Нельзя закрывать C12 только благодаря 302 синтетическим/CI тестам. Документация, история и новые тесты уже находятся в постоянной структуре, поэтому возвращать `development/` не нужно.
