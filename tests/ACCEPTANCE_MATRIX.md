# Матрица приёмки и регрессий

**Матрица требований и сценариев — единственная действующая копия в исходном репозитории.** M01–M04 — условия инженерной миграции, не новый runtime scope. Результаты выполнения и native gaps ведутся в [STATUS](../docs/roadmap/STATUS.md).

**Статусы реализации — в разделе наблюдений, [историческом отчёте C11R](https://github.com/apathoid/role-orchestrator/blob/cbd8e70baca3ab380a2ed3d43ae1fdd667616412/development/reports/C11R/INTEGRATION.md) и STATUS.md. A44–A53 покрыты автоматизированными тестами; A54 требует отдельной реальной native-приёмки и остаётся UNVERIFIED в native-части.** Foundation checks сами по себе не закрывают полные A41–A43. Эта матрица — задание для реализации тестов, не отчёт об успешном выполнении. Каждый будущий результат связывается с test path/run id и фактическим exit. Одно тестовое семейство может закрывать несколько строк.

Уровни: U — core/unit; C — adapter contract; I — subprocess/storage integration; E — end-to-end; N — native provider/client. Tests расположены в `tests/`, fixtures в `tests/fixtures/`, инструменты в `scripts/`; установочный package их исключает.

| ID | Требования | Сценарий и обязательное наблюдение | Уровень / владелец |
|---|---|---|---|
| A01 | R10,R25 | Build/import без Git и тестовых/инженерных каталогов; import не запускает процесс/сеть/чтение workspace | U/I C00,C12 |
| A02 | R01,R24 | Невалидные поля/version дают точный field error, корректный запрос без cwd принят | U C01 |
| A03 | R05,R23 | Дубликат request/decision/outcome не создаёт повторный dispatch; другой payload с тем же id отклонён | U/I C01,C03,C05 |
| A04 | R02,R13 | Простой вопрос -> один Controller -> final, ноль обязательных specialists/review | U/E C02 |
| A05 | R03,R16,R24 | Malformed Decision -> адресная correction, общий budget, без regex fallback/бесконечного retry | U C02 |
| A06 | R28,R16 | Уточнение/ответ продолжают тот же operation, расход и контекст сохранены | U/E C02,C10 |
| A07 | R01,R10 | В non-Git directory и без cwd работают применимые сценарии, нет git subprocess/discovery | U/E C02,C10 |
| A08 | R03,R04 | Handoff специалисту содержит цель, ограничения, выбранные refs; результат возвращён Controller | U/E C03 |
| A09 | R05 | Chain/diamond, cycle/unknown id, terminal vs model acceptance dependency различаются | U C03 |
| A10 | R03,R05,R16 | Два независимых worker выполняются одновременно, третий ждёт лимит без потери результата | U/I C03 |
| A11 | R06 | Replan добавляет/отменяет будущую работу; не меняет payload уже dispatch attempt | U C03 |
| A12 | R05,R26 | next_completion/all_requested дают правильный набор результатов; нет busy loop/duplicate Controller | U C03 |
| A13 | R03,R12,R13 | Disagreement двух моделей передан Controller; Host не голосует и не навязывает finalValidator | U/E C03 |
| A14 | R03,R13 | Неудача проверки не запускает host-fixed fix workflow; следующую операцию выбирает Decision | U/E C03 |
| A15 | R07,R08 | Review instruction не включает Host sandbox; standing permission не запрашивается повторно | U/C C04,C07,C08 |
| A16 | R08,R19 | Permission allow/deny/invalid option/late response после cancel привязаны к правильной попытке | U/C/E C04,C08,C10 |
| A17 | R09,R10 | Edit/index/branch/context change само по себе не вызывает cancel/reconcile/invalidation | U/E/N C04,C06,C12 |
| A18 | R17,R18,R24 | Required capability missing -> локальный отказ; optional streaming/usage unknown не блокирует вызов | C/I C04,C07,C08 |
| A19 | R14,R23 | Cancel до dispatch исключает внешнее действие; после dispatch сохраняет возможный эффект и provenance | U/I C03,C05 |
| A20 | R14,R18,R23 | Provider cancel/disconnect/late terminal: cleanup владельца, нет возрождения task или убийства чужого процесса | C/I/N C07,C08,C10 |
| A21 | R16 | Общий budget учитывает Controller/worker/correction/failure/resume, параллельные reservations не превышают лимит | U/I C03,C05,C11 |
| A22 | R16,R24 | Недоступная стоимость/usage явно unknown; жёсткий денежный предел не заявляется без enforcement contract | U/C C01,C03,C11 |
| A23 | R15 | Crash matrix reserve/dispatch/result/commit/ACK: никаких автоматических повторов unknown effect | I C05 |
| A24 | R15,R28 | Resume доставляет сохранённый итог без повторного worker; новый input имеет id, старый расход сохранён | I/E C05,C10 |
| A25 | R15,R26 | Unknown attempt ограничивает replay; независимое чтение/анализ другой операции продолжается | U/I C05 |
| A26 | R15,R23 | Store CAS конфликт повторяет только commit; single writer lock не блокирует проект/редактор | I C05 |
| A27 | R15,R26 | Corrupt operation / несовместимая version / disk error не скрываются и не уничтожают исправные операции | I C05,C11 |
| A28 | R15,R22 | Outcome commit неизвестен: перечитать attempt; потеря diagnostic sink не теряет durable result | I C05,C11 |
| A29 | R11,R24 | Host-observed, provider-reported, model claim, agent exit и tool exit не смешиваются | U/C C01,C06 |
| A30 | R17,R08 | Config priority/JSON path/version проверены; project config не добавляет endpoint/plugin/authority | U/I C04 |
| A31 | R20 | Новый provider plugin работает через прежний core; duplicate id/version/initialization errors адресны | C/I C09 |
| A32 | R20,R08 | Skill загружается как инструкции, не код/authority; запрет делегирования не выводится keyword heuristic | U/C C09 |
| A33 | R11,R12 | Finding reuse/supersede/disagreement сохраняют основания; нет merge по path и majority vote | U/E C06 |
| A34 | R11,R12 | Truncated/missing artifact/summary coverage видны; ограничения пользователя и unknown не пропадают | U/I C06,C11 |
| A35 | R13,R27 | Исторический PASS не выдаётся за новый; required check без подтверждения остаётся unverified в модельном fixture | U/E C06 |
| A36 | R11,R21,R22 | Retention/export/sink failure не изменяют semantic result; secrets/body capture default проверены | I C06,C11 |
| A37 | R25 | Установка пакета без tests/scripts/.agents/devDependencies/Git: clean install/build/package/API/CLI работают; в package нет fixtures | I/E C00,C12 |
| A38 | R18,R19 | Общие сценарии на двух настоящих исполнителях и внешнем ACP/Zed; версии, permissions, cancel/resume записаны | N C07,C08,C10,C12 |
| A39 | R20,R24 | External tool bridge валидирует schema, сохраняет permission/provenance; native tools не дублируются | C/I C09 |
| A40 | R21,R23,R26,R27 | Inspect/trace показывают owner/reason/budget/unknown; bounded logs и cleanup при нескольких operations | I/E/N C10,C11 |
| A41 | R29 | Product написан на JS ESM; JSDoc checker обнаруживает нарушение контракта; runtime работает без TS/checker/transpilation | U/I C00,C12 |
| A42 | R30,R25 | Locked Nix build/check, named/default apps, profile install, non-Git cwd, внешний state и работа без development подтверждены; NixOS отдельно проверен | I/E C10,C12 |
| A43 | R31 | GitHub CI фактически исполняет применимые проверки; missing обязательного harness/suite = FAIL; обязательные checks не скрыты; secrets отсутствуют | I C00,C12 |


## C12.0 — Инженерные критерии структурного перехода (проверяются по этапам)

| ID | Сценарий миграции | Проверяемый результат |
|---|---|---|
| M01 | Сохранение активного плана и инженерных знаний | После удаления `development/` агент начинает с AGENTS.md и находит в `docs/roadmap/` C12.1, статус, зависимости и действующие контракты; причины решений и отрицательные знания сохранены |
| M02 | Сохранение регрессии и обязательность CI | Каждый прежний проверяемый сценарий перенесён без ослабления assertions, tests/scripts запускаются из корня; отсутствие обязательной проверки даёт FAIL, а не ложный зелёный skip |
| M03 | Независимая установка продукта | npm tarball/Nix package вне checkout работают без tests/scripts/.agents/devDependencies/Git и не читают coding instructions; результаты с commit и exit |
| M04 | Документационная согласованность | Не осталось действующих ссылок на старые пути, scripts не создают `development/`, R25/A01/A37/A42/A43 и D10/D11/D14 обновлены, native UNVERIFIED не маскируется synthetic PASS |

M01–M04 выполняются в C12.0 и повторно проверяются в соответствующих C12.1/2/6/8/9. A01/A37/A42/A43 сохраняют действительный смысл до миграции, затем актуализируются; инженерные проверки не нужно искусственно связывать с новым runtime механизмом.

## C11R — обязательные проверки расширения (NOT RUN)

Нормативный контракт: [reasoning effort](../docs/REASONING_EFFORT.md). Шаги: [C11R](https://github.com/apathoid/role-orchestrator/blob/cbd8e70baca3ab380a2ed3d43ae1fdd667616412/development/plan/clusters/C11R_REASONING_EFFORT.md). Существующие зелёные suites не закрывают эти строки без проверки нового поведения.

| ID | Требования | Сценарий и обязательное наблюдение | Уровень / владелец |
|---|---|---|---|
| A44 | R17,R24,R32 | Config v1 без reasoningEffort и с native не отправляет override; один level допускает implicit default, несколько требуют явного; null/empty/duplicate/default вне списка дают точный JSON path; старые конфиги работают | U/I C11R.1–2 |
| A45 | R08,R17,R32 | Один xhigh у двух профилей разрешается в разные native values; новый доверенный level не требует правки core; порядок массива не выбирает default; project/skill не расширяет mapping/authority | U/I C11R.2 |
| A46 | R03,R05,R06,R32 | Параллельные workers одного профиля получают различные efforts, локальный отказ третьему не блокирует независимые actions; evidence может привести к следующему новому назначению; дубликат Decision не вызывает dispatch | U/C/I C11R.1,4 |
| A47 | R02,R03,R16,R33 | Один Controller без workers/новых внешних данных явно продолжает и меняет effort; повторные переходы в обе стороны разрешены до общего бюджета; next selection одноразовый, один активный Controller, нет forced delegation/anti-loop gate | U/I/E C11R.1,5 |
| A48 | R19,R24,R26,R33 | Неподдерживаемый стартовый/следующий собственный effort виден пользователю API/CLI/ACP; ни fallback, ни автоматического correction-вызова; независимые workers сохраняют результаты; explicit resume после допустимой настройки сохраняет operation/расход | I/E C11R.6 |
| A49 | R18,R20,R24,R32 | CLI/ACP передают точный native value перед prompt; native не меняет default; проверен launch precedence, model-specific options и однозначный selector; plugin без selectable поддержки даёт адресный отказ, native работает | C/I/N C11R.7–8 |
| A50 | R11,R13,R24,R32,R33 | Поддержанная передача без acknowledgment не блокирует результат; explicit rejection до prompt не запускает workload; mismatch после возможного dispatch сохраняет результат/эффект и не запускает replay; effort не доказательство качества | C/I C11R.7–8 |
| A51 | R05,R15,R23,R32,R33 | Crash до/после Decision/reserve/dispatch: pending выбор привязан ровно к одному attempt, позднее событие старой generation не меняет новый; старый snapshot без effort читается как not recorded; cancel не возрождается | U/I C11R.3,9 |
| A52 | R15,R17,R32 | Mapping изменён при прежнем level: прошлый route неизменен; idempotencyKey не переиспользуется для другого effective request; неизвестные исторические параметры не доказывают эквивалентность; unknown effect не превращается в none | U/I C11R.3,9 |
| A53 | R08,R16,R21,R22,R29,R32,R33 | Inspect/trace/export показывают choice/default/native value и атрибутированные факты; acknowledgment unknown не waiting; смена effort не сбрасывает ledger/grant; sink failure, redaction и evidence identity сохраняются | C/I/E C11R.7,10 |
| A54 | R18,R25,R30,R31,R32,R33 | Native probes на реально доступных CLI/ACP фиксируют versions, applied/submitted сведения, самостоятельный Controller и multi-model выбор; mocks не доказывают качество; Nix/package/removal и применимые CI suites проходят, недоступные native пути UNVERIFIED | I/E/N C11R.11–12,C12 |

Для A47 тест фиксирует разрешённость последовательности, а не предписывает модели чередовать уровни. Конечный общий бюджет — прежний ресурсный инвариант, не новая anti-loop политика. Для A50 подтверждение относится к сообщению провайдера о настройке, не к внутренним вычислениям модели.

## Правила доказательства

Mock Controller fixtures задают решения, позволяющие проверить Host. Они не доказывают реальное соблюдение инструкций LLM. Native acceptance дополнительно проверяет, что реальная модель получает достаточный контекст и может завершить задачи; её результаты не превращаются в математическую гарантию качества.

Отрицательные проверки должны контролировать forbidden effect: количество dispatch, отсутствие Git call, отсутствие повторного side effect, отсутствие секретов в экспортируемых данных. Только совпадения финального текста недостаточно.

Проверка протокола с fake ACP agent — C/I, даже если название fixture содержит native. Любой непроведённый обязательный сценарий остаётся UNVERIFIED с причиной. Нельзя менять ожидаемый результат ради прохождения, если он следует из утверждённого контракта.

## Наблюдения реализации

| ID | Состояние | Проверка |
|---|---|---|
| A01, A37, A41 | OBSERVED, foundation-часть | `check:package`, `check:removal`, `test:foundation`, в том числе отрицательная JSDoc fixture |
| A02, A03, A19, A22, A29 | OBSERVED, core-часть | `test:core`, `tests/core/core.test.js`, 6 тестов, exit 0 |
| A42, A43 | OBSERVED, Linux foundation-часть | [Foundation CI](https://github.com/apathoid/role-orchestrator/actions/runs/42388026539) |
| A04–A07, A19, A21, A24, A29 | OBSERVED, application-часть, синтетические порты | `test:integration`, `tests/integration/orchestrator.test.js`, 12 тестов, exit 0 |
| A08, A09 | OBSERVED, контракты handoff и графа | `tests/integration/handoff.test.js`, `tests/core/action-graph.test.js` |
| A08–A10, A12 | OBSERVED, сквозной scheduler с синтетическими портами | `tests/integration/delegation.test.js`; два параллельных workers, независимые операции и обе wait policies |
| A11, A13–A14, A19, A21–A22 | OBSERVED, core/application-часть | `test:core` и `test:integration`; отмена, перепланирование, неизвестные эффекты, общие лимиты и модельное разрешение разногласий |
| A18, A30 | OBSERVED, конфиг и синтетические capabilities | `tests/integration/configuration.test.js`; ограниченные project preferences, обязательный image input и неизвестный usage |
| A15–A17 | OBSERVED, Host и синтетический ProviderPort | `tests/integration/permissions.test.js`, `configuration.test.js`; отзыв grant, корреляция ответа, отмена и изменение рабочей среды |
| `A23` | OBSERVED, C05, Linux subprocess | `durable-dispatch.test.js`, девять границ SIGKILL вокруг reserve, dispatch, result, commit и delivery; фактический счётчик внешних эффектов, бюджет и корреляция revision/attemptId |
| `A24` | OBSERVED, C05 application/store | `durable-dispatch.test.js`, `resume.test.js`; сохранённый итог, новый input, текущий grant и сохранённый расход. CLI/ACP delivery относится к C10 |
| `A25` | OBSERVED, C05, синтетический провайдер | `resume.test.js`, `retry.test.js`; независимое действие при unknown и проверяемые основания retry |
| `A26` | OBSERVED, C05, Linux | `durable-dispatch.test.js`, `local-store.test.js`; повтор записи после CAS conflict и межпроцессный writer lock в state directory |
| `A27` | OBSERVED, C05, Linux и fault injection | `local-store.test.js`; повреждение/версия локальны, EROFS останавливает dispatch, запись восстанавливается без повторения эффекта |
| `A28` | OBSERVED, C05, Linux и fault injection | `durable-dispatch.test.js`; видимый неподтверждённый commit, повтор подтверждения исхода, отказ sync/async diagnostic sink |
| `A29` | OBSERVED, C06.1, синтетический ProviderPort и Linux store | `local-store.test.js`, `snapshot.test.js`: раздельные agent exit, tool exit и модельное сообщение, повторное открытие store, отказ при противоречивой атрибуции. Native adapters UNVERIFIED |
| `A33` | OBSERVED, C06.2, синтетические модели и Linux store | `local-store.test.js`, `orchestrator.test.js`: разногласие, supersedes, сохранение опор и повторное использование после открытия store, проверка ссылок и автора. Сквозная проверка кластера остаётся в C06.8 |
| `A34` | OBSERVED, C06.3, синтетический ProviderPort | `context.test.js`, `configuration.test.js`: байтовый лимит, excerpt с provenance, причины недоступности, дословные ограничения, отмены и unknown. Retrieval и summary проверяются в C06.4 |
| `A34` | OBSERVED, C06.4, синтетический ProviderPort и Linux store | `local-store.test.js`: bounded artifact fetch, отсутствие файла, выбор специалиста, точное разрешение между операциями, покрытие и авторство резюме после reopen |
| `A17` | OBSERVED, C06.5, тестовый ProviderPort и реальные изменения локальных файлов/Git | `mutable-context.test.js`, `configuration.test.js`: сохранение finding, выбор повторного чтения моделью, точное число dispatch и отсутствие отмены. Нативная часть остаётся для C12 |
| `A35` | OBSERVED, C06.6, тестовый ProviderPort и фактический subprocess | `assessment.test.js`: один tool exit до изменения, запрошенная проверка после изменения остаётся `unverified` по решению модели, проверены история, основания и количество dispatch |
| `A36` | OBSERVED, часть C06.7, локальный Linux store | `retention.test.js`: возраст/размер, сохранение истории и unknown, доступность общего blob, явный retention и повтор при ошибке unlink. Экспорт диагностики и обработка sink остаются в C11 |
| `A29`, `A33`–`A36` | OBSERVED, выход C06, синтетический ProviderPort и локальный Linux store | `context-quality.test.js`: повторное использование двух противоречащих findings, один новый dispatch специалиста, раздельные agent/tool exit, summary coverage, частичный итог, retention, трасса handoff без тел и отказ sink. Для A34/A36 экспорт, redaction и эксплуатационные пределы sink проверяются в C11. Native review UNVERIFIED |
| `A29`, `A33`, `A34` | OBSERVED, исправления C06 после ревью | `evidence-addressing.test.js`: две попытки с одной ссылкой провайдера сохраняют разные опоры после reopen. При сокращении истории Controller обнаруживает ранее неизвестную ссылку через каталог и передаёт выбранную запись специалисту. Синтетический ProviderPort и локальный store |
| `A18` | OBSERVED, часть CLI adapter | `codex-provider.test.js`, `provider-port.test.js`: обязательное интерактивное подтверждение блокируется до запуска; неизвестный необязательный usage остаётся неизвестным |
| `A20` | OBSERVED, CLI adapter и локальный Linux subprocess | `cli-process.test.js`, `codex-durable.test.js`, `provider-port.test.js`: адресная отмена и закрытие, сохранение поздних наблюдений, независимый процесс не остановлен. Нативная модель и внешний ACP остаются UNVERIFIED |
| `A38` | UNVERIFIED | [Проба Codex CLI](https://github.com/apathoid/role-orchestrator/blob/cbd8e70baca3ab380a2ed3d43ae1fdd667616412/development/reports/C07/CLI_NATIVE_PROBE.md) достигла HTTP 401 без ответа модели. Для A38 нужны успешные проверки с реальными исполнителями и ACP/Zed |
| `A16`, `A18` | OBSERVED, Generic ACP adapter и Linux subprocess | `acp-provider.test.js`: allow/deny, неизвестная опция, отмена параллельных запросов, обязательные возможности и negotiation, неизвестный usage |
| `A20` | OBSERVED, контракт ACP adapter | `acp-provider.test.js`: адресная отмена, поздний terminal, потеря транспорта, закрытие сессии и отсутствие ответа на cancel. Нативная часть UNVERIFIED |
| `A38` | UNVERIFIED, нативное рукопожатие ACP OBSERVED | [Проба Codex ACP 2.5.0](https://github.com/apathoid/role-orchestrator/blob/cbd8e70baca3ab380a2ed3d43ae1fdd667616412/development/reports/C08/ACP_ADAPTER.md) подтвердила ACP v1, но `session/new` не ответил до дедлайна. Модельный вызов и внешний клиент остаются открытыми |

### C10 — Пользовательские поверхности

| ID | Статус | Проверка |
|---|---|---|
| `A06`, `A07`, `A24` | OBSERVED, API / CLI / ACP fixture | `host-acp.test.js`, `host-cli.test.js`: уточнение, продолжение с сохранением расхода, повторная доставка без dispatch, запуск без Git |
| `A16` | OBSERVED, API / CLI / ACP fixture | `host-cli-permissions.test.js`, `host-acp.test.js`, `permissions.test.js`: реальные варианты запроса, адресный deny, unknown/late reply, отмена, unavailable |
| `A20` | OBSERVED, адаптеры и внешний ACP fixture | `host-acp.test.js`, `acp-provider.test.js`, `cli-process.test.js`: явная отмена, отсоединение транспорта, поздний результат и cleanup. Нативная часть открыта |
| `A38` | UNVERIFIED | Zed отсутствует в среде разработки. Контролируемые ACP-сессии подтверждают протокол и application semantics |
| `A40` | OBSERVED, C10 CLI presentation | Inspect показывает budget, route, attempts и unknown effects, trace/export ограничены технической проекцией журнала. Rotation и эксплуатационная приёмка относятся к C11 |
| `A42` | OBSERVED npm package и Nix x86_64-linux / Ubuntu | `check:package`, `check:removal`, [GitHub Actions](https://github.com/apathoid/role-orchestrator/actions/runs/42619871758) для `nix build`, named/default apps, profile install, non-Git cwd и внешнего state. Нативная приёмка NixOS остаётся UNVERIFIED |

## C11 — регрессионная приёмка Linux (OBSERVED)

C11.1: `tests/core/diagnostics-taxonomy.test.js` — semantics и корреляция direct/parallel/defer/recovery; C11.2: `tests/integration/diagnostic-sink.test.js` — bounded NDJSON/rotation/fault injection; C11.3: `diagnostic-redaction.test.js`; C11.4: `diagnostic-export.test.js`; C11.5: `host-cli.test.js`; C11.6: `diagnostic-races.test.js`; C11.7: `diagnostic-bounds.test.js`. OBSERVED: [CI 42799512219](https://github.com/apathoid/role-orchestrator/actions/runs/42799512219), `e980a05`, Linux x86_64, Node 24; 4/4 foundation, 19/19 core, 46/46 contracts, 181/181 integration, Nix flake/package PASS. A21/A22 подтверждены в части существующего ledger/unknown usage и пределов; A27/A28 — локальным durable store и failure-path regression; A29/A34 — контекстом и bounded diagnostics; A36 — retention, redaction, sink/export fault-injection; A40 — trace/inspect и lifecycle/race regression на fixture. Все эти пункты **OBSERVED только в соответствующей контрактной/интеграционной области**, а не end-to-end в реальном Zed. Native остаётся UNVERIFIED.

### C11 — замечания ревью (2026-11-10)

OBSERVED: [CI #42805542909](https://github.com/apathoid/role-orchestrator/actions/runs/42805542909), commit `25abd709965ddf162ef65124a3264d6f760cef89`: 4 foundation, 19 core, 46 contract, 190 integration, Nix/package PASS. `diagnostic-sink.test.js` проверяет 10 000 ошибок и backpressure stderr (P2-1); `diagnostic-export.test.js` и `runtime.test.js` проверяют redaction секретов во всех идентификаторах и route через trusted config (P2-2); `diagnostic-export.test.js` сравнивает durable event reasons/ids с core reducer (P2-3); `diagnostic-bounds.test.js`, `context.test.js` проверяют предел 1 КиБ при ссылках по 100 КиБ и доступность истории через ContextPort (P2-4); `host-cli.test.js` проверяет типы state/launch paths и неопределённость cwd (P3). Все эти подтверждения относятся к fixtures/contract/integration; нативные модели, ACP/Zed и NixOS остаются UNVERIFIED.

## C12.1 — Traceability требований к сценариям и наблюдениям

Единственный индекс R → A → regression. Это **сопоставление наличия/исполнения тестов**, а не утверждение, что каждому требованию доказан весь заявленный scope. Тесты приведены как проверяемые representatives, а не исчерпывающий список. Automated evidence: [CI 42874365595](https://github.com/apathoid/role-orchestrator/actions/runs/42874365595), Linux x86_64 / Node 24, commit `1341d75`; all mandatory root suites + package/Nix completed successfully. Native providers/Zed/NixOS отдельно UNVERIFIED.

| Требование | Сценарии | Исполненные тестовые пути / проверочные scripts | Доказанное и пробел |
|---|---|---|---|
| R01 | A02, A07, A80 | `tests/core/core.test.js`; `tests/integration/host-cli.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R02 | A04, A47 | `tests/integration/orchestrator.test.js`; `tests/integration/reasoning-controller.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R03 | A05, A08, A10, A13, A14, A46, A47, A80 | `tests/integration/delegation.test.js`; `tests/integration/reasoning-delegation.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R04 | A08 | `tests/integration/handoff.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R05 | A03, A09, A10, A12, A46, A51 | `tests/core/action-graph.test.js`; `tests/integration/delegation.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R06 | A11, A46 | `tests/integration/delegation.test.js`; `tests/integration/reasoning-controller.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R07 | A15 | `tests/integration/permissions.test.js`; `tests/contracts/acp-provider.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R08 | A15, A16, A30, A32, A45, A53, A79 | `tests/integration/permissions.test.js`; `tests/integration/host-acp.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R09 | A17, A80 | `tests/integration/mutable-context.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R10 | A01, A07, A17 | `tests/integration/host-cli.test.js`; `tests/integration/runtime.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R11 | A29, A33, A34, A36, A50, A80 | `tests/integration/context-quality.test.js`; `tests/integration/evidence-addressing.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R12 | A13, A33, A34 | `tests/integration/context-quality.test.js`; `tests/integration/assessment.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R13 | A04, A13, A14, A35, A50, A80, A81 | `tests/integration/assessment.test.js`; `tests/integration/delegation.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R14 | A19, A20, A79 | `tests/integration/durable-dispatch.test.js`; `tests/integration/cli-process.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R15 | A23, A24, A25, A26, A27, A28, A51, A52 | `tests/integration/durable-dispatch.test.js`; `tests/integration/resume.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R16 | A05, A06, A10, A21, A22, A47, A53, A80 | `tests/integration/delegation.test.js`; `tests/integration/reasoning-controller.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R17 | A18, A30, A44, A45, A52 | `tests/integration/configuration.test.js`; `tests/integration/reasoning-config.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R18 | A18, A20, A38, A49, A54, A77, A78, A80, A81, A82, A85, A86 | `tests/contracts/provider-port.test.js`; `tests/contracts/acp-provider.test.js`; `tests/integration/codex-provider.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R19 | A16, A38, A48, A81, A84, A86 | `tests/integration/host-acp.test.js`; `tests/integration/host-cli.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R20 | A31, A32, A39, A49 | `tests/contracts/plugin-api.test.js`; `tests/integration/extensions.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R21 | A36, A40, A53, A77, A78, A79, A80, A82, A83, A84, A85 | `tests/integration/diagnostic-export.test.js`; `tests/core/diagnostics-taxonomy.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R22 | A28, A36, A53, A77, A83, A84, A85 | `tests/integration/diagnostic-sink.test.js`; `tests/integration/durable-dispatch.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R23 | A03, A19, A20, A26, A40, A51, A78, A79, A82, A83, A84, A85 | `tests/integration/cli-process.test.js`; `tests/integration/local-control.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R24 | A02, A05, A18, A22, A29, A39, A44, A48, A49, A50 | `tests/integration/configuration.test.js`; `tests/integration/codex-output.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R25 | A01, A37, A42, A54 | `tests/foundation/foundation.test.js`; `scripts/check-package.mjs` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R26 | A12, A25, A27, A40, A48, A78, A80, A85, A86 | `tests/integration/local-store.test.js`; `tests/integration/durable-dispatch.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R27 | A35, A40, A81 | `tests/integration/diagnostic-export.test.js`; `tests/integration/host-cli.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R28 | A06, A24 | `tests/integration/resume.test.js`; `tests/integration/host-acp.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R29 | A41, A53 | `scripts/check-javascript.mjs`; `tests/foundation/foundation.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R30 | A42, A54, A81 | `scripts/check-nix-install.sh`; `.github/workflows/ci.yml` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R31 | A43, A54, A77, A80, A81, A82, A83, A84, A85, A86 | `.github/workflows/ci.yml`; `scripts/check-specification.mjs` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R32 | A44, A45, A46, A49, A50, A51, A52, A53, A54 | `tests/integration/reasoning-delegation.test.js`; `tests/contracts/acp-provider.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R33 | A47, A48, A50, A51, A53, A54 | `tests/integration/reasoning-controller.test.js`; `tests/integration/reasoning-failure.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |

### Неподтверждённые условия и отсутствие ложного PASS

- A38 и A54: два независимых реальных агента, Codex CLI/ACP модель, Zed, native thought-level и реальный расход — **UNVERIFIED**. Наличие разрешённого select-option/CLI flag не является подтверждением глубины мышления.
- A17/A20/A40: сценарии изменения workspace/cancel/diagnostics с subprocess и fixture — OBSERVED; произвольный реальный провайдер, side effects и внешний клиент требуют native пробы.
- A41/A42/A43: JS/checkJs, npm/Nix flake и Linux install вне checkout подтверждены на `1341d75`; запуск на настоящем NixOS, другие CPU/OS и реальное ACP окружение не подтверждены.
- M01: active roadmap/STATUS и AGENTS/.agents существует; проверен закончившийся CI после удаления `development`. Независимый новый coding-agent launch **UNVERIFIED**.
- M02: все 54 исходных test-файла перенесены, 4 обязательные suites и packaging checks исполнились, missing обязательных suites должен FAIL; semantic equivalence дополнительно рассматривается в C12.2.
- M03: synthetic clean npm/Nix вне checkout **OBSERVED в CI**; для native providers — UNVERIFIED.
- M04: docs/spec checker успешно прошёл на дереве без `development`; historical Git links остаются историческими, не runtime зависимостями.

## C12 — завершённый Linux CI baseline, незакрытые native обязательства (2026-11-10)

**OBSERVED:** [CI 42878217644](https://github.com/apathoid/role-orchestrator/actions/runs/42878217644), commit `70ababf`, Linux x86_64 / Node v24.21.0, SUCCESS: foundation 4/4, core 25/25, contracts 52/52, integration 217/217, acceptance 4/4, total 302/302, plus clean npm tarball, Nix flake/build/profile, actual NixOS module *evaluation* and checksum/reproducible archive. This is the latest complete automated acceptance evidence for C12.0–.2/.5–.9 and M01–M04 within the Linux/synthetic scope. It does **not** close native A38/A54 or all native portions of A17/A20/A40–A43/A49–A53; two real independent LLM sessions, real Zed client and NixOS live host remain **UNVERIFIED**. The single operational status is [roadmap STATUS](../docs/roadmap/STATUS.md), and the reproducible native verification protocol is [NATIVE_ACCEPTANCE](../docs/roadmap/NATIVE_ACCEPTANCE.md).

### C12R regression additions

| Acceptance | Regression evidence |
|---|---|
| A08, A32, A38 | `tests/integration/handoff.test.js`, `extensions.test.js`, `codex-provider.test.js`, `tests/contracts/acp-provider.test.js`: selected skill material/metadata, scope, unavailable/truncated and actual subprocess/ACP prompt. Regression PASS on C12R implementation HEAD; native behavior UNVERIFIED. |
| A09–A12, A19–A26, A28, A40, A44–A54 | `reasoning-failure.test.js`, `reasoning-controller.test.js`, `resume.test.js`: local Controller failure, ready reservation fairness, mixed durable worker recovery; regression PASS. |

C12R.4 regression additions: `tests/integration/context.test.js` (ambiguous legacy references, directory/fetch cause, oversized missing/retained/present artifact); existing `evidence-addressing.test.js`, `context-quality.test.js`, `mcp-context.test.js` and finding/summary tests cover scoped historical retrieval and attribution. Regression PASS on the implementation HEAD.

C12R.5: ACP contract tests distinguish observed output cap and malformed terminal; orchestration tests verify retained slot, addressed cleanup reason and late detach. Existing cancellation, partial output, process ownership and recovery fixtures remain required. Native deep failure cause is UNVERIFIED.

C12R.6.1–6.4: `tests/integration/c12r-coordination.test.js` combines chosen skill scope and actual rendered prompt, independent worker effort, addressed rejection, opposing findings and canonical evidence, model-chosen verification and high next-Controller effort, and partial final Assessment. Existing `delegation.test.js`, `reasoning-controller.test.js`, `reasoning-delegation.test.js` and `orchestrator.test.js` retain the distinct direct/one/multiple/continue/cancel/replan paths. Fixture strategies demonstrate available decisions, not actual model selection or improved quality. No new runtime workflow or mandatory review. Regression PASS.

**C12R.7 OBSERVED:** [CI 42973275738](https://github.com/apathoid/role-orchestrator/actions/runs/42973275738) on `4ecf0e50fa4d8ce70644d3c925190a8b0abff298`, Linux x86_64 / Node v24.21.0, SUCCESS, 310/310 (foundation 4, core 25, contracts 53, integration 224, acceptance 4), zero failed/skipped; root repeat, package/clean install, Nix flake/build/install and NixOS module evaluation PASS. Historical baseline 302/302 verified on `6ce64e9`. Existing R/A/M requirements unchanged; C12R.2 snapshot provenance and C12R.3 durable contract/diagnostic categories pass the expanded reasoning-snapshot/orchestrator tests. Native model choice, effort effectiveness, skill auto-discovery impact, original deep PROTOCOL_ERROR cause, actual CLI/ACP independence, live Zed and real NixOS remain UNVERIFIED. No native quality or efficiency improvement inferred from fixture counts. See [STATUS](../docs/roadmap/STATUS.md) and [NATIVE_ACCEPTANCE](../docs/roadmap/NATIVE_ACCEPTANCE.md).

### C12R.8 — адресные регрессии и пределы evidence (2026-11-11)

| Приёмка | Измеримый scope | Результат |
|---|---|---|
| A08, A29, A33, A34 | `tests/integration/context.test.js`, `evidence-addressing.test.js`, `context-quality.test.js`, `handoff.test.js` — per-Attempt refs, ambiguity, known unavailable reasons, selected worker context без обязательного Host file discovery | Существующий C12R.4 regression **PASS**; никакой новый defect не обоснован; реальный native output gap **UNVERIFIED** |
| A18, A20, A34, A38 | `tests/integration/retrieval-guidance.test.js` (2), `mcp-context.test.js` (2 transport variants) — optional model-selected retrieval instructions, действительный MCP list/fetch и Assessment | **PASS**, fixture/transport; native model choice **UNVERIFIED** |
| A18, A20, A40 | `tests/integration/mcp-bridge-limits.test.js` (3) — bounded loopback MCP, 64 уникальных calls, idempotent ID, 4-way concurrency peak, request/response limit; `tests/contracts/external-tools.test.js` сохраняет cancellations/permission | **PASS**, технические границы проверены; их достаточность для long-running native tasks **UNVERIFIED** |
| A08, A15, A32, A38, A54 | `handoff.test.js`, `c12r-coordination.test.js`, ACP/CLI contract fixtures — skill status/version, отсутствие Host semantic selection, реальные subprocess/tool prompt deliveries | **PASS в fixture scope**, native provider skills, Zed, independent providers **UNVERIFIED** |

**OBSERVED:** [CI 43022735065](https://github.com/apathoid/role-orchestrator/actions/runs/43022735065) и [43022743035](https://github.com/apathoid/role-orchestrator/actions/runs/43022743035) на `8506ec0aeda9996d4fa8cfdca9042b131efe196f`, Linux/Node 24, 315/315, 0 failed/skipped; root `npm test`, `npm run check`, package/removal, Nix/check/build/install и NixOS evaluation PASS. Это проверка source/fixture/CI, **не** нативная приёмка. Клиенты Zed, две независимые настоящие LLM с tools, реальные tool permissions/cancel/recovery, NixOS native и comparative quality/performance **UNVERIFIED**; см. [STATUS](../docs/roadmap/STATUS.md).

### C12R.8R — корректирующая техническая регрессия (2026-11-11)

| Сценарии | Фактически проверенная граница | Результат / остающийся gap |
|---|---|---|
| A18, A20, A28, A34, A40, A50 | `tests/integration/mcp-bridge-limits.test.js`: полный MCP HTTP JSON-RPC response budget, корректный post-execution `ToolResult` с `status/effect/callId/ref`, nonconforming fallback effect unknown, bounded projection без изменения durable receipt; actual `createExternalToolPort` read/write/unknown и отдельная oversized реализации `AttemptTools` | CI PASS; обычный ToolPort не достигает oversized fallback по штатному bounded output. Реальный native MCP overflow UNVERIFIED |
| A20, A25, A28, A40 | `tests/integration/mcp-bridge-limits.test.js`, `tests/contracts/external-tools.test.js`, `external-tool-review.test.js`: совместный call budget history/external в обоих порядках; 4 active + peak 5, duplicate/conflicting/non-finite ID, cancellation/late unknown receipt, закрытие transport, независимая другая operation/bridge и reopen локального Store | CI PASS на loopback/fixtures и local durable state; реальные native adapters/permissions после аварии UNVERIFIED |
| A04, A08, A13, A34, A38, A54 | `tests/integration/retrieval-guidance.test.js`: direct Controller без обязательного retrieval при опубликованных MCP tools; `mcp-context.test.js`: explicit history fetch/Assessment; `context-quality.test.js`, `c12r-coordination.test.js`: divergent findings, truncation, replan | Synthetic paths PASS. Содержательное решение настоящей модели и native A/B quality/performance comparison UNVERIFIED |

**OBSERVED:** [GitHub Actions 43030150864](https://github.com/apathoid/role-orchestrator/actions/runs/43030150864) и [43030159396](https://github.com/apathoid/role-orchestrator/actions/runs/43030159396) на `4c3f324e11b8d7ab851f893bafcbd492fd03f26d` — SUCCESS, 324/324, 0 failures/skipped; repeated root `npm test`, npm check, package/removal, Nix flake/build/install и NixOS **evaluation**. Синтетика не заменяет native C12.3/C12.4/A38/A54 или сравнительный real-model benchmark. Детали и ограничения — в [STATUS](../docs/roadmap/STATUS.md), будущий протокол — в [NATIVE_ACCEPTANCE](../docs/roadmap/NATIVE_ACCEPTANCE.md).


## C12R.9 — непрерывность Controller / проверка качества

| Контракт | Automated regression | Native quality / performance |
| --- | --- | --- |
| Отсутствие 128-record cap, 64+ КиБ, несколько Controller turns | `context-continuity.test.js`, `evidence-addressing.test.js`, `context.test.js` (CI outcome привязан к commit) | UNVERIFIED |
| Inline technical duplication без потери raw refs и провайдерского provenance | `context-continuity.test.js` и существующие evidence tests | UNVERIFIED |
| Шесть раздельных byte budgets, legacy alias и MCP fetch | `configuration.test.js`, `context.test.js`, `mcp-context.test.js` | UNVERIFIED |
| Derived operation map, completed uncertainty, bounded history | `context-continuity.test.js`, `resume.test.js` | UNVERIFIED |
| No-MCP optional request refs/cursor + прямое завершение + native tools | `context-continuity.test.js`, `retrieval-guidance.test.js`, `handoff.test.js` | UNVERIFIED |
| Provider ACK, memory/tokens, comparative A/B/C, Zed, NixOS runtime | **NOT ESTABLISHED** синтетикой; точные значения только при наблюдении | UNVERIFIED |

Сравнение baseline 64 КиБ / исходный код 256–512 КиБ / исправленная архитектура с одинаковыми real model, provider/adapter/skills, task, workspace и permissions остаётся обязательной частью native acceptance; число Workers или synthetic PASS само по себе не доказывает качество. Отдельная матрица C12R.9 не создаётся.


### C12R.9 review P1/P2 — адресные проверки (отдельно от настоящих моделей)

| Поведение | Автоматизированный путь | Статус приёмки native |
| --- | --- | --- |
| Не дублировать совпадающее по adapter-proof final Worker body | `tests/integration/codex-provider.test.js` (real CLI subprocess), `tests/contracts/acp-provider.test.js` (real ACP protocol subprocess), `context-continuity.test.js` (independent equal-text claims остаются) | UNVERIFIED |
| Не терять факт неизвестных эффектов / отмен / dispatch / pending при переполнении | `tests/integration/context-continuity.test.js`: 200 possible-effect attempts, 200 cancellations, unknown terminal, active dispatch, 1-byte budget, workCursor | UNVERIFIED |
| Позиция и raw source provenance без MCP | `context-continuity.test.js` positional nextController; `context-chunks.test.js` giant-ref/denied/stale/bad refs | UNVERIFIED |
| Сохранённые >64/128 КиБ без семантического Host compaction | `context-chunks.test.js`: UTF‑8/base64, chunks, full/truncated artifact, SHA‑256/integrity/retention, cancel, reopened store, MCP, no‑MCP Controller turns | UNVERIFIED |
| Текущие бюджеты независимы и alias только Controller | `configuration.test.js`, `context.test.js`, `mcp-context.test.js`, `context-chunks.test.js` | UNVERIFIED |

Итоговая строка **automated regression verified** должна ссылаться на конечный green CI и его точный HEAD; успешный исходный C12R.9 commit `1633a30` не подтверждает эти review fixes.

### C12R.9 review — фактический статус CI после кодовых исправлений

**OBSERVED:** исходный `1633a30` — два SUCCESS workflows (см. [STATUS](../docs/roadmap/STATUS.md)). Review code через `edc0f8a` содержит регрессии для Codex CLI/ACP, полной технической карты, stale/ambiguous/denied positional refs, состояния после restart, 64/128 КиБ byte-chunks (включая malformed UTF‑16), missing/retention/in-flight cancel и no-MCP Controller. Исторически адресные тесты ожидали GitHub Actions из-за застрявших jobs. Последующий полный CI на `daefdbc` (43106917665) и исторический runtime `d57c11e` (43174314648) SUCCESS; промежуточные FAIL не являются текущим состоянием. Нативная модель/Zed/NixOS и сравнительная A/B/C приёмка — **UNVERIFIED**. Не менять эту матрицу на PASS до наблюдённого SUCCESS итогового SHA.

### C12R.9 повторное ревью — независимость транспортов и performance

| Проверка | Наблюдаемая регрессия | Native status |
| --- | --- | --- |
| Controller 8 КиБ + ContextPort 64 КиБ | `context-chunks.test.js`: optional model-selected Controller continuation, несколько base64 частей, непрерывные `offset/nextOffset`, полное восстановление сохранённого UTF-8 | UNVERIFIED |
| `fetchMaxBytes=128 КиБ` + per-call `maxBytes=4096` | `context-chunks.test.js`: все части укладываются в ограниченный сериализованный ответ, malformed limits reject | UNVERIFIED |
| `fetchMaxBytes=512 КиБ` + MCP 256 КиБ | `context-chunks.test.js`: ответ MCP включая JSON-RPC не превышает transport bound; nextOffset даёт возможность собрать весь body | UNVERIFIED |
| Последняя страница / нулевой прогресс workMap | `context-continuity.test.js`: нет phantom nextCursor, budget stall и invalid cursor различаются | UNVERIFIED |
| Повторное чтение 4 МиБ артефакта через разные ContextPort | `context-chunks.test.js`: actual I/O bytes не увеличиваются пропорционально числу страниц; stat-backed SHA cache, corruption/missing/caller mutation | UNVERIFIED |

Synthetic subprocess/CI PASS не означает проверенного качества поведения настоящих моделей. Итоговые results — только в STATUS и CI конечного HEAD.

### C12R.9 повторное ревью — workMap continuity and disposition

| Проверка | Regression | Status |
|---|---|---|
| Growing Controller history / stable journal-prefix pages | `context-continuity.test.js`, real orchestrator nextController.contextRequest, exactly one row per page, new retry Worker, no skips/repeats | **PASS (synthetic)** |
| Accepted-only execution disposition, cancellation/effect, duplicate admission | `context-continuity.test.js`, authoritative applyEvent/admitActions transitions, deferral vs terminal, omitted cancellations preview | **PASS (synthetic)** |
| Mutable lifecycle and durable cursor | accepted→Attempt, late outcome, retry, file-store reopen and real Controller recovery, snapshot decode | **PASS (synthetic)** |
| End, invalid cursor, budget | explicit end/stall and invalid historical offset; strict v1 Decision validation | **PASS (synthetic)** |

**OBSERVED:** [CI 43174314648](https://github.com/apathoid/role-orchestrator/actions/runs/43174314648) на `d57c11ee414de13d8451202d28a9b19a36f0edd1`, 367/367 (280 integration), 0 failures/skipped, checkJs, package, Nix build/install and NixOS evaluation SUCCESS. Native integration и comparative real-model quality/performance остаются **UNVERIFIED**.

### C12R.9 final P2 — history directory (synthetic)

| Проверка | Regression (`history-directory.test.js`) | Result |
|---|---|---|
| Growing prompt-only Controller directory | 256 KiB and 6000-byte budgets, 31 observations/Decision per turn, findings, new Worker, exact prefix and fresh traversal | PASS |
| Page size/count/visibility/positional refs | 32/8192, long refs, selected scope, invalid/end/closed | PASS |
| Partial delivery | refs consume budget, materialization and final packing, zero rows, tiny error/end coverage | PASS |
| Late observation/outcome | stable prefix membership and event-local positions, ambiguous legacy slot, canonical body | PASS |
| MCP | actual HTTP context_list across bridges with growing journal, same cursor contract | PASS |
| Recovery | snapshot encode/decode, file-store reopen, real Controller continuation | PASS |
| Decision v1 | structured cursor, 0, legacy numeric decode, malformed reject; contextCursor independent | PASS |

**OBSERVED:** [CI 43183117068](https://github.com/apathoid/role-orchestrator/actions/runs/43183117068) на `2cff795bcf851f05cba7febd1d7dc740bab99d96`, 375/375 (288 integration), 0 failed/skipped/cancelled; checkJs, package, Nix build/install, NixOS evaluation SUCCESS. Native real models/Zed/NixOS runtime and comparative quality/performance remain **UNVERIFIED**.


### C12R.10 — Controller contract and transport (synthetic)

| Проверка | Regression | Evidence status |
|---|---|---|
| Shared Decision v1 example, required findingRefs, actual ids and admission; exact user answer | `controller-contract.test.js` (direct structured ProviderPort, Markdown/Unicode/JSON string) | **PASS (synthetic)** |
| Actual CLI/ACP prompt and text parsing/correction | `codex-provider.test.js`, `acp-provider.test.js`, `acp-contract-agent.js`: current cursor types, invalid JSON/non-object/depth/missing field, preserved tool effects and exact answer | **PASS (synthetic)** |
| Strict contract and no repair | `controller-contract.test.js`, existing core decoder tests and `orchestrator.test.js`: fenced/malformed, valid primitives, array, depth, field/enum/admission, bounded correction | **PASS (synthetic)** |
| Explicit Host Catalog rejection, independent Workers and permissions | `controller-contract.test.js`, existing `handoff.test.js`, `delegation.test.js`, `permissions.test.js`, CLI/ACP contract regressions | **PASS (synthetic)** |
| Invalid Decision with proposed additions, live accepted Worker and unknown effect | `controller-contract.test.js`: no rejected dispatch or replay; existing recovery/cancel tests preserve provenance | **PASS (synthetic)** |
| C12R.9 pagination, bounded context, positional refs, recovery, and prior native obligations | existing `context-continuity.test.js`, `history-directory.test.js`, `context-chunks.test.js`, other suites | **PASS (synthetic)** |

**OBSERVED:** [CI 43247177766](https://github.com/apathoid/role-orchestrator/actions/runs/43247177766) on `823b993fee85298fdc3d99431ada67f8436e8c33`: 381/381, 0 failed/skipped/cancelled, full root npm test and all Nix/package/specification checks SUCCESS. The evidence-only follow-up has its own CI; [STATUS](../docs/roadmap/STATUS.md) records the actual verified implementation SHA. Real models, real Zed, NixOS runtime and comparative quality/performance remain UNVERIFIED; synthetic PASS is not native acceptance.


### C12R.10R — transport clarity and native transparency (synthetic)

| Проверка | Regression | Evidence status |
|---|---|---|
| Decision A in ordinary native tool result; final A, B or invalid | tests/contracts/acp-provider.test.js, tests/fixtures/acp-contract-agent.js: actual ACP SDK/subprocess tool_call/update, observe gate before end_turn, no premature admission/reservation/Worker, final admission or correction; source/ref and outcome | **PASS (synthetic)** |
| Same three variants, including fenced final text | tests/integration/codex-provider.test.js: actual CLI JSONL command_execution and agent_message, exit/turn contract, accepted/reserved/dispatched action and actual Worker output, tool/agent/model provenance | **PASS (synthetic)** |
| Model-facing boundary, nested refs and optional reason | tests/integration/controller-contract.test.js, codex-provider.test.js and ACP prompt fixture: actual delivered instructions, valid example, missing findingRefs, reason:null rejection and omitted reason success | **PASS (synthetic)** |
| Native transparency and optional history | ACP native subagent tool observation without bridge/Host Worker; missing no-MCP ref without phantom Action; existing capability/Catalog/permissions/context/recovery/cancellation tests | **PASS (synthetic)** |
| Prior Decision message A, later B; tool-only turn; prior A and no new message | acp-provider.test.js / acp-contract-agent.js / codex-provider.test.js: actual transport, journal/admission/reservation/dispatch, ACP observe gate, named vs anonymous, CLI missing message technical waiting | **PASS (synthetic)** |
| ACP result provenance across output resets | anonymous prior message / new empty named message: no stale outputObservationRef, earlier observations retained; correction without fallback | **PASS (synthetic)** |
| Exact optional reason and current prompt payload | controller-contract.test.js: null/empty/whitespace rejected; omitted/non-empty accepted unchanged. Actual direct/ACP/CLI Controller payload and Worker envelope separation | **PASS (synthetic)** |

Synthetic wire events prove adapter and Host coordination only, not real LLM comprehension or quality. **OBSERVED:** [CI 43305179978](https://github.com/apathoid/role-orchestrator/actions/runs/43305179978) on `c10b323f28ccbe0ee05b3f815640d0415ab452e0`, 389/389 root tests, 0 failures/skips/cancellations; all required Nix/package/specification checks SUCCESS. See [STATUS](../docs/roadmap/STATUS.md). Review follow-up **OBSERVED:** [CI 43308261449](https://github.com/apathoid/role-orchestrator/actions/runs/43308261449) on `9e80b19641f9e3df2aaa89a807e553121d0553e1`: 398/398 root tests, 0 failures/skips/cancellations; full required Nix/package/specification checks SUCCESS. Red baseline [CI 43307699883](https://github.com/apathoid/role-orchestrator/actions/runs/43307699883) on `028c9b8` reproduced stale ACP result identity; fixed in `36bb276`. Real native C12R.10.7/.10R.7 and prior native obligations remain UNVERIFIED.

### C12R.10R follow-up — evidence attribution and ACP teardown

| Контракт | Регрессия | Статус |
|---|---|---|
| Matching trusted Host observation preserves Outcome source; exit, aliases, Attempt isolation and late history unchanged | `evidence-addressing.test.js`, `orchestrator.test.js`, actual ACP reasoning/process `acp-provider.test.js` with ContextPort and durable reopen | **PASS (synthetic)** |
| ACP intentional close identity vs genuine stream errors, first teardown and cancellation/deadline, invalid Decision and partial evidence | `acp-provider.test.js` actual SDK fixture, `cli-process.test.js` real subprocess and injected cleanup EPERM | **PASS (synthetic)** |

**OBSERVED:** [CI 43468204790](https://github.com/apathoid/role-orchestrator/actions/runs/43468204790), job 132032898957, implementation SHA `699237ecfb41990bf9875d5625ee956a7d04354a`: full npm test 408/408 (4 foundation, 25 core, 67 contracts, 308 integration, 4 acceptance), zero failed/skipped/cancelled; all specification/checkJs/import, package/removal/clean install, Nix flake/build/install/NixOS evaluation, release evidence and unchanged lock-file checks SUCCESS. F0 SDK close identity observed on the existing synthetic ACP subprocess fixture. Native integration and comparative quality/performance remain **UNVERIFIED** (F4; see [STATUS](../docs/roadmap/STATUS.md)); no real model or real Zed/NixOS runtime acceptance claimed.

## C13 — Interaction and activity engineering acceptance

| ID | Требования | Сценарий и обязательное наблюдение | Уровень / владелец |
|---|---|---|---|
| A55 | R11,R18,R21,R22 | Optional bound activity, equal/missing native IDs, no subscriber/slow/throwing, identical model context/journal/dispatch: `tests/integration/activity.test.js` | C/I C13.1,.3,.6 |
| A56 | R08,R18,R19,R23 | Actual SDK raw/negotiated capability, explicit extension route, scoped request/reply/notification, wrong owner, permissions/FS: `tests/contracts/acp-extension-probe.test.js`, `tests/integration/host-acp.test.js` | C/I C13.2 |
| A57 | R11,R18,R21 | Actual ACP/CLI subprocess native events before terminal, unchanged observations/output, no inferred audience/finding: `tests/contracts/acp-provider.test.js`, `tests/integration/codex-provider.test.js` | C/I C13.3 |
| A58 | R08,R14,R16,R19,R28 | Live native input, manual/handler ownership, correlation, duplicate/late/invalid reply, deadline, cancel, standard ACP form: `tests/integration/interactions.test.js`, `tests/integration/host-acp.test.js` | I C13.4 |
| A59 | R21,R22,R23,R26 | Count/byte bounded delivery, gap, sink isolation, oversized activity, local owner token/scope/answer binding and same result: `tests/integration/delivery.test.js`, `tests/integration/local-control.test.js` | I C13.5 |
| A60 | R01,R03,R09,R10,R13,R16,R18,R31 | Parallel workers, non-Git changed file, deterministic no/fast/slow/throwing comparison, actual counts and fixture metrics, all prior mandatory suites; `tests/integration/activity.test.js`, existing delegation/recovery/context/skills/reasoning/permissions tests | I/E C13.6 |
| A61 | R13,R18,R19,R27,R30,R31 | Two actual executors/client, comparable before/after task/model/effort/budgets, native activity/interaction/clarification/continuation/cancel/relay/skills, real usage/latency and completeness; unavailable channels UNVERIFIED | N C13.7 |

C13.0–.5 fixture and CI evidence is recorded in [STATUS](../docs/roadmap/STATUS.md). C13.6 current full CI and C13.7 native/comparative remain separately tracked there. No fixture or provider installation is native acceptance.

**C13 engineering OBSERVED:** [CI 43649941333](https://github.com/apathoid/role-orchestrator/actions/runs/43649941333) exact `01457b373cf5bd8946d04031bb7a9fc1f247d00a`, 424/424, zero failures/skips/cancellations, all mandatory checks. A55–A60 fixture/engineering PASS. A61 actual native/comparative **UNVERIFIED**, blockers and next probes in [NATIVE_ACCEPTANCE](../docs/roadmap/NATIVE_ACCEPTANCE.md#c137--actual-native-and-comparative-disposition). No F4/C12 native closure.


## C14 — Client presentation acceptance

| ID | Требования | Сценарий и обязательное наблюдение | Уровень / владелец |
|---|---|---|---|
| A62 | R18,R21,R22 | Pure modes, native source/scoped IDs, accepted findings vs live reports, safe terminal display, gap and partial outcome: `tests/integration/presentation.test.js` | I C14.1 |
| A63 | R08,R14,R19,R22,R23 | Direct/attached CLI owner, permission options, native form, selection/EOF/cancel/unavailable, machine stdout compatibility: `tests/integration/cli-ux.test.js`, `host-cli.test.js`, `local-control.test.js`, actual Linux PTY transport fixture `tests/pty/cli.test.js` | I C14.2,.4 |
| A64 | R08,R18,R19,R21,R23 | Actual SDK standard ACP native thinking/tool/plan, scoped parallel IDs, no synthetic updates or ambiguous messages, final once/load/clarification/background routing: `tests/integration/host-acp.test.js` | I C14.3 |
| A65 | R01,R03,R09,R11,R13,R16,R18,R21,R26,R31 | All existing mandatory C13/baseline tests; identical deterministic execution across delivery modes, bounded slow/failing consumers and gap handling; CLI mode compatibility and SDK transport checks; installed package and Nix checks | I/E C14.4 |
| A66 | R13,R18,R19,R27,R30,R31 | Actual native executors/model settings, real CLI terminal and Zed/graphical client, native input/tools/finding as supported, matched comparative task/quality/latency; precise UNVERIFIED per unavailable capability | N C14.5 |

**C14 engineering OBSERVED:** [CI 43651158169](https://github.com/apathoid/role-orchestrator/actions/runs/43651158169), exact `42f65def24649dd28360c3ea8fc553e187206493`, 432/432 root tests plus 2/2 actual Linux PTY transport fixtures; zero failures/skips/cancellations, all mandatory checks including Nix/package/release evidence. A62–A65 engineering/fixture PASS. A66 real native model/client and comparative quality/performance **UNVERIFIED**; precise blockers and executable probes in [NATIVE_ACCEPTANCE](../docs/roadmap/NATIVE_ACCEPTANCE.md#c145--actual-native-and-comparative-disposition). No real LLM or graphical widget claim; A61/F4/C12 native obligations remain open.


## C13R / C14R — corrective interaction and presentation acceptance

| ID | Требования | Проверяемый сценарий / тесты | Уровень |
|---|---|---|---|
| A67 | R08,R14,R19,R23 | Reply rejection, lost-before/lost-after, timeout, parallel pending, polling failure, EOF/no automatic replay: `tests/integration/local-control.test.js` C13R.1 | I/socket |
| A68 | R08,R14,R19,R23 | Original work binding reconnect after last owner disconnect, settled input rejected, observer/no capability escalation, no redispatch: `local-control.test.js` C13R.2, C14 view; `tests/pty/cli.test.js` attached | I/PTY |
| A69 | R21,R22,R26,R31 | Ordered bounded normal finish, blocked/throwing/disconnected consumer, gap, no replay, final independently: `delivery.test.js`, `cli-ux.test.js`, `local-control.test.js`, `host-acp.test.js`; C14R.5R actual Writable callback/throw/error/close/timeout/late callback and final independent | I |
| A70 | R11,R18,R21,R27 | Long actual Codex subprocess beyond raw capture, result/terminal/usage/exit/evidence limits and malformed/oversized/incomplete stream, explicit late denial, no/fast/slow/throwing consumer equivalence: `codex-output.test.js`, `codex-provider.test.js`, existing process regressions; C13R.4R 1100 small commands journal/refs/fetch/snapshot, tiny/large byte bounds and exact omission | I/subprocess |
| A71 | R18,R21,R23 | ACP anonymous/identified native source and scoped IDs, Codex item identity: `presentation.test.js`, `host-acp.test.js` C14R.1 | I/SDK |
| A72 | R08,R14,R19,R23 | Old Worker A while new prompt B, permission/form/FS/extension request/notification and return to A: `host-acp.test.js` C14R.2 | I/SDK |
| A73 | R21,R22 | Consecutive native text only, parallel source switch and input boundary: `cli-ux.test.js`, `tests/pty/cli.test.js` C14R.3 | I/PTY |
| A74 | R18,R21,R22,R26,R31 | Measured repeated full snapshot cost; immutable scoped committed findings, no sink/unscoped body, bound invocation identity: `local-control.test.js`, `delivery.test.js`, `host-acp.test.js` | I |
| A75 | R21,R22 | Human TTY final/clarification escape/control display; Unicode/newline and raw JSON/redirected stdout preserved: `tests/pty/cli.test.js`, `host-cli.test.js`, `presentation.test.js`; C14R.5R broken CLI Writable does not change direct JSON or attached terminal result/permission | I/PTY |
| A76 | R18,R21,R22,R23 | Negotiated standard ACP notices, actual lifecycle/accepted findings, no notice without capability, no load replay/new-prompt contamination: `host-acp.test.js` C14R.6 | I/SDK |

C13R/C14R actual baseline and per-step evidence in [corrective roadmap](../docs/roadmap/C13R_C14R_INTERACTION_RELIABILITY.md) and [STATUS](../docs/roadmap/STATUS.md). A67–A76 engineering fixture PASS: [CI 43688606063](https://github.com/apathoid/role-orchestrator/actions/runs/43688606063), exact implementation/documentation SHA `bd2c93333e1f1d7851ad4b2d5955236c4f43b89e`, 448/448 root + 4/4 actual Linux PTY, zero failures/skips/cancellations, all mandatory package/Nix/release/lock checks SUCCESS. A61/A66 and F4/C12 real model/client and comparative obligations remain UNVERIFIED; see [NATIVE_ACCEPTANCE](../docs/roadmap/NATIVE_ACCEPTANCE.md).


**C13R.4R / C14R.5R final corrective engineering PASS:** [CI 43691063762](https://github.com/apathoid/role-orchestrator/actions/runs/43691063762), exact combined implementation SHA `b1ae0c88c54fdb99c3c39ecc01c97bf3288c329d`, 455/455 root + 4/4 actual Linux PTY, zero failures/skips/cancellations, all mandatory package/Nix/release/lock checks SUCCESS. Existing A69/A70/A75 coverage extended, seven new integration tests (no removed/weakened tests). C13R.4R red-only `6d323bd6` CI 43690793449 actual adapter observation count 1024 vs 1100, corrected actual adapter + Coordinator journal + attributed outputRefs + fetch/snapshot; all four activity modes equivalent; bounded tiny/large streams, exact omissions, latest terminal/result and late decline. C14R.5R actual Writable confirmation/error/close/timeout/late callback, unavailable prompt/no synthetic answer, non-rejecting local reports, direct execution/JSON and attached socket terminal result. Native/comparative A61/A66/F4/C12 remain UNVERIFIED, not substituted by fixtures. See STATUS and corrective roadmap.


## C15 — rich presentation and transcript

| ID | Requirements | Acceptance evidence | Level |
|---|---|---|---|
| A77 | R18,R21,R22,R31 | Scoped committed facts, trusted CLI styles, streaming source/escape boundaries, readable native tools/findings, permission/form exact choice: `presentation.test.js`, `delivery.test.js`, `cli-ux.test.js`, Linux PTY | I/PTY |
| A78 | R18,R21,R23,R26 | ACP default attributed inline, explicit notices, native updates and independent final/interaction, bounded queues: `host-acp.test.js`, `delivery.test.js` | I/SDK |
| A79 | R08,R14,R21,R23 | Exact session request/response boundaries, A→B→A, historical retry and repeated load, background attribution: `host-acp.test.js` | I/SDK |
| A80 | R01,R03,R09,R11,R13,R16,R18,R21,R26,R31 | Existing full regression, mode equivalence, measured deterministic presentation comparison and bounds; package/Nix/CI | I/E |
| A81 | R13,R18,R19,R27,R30,R31 | Real installed CLI and Zed/native model/provider, matched comparative quality/latency; explicit UNVERIFIED when unavailable | N |

C15 A77–A80 engineering verification: see exact checkpoint and CI in [STATUS](../docs/roadmap/STATUS.md). A81 native model/graphical client and matched comparative acceptance UNVERIFIED; existing F4/C12/A61/A66/C13R/C14R obligations remain open.


## C15R — presentation quality and fidelity (engineering PASS / native UNVERIFIED)

| ID | Requirements | Acceptance criteria / expected evidence | Level |
|---|---|---|---|
| A82 | R18,R21,R23,R31 | Actual native tool ID, sparse updates, same ID across attempts/different IDs same text, duplicate suppression, terminal/failure/unknown, gaps/eviction, distinct modes; red/green complete fixture transcript | I/SDK |
| A83 | R21,R22,R23,R31 | Rich append-only full transcript with source/Thinking blocks, exact streamed text modulo display decoration/sanitization, findings/permissions, direct/attached actual PTY, color/plain/narrow, slow/failed writes, gap and cancel | I/PTY |
| A84 | R19,R21,R22,R23,R31 | Authoritative final/clarification once before summary on shared human TTY, exact attempt/dispatch/budget counts, partial/unknown/cancel, unchanged machine/redirect/exit | I/PTY |
| A85 | R18,R21,R22,R23,R26,R31 | Live/history outcome report classification (ordinary/late/discrepancy/duplicate, explicit fallback when not recorded), stable IDs and exact A→B→A/old retry/boundaries; bounded resources, full execution equivalence, full CI and baseline measurements | I/SDK/E |
| A86 | R18,R19,R26,R31 | Installed native CLI visual re-acceptance and real ACP client, matched real task/model/usage/latency and separate changed skill diagnosis; unavailable explicitly UNVERIFIED | N |

C15R A82–A85 engineering PASS: [CI 43713292671](https://github.com/apathoid/role-orchestrator/actions/runs/43713292671), exact implementation `9c09318f729b20fa989e1d4c6474a7eea7c0eff5`, 476/476 root + 7/7 actual Linux PTY, full mandatory Nix/package/release and red/green/matched fixture benchmarks PASS. A86 real native/visual/comparative UNVERIFIED; [actual transcripts and measurements](../docs/roadmap/C15R_TRANSCRIPT_EVIDENCE.md). See [C15R](../docs/roadmap/C15R_PRESENTATION_QUALITY.md) and [STATUS](../docs/roadmap/STATUS.md). Earlier A77–A80 exact-SHA CI evidence retained; A81 and F4/C12/C13/C14/C13R/C14R native/comparative obligations remain open.


## C15R.6 — CLI interaction safety and presentation refinement

| ID | Requirements | Required observations / regression sources | Level |
|---|---|---|---|
| A87 | R08,R14,R19,R21,R23 | Permission positional/native-id collision and request-bound partial input, expire/reconnect/observer/no unintended grant: cli-ux.test.js, local-control.test.js, Linux PTY | I/PTY |
| A88 | R18,R19,R21,R23 | Pinned ACP 2.4.0 typed form projection, oneOf/enum/anyOf, free text and multiple fields, constraints, skip/cancel and original response identity: cli-ux.test.js, host-acp.test.js, PTY | I/SDK/PTY |
| A89 | R21,R22,R23 | One Thinking source across many readline chunks, delivered text and original typed reply, direct/attached: cli-ux.test.js, PTY | I/PTY |
| A90 | R18,R21,R22,R31 | Distinct native tools with same title, monotonic bounded aliases, sparse/terminal, human Markdown final authority, machine stdout: cli-tools.test.js, cli-ux.test.js, PTY | I/PTY |
| A91 | R08,R14,R21,R26 | Partial orphan/mixed historical associations and exact known boundaries, no guessed answer; long/repeated/aborted load: acp-history.test.js, host-acp.test.js | I/SDK |
| A92 | R01,R03,R09,R11,R13,R16,R18,R21,R26,R31 | Red/green baseline, deterministic mode equivalence, complete root/PTY/Nix/package/release checks, overhead and architectural audit | I/E |
| A93 | R13,R18,R19,R27,R30,R31 | Real installed CLI and graphical ACP, actual native question, paired changed skill and comparative outcome/latency/usage | N |

C15R.6 A87–A92 engineering PASS on `804bbaa24f606dc5be79a27db303489dda1dd27f`, [CI 43957276791](https://github.com/apathoid/role-orchestrator/actions/runs/43957276791) (485 root / 9 PTY). Subsequent C15R.6R follow-up was verified at `8b9be91a96f4657dd861647da13808f86f548e93`, [CI 44035000221](https://github.com/apathoid/role-orchestrator/actions/runs/44035000221) (500 root / 9 PTY). A93 installed/native/comparative UNVERIFIED. Earlier A81/A86/F4/C12/C13/C14/C13R/C14R remain open.


## C15R.6R — CLI interaction corrective regression

| ID | Requirements | Evidence required before PASS | Level |
|---|---|---|---|
| A94 | R14,R19,R21,R23 | Provider regex pathological red subprocess, bounded worker match/mismatch/invalid/timeout/cancel, concurrent permission unaffected, :json typed validation; typed :cancel/:decline while a regex is pending, worker abort, no late accept/error, exact action and current request correlation | I/E |
| A95 | R18,R19,R21,R23 | Pinned SDK native form >128 fields, bounded choices paging, empty Enter, exact optional/required, original field keys including __proto__, verified reply ownership | I/SDK |
| A96 | R18,R21,R22,R23 | Compact native tool locations/descriptions plus short aliases; original source question attribution and lifecycle identity; delivered details preserved in debug | I/PTY |
| A97 | R08,R21,R26 | Same known orphan initial/middle/trailing continuation in inline and notices; exact session turns/history classification, no fabricated response or execution | I/SDK |
| A98 | R01,R03,R09,R11,R13,R16,R18,R21,R26,R31 | Full regression and CI on corrective HEAD: checkJs, suites, Linux PTY, package/Nix/lock/release, side-effect equivalence | I/E |
| A99 | R13,R18,R19,R21,R31 | Real PTY actual SDK bounded regex, independent native questions/permissions/tools, authoritative single final and no unresolved ACK auto-replay; input-bound cancellation/decline during async validation, external abort, next valid form and stale alias safety | I/PTY |
| A100 | R13,R18,R19,R27,R30,R31 | Real installed native RO, provider/changed-skill comparison, Zed ACP and visual/quality/latency re-acceptance, precise blocker when unavailable | N |

C15R.6R A94–A99 **ENGINEERING PASS**: `8b9be91a96f4657dd861647da13808f86f548e93`, [CI 44035000221](https://github.com/apathoid/role-orchestrator/actions/runs/44035000221) SUCCESS (500/500 root, 9/9 actual Linux PTY, complete Nix/package/release). Dedicated real-module baseline-vs-current cancellation probe confirmed RED→GREEN for native :cancel/:decline in normal and :json input. No native acceptance inferred. A100 real native/visual/comparative **UNVERIFIED**. Prior A93/A86/A81 and F4/C12/C13/C14/C13R/C14R native obligations remain open. No synthetic fixture substitutes for a real provider.

## C15R-UX — CLI Visual Fidelity & Markdown Rendering (ENGINEERING CI PASS / NATIVE UNVERIFIED)

Новые критерии относятся только к пользовательскому представлению. Это не новый обязательный runtime workflow, схема model response или изменение Host authority. Новые интеграционные регрессии добавлены в `tests/integration/cli-visual.test.js`, а реальные color/plain PTY — в `tests/pty/cli.test.js`; инженерные A101–A107 проверены в CI [44186026545](https://github.com/apathoid/role-orchestrator/actions/runs/44186026545) на SHA `9480cb7fc642f4b4071d39e37ecd82fd7ea562eb` (505 root / 10 Linux PTY). После первого PASS добавлены safe Markdown/unknown TERM follow-ups `94c3b88475ae80de5f96f1117c0d8f3a44c03b6a` и `75410c365846d95b6d803187e0bb55bf3a5f2bfb` (literal ordinary identifiers), затем полностью проверены [CI 44187637516](https://github.com/apathoid/role-orchestrator/actions/runs/44187637516) на `7b5a29faf523ffe1652cfaa2f55f4a8b23576254` (505 root, 10 actual PTY, Nix); реальный installed native A108 **UNVERIFIED**. Детальный [план](../docs/roadmap/C15R_UX_CLI_VISUAL_FIDELITY.md), текущий статус в [STATUS](../docs/roadmap/STATUS.md).

| ID | Требования | Проверяемое наблюдение | Уровень |
|---|---|---|---|
| A101 | R13,R18,R21,R22 | Trusted segmented styling, terminal-only 2/1/0-column outer left margin (TTY width aware, empty lines and prompt intact) и ANSI safety, fixed Controller accent, arbitrary `roleId` → deterministic predefined palette without Worker-name special cases; plain/NO_COLOR/16/256/truecolor, unique visible Attempt attribution, unchanged input/readline | I/PTY |
| A102 | R08,R14,R19,R21,R23 | Native questions, multi-field forms, permissions and footer: distinct header/prompt/options/meta, all material source descriptions/constraints accessible; exact typed values, scopes/options/ACK, partial input, concurrent requests, reconnect/cancel | I/SDK/PTY |
| A103 | R03,R13,R18,R21,R26 | Controller + arbitrary-role Workers source switching, streaming chunks preserve Thinking continuity and exactly one external left margin per physical line under native interleaving; only actual dispatched workers, honest profile/model/effort, gap/retry, no invented plan or model-generated content rewriting | I/PTY |
| A104 | R11,R18,R21,R22,R23 | Identity-aware compact tools, meaningful transitions without generic duplicates, display truncation marked, separate completed vs succeeded, unknown/gap/out-of-order preserved, raw lifecycle codes only in debug, no native event/evidence filtering | I/SDK/PTY |
| A105 | R11,R13,R19,R21,R22 | Markdown from authoritative Assessment.answer rendered safely only human TTY with the same post-render outer margin, plain answer unstructured, code fences/Unicode/links/large fallback; output exactly once before summary, exact raw/machine/JSON/ACP and state fidelity | I/PTY |
| A106 | R11,R13,R14,R21,R22,R23 | Actual reported/recorded findings with uncertainty, factual status/footer/summaries, no inference from silence, no misleading success/ACK/effect claims; permission and unknown warnings visible | I/PTY |
| A107 | R01,R03,R05,R08,R09,R13,R16,R18,R21,R26,R31 | Golden complete transcript + actual Linux PTY at widths 120/80/40/24 (no artificial right-margin wrapping), non-Git and arbitrary role/tool fixture, independent Workers and unchanged skills/context/Invocation/Outcome; slow/broken writable and bounded memory/latency; full mandatory exact-SHA CI | I/E/PTY |
| A108 | R13,R18,R19,R21,R27,R30,R31 | Installed real CLI visual re-acceptance and real provider/standard ACP client/native skill comparison where available; precise UNVERIFIED blocker otherwise. Distinct from historical A100/A93/A86 obligations | N |


**C15R-UX-R2F corrective evidence:** [CI 44282977384](https://github.com/apathoid/role-orchestrator/actions/runs/44282977384) PASS on exact implementation `2dc1d2a433615dbb8d39ada08f1b6c42101c7475`, 535 root / 12 Linux PTY. Seven deterministic delayed-Writable tests cover initial native pages, field changes, `:back`, fast `:choices`, error/cancel and concurrent requests; existing A110/A114 remain authoritative. Final docs-only SHA requires separate exact-SHA CI; real installed model/Zed A115 remains UNVERIFIED. Earlier incomplete RED CI attempts are not counted as passing/failing evidence.

**C15R-UX-P1 spacing evidence:** [CI 44339483661](https://github.com/apathoid/role-orchestrator/actions/runs/44339483661) SUCCESS on implementation `619f907dc73697081e4ab77f6a944f18f21bed78` (540/540 root, 14/14 Linux PTY, Nix). Five new terminal layout integration tests and two PTY cases cover stream-partial lines, ANSI/Unicode/Markdown, native display receipts, TTY widths and raw/JSON/ACP fidelity. A101/A103/A105/A107/A114 are extended, no new IDs. Docs-only SHA has its own CI obligation; installed model/Zed A108/A115 remain UNVERIFIED.

## C15R-UX-R1 — CLI Interaction & Visual Fidelity Corrective Follow-up

Corrective scope **не меняет** A101–A108 и исходный C15R-UX. Это отдельные проверяемые факты отображения, не новое требование к ответу модели, native wire или Host authority. RED: [CI 44255128308](https://github.com/apathoid/role-orchestrator/actions/runs/44255128308), baseline `92221b18224b57690faed0b1e21f66fd65bb13a9`, 4/4 новых адресных теста воспроизвели дефекты. **GREEN:** full mandatory [CI 44257161408](https://github.com/apathoid/role-orchestrator/actions/runs/44257161408) **SUCCESS** на exact implementation SHA `1820ff700b8e25821597fe761bb52b1ba383cd4f` (514 root / 11 actual Linux PTY / Nix). A109–A114 engineering PASS on that SHA, **A115 real installed provider/Zed UNVERIFIED**. Эта docs-only запись имеет отдельный SHA и собственную проверку.

| ID | Требования | Проверяемое наблюдение | Уровень |
|---|---|---|---|
| A109 | R08,R14,R18,R21,R23 | Interaction/permission broker lifecycle results visible in compact/detailed, including actual `PERMISSION_UNAVAILABLE` broker reason; no invented request number, native ACK or provider confirmation; debug preserves original reason/event ID, gap/unknown remain explicit | I/PTY |
| A110 | R08,R14,R21,R22 | Original structured ACP form/permission fields yield segmented source/header/field/options/meta/input prompt; typed/omitted choices unchanged; 128+ fields, large options, only **successfully Writable-confirmed** numeric positions retained in bounded per-request page history, protected by active request and current field-render generation, exact native `id:<optionId>` remains explicit; concurrent/cancelled requests do not grant across identities | I/PTY |
| A111 | R11,R18,R21,R23 | Native `completed` neutral, not command-success verification; failed/unknown/late/conflict/item.completed without status honest; no guessed verification or change to native tool identity | I/PTY |
| A112 | R08,R14,R21,R22,R23 | `:details [N]` previews current form field or permission metadata via bounded fixed-key descriptor access, not whole-object key enumeration even for 300k-key JSON objects; unknown keys disclosed as potentially omitted; Unicode-safe surrogate/combining/emoji clipping, nested/large/cyclic metadata and cancellations; request/permissions/draft untouched | I/PTY |
| A113 | R11,R18,R21 | First generic `pending` visible immediately; only true identity-scoped duplicates suppressed; no delay, timeout inference or fabricated terminal state | I/PTY |
| A114 | R01,R03,R05,R08,R09,R13,R16,R18,R21,R26,R31 | Direct/attached SDK/Linux PTY, truecolor/256/16/NO_COLOR/TERM=dumb, margin-aligned readline, slow/broken Writable, full transcript/Markdown final, before/after execution equivalence and exact-SHA mandatory Nix/package CI | I/E/PTY |
| A115 | R13,R18,R19,R21,R27,R30,R31 | Installed CLI with authenticated real provider, actual question/permission/tool/Workers and Zed ACP visual comparison, documented PASS/FAIL/UNVERIFIED blockers | N |

**R2.0–.6 targeted follow-up:** [RED CI 44265635274](https://github.com/apathoid/role-orchestrator/actions/runs/44265635274), [GREEN exact implementation SHA CI 44267481834](https://github.com/apathoid/role-orchestrator/actions/runs/44267481834) `5bb46f79cdf9d439933704741faf05d659e612ed` (528 root, 12 actual Linux PTY, Nix); R2 reuses A109/A110/A112/A114, so no new IDs. Real native A115 **UNVERIFIED**. A docs-only follow-up SHA requires separate verification.

**Planning baseline:** `bf117d405bf31cfc577021cb6cb12e2091df2b4b`; historical C15R.6R [CI 44035000221](https://github.com/apathoid/role-orchestrator/actions/runs/44035000221) covers only its original A94–A99, **not** C15R-UX. A100/A93/A86/A81 and other earlier native obligations remain UNVERIFIED.

## C15R-GUI — graphical standard ACP implementation (engineering CI PASS; native UNVERIFIED)

Baseline `420358abeea67a4cf40cfb7ae4fa433cd34914e9`; code and tests implemented on `feature/interactive-ux`. Historical C15R-UX evidence alone is not acceptance. Full [CI 44519422152](https://github.com/apathoid/role-orchestrator/actions/runs/44519422152) SUCCESS at `c0299bec` (546 root, 14 PTY, Nix/package/release); this verification-only documentation follow-up must be separately checked. New SDK and projection regressions: `tests/integration/presentation.test.js`, `tests/integration/host-acp.test.js`; preexisting `activity.test.js`, `delivery.test.js`, `acp-history.test.js` and permission/cancel test suites. [Status and exact SHA CI](../docs/roadmap/STATUS.md); [roadmap](../docs/roadmap/C15R_GUI_GRAPHICAL_ACP_PRESENTATION.md).

| ID | Требования | Проверяемое наблюдение | Уровень / статус |
|---|---|---|---|
| A116 | R02,R03,R18,R19 | Native Controller plan forwarded in all modes, absent/Worker-only/retry/empty passthrough; SDK session/load does not reconstruct native plan | C/I PASS c0299bec; Zed UNVERIFIED |
| A117 | R11,R13,R18,R19,R21 | Shared compact/detailed/debug typed selection, significant error/unknown/cancel only, true event/attempt IDs in debug, no duplicate acceptance/final | C/I R1 GREEN 31239fa; native UNVERIFIED |
| A118 | R08,R11,R18,R19,R21 | No builder/parser; original model Markdown untouched; plain-text notices preserve punctuation with safe controls; only RO-owned inline messages use Markdown escaping | C/I R1 GREEN 31239fa; Zed Markdown UNVERIFIED |
| A119 | R11,R12,R13,R18,R21 | Only recorded model findings; fixed label and indented untrusted multiline fields in RO-own inline/notice, no Host severity/confidence/verification | C/I R1 GREEN 31239fa; real model UNVERIFIED |
| A120 | R03,R08,R14,R16,R18,R19,R21,R23,R26 | Existing bounded transport, native thought/tools/plan/permissions and independent Workers unchanged; planning SHA vs corrected 3-round deterministic fast/slow/broken/disconnect comparison includes overflow and gaps | C/I R1 GREEN 31239fa; revised comparator final CI pending; real Zed UNVERIFIED |
| A121 | R11,R14,R15,R18,R19,R21,R28 | A→B→A, old Worker/late outcome/history classification, repeated load, no native reconstruction/replay/duplicate answer | C/I PASS c0299bec; real Zed UNVERIFIED |
| A122 | R03,R08,R13,R18,R19,R21,R27,R30,R31 | Exact final SHA full mandatory Node24/Nix/PTY CI and installed Zed client comparison | CI PASS c0299bec; later docs-only SHA pending; Zed/second graphical client UNVERIFIED |

**C15R-GUI-R1 corrective evidence:** RED [44528875854](https://github.com/apathoid/role-orchestrator/actions/runs/44528875854), GREEN code [44530205461](https://github.com/apathoid/role-orchestrator/actions/runs/44530205461). `presentation.test.js` contains R1-F1–F4 exact typed-event/notice/multiline/injection/route tests; existing host ACP SDK, activity, history, form/permission, cancellation and PTY suites retained. `scripts/c15r-gui-r1-transport-benchmark.mjs` runs in mandatory CI to compare planning-SHA projections and unchanged bounded queue. Original model content and trusted stored findings untouched. Real Zed/second ACP client and actual model/provider delivery UNVERIFIED; follow-up docs-only SHA has its own exact CI obligation.

**C15R-GUI-R2 — compact ACP UX:** R2 reuses A116–A122 (primarily A117/A118/A120/A121) without new IDs. Engineering regression: `presentation.test.js` tests omission of compact accepted, routine completed outcome and assessment when authoritative final exists, missing/empty/unconfirmed final, unknown effect/late/conflict/error/cancel/wait, reliable arbitrary role/profile/retry, same inline/notices policy and R1 finding boundary; `host-acp.test.js` tests actual ACP SDK native Controller plan/thought/tools/final with parallel Workers and repeated load in three modes, negotiated notices; `acp-history.test.js` verifies original historical facts accessible in detailed and correct compact recovered turns. Code [CI 44549574441](https://github.com/apathoid/role-orchestrator/actions/runs/44549574441) full PASS at `4d1311ec22ad5072536e79fea9721a98803aa782`. [Full exact implementation+comparator SHA CI 44551217099](https://github.com/apathoid/role-orchestrator/actions/runs/44551217099) SUCCESS at `0aeacb1ca1454d0188865a34f32452d168a6a0a2`: 557 root/14 PTY, Nix/release, 48 three-round deterministic R1→R2 cases. Compact own direct/parallel/intense 4→2 / 10→8 / 13→11 (inline), debug unchanged; native counts not suppressed. This evidence-only documentation update receives separate SHA/CI. Real Zed/second graphical client and authenticated model remain **UNVERIFIED**. No model/execution changes and no master merge.
