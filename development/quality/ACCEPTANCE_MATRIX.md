# Матрица приёмки и регрессий

**Бизнес-сценарии ещё NOT RUN: в ветке спецификация и стартовая инфраструктура.** Foundation checks сами по себе не закрывают полные A41–A43. Эта матрица — задание для реализации тестов, не отчёт об успешном выполнении. Каждый будущий результат связывается с test path/run id и фактическим exit. Одно тестовое семейство может закрывать несколько строк.

Уровни: U — core/unit; C — adapter contract; I — subprocess/storage integration; E — end-to-end; N — native provider/client. Tests хранятся только под `development/quality/`.

| ID | Требования | Сценарий и обязательное наблюдение | Уровень / владелец |
|---|---|---|---|
| A01 | R10,R25 | Build/import без Git и development; import не запускает процесс/сеть/чтение workspace | U/I C00,C12 |
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
| A37 | R25 | Удаление development без других edits: clean install/build/package/API/CLI работают; в package нет fixtures | I/E C00,C12 |
| A38 | R18,R19 | Общие сценарии на двух настоящих исполнителях и внешнем ACP/Zed; версии, permissions, cancel/resume записаны | N C07,C08,C10,C12 |
| A39 | R20,R24 | External tool bridge валидирует schema, сохраняет permission/provenance; native tools не дублируются | C/I C09 |
| A40 | R21,R23,R26,R27 | Inspect/trace показывают owner/reason/budget/unknown; bounded logs и cleanup при нескольких operations | I/E/N C10,C11 |
| A41 | R29 | Product написан на JS ESM; JSDoc checker обнаруживает нарушение контракта; runtime работает без TS/checker/transpilation | U/I C00,C12 |
| A42 | R30,R25 | Locked Nix build/check, named/default apps, profile install, non-Git cwd, внешний state и работа без development подтверждены; NixOS отдельно проверен | I/E C10,C12 |
| A43 | R31 | GitHub CI фактически исполняет применимые проверки; missing harness явно skipped; обязательные product checks не скрыты; secrets отсутствуют | I C00,C12 |

## Правила доказательства

Mock Controller fixtures задают решения, позволяющие проверить Host. Они не доказывают реальное соблюдение инструкций LLM. Native acceptance дополнительно проверяет, что реальная модель получает достаточный контекст и может завершить задачи; её результаты не превращаются в математическую гарантию качества.

Отрицательные проверки должны контролировать forbidden effect: количество dispatch, отсутствие Git call, отсутствие повторного side effect, отсутствие секретов в экспортируемых данных. Только совпадения финального текста недостаточно.

Проверка протокола с fake ACP agent — C/I, даже если название fixture содержит native. Любой непроведённый обязательный сценарий остаётся UNVERIFIED с причиной. Нельзя менять ожидаемый результат ради прохождения, если он следует из утверждённого контракта.

## Наблюдения реализации

| ID | Состояние | Проверка |
|---|---|---|
| A01, A37, A41 | OBSERVED, foundation-часть | `check:package`, `check:removal`, `test:foundation`, в том числе отрицательная JSDoc fixture |
| A02, A03, A19, A22, A29 | OBSERVED, core-часть | `test:core`, `quality/tests/core/core.test.js`, 6 тестов, exit 0 |
| A42, A43 | OBSERVED, Linux foundation-часть | [Foundation CI](https://github.com/apathoid/role-orchestrator/actions/runs/42388026539) |
| A04–A07, A19, A21, A24, A29 | OBSERVED, application-часть, синтетические порты | `test:integration`, `quality/tests/integration/orchestrator.test.js`, 12 тестов, exit 0 |
| A08, A09 | OBSERVED, контракты handoff и графа | `quality/tests/integration/handoff.test.js`, `quality/tests/core/action-graph.test.js` |
| A08–A10, A12 | OBSERVED, сквозной scheduler с синтетическими портами | `quality/tests/integration/delegation.test.js`; два параллельных workers, независимые операции и обе wait policies |
| A11, A13–A14, A19, A21–A22 | OBSERVED, core/application-часть | `test:core` и `test:integration`; отмена, перепланирование, неизвестные эффекты, общие лимиты и модельное разрешение разногласий |
| A18, A30 | OBSERVED, конфиг и синтетические capabilities | `quality/tests/integration/configuration.test.js`; ограниченные project preferences, обязательный image input и неизвестный usage |
| A15–A17 | OBSERVED, Host и синтетический ProviderPort | `quality/tests/integration/permissions.test.js`, `configuration.test.js`; отзыв grant, корреляция ответа, отмена и изменение рабочей среды |
