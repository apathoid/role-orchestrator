# C12.3–C12.4: протокол нативной приёмки

**Статус:** реальные вызовы двух независимых LLM-исполнителей, внешнего ACP-клиента и Zed **UNVERIFIED**. Контрактные тесты, синтетические subprocess/SDK fixtures и успешный Nix package smoke не подменяют эти результаты. Настоящий вызов требует конфигурации/полномочий пользователя и доступной native среды; в этой GitHub-операции они не предоставлены. Не передавать токены в GitHub Actions или логи.

## C12.3 — реальный provider-agnostic прогон

Перед исполнением зафиксировать commit SHA, Node version/OS, `role-orchestrator` version, точные версии **двух независимых исполнителей** (один реальный CLI, другой настоящий ACP агент или другой подтверждённый независимый adapter), model ids, capabilities и schema/config version. Установленные через lock версии `@agentclientprotocol/sdk@2.4.0` и `@agentclientprotocol/codex-acp@2.5.0` — не доказательство успешно выбранной модели. При несовместимой native версии фиксировать actual vs expected; не подгонять результаты.

1. Использовать контролируемую временную директорию без `.git` и секретов, отдельный `XDG_CONFIG_HOME` и `XDG_STATE_HOME`. Доверенные permissions должны запрещать запись/доступ к реальным проектам. Задача: простое наблюдаемое сообщение без инструментов. Доказать direct answer через конкретную модель и трассу, а не только HTTP/exit.
2. Отдельно попросить Controller делегировать независимым CLI/ACP исполнителям две подзадачи; проверить последовательные или параллельные attempts, корректную атрибуцию findings, model selection, получение двух результатов и отсутствие host vote.
3. Проверить разрешённый tool, permission deny, отмену до/после dispatch, late terminal, потерю связи и resume. Зафиксировать `dispatchCertainty`, effects, cancellation provenance; unknown не должен автоматически повторяться.
4. Reasoning: native/omission без override, два разных worker levels одного профиля, повторное независимое действие Controller с выбором другого level, неподдерживаемый собственный level с видимым пользователю technical result. Для ACP записать реально предложенный session option и фактически подтверждённый выбор. `adapter_confirmed` не доказывает внутреннюю глубину reasoning. Проверить отсутствие ACK как unknown, не ложное unsupported.
5. Для каждого сценария записать request-id/operation-id/attempt-id, начало и конец, точную используемую команду с удалёнными secrets, результат exit/observations, stdout/stderr и trace только в безопасной отредактированной форме, решение PASS/FAIL/UNVERIFIED, область и ограничения. Чувствительные значения/полные prompts из приватного workspace в Git не публиковать.

## Результаты, известные до C12

