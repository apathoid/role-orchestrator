# C12.3–C12.4: протокол нативной приёмки

## C17.4 — Controller context and decision reliability (NATIVE UNVERIFIED)

No authenticated real-model provider, user config/workspace, installed native agent or Zed GUI was available to the implementation agent. Node 24/Nix/actual PTY and SDK fixtures in Actions are engineering evidence only. The following procedure is for the operator, not a product runtime workflow; no private prompts, config or credentials go to Git or CI.

### Isolate builds and control conditions

Use a trusted local checkout and an authorized disposable, non-secret workspace (native Git/non-Git scenarios separately). RO does not sandbox tools. Keep the normal native permission/skill discovery configuration; do not grant additional authority for a test. Use absolute paths for provider/plugin/skill settings if configuration is relocated. Record exact model build/quantization, context window, sampling, effort, agent/transport/client and binary versions, OS, Node/Nix, timeout/other budgets, initial files/skill hashes, and whether the native session/server was cold or warm.

```bash
umask 077
OUT=$(mktemp -d "${TMPDIR:-/tmp}/ro-c17.XXXXXXXX")
B=d80638609d86da92e2a88d939fa09a90a1a3cfbf
C=bfd2532b7c840420dac7878f7bc66cd76eefa848
D=$(git rev-parse feature/controller-reliability)
printf 'B=%s\nC=%s\nD=%s\n' "$B" "$C" "$D" > "$OUT/builds.txt"
for variant in B C D; do
  case "$variant" in B) sha=$B;; C) sha=$C;; D) sha=$D;; esac
  git worktree add --detach "$OUT/src-$variant" "$sha" || break
  (cd "$OUT/src-$variant" &&
    nix build --no-update-lock-file --out-link "$OUT/ro-$variant" .#role-orchestrator) || break
done
node --version
nix --version
opencode --version
opencode run --help
```

A = direct native agent; B = approved baseline; C = only presentation changes; D = presentation, recovery, telemetry and independent UX corrections. B/C have no new text-prompt reporter; record their unavailable measures as unknown. D's telemetry is passive but has measurable cost; body capture is disabled in all main runs. Compare separately with D's capture explicitly enabled only for a safe diagnostic run. No provider-context compaction can be inferred from RO bytes. Use the actual provider's exposed metrics only.

### Main comparable run (at least 3 independent runs per accessible variant)

Set `BASE_CONFIG` to the absolute path of an existing trusted RO config, `WORKSPACE` to the absolute test directory, and `MODEL` to the matching actual native OpenCode model selector; confirm installed native CLI syntax first. Restore the same fixture contents between runs. Keep default presentation and credentials unchanged except separate state directory, explicit 65536 Controller history budget, capture off.

```bash
TASK='Ответь двумя строками: первая — число 42, вторая — слово Привет. Без других строк.'
for n in 1 2 3; do
  for variant in A B C D; do
    RUN="$OUT/$variant-$n"; mkdir -p "$RUN"
    if [ "$variant" = A ]; then
      (cd "$WORKSPACE" && /usr/bin/time -o "$RUN/time.txt" -f '%e %x' \
        opencode run --model "$MODEL" "$TASK" > "$RUN/result.txt" 2> "$RUN/stderr")
      printf '%s\n' "$?" > "$RUN/exit"
      continue
    fi
    jq --arg state "$RUN/state" \
      'del(.context.maxBytes) | .context.controllerMaxBytes=65536 |
       .storage.directory=$state | .diagnostics.captureBodies=false' \
      "$BASE_CONFIG" > "$RUN/config.json"
    RO="$OUT/ro-$variant/bin/role-orchestrator"
    (cd "$WORKSPACE" && /usr/bin/time -o "$RUN/time.txt" -f '%e %x' \
      "$RO" run "$TASK" --config "$RUN/config.json" --format json > "$RUN/result.json" 2> "$RUN/stderr")
    printf '%s\n' "$?" > "$RUN/exit"
    op=$(jq -r '.operationId // empty' "$RUN/result.json")
    if [ -n "$op" ]; then
      "$RO" trace "$op" --config "$RUN/config.json" --format json > "$RUN/trace.json"
      "$RO" export-diagnostics "$op" --config "$RUN/config.json" --output "$RUN/export.json"
    fi
  done
done
```

