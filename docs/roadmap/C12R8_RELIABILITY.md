# C12R.8 — Надёжность координации, контекста и нативных инструментов

**Ветка:** `greenfield/model-first-core`. **Baseline анализа:** `150046ef7ab0b48f75b115636b7f506fce1ba8d9`. **Статус:** новый корректирующий инженерный план; исполнение ещё не начиналось. Фактические результаты, проверенный HEAD и следующий шаг — в [STATUS](STATUS.md).

**Цель:** устранить подтверждённые остаточные препятствия для самостоятельной работы Controller и Workers: точность references, сохранность и обнаружение results, ContextPort, ACP/MCP, evidence, skills и реальные инструменты исполнителя. Исправлять *технические причины*, а не навязывать моделям новый алгоритм принятия решений. C12R.0–.7 уже инженерно завершены; native acceptance C12.3/C12.4/C12R.7 и NixOS остаётся `UNVERIFIED`. Повторно открывать прежние исправления только по новым фактам.

**Обязательные источники перед началом:** [AGENTS.md](../../AGENTS.md), [.agents/REASONING.md](../../.agents/REASONING.md), применимые файлы [.agents/engineering](../../.agents/engineering/README.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md), [STATUS](STATUS.md), [C12R_STABILIZATION](C12R_STABILIZATION.md), [ARCHITECTURE](../ARCHITECTURE.md), [CONTRACTS](../CONTRACTS.md), [EXECUTION](../EXECUTION.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md), [единственная acceptance matrix](../../tests/ACCEPTANCE_MATRIX.md). Этот документ задаёт scope разработки, **не** runtime workflow.

## 1. Неизменяемые архитектурные условия

1. **Model-first:** Controller интерпретирует задачу, определяет сложность/стратегию, декомпозицию, необходимость и число Workers, выбор профилей/моделей/reasoning effort, методы исследования, оценку и сопоставление evidence, перепланирование и завершение. Прямой ответ одной моделью допустим. Не навязывать роли, фиксированный путь, новые Controller turns, обязательный retrieval/Findings/Reviewer или число reasoning steps.
2. **Host владеет только технической координацией:** Operation/Action/Attempt identity, проверка формы/ссылок/technical dependencies, trusted authority, permissions, bounded resources, dispatch, lifecycle, cancellation, durable state, recovery, provenance и доставка известных данных. Host не судит о содержательной правильности/достаточности и не выбирает стратегию модели по эвристикам.
3. **Реальный исполнитель владеет инструментами:** файловое исследование, edit, terminal, VCS, project scripts, provider-native tools/skills и обнаружение project instructions работают через фактически доступные механизмы выбранного провайдера и его permissions. ContextPort — история оркестрации, а не обязательный source/terminal runtime. Каталог Host не является исчерпывающим реестром возможностей native agent.
4. **Запрещено искусственное окружение:** sandbox, OS/FS/container isolation, виртуальный workspace/checkout, Host shell/filesystem/Git, обязательное сканирование дерева, Host-классификация имён scripts/команд/файлов, source freshness/Git gates/CAS/reconciliation. Mutable workspace — допустимое обычное состояние.
5. **Текст не расширяет authority:** user restrictions, explicit writeIntent, trusted grants/configuration и native permissions сохраняются; skill или проектный файл не создаёт прав. Название Reviewer/Coder не вводит скрытую policy или урезание toolkit.
6. **История и recovery:** unknown effects не повторять вслепую; действительная отмена и зависимости сохраняются; самостоятельная разрешённая работа других Actions не блокируется локальным отказом Controller. Не выдавать model claim за observed tool exit.
7. **Технический бюджет — не семантический verdict:** ограничение должно защищать конкретный ресурс, иметь scope и адресную причину. Использование метрик не должно автоматически перенаправлять стратегию/effort. Core provider-agnostic, wire-level детали в adapters.

## 2. Контракт данных, ссылок и контекстного окна

