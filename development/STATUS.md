# Состояние реализации

| Показатель | Значение |
|---|---|
| Specification prepared | YES |
| Production implementation started | YES, переносимое ядро и прямой Controller path |
| Последний проверенный шаг | C11R.12 + исправления ревью P1×3/P2×2, CI PASS на 949292a |
| Следующий шаг | C12.1 |
| Functional implementation complete | NO для всего продукта; C11R implementation complete, C12 не завершён |
| Regression verified | OBSERVED: [CI 42821614211](https://github.com/apathoid/role-orchestrator/actions/runs/42821614211) на 949292a, Node 24/Linux — foundation 4/4, core 25/25, contracts 52/52, integration 217/217, всего 298/298 PASS; Nix/checkJs/package/removal/lockfiles PASS. Native UNVERIFIED |
| Native integration verified | UNVERIFIED |
| Production ready | NO |

## Исправления ревью C11R (10 ноября 2026)

- P1 recovery: технический `operation.recovered` сохраняет непотреблённый выбор Controller, только `operation.continued` его сбрасывает. Добавлены file-backed crash → reopen → resume → dispatch и repeated recovery тесты. CI после исправления ожидается.
- P1 ACP: `ProviderResult.reasoningUnavailable` сообщает только отказ выбора effort в сессии; application преобразует его в `technical waiting` с причиной, profile/level/known logical levels, а CLI и ACP отображают её. Для `runCli` подтверждается nonzero exit. Нет fallback/нового model prompt. CI ожидается.
- P1 retry: route содержит `requestHash` от полного материализованного worker-input (objective, expectedResult, context/evidence, instructions, skillInstructions, attachments, permissions-related constraints, выбранный профиль). Provider idempotency разрешён лишь при том же hash и прежнем route; legacy без hash отклоняется без предположения эквивалентности. `no_effect` и `user_approval` не изменены. CI ожидается.
- P2 snapshot: при worker dispatch проверяется связь `route.reasoning.level/selectionSource` с принятым Action, включая подмену journal и summary. Исторический nativeValue не вычисляется из текущего конфига.
- P2 diagnostics: ACK берётся из всех `attempt.outcome.observations` для attemptId, а не только последнего; добавлен тест позднего уточняющего outcome без повторного ACK.
- **Все 5/5 замечаний закрыты, включая внешний attachment без подтверждения байтов. CI PASS.** [Run 42821614211](https://github.com/apathoid/role-orchestrator/actions/runs/42821614211) проверил код 949292a: 298/298 тестов PASS, checkJs, Nix, package/removal, lockfiles PASS. Оставшиеся реальные нативные проверки Zed/Codex/ACP UNVERIFIED. Provider idempotency требует полного совпадения materialized input, включая контекст с актуального commit-boundary; одинаковая route без requestHash недостаточна. Проверены положительный и отрицательные варианты. Snapshot не принимает удалённый явный reasoning. При старых неопределённых effects нет автоматического replay. C12 не начинался; реальные Codex/ACP/Zed остаются UNVERIFIED.

## C11R — ход реализации (2026-11-10)

- **C11R.1 implemented / REGRESSION UNVERIFIED до проверки CI.** Добавлены Action.reasoningLevel и Decision.nextController (continue или reasoningLevel) в Decoder v1, независимо от словаря уровней; запрещены несовместимые final/clarification/wait. Продолжение без делегирования является полноценным Decision. Введены JSDoc ReasoningSelection/ReasoningCatalog для профилей и invocation. Тесты проверяют форму, точные пути ошибок, совместимость legacy решений и immutable decision identity.
- **C11R.2 implemented / CI PENDING.** Расширены JSON Schema v1 и decoder: native/omission, непустые mapping entries, уникальность уровней, deterministic default, точные JSON Pointer ошибки. Каталог отображает только levels/default, закрытый resolver возвращает nativeValue отдельным immutable per-invocation значением. Project preferences не могут добавлять значения. Добавлены интеграционные тесты.
- **C11R.3 implemented / CI PENDING.** Route расширен optional reasoning с различием исторического «не записан» и будущего native, декодер snapshot проверяет mode/level/source. Accepted nextController привязывается к следующей reservation через reasoningDecisionId; pending/consumed выводятся из событий одной generation. Противоречия binding и route rejected; idempotency/effect certainty не менялись.
- **C11R.4 implemented / CI PENDING.** Handoff разрешает trusted profile+level до reserve/open, неподдерживаемый worker level адресно отклоняется с actionId и доступными уровнями, остальные actions продолжаются. Selection immutable per invocation, записан в route и передаётся ProviderPort; retry с прежним idempotencyKey требует точного совпадения записанного reasoning. Добавлен mixed-batch regression.
- **C11R.5 implemented / CI PENDING.** Controller использует trusted default на первом ходу и one-shot selection из journal для следующего; самостоятельно продолжает без workers и обязательного внешнего события. Параллельные additions запускаются без принудительного ожидания перед продолжением. Controller видит историю, текущий выбор и сведения о pending selection; prompt/инструкции обновлены. Общий ledger/cancel/deadline остаётся прежним.
- **C11R.6 implemented / CI PENDING.** Недоступный Controller level/default не отправляет provider prompt и сохраняет technical waiting с operation/profile/level/availableLevels; отсутствует автоматический fallback. API/trace/CLI/ACP показывают причину и варианты; CLI выдаёт ошибочный exit code для этого случая. Явный resume после исправления доверенной конфигурации продолжает ту же operation с прежним ledger. Добавлен regression.
- **C11R.7 implemented / CI PENDING.** Codex CLI получает только trusted выбранное nativeValue через отдельный `-c model_reasoning_effort=<quoted>` в argv для одной invocation; native/отсутствие выбора не задаёт флаг, секреты/промпт не добавлены в argv, shell=false. Разные selections не изменяют provider config; регрессионные тесты проверяют аргументы, quoting и NUL.
- **C11R.8 implemented / CI PENDING.** ACP v1 выбирает nativeValue лишь по единственному объявленному select-option категории thought_level через session/set_config_option. После выбора проверяются effective value и неизменность model; native/omission не меняют ACP option. Отсутствующий/неизвестный/игнорируемый/меняющий model выбор завершает attempt с CAPABILITY_UNAVAILABLE/not_sent до prompt. Добавлен настоящий ACP fixture integration с подтверждением.
- **C11R.9 implemented / CI PENDING.** Существующие CAS/unknown outcomes и retryKey с C11R.4 сравнивают всю route.reasoning + configurationRef; изменение native mapping запрещает provider_idempotency retry, а независимый worker продолжает работу. Добавлены file-backed checkpoints до/после Decision/reserve/dispatch/outcome, reopen и проверка сохранения pending/consumed/native route. Historical not-recorded не доказывает эквивалентность.
- **C11R.10 implemented / CI PENDING.** Trace/export содержит per-attempt requested/source/effective native mapping/configurationRef/submission и ACP session config acknowledgment, с явным `not_recorded` без нативного подтверждения; Controller selection pending/consumed связана с decision и attempt. Export bounded (256 events и последние 256 attempts), known-secret redaction; inspect даёт pending. Убрана утечка nativeValue в Controller context: модель видит только levels и source, не провайдерский mapping. ACP-адаптер записывает подтверждение своего config option как локальное observation, не как доказательство внутреннего reasoning. Регрессии: отключенный diagnostics sink, redaction, history.
- **C11R.11 implemented / FULL CI PENDING.** Добавлен end-to-end сценарий: native Controller, две параллельные делегации на high/low, unknown worker и модельный replan на low, сохранение outcome. ProviderPort extension допускает selectable только при явном `supportsReasoningSelection: true`: встроенные CLI/ACP подтверждают контракт, legacy plugins продолжают native, selectable без поддержки отклоняется до open. В `development/reports/C11R/INTEGRATION.md` — A44–A54, обозначены synthetic и неизмеренные native версии/ACK/usage.
- **C11R.12 implemented / FULL CI PENDING.** Согласованы README, документы reasoning/configuration/contracts/execution/diagnostics, план C11R и матрица A44–A54. Сохранены отличия automated fixture PASS и native UNVERIFIED. В отчёте `development/reports/C11R/INTEGRATION.md` связываются тесты/команды/CI, доступные native-пробы обозначены отдельно. Контракт config остаётся v1, host не вводит scorer, дополнительную quota или второй scheduler.
- **Следующий кластер: C12.1.** Нужна интеграционная приёмка и реальный native Zed/CLI/ACP evidence до production readiness.
- Проверки baseline: [CI 42812645733](https://github.com/apathoid/role-orchestrator/actions/runs/42812645733), `nix develop --no-update-lock-file --command npm --prefix development run check`, `test:foundation` 4/4, `test:core` 24/24, `test:contracts` 51/51, `test:integration` 203/203, `check:package`, `check:removal` PASS. Последний совместный CI C11R.11–12 ещё проверяется. Реальные CLI/ACP/Zed остаются UNVERIFIED.

## C11 — диагностика и устойчивость

- C11.1 — Диагностические переходы ожидания, отмены, отказа и восстановления имеют технический subject и возможный next path. Trace из application дополняет actionId по attempt ledger; содержимое запроса/инструмента не добавляется. Добавлены четыре semantic golden-сценария: direct answer, параллельные attempts, deny/defer, recovery/unknown/cancel.
- Baseline CI `42c92f1` обнаружил дефект checker: он не распознавал уже запланированные шаги C11R.1–C11R.12; регулярное выражение исправлено без изменения плана. Изменение проверено в итоговом CI; native CLI/ACP/Zed не подтверждены.

- C11.2 — В state directory добавлен независимый bounded NDJSON writer: очередь, ротация, предел размера и файлов, timeout flush, stderr summary, drop/failure accounting. Отказ записи не влияет на task ledger. Добавлены fault-инъекции и тест ротации; проверено в итоговом CI.

- C11.3 — Перед sink и подписчиками производится рекурсивная проекция событий: известные secret refs из доверенной конфигурации, sensitive keys, bearer/basic headers и userinfo удаляются; body capture по умолчанию выключен. Добавлены тесты вложенных значений и подписчиков. Произвольный текст не гарантируется полностью очищенным; проверено в итоговом CI.

- C11.4 — Trace/export дополняются manifest происхождения, отсутствующих portions и truncation, техническим статусом, ограничениями и попытками с unknown. Источник — durable operation journal, а не transient log. Экспорт публикует лишь полный файл через exclusive hard link из временного файла с mode 0600. Тесты проверяют 300 событий, отсутствие prompt, EEXIST и ошибку частичной записи; проверено в итоговом CI.

- C11.5 — Diagnose выдаёт версии runtime и честный unknown для возможностей без negotiated provider session. Missing launch path и несуществующий state directory наблюдаемы без их изменения. Сквозной тест подтверждает отсутствие исполнения plugin module и создания state; проверено в итоговом CI.

- C11.6 — Добавлены повторяемые barrier-сценарии cancel/invoke и pending permission. Проверяются терминальность, отсутствие нового dispatch и позднего разрешения; наблюдаемое поведение подтверждается CI, ожидается.

- C11.7 — Лимит 128 optional context records предотвращает неограниченное размножение missing markers. Handoff сообщает число опущенных выбранных ссылок технической сводкой, не объявляя их доступными. Добавлены тесты 1500 ссылок и 4 МБ output. CI ожидается.

- C11.8 — Обновлена продуктовая эксплуатационная документация с фактическими командами, форматами, пределами NDJSON, redaction и native-ограничениями. Строки A21/A22/A27–A29/A34/A36/A40 проверяются по CI, а не считаются закрытыми одним описанием.

### Итог C11 и эксплуатационные границы

- **OBSERVED / REGRESSION VERIFIED:** [GitHub Actions run 42799512219](https://github.com/apathoid/role-orchestrator/actions/runs/42799512219), commit `e980a0525c6d7a0b07d39f1dbe3594b38436578b`, Linux x86_64/Node 24: `nix flake check`, проверка запуска установленных CLI apps вне checkout, locked npm installs, `check` (specification, JSDoc/checkJs, boundaries), `check:package`, `test:foundation` (4/4), `test:core` (19/19), `test:contracts` (46/46), `test:integration` (181/181), проверки lock; exit 0.
- **Приняты C11.1–C11.8:** аудит diagnostic events, bounded NDJSON/rotation/flush/drop summary, redaction и безопасный body capture, inspect/trace/export manifest с атомарной публикацией, side-effect-free diagnose, проверенные гонки cancel/permissions, bounded context, операционная документация. Отдельные коммиты каждого шага сохранены; последующие корректирующие коммиты закрыли CI regressions.
- **UNVERIFIED:** реальные модельные CLI/ACP сессии, внешний Zed, пользовательский NixOS, недоступные native capabilities. Синтетические тесты не доказывают native readiness. Нет оснований объявлять весь продукт production ready.
- Следующий кластер — **C11R.1**; C11R не реализован данным поручением.

### Исправления по ревью C11 (2026-11-10)

- **P2-1:** NDJSON sink выдаёт не более одного начального предупреждения и одной итоговой сводки при flush. При `stderr.write() === false` дальнейшие записи не создают давление на поток. Полные счётчики dropped/failed доступны внутри sink; при заблокированном stderr доставку финальной сводки гарантировать нельзя.
- **P2-2:** Runtime передаёт доверенные известные secret values из `providers.*.launch.env.*.fromEnv` в единую проекцию durable trace/export. Идентификаторы событий, попыток, действий, профилей и провайдеров тоже очищаются. Безопасная обработка произвольных неизвестных секретов не гарантируется.
- **P2-3:** Trace теперь содержит сохранённый `eventId`, `decisionId` при наличии, корреляцию attempt→action, технические `reasonCode` из общей core mapping и provenance отмены. Исключительные transient классификации позднего или противоречивого outcome остаются отдельно от journal kind.
- **P2-4:** `compactContext` учитывает размер unavailable/budget markers и число опциональных записей. Неуместившиеся ссылки не вставляются целиком: `host:context-budget` сообщает число непредставленных; исходные сохранённые записи можно адресовать через `ContextPort.list/fetch` в пределах бюджета. Литеральные сообщения пользователя и необходимые coordination facts отделены от optional byte budget.
- **P3:** `diagnose` проверяет тип state directory и type/execute permission для файлов запуска. Относительные команды и относительный PATH помечаются `cwd_dependent`; это статическая подсказка, а не обещание успешного будущего spawn.
- **OBSERVED:** [GitHub Actions #42805542909](https://github.com/apathoid/role-orchestrator/actions/runs/42805542909), HEAD `25abd709965ddf162ef65124a3264d6f760cef89`, Ubuntu x86_64, Node 24: `nix flake check`, CLI/package/install checks, `check`, foundation 4/4, core 19/19, contracts 46/46, integration 190/190, exit 0. Регрессионные тесты для всех пяти замечаний включены в suites. Нативные Codex/ACP/Zed и NixOS остаются **UNVERIFIED**; C11R не начат.
- Следующий этап — **C11R.1**.

## C11R — дополнение плана (2026-11-10)

**PLANNED / NOT IMPLEMENTED / native UNVERIFIED.** Добавлен [кластер C11R](plan/clusters/C11R_REASONING_EFFORT.md) и [целевой продуктовый контракт](../docs/REASONING_EFFORT.md). Выполнять после C11 до финальной C12; после завершённого C11 следующий шаг — C11R.1.

Приняты: config v1 без повышения версии, omission reasoningEffort = native для новых вызовов, пользовательский mapping унифицированных levels, динамический effort workers и Controller, самостоятельное продолжение без внешнего события. Специальный anti-loop механизм не вводится. Неподдерживаемый собственный effort показывается пользователю без fallback. Acknowledgment — контекст, не gate; исторические маршруты и неизвестные эффекты сохраняются.

Эта запись фиксирует только план и спецификацию. Production-код, runtime schema, тесты, зависимости, CI и конфигурация исполнения в этом дополнении не менялись. A44–A54 ожидают реализации и проверки; результаты C00–C10 ниже не закрывают C11R.

## C00 — foundation

- C00.1, C00.8 — Node 24.22.1, npm, TypeScript 5.9.3 и типы Node 24.10.0. Корневые версии ACP и npm/Nix locks сохранены. TypeScript проверяет JS только в harness. Отрицательная fixture возвращает TS2322 для несовместимого `Clock`.
- C00.2–C00.5 — ESM entrypoint, независимый harness, проверка графа импортов и инъецируемые диагностические порты. Тесты проверяют корреляцию и изоляцию отказа sink от вызывающего кода. Пустые наборы тестов возвращают NOT IMPLEMENTED.
- C00.6–C00.7 — синтетические runs со временем, командами, кодами выхода и cleanup. Отдельная копия продукта прошла npm install из lock, упаковку и импорт из tarball без Git, development и TypeScript.
- C00.9 — OBSERVED в [baseline Linux CI](https://github.com/apathoid/role-orchestrator/actions/runs/42387065141) для `e33733a`: flake check, devShell Node и npm ci. Локальный Nix отсутствует.
- C00.10 — CI подключает проверки JS, boundaries, foundation, package и removal под Node 24 из flake. Продуктовые проверки выполняются независимо от harness. OBSERVED: [GitHub Actions](https://github.com/apathoid/role-orchestrator/actions/runs/42388026539) завершился success на `db92cf9`.

Локальные команды с exit 0: `npm ci --ignore-scripts --no-audit --no-fund`, `npm --prefix development ci --ignore-scripts --no-audit --no-fund`, `npm --prefix development run check`, `test:foundation`, `check:package`, `check:removal`. C00 проверяет только инфраструктурные части A01/A37/A41–A43. CLI, NixOS и реальные провайдеры UNVERIFIED.


Отрицательная проверка C00.1: npm 11.9.0 под Node 22.22.0 вернул exit 1 (`EBADENGINE`, требование `^24.0.0`). Версии исходных ACP пакетов сохранены.

## C01 — контракты и переходы

- C01.1–C01.3 — версионированные декодеры Request, Decision и Outcome возвращают точный путь поля. Pure reducer принимает события с корреляцией, ведёт revision и возвращает intents для отмены. Итог попытки и оценка задачи различаются.
- C01.4–C01.7 — расход и слоты выводятся из записей attempts. Неизвестный usage сохраняется отдельно от известного нуля. Порты типизированы через JSDoc; core не открывает I/O. Переходы возвращают диагностические события без содержимого запроса.
- C01.8 — OBSERVED: `npm --prefix development run check` и `npm --prefix development run test:core` завершились exit 0, 6 core-тестов. Проверены конфликты идентичности, чужой attempt, поздний и противоречащий outcome, отрицательная форма сообщений, исчерпание ресурсов и provenance. OBSERVED: [CI для core](https://github.com/apathoid/role-orchestrator/actions/runs/42388439420) завершился success на `0acf661`.
- Ограничения: A02 проверен на уровне decoder; A03/A19/A22/A29 проверены в части core. Дедупликация между use cases, durable recovery, глобальная concurrency и сценарии с реальным адаптером относятся к следующим кластерам.

## C02 — одиночный цикл

- Application API предоставляет `submit`, `resume`, `inspect`, `cancel` поверх внедряемого StateStore/ProviderPort. Один Controller использует буквальный текст, ограничения, подтверждённую конфигурацию, каталог и результаты. Запросы/ответы повторно доставляются по requestId; синтетический store живёт только в harness.
- Структурная ошибка возвращается Controller через тот же бюджет. Assessment сохраняется отдельно от попытки; ссылки проверяются по доступным записям. Уточнение продолжает ту же operation по questionId. Отмена перед отправкой не вызывает провайдера. Timeout после отправки сохраняет unknown и исключает автоматический replay; новый запрос пользователя сохраняет историю и расход.
- OBSERVED: `npm --prefix development run check`, `test:core` и `test:integration`, exit 0. 6 core и 12 application-тестов. OBSERVED: [CI для C02](https://github.com/apathoid/role-orchestrator/actions/runs/42388867936) завершился success на `2f5bd90`.
- Ограничения: отмена и deadline проверены с cooperative ProviderPort. Реальные transport/process lifecycle, durable replay и crash matrix относятся к последующим кластерам. Native acceptance UNVERIFIED.

## C03 — делегирование

- C03.1 — materializeHandoff передаёт выбранный профиль, цель, ожидаемую форму, инструкции и буквальные ограничения. Контекст ограничен указанными refs, недоступные refs явно обозначаются, полномочия передаются от Host.
- C03.2 — чистый граф принимает независимые actions, адресно отклоняет отсутствующие/циклические зависимости и конфликт id. Terminal и model acceptance — разные условия готовности.
- OBSERVED: `npm --prefix development run check`, `test:core` (9), `test:integration` (14), exit 0. A08 и A09 проверены для handoff/графа.

- C03.3–C03.4 — application запускает выбранных специалистов параллельно в пределах общего лимита. Проверено освобождение одного из двух слотов для третьего worker, независимость операций, terminal failure и явная модельная оценка для разных типов зависимостей. `next_completion` возвращает первый результат и pending attempts; `all_requested` ждёт указанные действия/попытки. Повторное ожидание уже виденного результата получает ошибку поля.
- OBSERVED: `check`, `test:core` (9), `test:integration` (20), exit 0. [CI для handoff/графа](https://github.com/apathoid/role-orchestrator/actions/runs/42389043626) success на `ed33e7f`. OBSERVED: [CI для параллельного dispatch](https://github.com/apathoid/role-orchestrator/actions/runs/42389581263) success на `c28c516`.

- C03.5–C03.10 — модель может отменить конкретное действие и предложить новый id, сохраняя прежнюю попытку и её эффект. Дедупликация защищает от повторного dispatch, а поздний результат не меняет смысл более нового решения. При финале с запросом отмены Controller получает исход отмены до подтверждения оценки. Разногласие и ошибка проверки передаются Controller, который выбирает дальнейшее исследование.
- OBSERVED: итоговый локальный прогон `check`, `test:foundation` (4), `test:core` (9), `test:integration` (23), `check:package`, `check:removal`, exit 0. [CI для C03.10](https://github.com/apathoid/role-orchestrator/actions/runs/42389823781) success на `b5adc03`. Durable restart и нативные провайдеры UNVERIFIED.

## C04 — конфигурация и полномочия

- C04.1 — JSON Schema v1 и runtime validation. Ajv 8.20.0 закреплён в npm lock как реализация стандартного валидатора; исходные ACP версии и Nix lock сохранены. Ошибки формы содержат JSON Pointer и имя ограничения без входного значения. Ссылки провайдеров, профилей и ролей проверяются после схемы.
- C04.2 — merge по отдельным полям: defaults → trusted user config → ограниченные project preferences → trusted launch options. Project preferences могут выбрать существующие profile/role/skills и снизить лимиты. Читается только явно указанный файл или `.role-orchestrator.json` из выбранной директории.
- C04.3 — immutable model-facing catalog отделяет профиль, модель и capability provenance от launch/settings и secret refs. Две модели могут использовать один provider port.
- C04.4 — обязательные capability проверяются до открытия сессии. Недоступный image input даёт `CAPABILITY_UNAVAILABLE` с `not_sent`; необязательный usage сохраняется как unknown.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (9), `test:integration` (31), `check:package`, `check:removal`, exit 0. Результат относится к синтетическим портам. [CI для C04.1–C04.4](https://github.com/apathoid/role-orchestrator/actions/runs/42390386124) success на `ec2bfcf`.

- C04.5–C04.6 — доверенный grant ограничивает запуск выбранными профилями, проверяется до open и перед dispatch. Permission bridge сопоставляет host request id, attempt id, native request id и предложенную опцию. Standing decision не открывает повторный prompt. Отмена закрывает запрос; поздний или повторный ответ не применяется. Отсутствие UI возвращает unavailable.
- C04.7–C04.8 — regression меняет файл, Git index и branch во время попытки. Orchestrator завершает исходную попытку с прежним authority ref без повторного вызова. Runtime остаётся проверяемым без Git. Область гарантий описана в документации. Нативные permission settings проверяются вместе с реальными адаптерами.
- Итоговый локальный набор: `check`, `test:foundation` (4), `test:core` (9), `test:integration` (38), `check:package`, `check:removal`, exit 0. Removal smoke также загружает схему из реального npm tarball. Durable state/recovery, context retention, реальные адаптеры, CLI/ACP hosts, эксплуатационные и native acceptance checks относятся к C05–C12.

После C04.8 добавлен regression на независимое делегирование: `all_requested` задаёт момент следующего ответа Controller, а ready action вне списка ожидания выполняется параллельно.

### Исправления после ревью C02–C04

- Активные делегаты принадлежат operation и сохраняют один handle ожидания и отмены между уточнением и resume. Проверено, что Controller дожидается прежнего attempt и не тратит бюджет на повторные вызовы, пока тот выполняется.
- Контекст нового Controller содержит прежние решения, заданный вопрос и доставленный ответ с модельной атрибуцией. Текст пользователя сохраняет отдельную атрибуцию.
- Coordinator завершает ограниченное ожидание даже при зависшем invoke или cancel. После возможной отправки остаётся unknown, поздний результат не завершает operation, а неподтверждённое закрытие удерживает слот. Проверено с тестовым адаптером; нативный cleanup UNVERIFIED.
- Локально: `check`, `test:foundation` (4), `test:core` (9), `test:integration` (42), `check:package`, `check:removal`.

## C05 — долговременное состояние и recovery

- C05.1 — snapshot codec v1 сохраняет operation, историю действий и контекста, reservations и точные unknown outcomes. Проверены round-trip, отсутствующие optional поля, неизвестная версия, повреждённый ledger и отказ от runtime handles. Null usage отличается от нуля.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (42), `check:package`, `check:removal`, exit 0. Следующий шаг — C05.2, atomic local store.

- C05.2 — локальный StateStore загружает и перечисляет целые snapshots, сравнивает ожидаемую revision и публикует следующую через temp write, file sync, rename и directory sync. Инъекции ошибок проверяют частичную запись, сбой rename и видимую новую revision после ошибки directory sync.
- C05.3 — writer удерживает SQLite-блокировку собственного state directory через встроенный `node:sqlite`. Проверено на Linux с двумя процессами: отказ живому конкуренту, повторное открытие после close и SIGKILL, отсутствие takeover по возрасту файла. State directory должен существовать к открытию.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (47), `check:package`, `check:removal`. Следующий шаг — C05.4, bounded artifacts. Применение durable store в сценариях reserve/dispatch и recovery проверяется в следующих шагах. NixOS и нативные провайдеры UNVERIFIED.

- C05.4 — bounded artifacts публикуются до выдачи ссылки с SHA-256, размером и truncation metadata. Чтение ограничено байтами и различает unavailable и integrity_error. Инъекция частичной записи проверяет отсутствие опубликованной ссылки. Повторное открытие под writer lock очищает только именованные временные файлы; проверено сохранение blob, на который ссылается snapshot.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (49), `check:package`, `check:removal`. Следующий шаг — C05.5, durable reservation и crash gap до dispatch.

- C05.5 — координатор допускает внешний вызов после подтверждённых commit reservation и dispatch. При неподтверждённой записи перечитывает snapshot для корреляции и прекращает текущую попытку dispatch. Проверены четыре subprocess crash boundaries вокруг reserve и dispatch, сохранённый остаток бюджета и фактическое число внешних эффектов после повторной доставки requestId. Отдельный тест читает terminal unknown после закрытия и повторного открытия durable store.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (55), `check:package`, `check:removal`. Следующий шаг — C05.6, подтверждение outcome commit и повторная доставка. Активное возобновление после сбоя и статус прежнего провайдера относятся к C05.7.

- C05.6 — при CAS conflict исход повторно применяется к сохранённой revision с тем же eventId. Если итог уже виден после потерянного ACK store, точное совпадение позволяет повторно подтвердить запись без изменения revision. Проверены реальный конфликт CAS, повторная доставка requestId после SIGKILL между final commit и доставкой, сохранение единственного outcome и отсутствие повторного вызова провайдера.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (57), `check:package`, `check:removal`. Следующий шаг — C05.7, активный resume после перезапуска с текущей доверенной конфигурацией и capability status lookup.

- C05.7 — явный resume восстанавливает ledger и историю, применяет текущий grant, лимиты и каталог. Unresolved attempts передаются Controller. Status lookup требует действующей авторизации, совпадающего маршрута и negotiated capability; ожидание ограничено. Проверены SIGKILL, другой провайдер и конфигурация, изменившийся файл вне Git, успешный и зависший lookup и configured-only capability.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (61), `check:package`, `check:removal`. Следующий шаг — C05.8, явный retry и независимые действия при unknown. Нативная интеграция UNVERIFIED.

- C05.8 — явно предложенный retry сопоставляется с исходным attempt. Проверены отказ при трёх неподтверждённых основаниях, доступность независимого чтения, известный no-effect, доверенное scoped-разрешение и повтор с тем же ключом по контракту адаптера. Счётчик эффекта при идемпотентном повторе остался равен одному.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (67), `check:package`, `check:removal`. Следующий шаг — C05.9, изоляция ошибок store.

- C05.9 — list различает здоровые, повреждённые и несовместимые snapshots. Адресный отказ защищает повторную доставку начального requestId повреждённой операции, а другие операции работают. Проверены сохранность повреждённых байтов, чтение и commit раннего имени файла, инъекция EROFS и продолжение после восстановления записи без повторения внешнего эффекта.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (70), `check:package`, `check:removal`. Следующий шаг — C05.10, итоговая crash matrix.

- C05.10 — девять subprocess crash boundaries от reservation до доставки. Проверены число внешних эффектов, сохранённый расход, явный resume, повторная доставка, корреляция commit revision и attemptId и сохранность результата при отказе diagnostic sink. C05 закрыт на уровне локального Linux store и тестовых портов. A23–A28 отражены в acceptance matrix с границами доказательства.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (76), `check:package`, `check:removal`. Следующий шаг — C06.1, provenance. Нативные адаптеры, CLI/ACP delivery и NixOS остаются UNVERIFIED.

### C05 — исправления после ревью

- Snapshot codec сверяет status, dispatch certainty, timestamps, маршрут и итог attempt с последовательностью сохранённых событий. Несогласованная запись возвращает corrupt_snapshot, остаётся на диске и не допускает resume или dispatch.
- После abort coordinator ограничивает ожидание и завершает модельный ход, но до подтверждения отсоединения сохраняет коррелированные поздние факты. Проверены late outcome и расход, дедупликация observations, сохранение после дедлайна cleanup и отсутствие повторного модельного хода.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (14), `test:integration` (79), `check:package`, `check:removal` (из локального npm cache). Следующий шаг — C06.1.


## C06 — контекст, findings и acceptance

- C06.1 — история различает пользовательские сообщения, модельные сообщения, отчёты провайдера, события инструментов и наблюдения транспорта. Сохранены идентификатор источника, время приёма, доступный вывод и полнота. Порядок доставки восстанавливается из revision и позиции записи в событии. Снимки v1 без новых полей остаются читаемыми.
- OBSERVED: после повторного открытия Linux store выход процесса агента с кодом 0 и сообщение модели о прошедших тестах видны отдельно. Код завершения инструмента появляется только из отдельного структурированного события. Проверены противоречивый provenance в snapshot и дедупликация позднего события с другим временем доставки.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (80), `check:package`, `check:removal`, exit 0. Адаптеры CLI/ACP и локальная проверка Nix остаются UNVERIFIED. Следующий шаг — C06.2.


- C06.2 — Controller и специалисты могут добавлять структурированные findings с claim, subject, supports, author и uncertainties. `supersedes` связывает новую запись с предыдущей. Проверяются идентификаторы, авторство и ссылки в пределах операции. История сохраняет каждую находку и её опоры.
- OBSERVED: противоположные выводы двух профилей об одном файле сосуществуют. После повторного открытия store доступны оба вывода, модельная ревизия, исходные observations и предыдущая итоговая assessment. Невалидная находка специалиста оставляет исход вызова и raw output доступными. Проверены адресные ошибки для чужих ссылок, повторных ID и несовпадающего автора.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (83), `check:package`, `check:removal`, exit 0. Реальные CLI/ACP-адаптеры остаются UNVERIFIED. Следующий шаг — C06.3.


- C06.3 — доверенная настройка `context.maxBytes` ограничивает необязательную историю в UTF-8 JSON. Controller получает приоритет недавних записей, специалист получает выбранные ссылки и обязательные сведения об отмене и неизвестных эффектах перед dispatch. Цель, пользовательский текст и ограничения передаются дословно.
- OBSERVED: большие записи доставляются как помеченные фрагменты с provenance и ссылкой. Пропуск по лимиту, неизвестная ссылка и зарегистрированный вывод без payload различаются. Проверены многобайтный текст, лимит в один байт, сохранение исходного вывода и отсутствие невыбранной истории в handoff.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (85), `check:package`, `check:removal`, exit 0. Лимит относится к истории, а размер нативного окна зависит от адаптера. CLI/ACP остаются UNVERIFIED. Следующий шаг — C06.4.


- C06.4 — fetch привязан к вызову, выбранным ссылкам специалиста и операции. Доступ к другой операции требует точного доверенного разрешения. Адаптер публикует байты артефакта перед записью ссылки; лимит `context.maxBytes` применяется к записи и выдаче байтов. Модельные резюме сохраняют автора и ссылки на исходные наблюдения.
- OBSERVED: запрос деталей и ограниченного артефакта после повторного открытия store, явная недоступность удалённого файла, отказ при чтении невыбранной ссылки и при доступе к другой операции без разрешения. Проверено, что переданный моделью хеш не предоставляет доступ к байтам, а резюме сохраняется с `model_claim` рядом с исходными данными.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (87), `check:package`, `check:removal`, exit 0. Чистая установка прошла при отдельном повторном запуске после ошибки очистки временного каталога. Нативные CLI/ACP остаются UNVERIFIED. Следующий шаг — C06.5.


- C06.5 — observations могут содержать сообщённые источником место, версию и время в `reportedContext`. Controller и специалист получают эту информацию в обычном контексте и по выбранным ссылкам. Ранее сохранённые findings остаются доступны вместе с исходными наблюдениями.
- OBSERVED: правка постороннего файла сохраняет находку и даёт три предусмотренных вызова. После правки проверяемого файла Controller запрашивает одно целевое повторное чтение, всего пять вызовов. Правка файла, обновление индекса и смена Git-ветки во время активного вызова оставляют один исходный dispatch. Проверены фактические вызовы, журнал dispatch и round-trip снимка.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (89), `check:package`, `check:removal`, exit 0. Нативные CLI/ACP остаются UNVERIFIED. Следующий шаг — C06.6.


- C06.6 — Controller оценивает существенные требования и может сохранить объяснение по каждому. Координатор проверяет автора, уникальность ID и ссылки. На продолжении краткие незакрытые статусы доступны со ссылкой на исходную модельную оценку. Snapshot сверяет сохранённый итог с последней записью в истории.
- OBSERVED: fixture запустил проверку до правки и записал её tool exit 0. После правки модель вернула `unverified` для явно запрошенной проверки нового состояния. Подтверждены ровно три dispatch, единственный исходный tool exit и сохранение объяснения. Проверены адресные ошибки авторства, повторного ID и недоступной ссылки, а также видимость незакрытой оценки при лимите истории в один байт.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (91), `check:package`, `check:removal`, exit 0. Нативные CLI/ACP остаются UNVERIFIED. Следующий шаг — C06.7.


- C06.7 — `inspectFinding` связывает находки, опоры и попытки с исходными outcome. Локальный store применяет явную политику возраста и размера при открытии под блокировкой. Отсутствующий после очистки blob получает причину `retention`; снимки и модельные выводы сохраняются.
- OBSERVED: по лимиту удалён старый blob, а более новый и общие данные с возможным либо неизвестным эффектом остались доступны. Проверены сохранность снимков, чтение отметки retention, отказ от очистки при повреждённом снимке и повтор после ошибки unlink.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (93), `check:package`, `check:removal`, exit 0. Нативные CLI/ACP остаются UNVERIFIED. Следующий шаг — C06.8.


- C06.8 — сквозной сценарий повторно открывает store, доставляет две противоречащие находки без повторного запуска исследователей и выполняет один новый целевой check. Проверены provenance исходного и текущего результата, unavailable после retention, модельное резюме и частичный итог. Трасса привязывает позиции переданных записей и причины сокращения/недоступности к handoff. Ошибка sink сохраняет итог.
- OBSERVED локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (94), `check:package`, `check:removal`, exit 0. Кластер C06 закрыт для синтетического ProviderPort и локального store. Native review, реальные CLI/ACP-вызовы, экспорт/redaction диагностики остаются UNVERIFIED. Следующий шаг — C07.1.

### C06 — исправления после ревью

- P1 — ключ наблюдения привязан к операции, попытке и исходной ссылке провайдера. Исходная ссылка сохраняется как метаданные. Поиск, опоры findings и ссылки на вывод используют внутренние ключи. Snapshot отклоняет неоднозначные записи. Однозначные snapshots v1 по-прежнему читаются.
- P2 — `ContextPort.list` показывает метаданные записей, пропущенных в кратком контексте, постранично до 32 записей и 8 КиБ. Специалист видит только выбранные ссылки. Модель выбирает запись, извлекает её через `fetch` и при необходимости передаёт дальше.
- OBSERVED на Node 24.22.1. Обе регрессии воспроизведены на `783281f` и проходят с исправлением. `check`, `test:foundation` (4), `test:core` (15), `test:integration` (96), `check:package`, `check:removal`. Реальные CLI/ACP/Zed и установка приложения в NixOS остаются UNVERIFIED. Следующий шаг — C07.1.

## C07 — CLI/headless provider adapter

- C07.1 — [контракт запуска Codex CLI](reports/C07/CLI_LAUNCH.md). Адаптер формирует команду и argv из доверенных настроек, передаёт текст через stdin, сохраняет cwd и окружение с явными переадресациями `fromEnv`. Профиль Codex опционален. Формат stdout — JSONL.
- OBSERVED на Linux, Node 24.22.1. Бинарник Codex CLI 0.165.0 подтвердил флаги и чтение stdin вне Git. Контролируемый процесс подтвердил передачу stdin, cwd, argv и окружения. Обе установки из lock, `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (98), `check:package`, `check:removal` и `git diff --check` завершились успешно. Нативные модельные вызовы и локальный Nix остаются UNVERIFIED. Следующий шаг — C07.2.

- C07.2 — [владелец процесса CLI](reports/C07/CLI_PROCESS_OWNERSHIP.md) запускает отдельную группу Linux, записывает stdin, передаёт байты stdout и stderr, завершает группу при дедлайне, отмене или выходе лидера. Терминальный результат доступен после закрытия процесса и потоков. Ограниченное дочитывание помечает поток, если EOF недоступен.
- OBSERVED на Linux x86-64, Node 24.22.1. Подтверждены ENOENT, EPIPE, ранний выход, частичный вывод, дедлайн, отмена и очистка потомков. Параллельный вызов сохранил свою группу. `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (107), `check:package`, `check:removal` и `git diff --check` завершились успешно. Нативные сессии и восстановление после принудительного завершения владельца остаются UNVERIFIED. Следующий шаг — C07.3.

- C07.3 — [фрейминг и ограничение вывода Codex CLI](reports/C07/CLI_OUTPUT_FRAMING.md). Адаптер разбирает целые JSONL-строки, сохраняет ограниченные префиксы stdout/stderr и сообщает причину, позицию и число ошибок фрейминга. После пропуска строки разбор продолжается в пределах бюджета stdout.
- OBSERVED на Linux, Node 24.22.1. Проверены разрывы UTF-8 и границы чанков, отдельный stderr, некорректные строки, лимиты и доступность частичного вывода после ненулевого выхода. `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (113), `check:package`, `check:removal` и `git diff --check` завершились успешно. Нативная сессия Codex остаётся UNVERIFIED. Следующий шаг — C07.4.

- C07.4 — [Controller и Worker через Codex CLI](reports/C07/CLI_CONTROLLER_AND_WORKER.md). Фабрика `createCodexProvider` доступна через программный API. Controller возвращает полное JSON-решение через штатный decoder. Worker сохраняет текст. Сообщение модели, код CLI и сообщённый код инструмента имеют отдельное происхождение. При сбое транспорта частичный вывод остаётся доступным с неизвестным эффектом.
- OBSERVED на Linux, Node 24.22.1. Проверены модельное делегирование и частичный итог, адресное исправление Decision, различение кодов выхода и сохранение вывода без применения решения при сбое. `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (120), `check:package`, `check:removal` и `git diff --check` завершились успешно. Нативная сессия Codex остаётся UNVERIFIED. Следующий шаг — C07.5.

- C07.5 — [полномочия и возможности CLI](reports/C07/CLI_PERMISSIONS.md). Адаптер объявляет ограничения headless-вызова. Если обязательной возможности нет, отказ сохраняет её имя, статус и доступную причину. Нативный профиль выбирает оператор. Явный отказ команды сохраняется как отчёт провайдера и не меняет семантический итог хода.
- OBSERVED на Linux, Node 24.22.1. Проверены требование интерактивного разрешения, отсутствие запроса к брокеру, передача нативного профиля для Controller и Reviewer и отдельная запись нативного отказа. `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (124), `check:package`, `check:removal` и `git diff --check` завершились успешно. Настоящий модельный вызов и нативное применение прав остаются UNVERIFIED. Следующий шаг — C07.6.

- C07.6 — [общий контракт ProviderPort](reports/C07/PROVIDER_PORT_CONTRACT.md) проверяется на управляемом провайдере и Codex CLI с контролируемым дочерним процессом. Оба транспорта проходят одни проверки порядка наблюдений, терминального результата, идентичности вызова, отмены, закрытия, независимых вызовов и неизвестного usage. `test:contracts` подключён к CI.
- OBSERVED на Linux, Node 24.22.1. `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:contracts` (10), `test:integration` (124), `check:package`, `check:removal` и `git diff --check` завершились успешно. Нативная сессия Codex остаётся UNVERIFIED. Следующий шаг — C07.7.

- C07.7 — [сквозная проверка CLI и восстановления](reports/C07/CLI_DURABLE_RUN.md). Оркестратор, CLI-адаптер, реальный дочерний процесс и локальное хранилище проверены вместе. Изменение каталога без Git во время вызова сохранило один запуск. После `SIGKILL` оркестратора до записи исхода Worker явный resume запустил новый Controller, а эффект Worker остался неизвестным. Отмена закрыла активный CLI-процесс, сохранив частичные наблюдения.
- OBSERVED на Linux, Node 24.22.1. `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:contracts` (10), `test:integration` (127), `check:package`, `check:removal` и `git diff --check` завершились успешно. Нативная сессия Codex остаётся UNVERIFIED. Следующий шаг — C07.8.

- C07.8 — [нативный CLI-пробник](reports/C07/CLI_NATIVE_PROBE.md). Codex CLI 0.165.0 показал вход через ChatGPT, но запрос вернул HTTP 401 в диагностике и не дошёл до завершения хода. Нативная приёмка остаётся UNVERIFIED. Синтетические проверки A18 и A20 зафиксированы отдельно от A38.

## C08 — Generic ACP adapter

- C08.1 — [сопоставление ProviderPort и стабильного ACP v1](reports/C08/ACP_V1_PROTOCOL_MAPPING.md) по SDK 2.4.0, опубликованной спецификации и контрактному тесту. Подтверждены API подключения, рукопожатие, сессия, prompt, событие инструмента, запрос разрешения, отмена и закрытие через NDJSON с управляемым агентом.
- C08.2–C08.7 — [Generic ACP ProviderPort](reports/C08/ACP_ADAPTER.md). Публичная фабрика управляет соединением и сессией, передаёт вложения и потоковые события, связывает разрешения с попыткой, поддерживает явно подключённый client-tool bridge, проверяет выбор модели и завершает собственный процесс после отмены.
- C08.8 — общий контракт ProviderPort, протокольные fixtures и сквозной вызов Controller прошли на Linux, Node 24.22.1. `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:contracts` (34), `test:integration` (128), `check:package`, `check:removal` и `git diff --check` завершились успешно.
- OBSERVED: Codex ACP 2.5.0 согласовал ACP v1. `session/new` не ответил до дедлайна, поэтому модельный вызов и внешний ACP/Zed остаются UNVERIFIED. A18/A20 проверены локально на уровне контракта адаптера. Нативная часть A20 и A38 остаются открытыми. Следующий шаг — C09.1.

### Исправления после ревью C07

- CLI сохраняет `item.completed/error` как сообщение провайдера со ссылкой из исхода. Проверка воспроизвела потерю предупреждения на `fb87c65`. После исправления предупреждение сохраняется в snapshot успешного хода.
- CLI явно сообщает `context.retrieval: unsupported` в каталоге и предупреждает модель об ограничении в prompt. Доставка `ContextPort.list/fetch` через реальные адаптеры и её сквозная проверка внесены в C09.6.

### Исправления после ревью C08

- Controller принимает потоковый Decision без `messageId` после нового tool call за одну попытку. В тесте обновление статуса инструмента приходит между чанками JSON.
- После смены режима адаптер учитывает `config_option_update` и подтверждает модель до prompt. Брокер разрешений получает атрибутированное описание действия, включая пути и детали. Ошибка запуска ссылается на ограниченный stderr, ошибку протокола или наблюдение о процессе.
- Linux, Node 24.22.1: `check`, `test:foundation` (4), `test:core` (15), `test:contracts` (39), `test:integration` (128), `check:package`, `check:removal` и `git diff --check` прошли. Нативная приёмка по-прежнему UNVERIFIED. Следующий шаг — C09.1.

## C09 — Plugins, skills и внешние инструменты

- C09.1 — Manifest v1 проверяет идентичность, версию API и объявленные exports. Фабрика возвращает ProviderPort с согласованным описанием. Плагин получает конфигурацию своего endpoint и регистрацию cleanup.
- OBSERVED на Linux, Node 24.22.1: `check`, `test:contracts` (42), `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C09.2, явная загрузка.

- C09.2 — Composition загружает только доверенный список modules, пропускает disabled, локализует отказ и освобождает ресурсы неуспешной фабрики в обратном порядке. Project preferences не добавляют executable extensions.
- OBSERVED на Linux, Node 24.22.1: `check`, целевые integration-тесты конфигурации и загрузки, `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C09.3, conformance провайдера.

- C09.3 — Отдельный тестовый plugin проходит общий ProviderPort suite, включая отмену и закрытие. Сквозной сценарий проверяет выбор его профиля Controller через каталог и доставку результата штатным координатором.
- OBSERVED на Linux, Node 24.22.1: 13 целевых contract/integration-тестов, `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C09.4, источник skills.

- C09.4 — Каталог предоставляет версию, описание и ссылки на ресурсы. Инструкции загружаются для выбранного Controller handoff, с общим лимитом текста и явными причинами недоступности. Изменившаяся версия не подменяет показанную в каталоге.
- OBSERVED на Linux, Node 24.22.1: `check`, 6 целевых integration-тестов, `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C09.5, семантика ограничений skill.

- C09.5 — Worker получает буквальные ограничения skill, приоритет явных требований пользователя и действующие permissions. Тест передаёт запрет provider-native multi-agent review и проверяет, что заявление о разрешении из skill не допускает закрытый профиль.
- OBSERVED на Linux, Node 24.22.1: `check`, 10 целевых integration-тестов, `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C09.6, внешние инструменты.

- C09.6 — Проверены [MCP-каналы CLI и ACP](reports/C09/MCP_TRANSPORT.md), retrieval с привязкой к попытке и внешний инструмент со схемой, разрешением, отменой, лимитом и наблюдением. Нативные пробы: CLI получил HTTP 401, ACP истёк до prompt.
- OBSERVED на Linux, Node 24.22.1: `check`, `test:contracts` (46), `test:integration` (135), повтор целевых MCP/ExternalTool (5), `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C09.7, каталог и совместимость конфигурации.

- C09.7 — Проект выбирает установленные доступные профили и skills, а Controller получает предпочтения. Несовместимый plugin возвращает адресный статус профиля. После disable/uninstall на resume сохранены finding и provenance; новый вызов недоступного профиля отклонён без dispatch.
- OBSERVED на Linux, Node 24.22.1: `check`, 20 целевых integration-тестов, `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C09.8, документация и приёмка.

- C09.8 — Добавлено [руководство по расширениям](../docs/EXTENSIONS.md). Локально закрыты [A31/A32/A39](reports/C09/ACCEPTANCE.md) на уровне контрактов и управляемых адаптеров. Чистая установка tarball проверяет явную загрузку skill и инструмента без Git и development. Нативная проба skill вернула HTTP 401.
- OBSERVED на Linux, Node 24.22.1: `check`, `test:foundation` (4), `test:core` (15), `test:contracts` (46), `test:integration` (139), `check:package`, `check:removal`, пример из документации, `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C10.1, Composition root.

### Исправления после ревью C09

- Поздний ответ запущенного внешнего инструмента сохраняется отдельным наблюдением с исходным `callId` и `attemptId` даже после закрытия сессии провайдера. Начальный receipt и оценка эффекта сохраняются. Журнал доступен после переоткрытия store.
- Запрос разрешения показывает явно перечисленные автором инструмента скалярные поля `permissionPreviewFields`. Остальные значения скрываются. Лимит 4 КиБ отмечается в preview. Исходный ввод инструмента и standing decisions сохраняют свой контракт.
- OBSERVED на Linux, Node 24.22.1: дефекты воспроизведены на `cb49007`. После исправления прошли `check`, `test:foundation` (4), `test:core` (15), `test:contracts` (46), `test:integration` (142), `check:package`, `check:removal` и `git diff --check`. Нативная приёмка остаётся UNVERIFIED. Следующий шаг — C10.1.

## C10 — Публичный API, CLI и внешний ACP Host

- C10.1 — Composition root владеет конфигурацией, локальным store, расширениями, брокером и coordinator. Shutdown закрывает допуск, останавливает принадлежащие runtime вызовы и освобождает ресурсы. Проверка неуспешного запуска подтверждает cleanup плагина и освобождение writer lock без вызова модели.
- OBSERVED на Linux, Node 24.22.1: `check`, `test:integration` (143), `git diff --check`. Следующий шаг — C10.2.

- C10.2 — `openOrchestrator` экспортирует submit/resume/inspect/inspectFinding/cancel, подписку на типизированные события и close. Проверены независимые каталоги состояния, дедупликация requestId, отписка, форма результата и ошибки.
- OBSERVED на Linux, Node 24.22.1: `check`, 2 целевых интеграционных теста и `git diff --check`. Следующий шаг — C10.3.

- C10.3 — CLI предоставляет run/resume/inspect/cancel/diagnose/trace/export-diagnostics. Проверены аргументы, stdin Unicode, пустой ввод, non-Git cwd и разделение JSON stdout и ошибок. Trace/export используют безопасную проекцию сохранённого журнала с указанием отсутствующих данных.
- OBSERVED на Linux, Node 24.22.1: `check`, сквозной тест CLI и `git diff --check`. Следующий шаг — C10.4.

- C10.4 — Терминал показывает ресурс, описание действия и допустимые варианты. Брокер проверяет корреляцию, применяет standing decisions и гасит prompt при отмене. EOF и неинтерактивный ввод дают явный unavailable в stderr.
- OBSERVED на Linux, Node 24.22.1: `check`, 10 целевых тестов CLI и брокера, `git diff --check`. Следующий шаг — C10.5.

- C10.5 — Владелец CLI публикует локальный control endpoint после открытия writer. Запросы проверяют версию, token, конфигурацию и requestId. Потеря ответа сохраняет работу и позволяет повторить delivery с тем же id. SIGINT адресуется принятой операции. Без владельца cancel возвращает no_live_execution.
- OBSERVED на Linux, Node 24.22.1: `check`, локальный CLI, `git diff --check`. Среда вернула EPERM на bind AF_UNIX; 2 wire/process теста остаются UNVERIFIED локально и обязательны в GitHub CI. При EPERM standalone-вызов сообщает о недоступном endpoint в stderr и сохраняет single-writer lock. Следующий шаг — C10.6.

- C10.6 — Внешний `acp` использует стабильный ACP v1 SDK 2.4.0 и общий application API. Создание, загрузка с воспроизведением сохранённой истории, несколько сессий, progress и явный cancel проверены через stdio. Идентификаторы клиентской сессии генерируются независимо от cwd и сессий исполнителей.
- OBSERVED на Linux, Node 24.22.1: `check`, сквозные CLI и ACP stdio fixtures, `git diff --check`. Реальный Zed остаётся UNVERIFIED. Следующий шаг — C10.7.

- C10.7 — Внешний ACP передаёт фактическое описание и варианты через permission broker с привязкой к operation и попытке. Явный `--relay-client-tools` включает C08 bridge с согласованием возможностей конкретного клиента и scoped terminal ownership.
- OBSERVED на Linux, Node 24.22.1: `check`, 2 ACP stdio теста, включая параллельные allow/deny с одним native tool id и адресный fs relay; `git diff --check`. Следующий шаг — C10.8.

- C10.8 — ACP EOF отделён от user cancel. Принятый turn сохраняет результат после разрыва, а стабильный requestId связывается с журналом для load и повторной доставки. Проверены отказ от чужого supersession, адресная замена и продолжение в изменившемся cwd. Восстановлен ленивый импорт runtime для публичного пакета.
- OBSERVED на Linux, Node 24.22.1: `check`, 4 ACP stdio теста, 7 проверок resume/mutable context, `check:package`, `git diff --check`. Следующий шаг — C10.9.

- C10.9 — Общий fixture проверяет direct answer, delegation, partial result, permission и clarification/resume через API, CLI и внешний ACP. Отдельные сквозные проверки покрывают явную отмену, разрыв клиента, non-Git и повторную доставку. Обновлена матрица A06/A07/A16/A20/A24/A38/A40.
- OBSERVED на Linux, Node 24.22.1: 5 сквозных тестов ACP/общих поверхностей, `check:package`, `git diff --check`. Zed в среде отсутствует, нативная часть A20/A38 остаётся UNVERIFIED. Следующий шаг — C10.10.

- C10.10 — npm bin и устанавливаемый flake с Node 24, named/default packages/apps и CLI smoke. Source closure состоит из файлов продукта. Hash кэша вычислен `prefetch-npm-deps` на [GitHub Actions](https://github.com/apathoid/role-orchestrator/actions/runs/42619282319) для committed lockfile. В CI добавлены сборка, запуск обоих apps, установка во временный profile, non-Git cwd, внешний state, PATH и smoke бинарника Codex.
- OBSERVED локально на Linux, Node 24.22.1: `check`, `test:foundation` (4), `test:core` (15), `test:contracts` (46), `test:integration` (156 прошли, 2 socket-теста требуют CI), `check:package`, `check:removal`, `git diff --check`. [Проверка ветки](https://github.com/apathoid/role-orchestrator/actions/workflows/ci.yml?query=branch%3Agreenfield%2Fmodel-first-core) включает Nix и AF_UNIX. Приёмка на NixOS и в настоящем Zed остаётся UNVERIFIED.
- Реализация C10 завершена. Следующий шаг плана — C11.1, аудит событий.

### Итоговая проверка C10

- OBSERVED на GitHub Actions (Ubuntu x86_64, Node 24): [Nix build и flake check, оба apps, временный profile, запуск вне Git с внешним state, smoke Codex и интеграционные тесты с AF_UNIX](https://github.com/apathoid/role-orchestrator/actions/runs/42619871758).
- После финальной проверки усилены shutdown и корреляция CLI cancel при двух одновременно стартующих процессах. Явные launch overrides сравниваются после соединения с живым владельцем. ACP-адаптер допускает negotiation требуемого client-tool bridge с реальными возможностями сессии.
- OBSERVED локально после уточнений: `check`, `check:package`, `check:removal`, `test:integration` (157 прошли, 2 socket-теста для CI), `git diff --check`. Нативная приёмка Zed и NixOS остаётся UNVERIFIED. Следующий шаг — C11.1.
- C10.4 — Постоянные разрешения из доверенного `permissions.standing` применяются в CLI и ACP через тот же broker. Проверены отказ без prompt в запущенном CLI, отклонение неизвестного профиля/дубликата и запрет project preferences задавать правила. OBSERVED: `check`, 15 целевых проверок конфигурации, CLI и broker, `git diff --check`.

### Исправления по ревью C10

- ACP сохраняет связь операции с клиентской сессией после завершения prompt. Продолжающийся worker может запросить permission и client tool. Вызовы проверяют соединение, попытку и действующий grant. Явный terminal release очищает ownership и abort listener.
- CLI и ACP разрешают project preferences по cwd принятой или продолженной операции. Профиль, предпочтения, таймаут и лимиты применяются в одном coordinator с общим пределом параллельности. Уже допущенные workers сохраняют исходные параметры вызова.
- Local control закрывает допуск новых run/resume сразу при shutdown. Принятые запросы, их повторная доставка, inspect и cancel могут завершиться. Владелец CLI публикует endpoint до загрузки провайдеров. Ожидание готовности ограничено 30 секундами после начала инициализации. CLI может инспектировать и отменять работу живого ACP Host. Запуск и продолжение ACP work требуют его клиентской сессии.
- OBSERVED на `108c7b1`: воспроизведены потеря ACP relay после clarification и применение профиля/таймаута по умолчанию вместо project preferences. После исправлений локально прошли `check`, `test:foundation` (4), `test:core` (15), `test:contracts` (46), `test:integration` (160), `check:package` и `git diff --check`. Пять AF_UNIX проверок и чистая установка из lock выполняются в [CI ветки](https://github.com/apathoid/role-orchestrator/actions/workflows/ci.yml?query=branch%3Agreenfield%2Fmodel-first-core). Zed, реальные модельные вызовы и NixOS остаются UNVERIFIED. Следующий шаг — C11.1.