Do not silently discard a failure, cancellation or an empty result. Inspect local rotated diagnostics in each state directory and correlate operationId/attemptId (and actual native session/thread id where present). Use `context.host_prepared`, `adapter.prompt.prepared`, `adapter.prompt.send_attempted` / launch or observed native turn, `adapter.prompt.reply`, `provider.reply_observed`, `controller.invalid_proposal` and journal terminal events. Record missing/rotated/drop markers; redact exports before sharing. In the separate capture test, enable existing `diagnostics.captureBodies=true` with a non-sensitive fixture; collect only the bounded redacted representation from the sink, not as model history or client events.

### Autonomy and quality checks (repeat with authenticated independent alternatives when available)

Use the main fixed rubric: compare the actual two lines, valid Decision acceptance (RO only), first-attempt acceptance, accepted/rejected counts and stage, invocation count, elapsed/stop/exit, prompt bytes, reported usage, native tool events and meaningful task content. For each scenario below record the exact input, expected observable, actual result, evidence, PASS/FAIL/UNVERIFIED. A different valid model strategy is not a failure. No mandatory tools or forced delegation are introduced.

| Input/scenario | Verification |
|---|---|
| Main simple two-line answer | Literal 42 / Привет; native direct is content/time reference only; RO can complete in one Controller invocation |
| Request Markdown headings, Unicode and separately literal JSON | Compare actual answer format, not transport wrapper; no Host rewriting |
| Authorized changed-skill task on fixed test commit | Native skill is available outside RO catalog; compare required output/evidence and actual skill use when observable |
| Non-Git test dir with a harmless project instruction, file and script | Native discovery follows the actual task/instructions; no Git gate |
| Naturally rejected completed Decision | Original attempt correlation, active correction marker, availability/ref/truncation, no mandatory reuse/retrieval; if not observed mark native case UNVERIFIED (deterministic parser/admission fixtures separate) |
| Two independent tasks suitable for delegation and native subagents | Observe chosen Actions/waits/results and native subagent events where available; distinguish native subagent from RO Worker |
| Natural native choice/form and clarification | Original field titles/values, optional :skip vs empty, :back, broker ACK, request identity, direct and attached client; no model question seen = UNVERIFIED |
| Resume with a related and subsequently a different task after finished/waiting | Original/new user messages, order, no stale correction or inferred intent |
| Cancel during active safe read, controlled timeout, disconnected provider | User cancellation source, terminal vs unknown effect, no blind replay; never test a potentially damaging effect |
| Normal authorized MCP-disabled configuration | Can complete using available native capabilities; no forced retrieval. Record absent capability honestly. |

Repeat using the user's Ornith-1.5-35B-A3B/OpenCode ACP configuration if available, a smaller model and a stronger control, and another independent transport/provider. Run C16.6 and prior real installed Zed/CLI/native acceptance obligations separately if not already verified. Report sample sizes, each run and range/median; do not claim universal speedup from three runs or infer hidden reasoning. Report actual content/evidence/skill compliance alongside throughput. If a material regression is reproduced, isolate B→C vs C→D and revise only the agreed C17 changes. Until actual evidence is obtained, native effectiveness and absence of quality regression remain UNVERIFIED.

## C15R-GUI — graphical ACP client verification (UNVERIFIED)