| Evidence | OBSERVED / UNVERIFIED | Смысл |
|---|---|---|
| GitHub CI regression `1341d75` | OBSERVED [run 42874365595](https://github.com/apathoid/role-orchestrator/actions/runs/42874365595) | Automated fixture/process, npm/Nix; **не** реальный LLM |
| Codex CLI probe C07 | HTTP 401 OBSERVED, model answer UNVERIFIED | Auth error; `turn.completed` отсутствует |
| Codex ACP 2.5.0 probe C08 | initialize ACP v1 OBSERVED; session/new timeout | Успешный model prompt/tools/cancel/recovery UNVERIFIED |
| Реальные два независимых исполнителя | UNVERIFIED | Доступ к authenticated native sessions не подтверждён |
| Эффективный native reasoning level/usage | UNVERIFIED | Нет внешнего подтверждения и model output |

## C12.4 — настоящий Zed как внешний ACP-клиент

Внешняя ACP поверхность `role-orchestrator acp --config /путь/к/config.json` должна быть зарегистрирована в **реальном Zed** (не локальном SDK mock). Использовать настоящий пользовательский профиль/доступный agent provider и временную задачу без Git; не менять полномочия ради прохождения теста. Зафиксировать версию Zed, внешнего ACP SDK/Host, исполняемого агента, выбранной модели, Node, ОС, binary path, config schema и точный commit.

| Сценарий | Доказательство результата |
|---|---|
| Register → initialize → session/new | Сообщения реального клиента, IDs клиентской сессии/внутренней provider-сессии и связь с operation |
| Prompt/stream/progress/final | Фактический ответ модели, attributed event/attempt, не только exit process |
| Permission allow/deny | Native request identity, предъявленный ресурс/варианты, ответ пользователя и недопуск после deny |
| Cancel при активном prompt | Состояние provider cancel, отсутствие нового dispatch, позднее terminal без возрождения |
| Disconnect / restart / load / resume | Возобновление той же operation, сохранённый ledger/result, без дублирующего effect |
| Non-Git / изменившаяся рабочая директория | Отсутствие host Git gate, сохранение пользовательского cwd, изменение среды не требует forced reconcile |
| Reasoning Controller/worker | Если выбранные реальный agent/модель декларируют capability, подтвердить effective native selection и фактический model result; иначе UNVERIFIED с точной причиной |

Реальные trace/inspect/export следует сохранять с удалением secrets, путей пользователя и содержимого закрытых документов. Использовать различающиеся requestId, ACP client session ids, provider attempt/session ids; совпадение имён не является доказательством корректной корреляции. API/CLI/ACP fixture и successful initialize не заменяют эти проверки.

**Фактический результат C12.4 в данной сессии: UNVERIFIED.** В GitHub API/CI нет подключенного интерактивного Zed-клиента. Нельзя подтвердить его версию, доступный model account, permissions или успешный session/load. После появления реальной среды заполняется таблица с command, commit, versions, observations, exits и ссылкой на безопасное evidence; только тогда менять статус A38 и R19.

## Разграничение результата

Ни одна из этих незавершённых проверок не должна блокировать независимую C12.5–C12.9 инженерную работу, но финальный статус всего C12/production readiness остаётся **NATIVE ACCEPTANCE PENDING**. Источник требований: [матрица A18/A20/A38/A49/A50/A54](../../tests/ACCEPTANCE_MATRIX.md), [полный C12](C12_ACCEPTANCE_DELIVERY.md).

## C12R.7 — дополнительные native сценарии и сравнительная оценка

На implementation HEAD `4ecf0e50fa4d8ce70644d3c925190a8b0abff298` инженерная регрессия PASS ([CI 42973275738](https://github.com/apathoid/role-orchestrator/actions/runs/42973275738)); это не native результат. Сохранить открытыми C12.3/C12.4 и реальную NixOS установку. Ниже сценарии расширяют существующий протокол, не создают runtime workflow.

1. На сопоставимых безопасных задачах проверить direct, явно запрошенное распределение Sol/Astra, несколько независимых Workers, продолжение Controller без внешнего события и выбор собственных/Worker logical levels. Фиксировать реально выбранные model/effort и adapter ACK отдельно от утверждений о глубине reasoning. Два профиля одного Codex ACP не подтверждают независимые CLI/ACP пути.
2. Сопоставить локальный skill-запрет native subagents с задачей без запрета, сохраняя явные пользовательские constraints. Подтвердить выбранную версию и actually delivered skill в Worker; различать native auto-discovery Controller и оркестрированные Actions. Не считать прямой ответ без явного требования делегирования дефектом.
3. Проверить локальный отказ Controller при уже принятой работе, завершение допустимых Workers, reuse unsent reservation после restart и no blind replay dispatched unknown. Проверить native cancellation/late/cleanup с реальными per-attempt/session IDs; недоступные или опасные сбои оставлять в fault-injection tests отдельно от native PASS.
4. Проверить discover/fetch неполного context, атрибуцию raw tool exit, provider report и finding, противоречащие findings и replan. При partial output, длительном ACP вызове или PROTOCOL_ERROR зафиксировать действительный stop/limit/transport/session/process evidence; не приписывать причину deep effort без подтверждения. Обосновывать Assessment по пользовательским требованиям, а не наличием большого числа вызовов.

Сравнивать A — доступный исходный baseline, B — исправленная версия. Отдельное C не требуется: дополнительная оптимизация Controller prompt не выполнялась. Зафиксировать одинаковые задачи, workspace, permissions/limits, версии, model/profile, user constraints и фактические критерии. Записывать quality/requirement coverage, evidence correctness, полезный вклад Workers, replan, invocation counts, slot wait, wall-clock, подтверждённый usage/cost, доступность context, фактический prompt size без чувствительного текста, сохранённую полезную работу при отказе. Повторять существенные сравнения; неизвестные значения не оценивать как факт. Не требовать автоматический scoring, количественную норму или обязательный benchmark runtime.

**Текущий native/comparative status: UNVERIFIED.** Нет подключённой authenticated native среды, оригинальных полных traces трёх исходных runs, сопоставимых измерений A/B и подтверждённых версий Zed/client/agent. Доступный один redacted journal подтверждает лишь два завершённых Controller medium/default attempts без оркестрированных Workers. Для закрытия нужны фактические command/exit, build SHA, версии, correlation и безопасно отредактированные observations; результаты записывать в STATUS и единственной acceptance matrix.

## C12R.8 — дополнительные проверки при подтверждённых дефектах

[План C12R.8](C12R8_RELIABILITY.md) дополняет, **но не заменяет** обязательную нативную приёмку C12.3/C12.4/C12R.7 и реальной NixOS среды. После диагностики C12R.8.0 в сопоставимых доступных native runs проверить только соответствующие подтверждённые technical problems: фактический путь Worker output до Controller/retrieval, границы хранения/усечения, длительные и concurrent MCP calls, реальную доступность provider-native skills/tools/scripts и необязательность retrieval. Сохранять build SHA, версии, реальные capabilities, redacted per-attempt evidence и `PASS/FAIL/UNVERIFIED`. Отсутствие capability у провайдера не доказывает suppression Host; статический лимит сам по себе не доказывает причину наблюдавшегося native failure. Результаты фиксируются в действующих STATUS и [единственной матрице](../../tests/ACCEPTANCE_MATRIX.md), без нового native gate или альтернативного индекса.

## C12R.8R.3 — сопоставление retrieval-инструкций в настоящем native исполнении

**Текущий результат: UNVERIFIED.** Ни реального authenticated Codex CLI/Generic ACP/Zed, ни изолируемого измерения влияния текста инструкций в этой среде нет. `retrieval-guidance.test.js`, `mcp-context.test.js` и `c12r-coordination.test.js` подтверждают только возможности fixture/transport, а не решения LLM. Для native A/B использовать одинаковые задачи, model/profile, reasoning effort, версию агента/клиента, permissions, tool capabilities, limit settings, исходный workspace и user constraints. Исходная формулировка была в C12R.7 (commit `4ecf0e5`), optional wording — в C12R.8/C12R.8R. Если сравнивать исторические commits напрямую, другие различия кода являются **confounder**. Для чистого эффекта инструкций изменять только указанный текст в отдельном контролируемом инженерном build той же версии; **не** добавлять runtime Host prompt switch, workflow, ограничитель инструмента или новый retrieval gate.

| Сценарий | Наблюдаемый критерий и качество |
|---|---|
| Все нужные данные уже в prompt | Требования пользователя выполнены; учитывать дополнительные tool calls, но не считать любой fetch ошибкой без анализа необходимости |
| Существенный Worker output есть в history, но отсутствует в prompt | Увидела ли модель ссылку и получила ли недостающий материал через разрешённый context fetch; correctness/ref provenance Assessment |
| Два Workers дали противоречащие результаты | Модель сравнила evidence, сохранила неопределённость и выбрала проверку или partial Assessment; Host не проголосовал |
| Часть context усечена/недоступна | Правильно ли различены truncated/payload/budget/denied и выбрана дальнейшая проверка без выдуманного content |
| Большая история с одной существенной записью | Проверить discoverability/targeted retrieval, выполнение требований, число и стоимость вызовов; не требовать mandatory page-through |

Для каждого запуска записать build SHA, реальные model/provider/client versions, negotiated MCP/tools и permissions, action/attempt IDs, полученные refs, citations/Assessment по каждому требованию, причины unavailable, failures и unknown effects, фактические token usage/cost (либо `unknown`), bounded prompt size, tool calls, slot wait, wall-clock и доказанные user-visible outcomes. Сравнивать несколько сопоставимых повторов с фиксируемым seed, если провайдер его действительно поддерживает; случайность моделей не устраняется одним выполнением. Считать корректность и requirement coverage первичными относительно числа вызовов или байтов. Результаты `PASS/FAIL/UNVERIFIED` с provenance переносить в единые [STATUS](STATUS.md) и [ACCEPTANCE_MATRIX](../../tests/ACCEPTANCE_MATRIX.md). Ни уменьшение двух исходных литералов на 54 байта, ни fixture PASS не подтверждают улучшение качества/эффективности настоящего оркестратора.

## C12R.9 — сравнительная native-проверка исправленного контекста (план, не результат)

**Статус: UNVERIFIED.** Проверки дополняют C12.3/C12.4 и существующие C12R.7–.8R, не являются runtime workflow. [Обязательный инженерный контракт C12R.9](C12R9_CONTEXT_CONTINUITY.md). Исходное сообщение пользователя о native Codex JSONL/trace служит основанием для теста; его первопричина не перепроверена непосредственно в этом репозитории. Не коммитить закрытые исходники, промпты, токены и сырые трассы.

**Сценарии, которые нужно выполнить при реальной доступности провайдера:**

1. Реальная задача с несколькими независимыми различающимися результатами, суммарно >64 КиБ, >128 событий, несколько последующих вызовов Controller; отдельная длинная история с result >256 КиБ и выключенным MCP. Зафиксировать, известны ли Controller предыдущие поручения и доступен ли их materialized content.
2. Простой прямой Controller response без Worker, MCP и обязательного history request; дополнительные fetch/Controller turns не требуются.
3. Native MCP включён: модель по собственному выбору вызывает `context_list/context_fetch`. MCP выключен или не согласован: модель при недостатке inline history использует **необязательный** `nextController.contextRequest` для конкретного ref либо страницы по cursor, а следующий обычный invocation получает result без повторного Worker. В обоих случаях проверить denied/missing/payload/truncated/budget и фактическую полноту capture.
4. Отдельно проверить естественное использование provider-native project files/skills/scripts, `completed + effect: unknown`, active cancel/late/restart и отсутствие Host workflow/role-based toolkit suppression.

**Сравнительные группы (не смешивать причины):** A — исходный runtime при 64 КиБ, B — тот же исходный код с 256 и 512 КиБ `context.maxBytes` (в исходном коде этот параметр влияет на множество технических ресурсов; явно отметить confounder), C — исправленный C12R.9 runtime с независимыми бюджетами и компактной производной картой. Для каждой группы одинаковые задачи, baseline workspace, model/profile/effort, permissions, version/transport, native capabilities и границы прочих ресурсов, насколько возможно. Фиксировать фактические отклонения.

**Измерить:** operation/decision/action/attempt refs, количество завершённых поручений и доступных результатов, реальное содержание доставленной history, технический индекс total/represented/omitted, outcome/observation provenance, полноту stored/captured/inline/fetched, byte size отдельно для optional context, техники и Adapter payload, native token usage/cost (если сообщил провайдер), Controller turns, fetch/tool calls, задержку, correctness/requirement coverage, необходимость или ненужность повторного исполнения. Число Workers или уменьшение prompt не является самостоятельной мерой качества. При случайном поведении модели сопоставить несколько запусков, не выдумывать deterministic guarantee.

**Приёмка:** доказать техническую непрерывность ранее выполненной работы, возможность получить сохранённый результат по model-selected ref без обязательного MCP, сохранение прямого ответа без fetch, реальных permissions и uncertainty. Разделить Implementation complete, Regression verified, Native integration verified и Performance/quality comparison verified. Если реальных authenticated Codex/Zed/NixOS нет — отметить **UNVERIFIED** в [STATUS](STATUS.md) и единственной [ACCEPTANCE_MATRIX](../../tests/ACCEPTANCE_MATRIX.md), а не заменять их synthetic PASS.

### C12R.9 review — обязательное сравнительное подтверждение

Сопоставить на одной и той же задаче и versions provider/model/adapter: (a) исходный baseline `1633a30`, (b) вариант с увеличенным Controller budget 512 КиБ без review-fixes, (c) исправленный HEAD при default Controller **256 КиБ**, (d) исправленный HEAD с 512 КиБ как измерительный режим. Отдельно для (c)/(d) проверить `fetchMaxBytes` 64/128 КиБ без изменения capture budget, MCP on/off, длинный report >120 КиБ **полностью сохранённый** и технически усечённый. Измерить input/output token usage если фактически сообщил provider, число реальных model-selected fetch/nextController calls, качество references/assessment, unknown effects/cancel/recovery и повторное поручение работы. Приложить полный идентификатор версии, turn logs, Exit/ACK и результаты. Пока authenticated providers/Zed отсутствуют — все native результаты **UNVERIFIED**, synthetic CLI/ACP protocol fixtures не заменяют их.

## C12R.10 — отдельная локальная comparative acceptance Controller contract

**Статус:** UNVERIFIED; инженерная реализация ещё не начата. Детальный протокол — [C12R.10, §10](C12R10_CONTROLLER_CONTRACT.md). C12R.10.0–.6 выполняются и проверяются существующими synthetic fixtures/CI без реальных моделей. Никаких LLM credentials, OpenCode/llama.cpp/Zed или benchmark jobs в GitHub Actions; отсутствие нативной среды не блокирует инженерную delivery. После завершения разработки пользователь/инженер отдельно повторяет реальные эксперименты в доступном локальном окружении.

Сравнить direct OpenCode CLI, optional direct ACP, Role Orchestrator before/after C12R.10. При фактическом запуске фиксировать build SHA, adapter/agent/provider/model versions, sampling/reasoning, context settings, исходный запрос, применимые native instructions/permissions и состояние тестовой среды. Это metadata эксперимента, не новые настройки/ограничения runtime. Основное сравнение before/after проводится при одинаковых существенных условиях; CLI/ACP могут отличаться. Не смешивать изменение Decision prompt с изменением context budgets. Не заменяет отдельную C12R.9 матрицу.

Оценивать first Decision acceptance и ошибки транспорта, но также end-to-end correctness, scope, достоверность, полезность делегирования, wall-clock, native tool calls, invocations, unexpected effects и фактический usage при наличии. Включить прямой ответ, native skill, сложную координацию и model-selected history. Не требовать конкретную стратегию. Нативные результаты фиксировать с provenance, redaction и ограничениями; неизвестное оставлять UNVERIFIED. C12.3/C12.4/Zed/NixOS и C12R.9 comparative obligations не закрываются одним C12R.10 экспериментом.
