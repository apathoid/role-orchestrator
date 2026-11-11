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
| R01 | A02, A07 | `tests/core/core.test.js`; `tests/integration/host-cli.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R02 | A04, A47 | `tests/integration/orchestrator.test.js`; `tests/integration/reasoning-controller.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R03 | A05, A08, A10, A13, A14, A46, A47 | `tests/integration/delegation.test.js`; `tests/integration/reasoning-delegation.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R04 | A08 | `tests/integration/handoff.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R05 | A03, A09, A10, A12, A46, A51 | `tests/core/action-graph.test.js`; `tests/integration/delegation.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R06 | A11, A46 | `tests/integration/delegation.test.js`; `tests/integration/reasoning-controller.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R07 | A15 | `tests/integration/permissions.test.js`; `tests/contracts/acp-provider.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R08 | A15, A16, A30, A32, A45, A53 | `tests/integration/permissions.test.js`; `tests/integration/host-acp.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R09 | A17 | `tests/integration/mutable-context.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R10 | A01, A07, A17 | `tests/integration/host-cli.test.js`; `tests/integration/runtime.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R11 | A29, A33, A34, A36, A50 | `tests/integration/context-quality.test.js`; `tests/integration/evidence-addressing.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R12 | A13, A33, A34 | `tests/integration/context-quality.test.js`; `tests/integration/assessment.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R13 | A04, A13, A14, A35, A50 | `tests/integration/assessment.test.js`; `tests/integration/delegation.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R14 | A19, A20 | `tests/integration/durable-dispatch.test.js`; `tests/integration/cli-process.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R15 | A23, A24, A25, A26, A27, A28, A51, A52 | `tests/integration/durable-dispatch.test.js`; `tests/integration/resume.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R16 | A05, A06, A10, A21, A22, A47, A53 | `tests/integration/delegation.test.js`; `tests/integration/reasoning-controller.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R17 | A18, A30, A44, A45, A52 | `tests/integration/configuration.test.js`; `tests/integration/reasoning-config.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R18 | A18, A20, A38, A49, A54 | `tests/contracts/provider-port.test.js`; `tests/contracts/acp-provider.test.js`; `tests/integration/codex-provider.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R19 | A16, A38, A48 | `tests/integration/host-acp.test.js`; `tests/integration/host-cli.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R20 | A31, A32, A39, A49 | `tests/contracts/plugin-api.test.js`; `tests/integration/extensions.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R21 | A36, A40, A53 | `tests/integration/diagnostic-export.test.js`; `tests/core/diagnostics-taxonomy.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R22 | A28, A36, A53 | `tests/integration/diagnostic-sink.test.js`; `tests/integration/durable-dispatch.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R23 | A03, A19, A20, A26, A40, A51 | `tests/integration/cli-process.test.js`; `tests/integration/local-control.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R24 | A02, A05, A18, A22, A29, A39, A44, A48, A49, A50 | `tests/integration/configuration.test.js`; `tests/integration/codex-output.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R25 | A01, A37, A42, A54 | `tests/foundation/foundation.test.js`; `scripts/check-package.mjs` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R26 | A12, A25, A27, A40, A48 | `tests/integration/local-store.test.js`; `tests/integration/durable-dispatch.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R27 | A35, A40 | `tests/integration/diagnostic-export.test.js`; `tests/integration/host-cli.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R28 | A06, A24 | `tests/integration/resume.test.js`; `tests/integration/host-acp.test.js` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R29 | A41, A53 | `scripts/check-javascript.mjs`; `tests/foundation/foundation.test.js` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
| R30 | A42, A54 | `scripts/check-nix-install.sh`; `.github/workflows/ci.yml` | CI fixture/process PASS; реальные provider/client/NixOS части UNVERIFIED |
| R31 | A43, A54 | `.github/workflows/ci.yml`; `scripts/check-specification.mjs` | CI automated PASS в области соответствующих сценариев; качество reasoning/новых сред не устанавливается |
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
| A08, A32, A38 | `tests/integration/handoff.test.js`, `extensions.test.js`, `codex-provider.test.js`, `tests/contracts/acp-provider.test.js`: selected skill material/metadata, scope, unavailable/truncated and actual subprocess/ACP prompt. New HEAD execution pending; native behavior UNVERIFIED. |
| A09–A12, A19–A26, A28, A40, A44–A54 | `reasoning-failure.test.js`, `reasoning-controller.test.js`, `resume.test.js`: local Controller failure, ready reservation fairness, mixed durable worker recovery; execution pending. |

C12R.4 regression additions: `tests/integration/context.test.js` (ambiguous legacy references, directory/fetch cause, oversized missing/retained/present artifact); existing `evidence-addressing.test.js`, `context-quality.test.js`, `mcp-context.test.js` and finding/summary tests cover scoped historical retrieval and attribution. Verification remains pending on the implementation HEAD.

C12R.5: ACP contract tests distinguish observed output cap and malformed terminal; orchestration tests verify retained slot, addressed cleanup reason and late detach. Existing cancellation, partial output, process ownership and recovery fixtures remain required. Native deep failure cause is UNVERIFIED.