Engineered ACP v1 wire forwarding and RO-owned projection have SDK tests; **no real installed Zed session or screenshot was available for this implementation**. Do not infer Zed rendering from official protocol schemas, Zed documentation or SDK fixture. See [C15R-GUI](C15R_GUI_GRAPHICAL_ACP_PRESENTATION.md), [A116–A122](../../tests/ACCEPTANCE_MATRIX.md). Record installed RO exact SHA, real Zed version, pinned ACP SDK v1, provider/model, capabilities and redacted actual `session/update`; compare before/after for native Controller plan in compact (not Host plan), interleaved parallel Workers, source/finding uncertainty, original Markdown/final, permission/form, cancel/unknown and A→B→A `session/load`. **Probe client Markdown rendering before building an own formatter.** Measure bounded native delivery/gaps/latency separately with deterministic fixtures. Report actual RO-wire PASS, client-render PASS, client limitation or UNVERIFIED. A second compatible ACP client if available. Do not publish credentials/private prompts/paths, fabricate native results, add special client branches or change authority.


## C15R-GUI-R2 — graphical client visual recheck (UNVERIFIED)

For R2 at the **final implementation SHA**, exercise an authenticated real Zed ACP session with a direct Controller, native plan when actually sent, Thinking/tools, independent Workers, permissions/form and the original Markdown final. Capture redacted ACP logs, client/protocol capabilities, exact model/provider/Zed versions and before/after screenshots. Verify no UUID-heavy accepted status or redundant assessment in compact, identity+profile short dispatch, exact distinction of `terminal=completed/effect=unknown`, actual failures and history A→B→A/repeated load; test detailed/debug and negotiated notices. The SDK fixture and deterministic bounded queue CI are **not** a substitute for graphical/native PASS. No new ACP synthetic events or per-client workaround is required.

## C15R-GUI-R1 — actual graphical-client corrective recheck (UNVERIFIED)

After R1-F1–F4, use an installed, authenticated real Zed ACP client to verify plain-text notice punctuation, multiline finding field indentation, compact/detailed/debug event selection, unchanged native Controller plan/thought/tool/form/final and A→B→A recovery. Capture version, exact SHA, redacted before/after wire logs and screenshots; check negotiated notices support. A synthetic same-process bounded queue comparison in CI is not proof of real-client render, browser behavior, Zed latency or model success. If unavailable, retain **UNVERIFIED**. No new permission or model workflow requirement is introduced.

## C15R-UX-R1.7 — native corrective acceptance (UNVERIFIED)

**Текущий результат: UNVERIFIED.** В GitHub CI нет установленного и авторизованного реального user provider/config/workspace, отдельного графического Zed клиента, фактически выбранной модели и подтверждённых native permissions. Прогон synthetic SDK и настоящего Linux PTY фиксирует только Host/CLI transport, не настоящие решения LLM. A115 и исторические A108/A100/A93/A86/A81 не закрывать.

На установленном CLI с exact implementation SHA и real provider сделать безопасный non-Git request, сохранённые redacted CLI/JSON/trace: один answered + один timed_out/unavailable native form, permission allow/deny/expired, параллельная независимая активность Workers при ожидающем вводе, tool `completed` без verified success, generic-only pending, long schema/emoji/:details/choices/cancel; проверить исходную native correlation и отсутствие false ACK. Сравнить TTY с NO_COLOR/narrow/16/256/truecolor, direct и attached CLI и реальный Zed ACP, финальный Markdown vs raw JSON, старый и исправленный build с одинаковыми model/config/permissions. Для каждого сценария записать binary versions, SHA, operation/attempt/request/native IDs, timestamps, provider response, actual command/exit, exact observed outcome, redacted screenshot и verdict PASS/FAIL/UNVERIFIED. Не записывать secrets, не придумывать native result.


## C15R-UX.8 — native visual acceptance (UNVERIFIED)

**Статус:** UNVERIFIED. Synthetic Node SDK/actual Linux PTY может подтвердить технический транспорт и Markdown/ANSI fidelity, но не настоящие native questions, выбор модели, реальную параллельную самостоятельную работу Workers или графическое представление ACP/Zed. В этой GitHub-сессии отсутствует authenticated пользовательская среда с настоящими provider executors, config/permissions и Zed GUI. Не отправлять secrets, приватные пути и prompts в публичный CI/репозиторий.