Технически разделять **Received** (что реально принял adapter), **Persisted** (какая часть записана durable), **Discoverable** (какая запись идентифицируема), **Retrievable** (какое содержимое действительно можно получить), **Delivered** (что фактически попало в Invocation) и **Interpreted** (использование/оценка моделью). Последнее Host не может вывести из успешной доставки.

Для результата различать полноту provider output → adapter capture → stored payload → retrieval → prompt. `Persisted` не означает «все исходные байты». Chunked fetch не восстанавливает байты, ранее отброшенные storage/adapter. Reference не доказывает наличия payload; Provider completion не подтверждает внутренние инструменты.

**Reference integrity и authority:** Host проверяет identity, существование/однозначность и разрешённую область видимости. Модель определяет достоверность, актуальность и достаточность evidence. При unavailable разрешённой истории — явная причина без фиктивного payload. Best-effort handoff не ослабляет проверку Decision, `denied`/permission или scope выбранных `Action.contextRefs`. Недоступность истории не блокирует native filesystem/terminal.

**Baseline SUPPORTED исходниками:** `context.maxBytes` по умолчанию 64 KiB ограничивает историю и используется в `captureArtifact`/`fetch`; `local-store.writeArtifact` может сохранять лишь префикс байтов. Этот лимит **не** гарантирует размер всего Invocation/контекстного окна модели. Не считать, что каждый Worker output проходит через artifact capture. Не объявлять статическое ограничение доказанной причиной native incident.

## 3. C12R.8.0 — Диагностика и минимальный engineering scope (P1, выполнить первым)

1. На актуальном HEAD изучить нормативные документы и фактические изменения C12R.4/.5/.6/.7; повторить только проверки оставшихся сомнений, не переписывать закрытые механизмы.
2. Исследовать доступные оригинальные trace/inspect/journal проблемных native runs, установленные версии провайдеров/клиентов и CI. Если исходных материалов нет — конкретное `UNVERIFIED`, а не выдуманная причина. Сам факт неиспользования результата Controller не доказывает failure: модель могла решить его не читать.
3. Для каждого проблемного Worker output проследить `Provider → Adapter → Observation/Outcome → Durable State → Controller Context → Optional ContextPort`: исходный payload/усечение, receipt, сохранённые байты/metadata, reference, history/directory/fetch, реально доставленный prompt, negotiated tools и решение модели. Отдельно рассмотреть `context.unavailable: MISSING`, невалидные Assessment references и большие outputs.
4. Проверить ACP/MCP configured → negotiated → published → successfully called, ограничения длины request/response, concurrency, общие лимиты bridge, native capabilities/tools, cancel/cleanup и сопоставимые environment permissions.
5. Проверить альтернативные объяснения там, где выбор решения меняется. Для каждой проблемы зафиксировать `OBSERVED` (воспроизведено), `SUPPORTED` (проверено в коде), `HYPOTHESIS`, `UNVERIFIED` или `RESOLVED`; указать owner/source of truth, нарушенный контракт и минимальную различающую регрессию.
6. Матрица результата: **Наблюдение → Гипотезы → Различающая проверка → Причина → Контракт → Минимальный фикс / no change required**. Обновить STATUS, определить необходимость C12R.8.1–.6. Не создавать новый runtime инструмент ради диагностики.

**Критерий:** подтверждён инженерный scope без предположения, что все направления требуют реализации. Отсутствие native среды не блокирует воспроизведённую независимо техническую ошибку.

## 4. C12R.8.1 — ContextRefs, identity и handoff (P1 при подтверждённом дефекте)

**Проверять:** `controller-context.js`, `handoff.js`, `context-access.js`, `context-bundle.js`, operation history, persistence/reference resolution.

- Однозначная связь с Operation/Action/Attempt и provenance; provider-local refs разных Attempts не смешиваются, исторические неоднозначные refs не разрешаются произвольно. Сначала учесть уже выполненный C12R.4.
- Для разрешённого, но недоступного payload передать известную точную причину; не подставлять вымышленное содержимое, не заявлять успешную доставку и не блокировать независимые native tools. Для denied/out-of-scope сохранить существующий отказ, не маскировать его `missing` или `budget`.
- Не вводить mandatory prefetch каждого ref, semantic review или новый глобальный resolver/источник истины.

