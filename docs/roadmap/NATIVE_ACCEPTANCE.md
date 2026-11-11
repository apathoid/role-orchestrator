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