На установленном пакете с **точно записанным SHA**, Node/Nix version, native ACP/CLI provider binary+model versions и permission configuration выполнить контролируемые non-Git задания: (1) прямой ответ с Markdown и без Markdown, проверить original Assessment.answer через JSON и redirected stdout, visual TTY с/без NO_COLOR и единственный authoritative final; (2) native form из нескольких полей + `:details N`, выбор native option/scope и `:back`/`:skip`/`:cancel`, значение с пробелами, отказ и подтверждённый ACK, не угадывая q0/_custom; (3) два естественно фактически dispatched независимых Worker с произвольными ролями, intermixed Thinking и tools, failure/unknown/gap/recorded finding и bounded scrollback; (4) аналогичный клиент ACP через настоящий Zed с source identity и без подавления native widgets/skills; (5) сопоставимая задача на предыдущем C15R.6R build и новом C15R-UX при равных models/config/environment.

Для каждого прогона сохранить redacted command, versions, SHA, timestamp, request/attempt/native IDs, короткий transcript/скриншоты, фактические ACK/outputs/exit, PASS/FAIL/UNVERIFIED. Для native недоступных возможностей записать точный blocker, не эмулировать пользовательские permissions. Уточнить статусы A108 и исторических A100/A93/A86 только после фактических доказательств.


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

## C13.7 — actual native and comparative disposition

**2026-11-15, engineering SHA `01457b373cf5bd8946d04031bb7a9fc1f247d00a`, baseline `11135cf29ed4faf033ed07ceb10e76a5491380da`.** A61 native/comparative UNVERIFIED. Current environment: `node --version` v22.16.0, `git --version` 2.47.3, `command -v nix/codex/codex-acp/opencode/zed` unavailable, no OPENAI_API_KEY/ANTHROPIC_API_KEY (presence checked, values not read), GitHub DNS unresolved. GitHub Actions locked npm install and SDK fixtures observed, not authenticated agent execution. No actual external client connected. No native model response, usage, latency or quality claim. Existing F4/C12 native obligations are not closed.

Next executable probes in the user's configured real environment (do not publish tokens/prompts):

1. `git checkout feature/interactive-ux`, record `git rev-parse HEAD`; `nix develop --command node --version`, `codex --version`, `codex-acp --version`, `opencode --version`, `zed --version` as applicable. Record actual provider profile/model/effort, capabilities, adapter and client versions; use trusted existing config and permission policy. Do not change real workspace identity or grant access just for tests.
2. `role-orchestrator run --config "$RO_CONFIG" --cwd "$TASK_CWD" --request-id c13-native-direct --format json 'Return a short direct answer without tools.'`; inspect/trace the returned operation ID. Repeat on the baseline with a distinct state directory/request ID and same task/settings. Confirm genuine model response, invocation/usage and quality, not process exit.
3. `role-orchestrator run --config "$RO_CONFIG" --cwd "$TASK_CWD" --request-id c13-native-parallel --format json 'Delegate two independent inspections of the supplied workspace, report model-authored findings with evidence, and assess the results.'`; use two independent actual executors (CLI and ACP or another independent adapter), record actual chosen actions, context, observations, findings, budgets and outcomes. Compare baseline/after with matching settings; allow model choice and stochastic variation. Test mutable non-Git/dirty workspace, native skills/tools/scripts, permission deny, unknown effect/cancel/resume, optional retrieval and continuation.
4. Register `role-orchestrator acp --config "$RO_CONFIG"` in actual Zed. Capture negotiated native channels, not assumed support; verify actual thought/tool/plan, form elicitation only where supported, original permission options, post-clarification independent Worker, session routing/disconnect/load/cancel. Explicit public message/live finding channel absent or unsupported => UNVERIFIED/limited, no fabricated output.
5. Record commands/exits, versions, SHA, task-specific checks/assessment, model turns/corrections, actual usage or unknown, first useful notice and total wall time, redacted correlation and observations. Repeat representative tasks. C13.6 fixture timings in STATUS are separate engineering observations; do not score native performance from them.