**Адресные регрессии:** повторяющийся providerRef в разных Attempts, ambiguous/missing/payload/budget/retention, межоперационный share/denied, cancellation во время handoff, продолжение Worker без необязательной исторической записи.

**Выход:** корректная identity и permissions без ограничения реального workspace средствами ContextPort.

## 5. C12R.8.2 — Сохранение и доступность результатов Workers (P1 по диагностике)

**Проверять:** ACP/CLI adapters, Observation/Outcome, `local-store.js`, `context-access.js`, operation history и Controller context.

- Различить provider truncation, adapter output limit, storage prefix truncation, retention/отсутствие artifact, retrieval size limit и отсутствие/частичную доставку. Не обещать полный результат без полного хранения. Проверить per-attempt provenance, hash, completeness и restart/resume.
- Сначала использовать действующие Outcomes, Operation History и ContextPort directory. Если подтверждена недостаточность metadata, расширить существующее представление минимальными техническими полями identity/status/ref/completeness/availability/reason/retrieval; не создавать второй индекс, Host-summary/relevance score.
- Проверить, не создаёт ли совместное применение `context.maxBytes` к history/capture/fetch подтверждённую потерю значимой информации. Менять лимиты или retention только при доказанной необходимости и bounded consumption.
- Chunked retrieval рассматривать *лишь после* подтверждения, что нужные байты сохранены полностью и недоступны именно из-за retrieval. Не вводить universal retrieval service, vector storage или автоматическую смысловую компрессию.

**Адресные регрессии:** большие outputs разного происхождения, действительно усечённый/целый artifact, превышение fetch limit, retention, absent/corrupt bytes, restart/resume, known but unavailable result.

**Выход:** Controller может обнаружить разрешённый фактически доступный результат; полнота и причина отсутствия не преувеличиваются. Модель сама решает, нужен ли retrieval.

## 6. C12R.8.3 — MCP/ACP, технические бюджеты и native tools (P1 при дефекте)

**Проверять:** `src/adapters/mcp-bridge.js`, конкретные adapters, capability negotiation, permission broker.

- Baseline `maxToolCalls = 64` и `maxConcurrentCalls = 4` на bridge одного Invocation, `maxRequestBytes = 32 KiB`, `maxResponseBytes = 256 KiB`. Уникальные request ids хранятся в `calls` до закрытия bridge, history retrieval и registered external tools используют общий механизм. Установить реальное влияние на длительные задачи, смешанные tools и моментальную конкуренцию, не объявлять сами числа дефектом.
- Различать **исчерпание бюджета** и **временный concurrency peak**. Если доказано, допустимы явные доверенные/настраиваемые ресурсные контракты, адресные бюджеты и bounded backpressure; обязательно проверить timeout, memory/CPU, cancellation, cleanup, idempotency и отсутствие deadlock. Не создавать scheduler model actions и не удалять пределы вслепую.
- Разделять configured, negotiated, published и реально использованный инструмент. `supported` / `unsupported` / `unknown` не превращать в тотальный список native capabilities или глобальный запрет.
- Нативные tools остаются непосредственно доступными при фактической поддержке и разрешении. Если Generic ACP требует client filesystem/terminal, использовать только существующий разрешённый relay с negotiated capabilities; не реализовывать Host shell/filesystem.

**Адресные регрессии:** >64 уникальных вызовов в Invocation, сверхлимитная concurrency, смешанный context/external tool traffic, повтор одного request id, oversized request/response, cancellation ожидающих и активных вызовов, cleanup и нативная работа без bridge.

**Выход:** понятные, ресурсно обоснованные ограничения без подавления независимых разрешённых инструментов исполнителя.

