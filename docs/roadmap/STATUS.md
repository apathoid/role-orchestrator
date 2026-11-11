# Role Orchestrator — оперативный статус

**Ветка:** `greenfield/model-first-core`. **Baseline перед C12:** `cbd8e70baca3ab380a2ed3d43ae1fdd667616412`.
**Последний полностью выполненный инженерный этап:** C12R.8R (implementation complete / automated regression verified для подтверждённого technical scope).
**Следующий шаг:** **C12R.9.0** — baseline/воспроизведение потери видимости завершённых результатов Controller и проверка существующих ограничений/дублирования по [C12R.9](C12R9_CONTEXT_CONTINUITY.md). Реальная native acceptance C12.3/C12.4/C12R.7–.9, Zed/NixOS и сравнительная оценка остаются UNVERIFIED и выполняются при доступе к настоящим средам по [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md). Не вводить новый Host механизм только ради непроверенной гипотезы о качестве.

| Слой готовности | Фактическое состояние |
|---|---|
| Implementation | C00–C11R, C12.0–C12.2/C12.5–C12.9 и C12R.0–.8R завершены в доступном инженерном scope. Нативные C12.3/C12.4 **не выполнены** |
| Automated regression | **OBSERVED PASS 324/324** на `4c3f324e11b8d7ab851f893bafcbd492fd03f26d`: [GitHub Actions 43030150864](https://github.com/apathoid/role-orchestrator/actions/runs/43030150864), [43030159396](https://github.com/apathoid/role-orchestrator/actions/runs/43030159396), Linux x86_64 / Node 24. После закрывающего документационного commit его собственный CI проверяется отдельно |
| Suite composition | foundation 4/4; core 25/25; contracts 53/53; integration 238/238; acceptance 4/4; root `npm test` тоже PASS |
| Package / clean install | **OBSERVED**: checkJs/spec/boundaries, root locked npm install, `npm pack`, extracted tarball CLI diagnose + fixture E2E, Nix flake/check/build, `nix run`, `nix profile add`, non-Git workspace, lock consistency |
| NixOS | **OBSERVED** `lib.nixosSystem` evaluation включает `environment.systemPackages` с продуктом. Реальный boot/запуск на NixOS **UNVERIFIED** |
| Native providers / Zed | **UNVERIFIED**: два независимых реальных LLM, Codex CLI/ACP успешный prompt, Zed как ACP-клиент, реальные permissions/cancel/resume и native reasoning |
| C12 в целом | **INCOMPLETE — NATIVE ACCEPTANCE PENDING**; production readiness **NO** |

## C12R.9 — план готов к реализации (2026-11-11)

**Текущий статус: PLAN APPROVED / IMPLEMENTATION NOT STARTED / REGRESSION UNVERIFIED / NATIVE UNVERIFIED / COMPARATIVE UNVERIFIED.** Подготовлен [детальный план непрерывности контекста](C12R9_CONTEXT_CONTINUITY.md); активный [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) и [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md) связаны с ним. Планирование выполнено на baseline `b497b28c145fdbc3b17703e543fece6994ae82a6`; инженерный исполнитель обязан повторно проверить актуальный HEAD.

**Проблема и статус доказательств.** По представленному пользователем разбору нативных Codex-сессий Controller терял содержательные старые Worker reports при `context.maxBytes=65536` и отключённом MCP и мог повторять проверку. Оригинальные сессии не перепроверены в репозитории: native causality остаётся UNVERIFIED. По исходникам SUPPORTED: 64 КиБ default для optional history, ограничение 128 записей, recency-first selection, отдельный `host:invocation-context` с уже существующими `outcomes/pendingAttempts/actions`, общая настройка `context.maxBytes` для history/handoff/fetch/capture/skill/tool, новый native session/process per invocation в действующих ACP/CLI adapters. Возможное дублирование полных результатов из исходных trace требует минимального воспроизведения с доказанной identity.

**Принятое направление:** сначала C12R.9.0 диагностика/регрессии, C12R.9.1 устранение технических дубликатов, C12R.9.2 пересмотр независимых ресурсных границ; затем лишь при выявленном пробеле минимальная производная связь Action→Attempt→Outcome→Refs и согласование terminal/effect; ContextPort retrieval и native skills уточнять адресно. Отказ от заранее обязательных индексатора, Host summaries/compaction, semantic context fairness, MCP, нового Controller turn, native session persistence, project file discovery и Host filesystem runtime. Повторная модельная проверка может быть самостоятельным разумным выбором, поэтому её количество не является PASS/FAIL само по себе.

**Инженерный handoff:** следующий C12R.9.0 → самостоятельные commits с применимыми тестами, документацией и обновлением этого STATUS; runtime-код, product contracts и матрица в ходе подготовки плана **не изменялись**. Предыдущий verified CI **324/324** относится только к `4c3f324`; новый плановый документационный HEAD требует собственной проверки, native и quality comparison не заявлены.

## C12R.8R — исправления после ревью (2026-11-11)

**Scope/ownership — C12R.8R.0 (SUPPORTED):** baseline `be72f76c001cdf13617a706e068078c6d79c3d32`. Штатный `createExternalToolPort` ограничивает payload `min(context.maxBytes, 64 KiB)` и возвращает небольшую структурированную запись `ToolResult(status/effect/callId/ref)`. Следовательно, C12R.8 fixture с `{payload: 300 KiB}` **не** доказывал потерю provenance на штатном пути. Публичный `Invocation.externalTools` допускает другую реализацию `AttemptTools`; до исправления её крупный корректный `ToolResult` мог быть заменён общим `unavailable/budget` или HTTP 413 после выполнения. Владелец нарушения — **MCP adapter serialization**, не модель, core, tool permission policy или durable Store. Полученный `ToolReceipt` записывается в observation history и становится durable после успешного commit соответствующего события; срыв между effect и commit по-прежнему сохраняет unknown outcome, без blind replay.

| Этап | Подтверждённое поведение / исправление | Проверяемое основание |
|---|---|---|
| **C12R.8R.1** — MCP effect/provenance | Ответ после выполнения, не помещающийся в MCP budget, проектируется до `status/effect/callId/ref` с `outputUnavailableReason: budget` и `isError: true`. Фактический `ToolReceipt` не меняется. Для некорректного/неполного `ToolResult` переполнение сообщает консервативный `effect: unknown` (или корректное известное значение); метаданные не выдаются за успешную доставку output | `mcp-bridge-limits.test.js`: штатный read/write/unknown `ToolPort`, альтернативный oversized порт и exact-id duplicate/conflict |
| **C12R.8R.1** — весь HTTP response | Byte check включает **полный JSON-RPC envelope и request id**, не только MCP content. На точной границе, когда content помещается, но весь body нет, возвращается компактный effect-bearing MCP result вместо ложного HTTP 413 | Exact 256 KiB content boundary regression, original completed write effect остаётся `possible` |
| **C12R.8R.1** — durable provenance | Инъецированный valid `AttemptTools` с большим output передаёт receipt в тот же orchestrator journal; MCP отображение ограничено, но исходные `output/effect/callId` остаются после reopen `LocalStateStore`. Повтор MCP request id не приводит к новому выполнению | `mcp-bridge-limits.test.js` integration + проверка persisted receipt fields и count=1 |
| **C12R.8R.2** — общий бюджет | `context_list/context_fetch` и external tools используют прежние общие 64 calls/4 concurrent. Оба порядка 32+32, повтор/конфликт request id, адресный pre-dispatch budget; не возникают новые quota и обязательные retrieval stages. Нечисловые и non-finite numeric JSON-RPC ids отвергаются до dispatch (например `1e400` не сериализуется как `id:null`) | `mcp-bridge-limits.test.js` mixed, peak, invalid ID и oversized request/response |
| **C12R.8R.2** — cancellation/cleanup | Active write при cancellation возвращает `unknown`, поздний receipt сохраняет `unknown` effect, нет повторного исполнения. `bridge.close()` закрывает transport и очищает bounded dedup cache, не останавливая независимый bridge; самим tool-call lifecycle владеет `Invocation/ToolPort`. Cached promises после выполнения сохраняют только bounded model-visible reply | `mcp-bridge-limits.test.js` active cancel, late receipt, in-flight close, independent bridge; `external-tool-review.test.js` прежняя durable late recovery |
| **C12R.8R.3** — model-first retrieval | MCP `context_list/fetch` опубликованы, но direct Controller fixture завершает задачу без history calls. Существующие MCP CLI/ACP fixtures проверяют фактический fetch выбранной истории, `context-quality` и `c12r-coordination` — omitted/contradictory evidence, model-scripted replan и Assessment | `retrieval-guidance.test.js` + `mcp-context.test.js` + `c12r-coordination.test.js`. Это **не** evidence о качестве выбора настоящей LLM |

**C12R.8R.4 — Implementation complete / automated regression verified: YES для доступного технического scope.** Кодовые коммиты: `d86e642` (effect-bearing fallback), `017bcf0` (mixed budget, lifecycle, bounded dedup cache), `7c9e754` (durable receipt test), `e3c3138` (точное семантическое сравнение decoded receipt), `75c5d7f` (unknown fallback), `6dd052a` (direct optional retrieval), `31b4a06` (full envelope), `fe2a9bf` (validated request-id type), `4c3f324` (non-finite numeric IDs).

**OBSERVED:** [CI 43030150864](https://github.com/apathoid/role-orchestrator/actions/runs/43030150864) и [43030159396](https://github.com/apathoid/role-orchestrator/actions/runs/43030159396) на `4c3f324e11b8d7ab851f893bafcbd492fd03f26d` оба SUCCESS: Linux x86_64 / Node 24, `npm ci`, specification/checkJs/boundaries, foundation 4, core 25, contracts 53, integration 238, acceptance 4, root repeat `npm test` **324/324**, package/clean-install/removal checks, Nix flake/package/install и NixOS systemPackages evaluation, release tarball/checksum, lock-file check — всё PASS. Проверки через CI; локального npm/Nix execution и реального Zed в этой среде нет.

**Зафиксированные отклонения:** два CI на `7c9e754` были FAIL только из-за сравнения добавляемых snapshot decoder `undefined` optional properties (не потери receipt), исправлено тестом `e3c3138`; запуски `e3c3138` затем CANCELLED при обновлении ветки. Два CI на `31b4a06` были FAIL на checkJs TS2345 (narrowing `message.id` внутри callback); с `fe2a9bf` используется локальный проверенный `requestId`, повторный полный CI PASS. Никаких прежних FAIL не представлено как PASS.

**Сохранённые инварианты:** нет нового Host filesystem/terminal/Git/sandbox, scheduler, semantic filtering/relevance decision, automatic retrieval, compaction, обязательного Worker/Controller turn, подмены unknown effect или автоматического retry. Permissions/trusted authority/selected tools/role/model/effort/worker independence не ослаблялись. Лимиты остаются: 64 MCP unique calls и 4 active, request 32 KiB, response 256 KiB; отдельный ToolPort максимум 32 registered external calls, output до 64 KiB. В недоверенных сторонних реализациях `AttemptTools` возможны oversized values: adapter сохраняет проверяемый effect в bounded presentation, но это не гарантия полного сохранения любого исходного output.

**Native integration verified: UNVERIFIED. Performance/quality comparison verified: UNVERIFIED.** Нет реального Zed ACP, двух независимых authenticated native моделей, native skills/scripts, настоящей NixOS эксплуатации или сопоставимых измерений original/updated retrieval instructions. Нет оснований заявлять улучшение качества по сокращению prompt либо synthetic fixture. Сопоставимые пять сценариев и протокол результатов зафиксированы в [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md). C12.3/C12.4/A38/A54 остаются открытыми. Финальный документационный commit требует собственной CI проверки; фактический implementation HEAD выше.

## C12R.8 — C12R.8.0 диагностика, условные исправления и C12R.8.7

**Инженерное завершение (2026-11-11):** код подтверждённых изменений проверен на `8506ec0aeda9996d4fa8cfdca9042b131efe196f`. Следующий документационный commit не меняет runtime-контракты; его собственные результаты CI фиксируются отдельно. Original native run artifacts, полные prompt/transport traces, версии внешних исполнителей и доступ к настоящим Zed/ACP/двум независимым LLM отсутствовали: соответствующие гипотезы остаются **UNVERIFIED**, не считаются доказанными дефектами.

### Матрица первопричин C12R.8.0 и решения по C12R.8.1–.6

| Наблюдение / различающая проверка | Владелец, причина и нарушаемый контракт | Решение |
|---|---|---|
| **OBSERVED:** [43019760145](https://github.com/apathoid/role-orchestrator/actions/runs/43019760145) и [43019751964](https://github.com/apathoid/role-orchestrator/actions/runs/43019751964) на `6f6f6f3` FAIL только в `tests/acceptance/delivery.test.js:50`. Test ожидает `**Следующий шаг:**` / `**Следующий этап:**`, STATUS имел другое название. Контроль: [43021235707](https://github.com/apathoid/role-orchestrator/actions/runs/43021235707), [43021226135](https://github.com/apathoid/role-orchestrator/actions/runs/43021226135) PASS. | Handoff документации, а не провайдер или оркестрация. Нарушен проверяемый entry-point contract кодирующего агента. | **FIX** `f078dc6`: восстановить заголовок в STATUS, не ослаблять acceptance. |
| **C12R.8.1 SUPPORTED:** `context-access.js`, `controller-context.js`, `evidence-identity.js`; `context.test.js`, `evidence-addressing.test.js` покрывают per-Attempt refs, legacy ambiguity, payload/missing/retention, ограничения доступа. Дополнительной отличающей неудачи нет. | Identity/visibility владеют application/core + StateStore; модель владеет содержательной интерпретацией. C12R.4 уже устранил подтверждённый дефект. | **NO CHANGE REQUIRED**. Не вводить второй resolver или обязательный prefetch; native correlation **UNVERIFIED**. |
| **C12R.8.2 SUPPORTED:** `context.maxBytes` (default 64 KiB) применяется к history/capture/fetch, `local-store.writeArtifact` отмечает `size/originalSize/truncated`; ACP имеет отдельный накопительный output limit. `context-quality.test.js`, `local-store.test.js`, `mcp-context.test.js` и C12R.5 проверяют частичный payload/причины отсутствия. Ни исходного полного output, ни подтверждённого loss сверх заявленного контракта нет. | Adapter capture и durable artifact, ContextPort как история оркестрации; размер capture не равен всему prompt window. Возможные причины: provider output limit vs storage prefix vs retrieval. | **NO CHANGE REQUIRED без новых данных**. Не обещать полный output, не добавлять chunking/Host summaries, native loss/impact **UNVERIFIED**. |
| **C12R.8.3 OBSERVED:** `mcp-bridge.js` допускает 64 unique calls и 4 concurrent, ограничивает request/response; `mcp-bridge-limits.test.js` на реальном loopback MCP проверил 64/65, idempotent repeated ID, конфликт ID, временный concurrency peak и oversize. Проверка успешна; неисправности в native task из числа 64 не доказано. | MCP bridge технические ресурсы, отдельный permission-aware ToolPort; нет Host права выбирать инструмент или менять лимит ради предположительного выигрыша. | **REGRESSION ADDED** `2f0e40d`, runtime limits неизменны; native workload budget/performance **UNVERIFIED**. |
| **C12R.8.4 SUPPORTED:** `finding.js`, `evidence-identity.js` проверяют author, refs, uniqueness и Assessment field path. `assessment.test.js`, `evidence-addressing.test.js`, `c12r-coordination.test.js` покрывают correction, findings, противоречия, partial final; новых failed admissions не воспроизведено. | Host владеет ссылочной целостностью; модель — truth, sufficiency, freshness и replan. C12R.3/.4 уже обеспечили технический correction path. | **NO CHANGE REQUIRED**. Не вводить обязательный Reviewer/semantic verdict. |
| **C12R.8.5 SUPPORTED:** `handoff.js`, `skill-registry.js`, `invocation-prompt.js`, ACP/CLI fixtures подтверждают selected skill version/status/instructions и действующий toolkit по профилю; профильные native skills/scripts и проектные инструкции не требуют Host registry. | Catalog доставляет лишь явно выбранные сведения; реальный provider владеет native tools и project discovery; permissions сохраняются. C12R.6.0 уже реализован. | **NO CHANGE REQUIRED**. Натуральная skill/script/terminal доступность конкретных реальных ACP agents **UNVERIFIED**. |
| **C12R.8.6 SUPPORTED:** `controllerInstructions` безусловно советовал page-through истории, `retrievalDetail(true)` — вызов MCP. Это prompting policy, не runtime defect и не сигнал об утрате payload. После изменения `mcp-context.test.js` в [43021599182](https://github.com/apathoid/role-orchestrator/actions/runs/43021599182) и [43021607885](https://github.com/apathoid/role-orchestrator/actions/runs/43021607885) упал из-за exact-string asserts двух test-agent fixtures, а не из-за реального отказа MCP; поправленные fixtures и те же actual MCP/fetch/Assessment E2E [43021956082](https://github.com/apathoid/role-orchestrator/actions/runs/43021956082), [43021948165](https://github.com/apathoid/role-orchestrator/actions/runs/43021948165) PASS. | Владелец инструкций — application/adapter prompt presentation, использование retrieval решает модель. Технические возможности/authority не меняются. | **FIX** `319001c`, fixture correction `9bf4d04`, compact wording `8506ec0`. Новые `retrieval-guidance.test.js` и неизменённая фактическая MCP доставка. Суммарная длина двух заменённых ASCII-фраз 356 → 302 байта относительно исходного C12R.7. Это **не** токены и **не** доказательство native efficiency. |

### C12R.8.7 — проверка и передача

- **Implementation complete — YES, в подтверждённом доступном scope.** Коммиты: `f078dc6ce3afeca5affc4ea2d3f868dbae32f73b` (handoff), `319001c5788b9f2dc27d0a60a56e92b5f1e1173d` (model-owned optional retrieval), `9bf4d045db979ed18251f15596b7d4b42f3e0bd6` (ACP/CLI fixture contracts), `2f0e40d7a3ce23b01cb561f04f7f6712aa3f94fd` (MCP regression characterization), `8506ec0aeda9996d4fa8cfdca9042b131efe196f` (shorten prompt). No new Host project runtime, tool suppression, required workers/workflow, compaction, source freshness, forced reconciliation, modified permissions, blind replay or model-selection heuristic.
- **Regression verified — OBSERVED PASS 315/315 on `8506ec0`.** [GitHub Actions 43022735065](https://github.com/apathoid/role-orchestrator/actions/runs/43022735065) and [43022743035](https://github.com/apathoid/role-orchestrator/actions/runs/43022743035), complete SUCCESS; Linux x86_64, Node 24. Both ran locked `npm ci`, `npm run check` (specification/checkJs/boundaries), suites foundation 4, core 25, contracts 53, integration 229, acceptance 4, repeated root `npm test`, `check:package`, `check:removal`, Nix flake check/package, package install outside checkout, NixOS systemPackages evaluation, reproducible npm tarball, checksum/artifact and lock integrity. CI execution, **not** local npm/Nix execution; artifacts attached to the runs. Original 310 tests + 2 optional-guidance + 3 MCP-boundary tests = 315.
- **Native integration verified — UNVERIFIED.** Real Codex CLI, independent Generic ACP agent/model, external Zed client and permissions, native terminal/fs/scripts/skills, tool effects/cancel, real crash/resume and real NixOS execution not available. NixOS *evaluation* is not real boot. A38/A54 and native portions of C12.3/C12.4/C12R.7/.8 remain open.
- **Performance/quality comparison verified — UNVERIFIED.** No matched baseline/corrected real-model tasks, original traces, actual prompt tokens, useful Worker contributions, runtime overhead, token usage/cost or model outcomes. Two instruction literals shrinking by 54 bytes is not a measured quality improvement. Compare matched workspaces, provider versions, limits and permissions before claiming effect; use [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md).
- **Remaining limitations:** MCP 64 unique calls / 4 concurrent per bridge, 32 KiB request / 256 KiB response; `context.maxBytes` 64 KiB by default, prefix artifact capture; ACP own accumulated output cap. These technical limits are documented, with distinct failure/availability semantics, but their native suitability has not been established. Do not reinterpret `MISSING` or `PROTOCOL_ERROR` from redacted historical evidence as confirmed causes.
- **CI provenance of closing commit:** documentation-only conclusion after tested `8506ec0`; its own CI must be inspected separately. Follow-up is native acceptance, not automatic reopening of C12R.8.1–.5.

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