## C14.5 — actual native and comparative disposition

**2026-11-15; engineering SHA `42f65def24649dd28360c3ea8fc553e187206493`; C13 comparison checkpoint `01457b373cf5bd8946d04031bb7a9fc1f247d00a`, pre-C13 baseline `11135cf29ed4faf033ed07ceb10e76a5491380da`.** A66 UNVERIFIED for actual native executors/client and comparative quality/performance. Local probe 2026-11-14 23:00:51 UTC: Node v22.16.0, git 2.47.3, `script` /usr/bin/script, no paths for nix/codex/codex-acp/opencode/zed, no OPENAI_API_KEY/ANTHROPIC_API_KEY (presence only), GitHub DNS unresolved. No authenticated real agent or Zed session available. [CI 43651158169](https://github.com/apathoid/role-orchestrator/actions/runs/43651158169) on exact engineering SHA: 432/432 root and 2/2 actual Linux PTY transport fixtures PASS, including permission/form and attached owner; standard ACP SDK fixtures PASS. Not proof of native model behavior, usage, latency, or graphical rendering.

Next probes in real configured environment, in addition to C13.7 (retain F4/C12 obligations):

1. Record exact checkout SHA, Node/OS/package, actual installed executor versions, provider/model/effort/settings and client version/capabilities. Use two independent real executors and existing trusted `RO_CONFIG`, a representative mutable task workspace `TASK_CWD`, matching permissions/budgets, distinct state directories and request IDs. No new workspace gates or expanded grants. Do not expose credentials or prompts in logs.
2. In real TTY: `role-orchestrator run --config "$RO_CONFIG" --cwd "$TASK_CWD" --presentation compact --request-id c14-native-compact 'Inspect this workspace and report verified findings with evidence.'` Repeat representative direct/complex tasks with `--presentation detailed` and `--presentation debug` (new IDs). Compare with ordinary non-TTY `--format json` using stdout redirection; activity belongs to stderr, final stdout remains machine format. Compare same tasks/settings against pre-C13 baseline and C13 checkpoint without presentation when equivalent capabilities exist; test model-selected delegation, native tools/skills/AGENTS.md/scripts, dirty/non-Git workspace, actual findings and independent Workers. Do not require identical model plans.
3. In a configured TTY, provoke supported native permission and session-form elicitation via real agent tasks; select actual offered option and supported form reply, test deny/decline/cancel, timeout/EOF/Ctrl-C and resume. Use `role-orchestrator resume --config "$RO_CONFIG" --presentation detailed OPERATION_ID` when continuation is supported. Check two concurrent requests and attached owner routing; verify independent operation unaffected on disconnect. Unsupported mode, form or channel remains UNVERIFIED or explicitly unavailable, not PASS. Controller clarification and native input stay separate.
4. In actual Zed or another real ACP graphical client register `role-orchestrator acp --config "$RO_CONFIG" --presentation detailed`. Repeat with compact/debug. Capture negotiated capabilities, actual thought/tool/Controller plan rendering, final once, original permission options and supported native forms, clarification while Worker continues, next prompt/session routing, disconnect/load/cancel. Standard finding/lifecycle/gap notices only when client declares session.notices; no assumed out-of-prompt display. Verify actual advertised/observed behavior. Verify no synthetic thinking/tool or transcript replay; recorded findings remain inspectable.
5. Repeat representative paired tasks and record exact commands/exits, versions/settings, actual model choices, task-specific verification and completeness, turns/corrections, usage or unknown, first useful notice and total wall time, permissions/effects and observed native UI gaps. Redact secrets, record stochastic variance; compare outcome quality and overhead, not identical plans or fixture timing. If a real material regression emerges, fix before release or explicitly reject acceptance. No fixture can close A61/A66/F4/C12 native obligations.


## C13R/C14R — corrective native and comparative probes

Local blocker unchanged at corrective baseline: Node 22.16.0, no Nix / codex / codex-acp / opencode / Zed, GitHub DNS unresolved and no accessible provider authentication. GitHub Linux SDK/subprocess/PTY fixtures are engineering evidence, never native model acceptance.

1. In configured native environment record exact branch SHA, Node/OS/adapter and model/effort, CLI and Zed versions/capabilities, commands/exits and usage if available. Run identical task settings on review baseline `31bfc6ee` and corrective branch with actual Codex CLI and ACP workers; do not require equal stochastic plans. Include long reasoning/tools >1 MiB, final result/exit, observation omission, actual quality and model invocation/correction counts, throughput and first useful output latency.
2. Actual CLI TTY direct/attached: permission/form, two independent pending requests, rejected/lost reply, same live owner/request reconnect, future input, no duplicate dispatch/approval. Compare compact/detailed/debug and machine JSON redirected stdout. Never expose answerKey/token in logs.
3. Real Zed/ACP client: record session.notices capability (absent means explicit fallback), actual lifecycle/finding rendering and source metadata, thought/tool updates before final, gap and session/load history; old Worker A while B prompt active, original permission/form/FS/extension reply correlation and return to A. Verify no new-model-turn or context changes. Generic extension still requires explicit negotiation and actual client support; no assumption based on raw capability.
4. Preserve existing A61/A66/F4/C12 native/comparative obligations; record each unavailable channel or executor as UNVERIFIED rather than claiming PASS from SDK fixtures. Do not merge to master without explicit approval.


## C15.7 — Rich Presentation & ACP Transcript native disposition

**2026-11-15; engineering checkpoint `18a5b7ae7e08f4c6fd0afd1c5524cef728f994a7`; planning baseline `c5c4fca422b895b1962d7c2521cb168ac50ec655`. A81 UNVERIFIED.** Local probes actually executed: `node --version` v22.16.0; `git --version` 2.47.3; `command -v nix codex codex-acp opencode zed ollama` unavailable for all; OPENAI_API_KEY and ANTHROPIC_API_KEY absent (presence only); `getent hosts github.com` no result. No authenticated native provider, real graphical client or local installed Nix package can be run here. GitHub connector source/commit operations and actual Linux Node 24 SDK subprocess/PTY/package/Nix checks are available; these are deterministic engineering evidence, not native model/GUI acceptance. No native usage, model quality, real graphical layout or latency claims. Prior F4/C12/C13/C14/C13R/C14R open obligations retained.

Executable native handoff (use real configured environment, trusted configuration and existing grants; redact prompts/credentials):

1. Record exact checkout SHA, installed package, Node/OS, actual executor/client versions and model/provider/effort. Run baseline and C15 with equivalent configuration/task/settings, separate state directories/request IDs and real mutable dirty/non-Git workspace. Use at least two independent actual executors. Do not require identical stochastic plans, add model gates or expand grants.
2. Installed actual TTY: `role-orchestrator run --config "$RO_CONFIG" --cwd "$TASK_CWD" --presentation compact --request-id c15-native-compact 'Inspect the workspace and report verified findings with evidence.'` Repeat direct and complex tasks in detailed/debug, NO_COLOR=1, redirected machine JSON and attached owner. Observe colored/source labels, native thinking/tools, actual dispatch/outcome/finding and final once; distinguish recorded claims and unknown effects. Confirm same native skills/AGENTS.md/scripts/subagents and tools. Test parallel same-profile Workers, Controller technical failure with independent Worker, permission/form exact native options, deny/decline/EOF/Ctrl-C/timeout, old owner/reconnect, cancel/resume and final stdout unchanged.
3. Register `role-orchestrator acp --config "$RO_CONFIG"` in actual Zed/other standard graphical client (inline default). Test compact/detailed/debug, actual native thinking/tool/Controller dynamic plan/permissions/forms and visible RO blocks, no invented widgets or duplicate final. Repeat with `--progress-display notices`, record real session.notices capability and expected omission if absent. Record actual client grouping/messageId behavior; do not assume visual separation or universal dedup.
4. Check real session history via close/reopen/load: question/answer, cancellation and subsequent turns, recovered durable facts, no fake native activity. Exercise A→B→A with explicit newOperation/continueOperationId using a standard ACP harness/client exposing the existing metadata (do not assume Zed UI supports those explicit options). Old Worker A requests/finishes while B active; verify original authority and no injection into B. Recover A, retry old request ID returns original response; repeated load has same turn chronology and stable own IDs. Legacy ambiguous boundary must be disclosed. Actual GUI client support is separately observed or UNVERIFIED.
5. Capture paired real task outcomes, model-selected delegation/context/evidence, findings and assessment quality, usage or unknown, invocation/correction counts, first useful display and total latency, long reasoning/parallel tools/slow client, disconnect and repeated history. Preserve earlier native/comparative probes in this file. Synthetic benchmark medians in STATUS do not establish native quality or real-client latency. No merge to master without explicit request.


## C15R — native re-acceptance (UNVERIFIED)

User screenshot on 2026-11-15 is OBSERVED baseline evidence: compact CLI visual acceptance NOT ACCEPTED, not evidence of a model failure (Ctrl+C). Re-run installed CLI on the same task/profile/config/cwd, capture full actual transcript and compare to [C15R.2](C15R_PRESENTATION_QUALITY.md#c15r2--rich-cli-blocks-and-interaction-safe-output). Follow [C15R.5](C15R_PRESENTATION_QUALITY.md#c15r5--full-engineering-verification-native-re-acceptance-and-separate-skill-diagnosis) for native CLI/ACP and comparative probes, including separate changed skill diagnosis (cause UNVERIFIED; no automatic Host skill mechanism changes). Record exact versions and blockers; A86 remains UNVERIFIED until actual probes; previous A81/F4/C12/C13/C14 obligations retained.

**Final C15R engineering 9c09318f729b20fa989e1d4c6474a7eea7c0eff5 / [CI 43713292671](https://github.com/apathoid/role-orchestrator/actions/runs/43713292671) SUCCESS:** 476/476 root, 7/7 actual Linux PTY, actual SDK subprocess, full Nix/package/release. [Captured transcripts](C15R_TRANSCRIPT_EVIDENCE.md). A86 remains UNVERIFIED for real installed native CLI visual acceptance, real LLM and graphical ACP, matched native quality/usage/latency. Local probes: Node 22.16.0/Git 2.47.3; no executable nix/codex/codex-acp/opencode/zed/ollama/role-orchestrator, no accessible user's workspace/config/provider authentication, GitHub DNS unresolved. CI native-readiness step records disposition, not native PASS.

Changed: archived actual RO operation 309ccd6c-51c4-4823-a941-56c9ec44b6ca (2026-11-13) recorded native OpenCode skill call with id=changed and completed skill_content/resource metadata; local-small / llamacpp/small / native effort. Earlier direct OpenCode run was reported successful in prior review, but original direct archive and exact matched config/effort not revalidated here. Screenshot 2026-11-15 shows read/glob/shell lookup and a substitute skill choice, not proof of a missing skill or Host delivery regression. Origin of available_skills in that run, actual inventory, cwd, resource and model tool choice remain UNVERIFIED. No runtime change. Next: using installed RO at implementation SHA above and real configured OpenCode, record exact versions and matched task/model/effort/cwd/config/permissions. Run directly with `opencode run --model llamacpp/small --format json "$TASK"` in `$TASK_CWD` (verify flags against installed version); run `role-orchestrator run --config "$RO_CONFIG" --cwd "$TASK_CWD" --presentation compact --request-id c15r-native-changed "$TASK"` with matching local-small profile configured. Record native tool inventory, actual skill call/completion, resource metadata, redacted request/observations, final and usage if known; repeat representative paired runs, preserving native settings. Do not assume equal stochastic plans, publish private prompts/paths/secrets or change skill runtime without confirmed cause and separate scope approval. Repeat C15.7 probes for native visual/ACP and independent executors. Earlier A81/F4/C12/C13/C14/C13R/C14R obligations open.

## C15R.6 — native corrective re-acceptance (ENGINEERING VERIFIED; REAL NATIVE UNVERIFIED)

C15R.6 addresses the observed unusable JSON/question prompt and residual CLI transcript defects after C15R engineering completion; [detailed implementation and acceptance](C15R_PRESENTATION_QUALITY.md). C15R.6 engineering was subsequently verified at `804bbaa24f606dc5be79a27db303489dda1dd27f` (CI 43957276791 PASS, 485 root/9 PTY); C15R.6R and its final interaction-cancellation correction verified at `8b9be91a96f4657dd861647da13808f86f548e93`, [CI 44035000221](https://github.com/apathoid/role-orchestrator/actions/runs/44035000221) (500 root/9 PTY). Real native runs have **not** been performed in this environment. Carry A86 and earlier native obligations forward, do not count prior 476/476 + 7/7 as new evidence.

After C15R.6.6, verify the **actually installed** RO package SHA and real provider/ACP/Zed/version/model/effort/config/cwd/permissions. Repeat the user's native changed-skill description task in the authorized frontend environment, plus a real interaction if naturally requested; otherwise use an exact pinned SDK/PTY form/permission fixture and mark real model-native question **UNVERIFIED**. Capture redacted complete terminal scrollback including source/Thinking/tool blocks, active input, selections, final once, status and unknown effects. Check partially typed response vs expired request/new permission, attached owner/reconnect, parallel Workers continuing, readable no-color/narrow PTY and machine stdout.

In a standard graphical ACP client verify native question/form schema unchanged, permission/plan/thinking/tools still native, inline default, exact session/load and old unassociated-record fallback; no synthetic widgets or Zed-specific protocol. For comparative skill diagnosis match direct provider and RO capabilities/cwd/config/tool inventory and actual observations; do not require identical nondeterministic model tool choices or change skill discovery on a screenshot alone. Capture quality/usage/latency only when available and comparable. Never publish private files, credentials or raw prompts. Unavailable client/auth/environment remains precisely **UNVERIFIED**, with executable reproduction instructions. This section is an acceptance plan, not a PASS assertion.

### C15R.6R-Final — native disposition after engineering CI 44035000221

**Engineering PASS** at `8b9be91a96f4657dd861647da13808f86f548e93`: native form `:cancel`/`:decline` during pending worker validation terminates the original technical task and preserves original ACP action. Direct/attached synthetic actual Linux PTY and SDK fixtures PASS; **installed native CLI / real model question / Zed ACP / direct-provider-versus-RO `changed` comparative A100 remain UNVERIFIED**. Local environment 2026-11-17: Node v22.16.0, Git 2.47.3, missing nix/codex/codex-acp/opencode/zed/ollama/role-orchestrator; no authorized user's config, authentication, actual frontend workspace or GUI client. Repeat the existing C15R.6 native procedure above with the actual installed implementation SHA, equivalent profile/model/effort, permissions and cwd. During an actual elicitation start a costly form pattern if naturally available, type `:cancel`/`:decline` while validation is ongoing, verify original action once and that unrelated Workers continue; do not artificially change native provider capabilities or model prompts. Confirm terminal source, stdout and real Zed history separately. Preserve A93/A86/A81/F4/C12/C13/C14/C13R/C14R obligations; do not classify fixture success as native PASS.