## 7. C12R.8.4 — Evidence, Findings, Assessment (P1 при дефекте)

**Проверять:** `src/core/finding.js`, evidence identity/reference resolution, correction lifecycle.

- Host проверяет структуру, author, ссылочную identity/visibility/provenance. Model оценивает truth, freshness, evidentiary sufficiency, противоречия и необходимость дополнительной проверки.
- При invalid Assessment/Decision возвращать точную техническую причину и использовать действующий correction lifecycle без автоматической подстановки ссылок, ослабления admission, semantic review или повторного запуска завершённых Workers.
- Findings остаются необязательными согласно действующему контракту; Assessment не вводит обязательного отдельного invocation. Исторические observations остаются доступны при mutable workspace, модель решает об актуальности.

**Регрессии:** неверные/повторяющиеся refs, исправление Assessment без повторной работы, противоречащие findings, изменение файлов после evidence, прямой ответ без Findings.

**Выход:** адресная техническая целостность и model-owned семантическая оценка.

## 8. C12R.8.5 — Skills, project instructions, scripts и роли (P1 для границ)

**Проверять:** Skill Catalog/selected handoff, provider adapters, реальные native capability permissions.

- Сохранить C12R.6.0: явно выбранные catalog skills передаются с id/version/provenance/status `complete/truncated/unavailable`, материал включён в identity Invocation/retry. Не дублировать уже исправленную доставку без доказанного дефекта.
- Provider-native skills не требуют регистрации, Host discovery/семантического анализа или переноса в Catalog; локальные native ограничения subagents не автоматически запрещают отдельную оркестрацию.
- Модель сама обнаруживает применимые `AGENTS.md`, README, файлы подкаталогов и scripts через реальные инструменты. Такие файлы не создают trusted authority. `.role-orchestrator.json` обрабатывается Host **только** как предусмотренные machine-readable project preferences, не как повод сканировать остальные инструкции.
- Role — назначение и инструкции, а не новая permission/isolation policy. Сохранять explicit user restrictions, native permissions и writeIntent. Не классифицировать scripts/команды Host, не запускать тесты автоматически, не требовать Git/clean workspace.

**Регрессии:** unregistered native skill, вложенные инструкции, project script/VCS, selected skill version/status mismatch, skill с попыткой повысить authority, смена файлов при работе, работа без ContextPort, отсутствие role-based toolkit suppression.

**Выход:** реальный инструментарий не подменяется и не фильтруется Host.

## 9. C12R.8.6 — Prompt overhead, retrieval instructions, observability (P2)

- В `controller-context.js` и `mcp-bridge.js` сделать рекомендации `context_list/context_fetch` **условными**: использовать историю по решению модели, если это помогает задаче/устранению существенной неопределённости. Не требовать page-through всей истории при достаточном контексте. Сначала проверить измеримый эффект; предпочесть замену/сокращение текста, а не добавление новых указаний.
- Измерить отдельно user request, обязательные instructions, catalog, role/selected skills, history, metadata, отправленный adapter payload. UTF-8 bytes не равны токенам модели; `context.maxBytes` не гарантирует полный context window. Не вводить общего prompt compaction, Host-summary pipeline или semantic relevance heuristics.
- Добавлять только нужную диагностику: operation/action/attempt, result resolution, persistence, completeness, delivery, retrieval, known budget cause и фактические provider usage metrics при наличии. Diagnostics не второй источник истины и не двигатель Host strategy. Не сохранять приватный raw prompt/tool bodies по умолчанию.
- Дополнительные tool calls, elapsed time и число Workers — показатели наблюдения, а не автоматические Host gates (кроме явных действующих технических лимитов).

**Регрессии:** optional retrieval vs direct completion, технические пропуски/delivery markers, отключённый sink не меняет состояние операции.

**Выход:** снижение подтверждённого лишнего overhead без потери существенных сведений и самостоятельности модели.

## 10. C12R.8.7 — Проверки и фактическое завершение (обязательная приёмка изменённых механизмов)

