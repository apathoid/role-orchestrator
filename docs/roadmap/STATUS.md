# Role Orchestrator — оперативный статус

**Ветка:** `greenfield/model-first-core`. **Baseline перед C12:** `cbd8e70baca3ab380a2ed3d43ae1fdd667616412`.
**Последний полностью выполненный инженерный этап:** C12R.7 (implementation complete / regression verified).
**Следующий шаг:** C12R.8.0 — диагностика по [плану C12R.8](C12R8_RELIABILITY.md). C12R.8.1–.6 условны, C12R.0–.7 остаются закрытыми без нового evidence. **Нативная приёмка C12.3/C12.4/C12R.7 и NixOS по [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md) остаётся обязательной и UNVERIFIED.**

| Слой готовности | Фактическое состояние |
|---|---|
| Implementation | C00–C11R, инженерные C12.0–C12.2/C12.5–C12.9 и C12R.0–.7 реализованы. Нативные критерии C12.3/C12.4 **не выполнены** |
| Automated regression | **OBSERVED PASS 310/310** на `4ecf0e50fa4d8ce70644d3c925190a8b0abff298`: [GitHub Actions run 42973275738](https://github.com/apathoid/role-orchestrator/actions/runs/42973275738), Linux x86_64 / Node v24.21.0 |
| Suite composition | foundation 4/4; core 25/25; contracts 53/53; integration 224/224; acceptance 4/4; root `npm test` тоже PASS |
| Package / clean install | **OBSERVED**: checkJs/spec/boundaries, root locked npm install, `npm pack`, extracted tarball CLI diagnose + fixture E2E, Nix flake/check/build, `nix run`, `nix profile add`, non-Git workspace, lock consistency |
| NixOS | **OBSERVED** `lib.nixosSystem` evaluation включает `environment.systemPackages` с продуктом. Реальный boot/запуск на NixOS **UNVERIFIED** |
| Native providers / Zed | **UNVERIFIED**: два независимых реальных LLM, Codex CLI/ACP успешный prompt, Zed как ACP-клиент, реальные permissions/cancel/resume и native reasoning |
| C12 в целом | **INCOMPLETE — NATIVE ACCEPTANCE PENDING**; production readiness **NO** |

## C12R.8.0 — первичная диагностика на HEAD 6f6f6f3 (2026-11-11)

**OBSERVED / CI blocker:** HEAD `6f6f6f39fc7b872c102120497645371cd0bca66d` имеет два failed CI запуска [43019760145](https://github.com/apathoid/role-orchestrator/actions/runs/43019760145) и [43019751964](https://github.com/apathoid/role-orchestrator/actions/runs/43019751964). В обоих failing step — Acceptance regression, `tests/acceptance/delivery.test.js:50`: handoff ожидает заголовок `**Следующий шаг:**` / `**Следующий этап:**`, а подготовленный STATUS содержал `**Следующий инженерный шаг (по новому запросу):**`. Это проверяемый конфликт документационного handoff, а не failure модели, MCP, context или provider. В этом изменении восстановлен допустимый заголовок без изменения теста.

**SUPPORTED / уже закрытые механизмы:** C12R.4 проверяет ambiguous refs и причины недоступности payload; C12R.5 разделяет ACP accumulated-output limit от protocol failures; C12R.6.0 обеспечивает selected skill delivery; C12R.1 сохраняет независимые Workers при Controller fault. Сохранение их статуса требует новой отличающей регрессии для открытия дефекта.

**SUPPORTED / C12R.8.6 prompt guidance:** исходные `controllerInstructions` и MCP `retrievalDetail(true)` предписывали искать историю даже если достаточно доставленного контекста. Это конкретный prompt-policy дефект: дополнительная загрузка не должна быть обязательным поведением. Корректировка делает retrieval опциональным решением модели, не меняет tool publication, authority, ContextPort или накопленные записи; добавлены регрессии на соответствующую границу. Prompt token savings / native quality effect пока UNVERIFIED. Изменение в отдельном implementation commit после `f078dc6`.

**OBSERVED / C12R.8.6 fixture correction:** CI на `319001c5788b9f2dc27d0a60a56e92b5f1e1173d`, runs [43021599182](https://github.com/apathoid/role-orchestrator/actions/runs/43021599182) и [43021607885](https://github.com/apathoid/role-orchestrator/actions/runs/43021607885), завершился FAIL в двух MCP-интеграциях: оба нативно исполняемых test-agent fixtures требовали прежнюю точную строку `Use MCP tools...`, после смены формулировки fixtures ошибочно завершали процесс и давали waiting/PROVIDER_DISCONNECTED. Их проверка обновлена на новую формулировку, при сохранении реальных MCP calls и итогового evidence assessment в существующих integration tests. Проверки исправленного HEAD ещё не выполнены.

**C12R.8.3 — адресные diagnostic regressions (без изменения runtime):** `tests/integration/mcp-bridge-limits.test.js` проверяет весь лимит 64 уникальных MCP calls, identity/idempotent re-request, 4 активных вызова и возобновляемость после concurrency peak, лимиты request/response. Проверяется фактическое поведение существующего bridge, а не утверждение об оптимальности лимитов для нативных задач. Новый CI ещё не завершён; dynamic budget tuning и нативные workload сравнения остаются UNVERIFIED.

**C12R.8.6 — bounded prompt overhead:** предыдущая корректировка optional retrieval была семантически верной, но увеличивала статический текст инструкций. Точечное сокращение сохраняет явный выбор модели, происхождение model summaries и сообщение о material unavailable evidence: фразы Controller/MCP уменьшены с **219/137** до **172/130** ASCII-байт относительно исходного C12R.7 (в сумме 356 → 302 байта). Это сравнение только двух отдельных литералов, не полного фактически отправленного prompt и не количества токенов; native runtime effect/performance UNVERIFIED. Regression assertions и fixtures уточнены без удаления фактической MCP доставки.

**Незакрытые диагностические гипотезы:** без исходных native traces нельзя приписать прежние MISSING / CAPABILITY_UNAVAILABLE / PROTOCOL_ERROR непосредственно лимитам bridge или утрате output. Bridge имеет ограниченное число calls/concurrency, artifact storage может хранить префикс; сами эти свойства ещё не доказывают неисправность. Исследование C12R.8.1–.6 продолжается; native подтверждение/замеры отсутствуют. Следующее действие — адресные source-level регрессии, а не подмена технических причин предположениями.

**CI этого коммита:** ещё не выполнен; прежние 310/310 относятся к `4ecf0e5`, а CI базового документационного HEAD красный. Implementation/regression C12R.8 пока не завершены.

## C12R.8 — диагностика и адресные инженерные исправления

- **IN PROGRESS.** C12R.8.0 начат на `6f6f6f3`, CI handoff fix `f078dc6ce3afeca5affc4ea2d3f868dbae32f73b` опубликован; C12R.8.1–.5 оцениваются условно, C12R.8.6 — адресное изменение рекомендации optional retrieval. C12R.8.7 (новые проверки этого HEAD) ещё не подтверждён.
- **Проверенный baseline для планирования:** `150046ef7ab0b48f75b115636b7f506fce1ba8d9`. `SUPPORTED` исходниками: MCP bridge имеет общий лимит 64 уникальных вызовов и concurrency 4; `context.maxBytes` применяется к истории, artifact capture/fetch, local store способен хранить усечённый префикс; Controller prompt рекомендует необязательный page-through history. **Это не подтверждённые первопричины прежних native failures.**
- **Handoff:** агент начинает с [C12R.8.0](C12R8_RELIABILITY.md), сопоставляет с уже реализованными C12R.4/.5/.6/.7, фиксирует evidence/owners/различающие проверки, затем реализует только подтверждённый минимальный scope, отдельными логическими коммитами с тестами и обновлением STATUS.
- **Происхождение проверок:** 310/310 — ранее выполненный CI на `4ecf0e5`, не новый прогон этого документационного HEAD. В рамках подготовки плана runtime/npm/Nix/native tests не запускались. C12.3/C12.4, live Zed/ACP, real NixOS и сравнительные performance/quality результаты по-прежнему `UNVERIFIED`.
- **Готовность:** отдельно фиксировать implementation, automated regression, native integration и performance comparison; не отмечать `PASS` без реального evidence.

## C12R — инженерная часть завершена, native acceptance pending

**Baseline:** `4ebaf262b98d541120745e04f697ebbb3404fc88`. Начало инженерной работы: `6ce64e994a189f0c9e1bc255a8e97184f75a90ca`. C12R.0 выполнен в доступной части; исходные материалы всех трёх native runs неполны. Проверенный implementation HEAD: `4ecf0e50fa4d8ce70644d3c925190a8b0abff298`. Источник задач — [C12R_STABILIZATION](C12R_STABILIZATION.md); текущие требования и единая матрица сохраняются.

| Шаг | Состояние |
|---|---|
| C12R.0 | COMPLETE in available scope — baseline 302/302, confirmed defects and native evidence gaps; regression tests now PASS |
| C12R.6.0 | Implemented — selected structured skill delivery, scope and identity; regression PASS |
| C12R.1 | Implemented — local Controller failure, eligible FIFO reservations, durable worker recovery; regression PASS |
| C12R.2 | Implemented — explicit Controller selection checked against both snapshot copies; regression PASS |
| C12R.3 | Implemented — durable contract correction, admission categories and trace; adapter classification checked in C12R.5; regression PASS |
| C12R.4 | Implemented — distinguish directory/fetch unavailability, verify ambiguity and artifact presence; regression PASS |
| C12R.5 | Implemented — observed ACP accumulated-output limit vs malformed terminal; cleanup evidence and retained-slot cause; regression PASS |
| C12R.6.1–6.4 | Implemented — combined model coordination regression, existing direct/replan/effort/partial paths retained; no additional prompt changes justified; regression PASS |
| C12R.7 | ENGINEERING COMPLETE — 310/310, package/Nix/NixOS evaluation PASS; native/comparative UNVERIFIED |

### C12R.0 — исходные доказательства и ограничения

- OBSERVED: из исходника `src/adapters/invocation-prompt.js` на рабочем HEAD выполнен изолированный JS-вызов `renderInvocationPrompt` с выбранным skill (complete, уникальный marker); marker отсутствует в итоговой JSON-строке. Это воспроизведение renderer, не native/CLI/ACP E2E.
- SUPPORTED: `drive()` переводит operation в technical waiting после неуспешного Controller outcome; `reserve()` и `dispatchWorker()` требуют active. Принимаемые additions с continue могут оставаться неотправленными. Проверить один слот, cancellation, зависимости и recovery в C12R.1.
- SUPPORTED: `snapshot.js` проверяет explicit Controller level только внутри selectable ветки; native mode при explicit выборе не отклоняется. Проверить согласованно повреждённые journal/materialized route в C12R.2.
- OBSERVED (доступный редактированный journal/inspect из обсуждения): одна operation, revision 8, finished, два terminal completed Controller attempts, профиль controller, codex-acp / gpt-6.1-sol, selectable medium/default, sent, effect unknown, adapter_confirmed; worker attempts нет. Экспорт не содержит model content, tool bodies и transient diagnostics. Нельзя установить причину выбора одиночной стратегии или доказать отсутствие нативного делегирования. Raw IDs/тексты не публикуются.
- UNVERIFIED: оригиналы остальных двух native runs, точный build commit/client/adapter versions и session IDs, CAPABILITY_UNAVAILABLE/PROTOCOL_ERROR/context.unavailable: MISSING correlation, причины и сравнительные показатели. Не приписывать ошибки effort или skill без доказательств.
- Baseline `6ce64e9` 302/302 подтверждён run 42970897216. Локальный Git checkout недоступен в рабочем окружении (DNS GitHub); source reads и публикация через GitHub API. Полная npm/Nix регрессия implementation HEAD подтверждена run 42973275738. Native environment отсутствует.

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

## C12R.7 — подтверждённый инженерный результат

- OBSERVED: [CI 42973275738](https://github.com/apathoid/role-orchestrator/actions/runs/42973275738), commit `4ecf0e50fa4d8ce70644d3c925190a8b0abff298`, Linux x86_64 / Node v24.21.0, SUCCESS. Root locked npm install, specification/checkJs/import boundaries, foundation/core/provider/integration/acceptance suites и повтор из root `npm test`: 310/310, 0 failed/skipped. Baseline: 302/302, добавлены 8 тестов (1 provider contract, 7 integration), расширены существующие assertions.
- OBSERVED: Nix flake/check/build, locked package, install and exercise outside checkout, package contents/public import, NixOS systemPackages evaluation, repeatable npm pack, lock consistency. Artifact [release-evidence-4ecf0e5…](https://github.com/apathoid/role-orchestrator/actions/runs/42973275738/artifacts/13834730963), npm tarball 74 files / 172623 bytes / SHA-256 `ca5d3f6239e2108565b7b643141dc467b7a1655c7fcd3b6af3d88c8839080577`. No registry publication or signed/native release claim.
- Addressed regressions: selected inline/loaded skill transport and identity, mixed recovery with preserved unsent/unknown/terminal/cancelled actions, slot fairness, explicit reasoning snapshot consistency, durable correction/category, context missing/ambiguous/payload reasons, ACP accumulated-output limit and retained/detached slot evidence. The new coordination fixture combines two worker levels, selected skill scope, failed admission, opposing findings, model-selected replan and partial Assessment. Earlier C12R failures were resolved; no change to checks/workflows to obtain PASS.
- Source review: no new runtime workflow/scheduler, strategy heuristics, automatic effort fallback, native Controller skill-discovery changes, isolation, context compaction, freshness gate or mandatory semantic verdict. Model decisions remain the source of Actions and Assessment. Existing technical reservation/admission and history contracts were extended; provider-specific ACP behavior remains in the adapter. Further Controller prompt optimization is not justified by current evidence; only C12R.6.0 scope/contract change was needed.
- Comparative: baseline A and corrected B engineering fixtures are verified. No separate C (additional Controller prompt optimization). Native comparative task replay, quality, wall-clock, token usage/cost, useful Worker contribution and actual sent prompt-size comparison are UNVERIFIED. The one available original operation cannot establish effect size or causal explanation. Record actual versions/config/commit and redacted per-attempt evidence on representative native runs; see NATIVE_ACCEPTANCE.
- Implementation complete / regression verified applies to the tested source tree. This closing documentation-only commit records the CI evidence; its own CI may run independently. Native C12/C12R, production readiness remain open.

### C12R implementation commits

| Step | Commit(s) |
|---|---|
| C12R.0 | `f502559` |
| C12R.6.0 | `2f733a7`, `d2409bd` |
| C12R.1 | `3cdf273` |
| C12R.2 | `8ada07e` |
| C12R.3 | `00eca45`, `8dd0d91` |
| C12R.4 | `6e26187` |
| C12R.5 | `bd18836` |
| C12R.1/.5 test corrections | `a2b882d` |
| C12R.6.1–6.4 | `4ecf0e5` |
| C12R.7 | Closing documentation commit |

## Наблюдение CI/поставка

- C12R.3 `00eca45`: [42972503575](https://github.com/apathoid/role-orchestrator/actions/runs/42972503575) FAIL at JS syntax; corrected in `8dd0d91`. Tests not reached.
- C12R.5 `bd18836`: [42972829866](https://github.com/apathoid/role-orchestrator/actions/runs/42972829866) checkJs/core/provider contracts PASS; integration 221/223. Corrective regression commit fixes invalid multi-revision seed CAS and teardown ordering.



- Baseline `6ce64e9`: [42970897216](https://github.com/apathoid/role-orchestrator/actions/runs/42970897216) SUCCESS.
- C12R.6.0 `2f733a7` / C12R.1 `3cdf273`: [42971840155](https://github.com/apathoid/role-orchestrator/actions/runs/42971840155) / [42972153922](https://github.com/apathoid/role-orchestrator/actions/runs/42972153922) FAIL at checkJs (TS2322, inferred skill material status widened to string). Corrected explicit `SkillInstructions[]` type; regression pending. Earlier runs did not reach tests.


[GitHub Actions 42878217644](https://github.com/apathoid/role-orchestrator/actions/runs/42878217644), commit `70ababf`, concluded **SUCCESS**. В нём:
- `npm ci`, `npm run check`, 302 tests, `check:package`, `check:removal`, Nix/flake/install smoke/NixOS eval — все обязательные jobs/steps PASS;
- `scripts/prepare-release.mjs` дважды собрал идентичный `role-orchestrator-0.1.0-dev.0.tgz`, 74 файла, 166848 байт, SHA-256 `24677ca1cd64a27d761dea2078f4b1d8a93b5fc44d2d1179cee708b9c43e267d`;
- Github artifact [release-evidence-70ababf6…](https://github.com/apathoid/role-orchestrator/actions/runs/42878217644) (artifact id `13792853313`) содержит npm tarball, manifest, Nix metadata. Ничего не опубликовано в registry; package `private: true`.

CI использует synthetic/fake providers и настоящие subprocess/storage tests — результаты **не** доказывают использование реального LLM, Zed или ОС NixOS. Исторические native probes: Codex CLI → HTTP 401 без `turn.completed`; ACP 2.5.0 → initialize v1, `session/new` timeout. Эти результаты оставлены как failed/unknown evidence, не повышены до PASS.

## Открытые обязательства и приёмка

**C12.3:** два независимых настоящих provider/model sessions, transport/tool permissions, side-effects/unknown, cancel, recovery, model-selected effort. **C12.4:** реальный Zed ACP client, session/new/prompt/progress, permission deny/allow, disconnect/load/resume, real external state и per-attempt IDs. **NixOS native:** установка и запуск в действительном окружении, наблюдение native dependencies/linking/state, без требования Git. См. [детальный протокол](NATIVE_ACCEPTANCE.md) и [C12 acceptance criteria](C12_ACCEPTANCE_DELIVERY.md).

Следующее native подтверждение должно включить конкретные versions, commit, команды/exits, редактированные observations, результаты PASS/FAIL и отдельные оставшиеся UNVERIFIED в [матрице](../../tests/ACCEPTANCE_MATRIX.md). Нельзя закрывать C12 только благодаря 310 синтетическим/CI тестам. Документация, история и новые тесты уже находятся в постоянной структуре, поэтому возвращать `development/` не нужно.