**Automated:** регрессии каждого исправленного дефекта и смежных failure paths: reference ambiguity/permissions, context and artifacts, partial outputs, recovery/unknown effects, MCP tool budgets/concurrency/cancellation, skills identity, independent Workers, mutable workspace и direct single-model completion. Использовать текущие suites и единственную `tests/ACCEPTANCE_MATRIX.md`; не создавать fake PASS и не ослаблять admission.

**Native:** [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md) остаётся действующим протоколом C12.3/C12.4/C12R.7 и NixOS. Проверять соответствующие сценарии C12R.8 только при наличии у выбранного профиля реальных инструментов: direct/parallel delegation, discoverable Worker results, optional retrieval, replan, correction, restart/resume, native skills/files/scripts/VCS, большой результат, длительные MCP calls, отсутствие forced reconciliation. Нельзя требовать filesystem/terminal от провайдера, который их не предоставляет. Два профиля одного ACP adapter не являются двумя независимыми CLI/ACP путями.

**Измерение эффекта:** сопоставимые baseline/после задачи, workspace, versions/models/profiles, permissions, limits и user requirements. По возможности фиксировать requirement coverage, correctness evidence, доступность results, tool/reference failures, Controller/Worker/retrieval calls, wall-clock, slot wait, фактический prompt size, provider token usage и сохранённую работу при сбое. Не превращать число Workers или скорость в автоматическую оценку качества. Стохастичность нативных моделей учитывается; отдельная «prompt-optimized» группа нужна только если реально менялся prompt.

**Отдельные статусы:** `Implementation complete`, `Regression verified`, `Native integration verified`, `Performance/quality comparison verified`. Не проведённая проверка = `UNVERIFIED`. Целевой итог: подтверждённые технические дефекты устранены, нет новых mandatory workflows/Host semantics/native-tool suppression, недоказанные гипотезы явно открыты.

## 11. Инженерный порядок и handoff исполнителю

1. **Сначала C12R.8.0** на актуальном HEAD. Документировать компактную матрицу доказательств, технических владельцев, воспроизводимых причин и scope. Не начинать масштабный рефакторинг до понимания поведения.
2. C12R.8.1–.6 — **не последовательные обязательные стадии**. Агент самостоятельно выбирает минимальный целостный набор подтверждённых исправлений; «no fix needed» допустим. Связанные направления можно объединять по реальным зависимостям.
3. Каждое самостоятельное логическое изменение: минимальная регрессия → исправление → проверка смежных failure/lifecycle/authority paths → отдельный commit → необходимые нормативные docs/STATUS. Не делать пустых кодовых коммитов только ради номера этапа.
4. Выполнить доступные `npm ci`, `npm run check`, `npm test`, `npm run check:package`, `npm run check:removal`, применимые Nix flake/check/build/install/NixOS evaluation по существующему CI; результаты относить к точному commit. Не заявлять native PASS по синтетическим проверкам.
5. Обновлять только затронутые `docs/`, `docs/DECISIONS.md` при новом существенном архитектурном компромиссе, `CHANGELOG.md` при пользовательски наблюдаемом изменении, единственную матрицу и `docs/roadmap/STATUS.md`. Не восстанавливать `development/`, не создавать второй source of truth.
6. Не блокировать независимо доступные инженерные исправления ожиданием нативной среды, но сохранять открытыми C12.3/C12.4/native NixOS и фактические quality/comparison gaps.
7. Вне scope: новый planner/workflow engine, mandatory role graph/Reviewer, Host file/terminal/Git runtime или isolation, semantic filtering/scoring, обязательный discovery skills/scripts, vector retrieval, compaction/summarizer, source freshness, forced reconciliation и скрытый model/effort fallback.

**Первое действие агента:** C12R.8.0 с обновлением фактического STATUS и определением подтверждённого scope. Затем реализовать доступные необходимые исправления с регрессиями до инженерного завершения, без запроса нового «продолжай», но без выдачи UNVERIFIED за выполненную приёмку.
