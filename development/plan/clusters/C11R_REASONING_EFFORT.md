# C11R — Адаптивный reasoning effort

**Статус: IMPLEMENTED (C11R.1–C11R.12); автоматическая регрессия — GitHub CI, native acceptance — UNVERIFIED до C12.** Вход: завершённые C03–C10; выполнять после C11 и до C12. C11 обеспечивает диагностическую основу; новые события и проверки добавлять вместе с поведением C11R. Цель — выбор effort специалистов **и самого Controller**, включая самостоятельное продолжение без внешнего события и без обязательного делегирования.

Нормативная семантика и формы данных: [Reasoning effort](../../../docs/REASONING_EFFORT.md). Прочитать также [контракты](../../../docs/CONTRACTS.md), [исполнение](../../../docs/EXECUTION.md), [конфигурацию](../../../docs/PROVIDERS_AND_CONFIGURATION.md), корневой AGENTS и reasoning-инструкции разработки. Этот файл задаёт порядок реализации, не новый runtime workflow.

## Фиксированные решения

1. Production остаётся JavaScript ESM, JSDoc/checkJs и Node 24; Nix flake сохраняется.
2. Не повышать config schemaVersion: отсутствие reasoningEffort означает native, новые поля необязательны для прежней конфигурации.
3. Пользователь задаёт унифицированные level → нативные effort. Core не содержит словаря нативных значений, порядковой метрики интеллекта или правил выбора сложности.
4. Не вводить anti-loop механизм, обязательное внешнее событие или effort-specific квоты. Все настоящие calls подчинены прежнему ledger/deadline/cancel.
5. Неподдерживаемый effort **Controller** показывается пользователю; не запускать автоматический fallback/correction на другом effort. Для worker сохраняется адресный отказ, доступный Controller.
6. Отсутствие acknowledgment не блокирует вызов, findings или завершение; никакой freshness gate.
7. Mapping принадлежит trusted config, разрешение — application, нативная передача — adapter.
8. Расширять существующие route/snapshot/identity/recovery. Unknown-effect replay не разрешается сменой effort.
9. Прямой ответ и работа одним Controller остаются полноценными. Worker-only реализация не завершает C11R.

## Карта владельцев в текущем checkout

Ориентиры подтверждены исходниками при подготовке плана на a934962bc1e81f835657c89fc43750ad5d0bc914. Перед реализацией читать актуальные версии. Это карта интеграции, не требование сохранять имена внутренних helpers.

| Слой | Точки интеграции | Изменение |
|---|---|---|
| Core | src/core/contracts.js, ports.js | Action/Decision декодеры и JSDoc Profile/Invocation |
| Core state | src/core/operation.js, snapshot.js | DispatchRoute, сохранение Decision, pending→attempt binding и чтение старых записей |
| Configuration | src/application/configuration/config-v1.schema.json, decode-config.js, resolve-config.js, catalog.js | union native/array, default, trusted mapping и модельная проекция |
| Application | src/application/handoff.js, orchestrator.js, action-round.js, controller-context.js | локальный admission, общий resolver, следующий Controller, prompt contract, ledger/retry |
| Recovery/context | src/application/recovery.js, context-access.js, finding-history.js | исторические route/observations, неизвестные параметры и эффекты |
| CLI adapter | src/adapters/cli/codex-launch.js, codex-provider.js | нативный параметр per invocation и launch precedence |
| ACP adapter | src/adapters/acp/input.js, provider.js | model/session negotiation, selector, setter, факты настройки |
| Extension/API | src/main/plugin-api.js, extensions.js, runtime.js | capability передачи selectable-setting и совместимость native |
| Public Hosts | src/hosts/cli.js, commands.js, acp.js и src/main/cli.js | пользовательская ошибка Controller, inspect/trace/resume |
| Prompt/diagnostics | src/adapters/invocation-prompt.js, controller-context.js и существующие diagnostic ports | схема выбора, происхождение и наблюдаемость без секретов |

До изменения установить точную границу между public protocol version, config version, snapshot decoder и plugin contract. Решение «config остаётся v1» не позволяет молча сломать остальные контракты; additive optional fields должны сохранять прежнее поведение.

## C11R.1 — Контракты ядра и модельный протокол

Результат:
- Ввести минимальные JSDoc tagged types для native/selectable selection. Добавить Action.reasoningLevel и Decision.nextController по постоянной спецификации.
- Decoder проверяет форму; membership проверяется против доверенного профиля, не закрытым enum.
- Продолжение Controller является валидным действием существующего Decision. Не считать nextController.continue пустым proposal; простое изменение preference не создаёт скрытого dispatch.
- Описать сочетания nextController с additions, waitPolicy, finalAssessment, clarification; сохранить acceptedActionIds/findings и существующую обработку independent actions.
- В Profile и Invocation различить модельный каталог и материализованный выбор; opaque nativeValue не превращать в provider-specific core type.
- Не добавлять отдельный Action kind для смены effort.

Проверки (A44, A46, A47): прежние Decision/Action принимаются, отрицательные формы дают точный field path, continue без additions валиден, final/clarification с pending selection отклонены, level без continue и без основания нового хода не вызывает busy loop. Одинаковый decisionId с другим effort — identity conflict, не повторный dispatch.

## C11R.2 — Конфигурация v1 и каталог

Результат:
- Обновить JSON schema, decoder/reference validation, config resolution без schemaVersion bump.
- Нормализовать отсутствие поля в native для будущих вызовов. Проверить default для одного/нескольких значений, duplicate level, null/пустые строки/массив, запрещённый default при native.
- Доверенный mapping разрешать однократно в существующем application пути; не дублировать registry нативных соответствий внутри adapter.
- Catalog сообщает mode, levels/default, provenance доступных capabilities; поддержка зависит от модели/сессии, не только provider id.
- Project preferences не добавляют mapping или executable options. Прежние config files не требуют редактирования.
- Встроенные prompts объясняют унифицированные имена и отсутствие межмодельной гарантии качества.

Проверки (A44–A45): omission и native дают одинаковое отсутствие override; все конфиги до C11R работают; неполные наборы и два разных native mapping для одного level допустимы; произвольный доверенный новый level не требует правки core. Ошибки с JSON path без секретов. Порядок массива не меняет default.

## C11R.3 — Durable selection и route до dispatch

Результат:
- Расширить существующий route и его snapshot decoder до подключения реального dispatch.
- Сохранять native/selectable, level/nativeValue/selectionSource и прежнюю configurationRef.
- Привязать одноразовый nextController из принятого Decision к одному следующему attempt в существующей последовательности commit/reserve. Выводить pending/consumed из durable records либо поддерживать только одну проверяемую истину; не держать независимый in-memory флаг.
- Сохранённые Decision/Action и invocation должны согласованно объяснять конкретный route. Определить проверяемые противоречия snapshot, не выводить effort из текста objective.
- Старое отсутствие route.reasoning — not recorded; не подставлять текущий default в историю.
- Убедиться, что config identity покрывает mapping. Изменение необязательной настройки не инвалидирует историю.

Проверки (A51–A52): round trip, old snapshot, contradictory binding/route, одна и та же ссылка/Decision после reopen, изменение mapping при том же level. Snapshot не понижает неизвестную dispatch/effect certainty. Никакого provider вызова ради проверки snapshot.

## C11R.4 — Делегирование и admission

Результат:
- В prepareHandoff/существующем resolver разрешить профиль+level перед prompt.
- Для worker неизвестный/unsupported level возвращает конкретный отказ с actionId и доступными вариантами; независимые actions исполняются.
- Передавать immutable selection adapter, не менять profile object глобально.
- Добавить выбор в context/history с существующими provenance/ref правилами; findings не получают новый effort-based статус.
- Оставить роль необязательной. Разные efforts не требуют разных providers/profiles или постоянных specialists.

Проверки (A46): одна партия включает корректные и некорректный выбор; корректные workers получают ровно свои параметры. Chain/diamond и model acceptance dependency сохраняются. Параллельные attempts одного профиля с разным effort не протекают друг в друга. Повтор proposal не создаёт новый вызов.

## C11R.5 — Собственный effort Controller и самостоятельные ходы

Результат:
- В существующем drive использовать default для первого хода, одноразовый nextController для следующего и default после его потребления.
- continue:true планирует следующий ход в том же coordinator, generation и ledger. Нет проверки нового внешнего события или требования делегировать.
- Controller получает прежний контекст, собственный предыдущий Decision, результаты/pending и параметры текущего/следующего выбора; не теряет полезный результат собственного анализа.
- Обновить инструкции и выдаваемую JSON-схему Controller одновременно с decoder, включая single-model путь.
- Сохранить сериализацию Controller: один активный ход на operation, без competing decisions; cancel/supersede не могут запустить старый pending выбор.
- Если limit занят workers, использовать существующее ожидание capacity; это ресурсная причина, не условие «нужна новая информация».
- Correction текущего malformed response остаётся в общем бюджете; уже принятый pending выбор применяется к первому новому Controller attempt по спецификации.

Проверки (A47): один профиль, ноль workers, нет новых внешних данных — Controller продолжает на новом effort и завершает. Несколько последовательных самостоятельных ходов с high→medium→high разрешены до обычного лимита; тест защищает отсутствие специального запрета, не вводит anti-loop policy. Additions+continue не создают второго Controller. Повтор Decision, cancel и superseding generation исключают повторный dispatch.

## C11R.6 — Ошибка собственного выбора и публичное продолжение

Результат:
- Для отсутствующего level, неподдерживаемого default или явного отказа adapter следующего Controller использовать существующий technical waiting/result.
- Ошибка видна в API/CLI/ACP: операция, профиль, level, причина и известные варианты; запретить пустой успешный ответ.
- Не отправлять автоматический новый Controller prompt на другом effort. Не считать отсутствие acknowledgment ошибкой.
- Сохранить operation/расход/observations; уже допустимые независимые workers могут завершиться. Не отменять их автоматически.
- Явный пользовательский resume после выбора допустимой конфигурации запускает следующую generation/default в рамках текущего lifecycle, не повторяет неизвестные старые попытки.
- Повтор доставки ошибки не вызывает модель. Inspect/trace доступны без работоспособного Controller/plugin.

Проверки (A48): неподдерживаемый next/default виден на всех публичных поверхностях, fallback dispatch=0; независимый worker результат сохраняется; исправление trusted config + явный resume работает с тем же operation и расходом; ошибка old attempt не перенастраивает новый.

## C11R.7 — ProviderPort и CLI

Результат:
- Дополнить общий ProviderPort contract suite нормализованным selection и facts submission/acknowledgment.
- Проверить официальный контракт версии CLI, доступной при реализации; в development/reports/C11R записать версию, источник и наблюдение.
- В Codex launch применить selected native effort per invocation, проверить precedence относительно nativeSettings.profile. В native режиме не добавлять override.
- Использовать argv/типизированную сериализацию поддержанного аргумента; никакой shell interpolation, prompt-инструкции вместо настройки или silent fallback.
- Передавать только разрешённые значения; учесть start failure, timeout/cancel и поздние результаты. Настройка не меняет permissions/MCP launch.
- Plugin adapters без selectable support должны сохранять native-путь и явно отказывать selectable. Не расширять произвольно весь nativeSettings API ради этой функции.

Проверки (A49–A50, A53): управляемый дочерний процесс видит точное значение, проверены native/no override, приоритет и отказ. Acknowledgment absent не блокирует успешный результат. ProviderPort suite проходит для native и selectable, включая late result и cancel. Synthetic CLI не считается native LLM evidence.

## C11R.8 — Generic ACP

Результат:
- После выбора конкретной модели получить актуальные options/capabilities сессии.
- Определить selector только по документированному контракту либо явному trusted adapter setting; при нескольких неоднозначных options вернуть адресную capability error. Не угадывать по display name.
- Проверить native value, выполнить поддержанный setter до prompt, сохранить доступный ответ. Не считать category или отдельное эхо обязательными для любого ACP агента.
- Native mode не отправляет setter. Модель/режим могут обновить набор options: не использовать устаревшую копию.
- Сессии/attempts не меняют настройки друг друга; cleanup на setter failure/cancel и поздних ответах остаётся у adapter.
- Если установленный SDK/агент не поддерживает нужный метод, явно зафиксировать ограничение. Версии и возможное обновление зависимости обосновывать контрактом и native evidence, не выдумывать API.

Проверки (A49–A50): selectable model, отсутствующий selector, неподдерживаемый value, ambiguous selectors, модель меняет options, setter отказ, потеря ответа, ack absent при поддержанном setter, параллельные sessions, cancel до prompt. Ни один отказ не отправляет prompt с подменённым effort. Wire contract fixtures отделены от native проверки.

## C11R.9 — Recovery, retry и идентичность

Результат:
- Проверить crash до/после принятия Decision, reserve, dispatch, outcome, доставки.
- Pending selection восстанавливается только для ещё не начатого нового invocation. Неизвестный эффект или неясное потребление не переводить в not_sent/none ради продолжения.
- Idempotent retry сравнивает эффективный запрос, включая effort и mapping, по реальному adapter contract. Другой effort не использует старый key скрыто.
- Старый route без effort остаётся inspectable, но не доказывает эквивалентность нового запроса.
- После explicit resume применять актуальные grants/config к новым calls; routes прошлого неизменны. Не вводить workspace fingerprint или глобальную инвалидность evidence.

Проверки (A51–A52): реальный локальный store/reopen и контролируемые crash barriers, повтор commit без повторного внешнего эффекта, historical not-recorded, изменённый mapping, независимое действие при unknown. Самостоятельное новое рассуждение с историей допустимо; слепой replay tool-эффекта — нет.

## C11R.10 — Диагностика и ресурсы

Результат:
- Расширить существующие inspect/trace/export: requested level, default/model source, immutable native mapping, configurationRef, submission/acknowledgment facts и Controller pending/consumed selection.
- Нет второго журнала reasoning как source of truth. Ошибка sink не мешает координации; отсутствие acknowledgment не причина waiting.
- Коррелировать факты по attempt, не связывать evidence по одному profile/level. Findings/evidence не ранжировать по effort.
- Все реальные calls потребляют прежний ledger; late usage уточняет прежнюю попытку, не создаёт новый расход. Нативный неизвестный usage остаётся unknown.
- Не писать chain of thought. Сохранить bounds/redaction и невозможность произвольного provider payload попасть в export.

Проверки (A53): смена effort не сбрасывает budget/grant/deadline; сохраняются уникальность evidence refs, historical route и отказ sink. Ошибка одного operation не блокирует другие. Export читается после отключения plugin.

## C11R.11 — Сквозная регрессия и native evidence

Результат:
- Пройти A44–A54 и регрессии A03–A05, A08–A14, A18–A29, A30–A31, A33–A40.
- Узкие core/config/contract/integration suites запускать на соответствующем шаге; общий проверочный набор — после интеграции. Не создавать дублирующие тесты ради каждой строки.
- Сквозные пути: direct native; selectable single Controller с самостоятельным продолжением; несколько workers; replan после evidence; ошибка worker с продолжением; собственная ошибка с показом пользователю/resume.
- Реальные CLI/ACP probes выполняются только с доступными настроенными исполнителями. Записать версии, фактические параметры, ответы, время/usage и непроверенные ограничения без секретов.
- Проверить, что живой Controller понимает доступные уровни, может не делегировать и завершить задачу. Выбор всегда максимального effort не считать доказательством адаптивности.
- Сравнение полезности/стоимости — наблюдение, не обязательный автоматический Host scorer. Не добавлять ограничения циклов до отдельного решения по реальным данным.
- Проверить package/removal и Nix/CI по действующему процессу. Никаких дополнительных credentials в CI; native отсутствие не маскировать mock PASS.

Проверки (A54): отличать configured/submitted/acknowledged от результата задачи и фактического внутреннего reasoning. Нативная недоступность остаётся UNVERIFIED, независимые части реализации продолжаются.

## C11R.12 — Закрытие и передача C12

Обновить постоянные docs по фактически реализованным полям, README и примеры; убрать planned пометку лишь с реально реализованного контракта, native readiness оставить отдельной. В STATUS и reports/C11R связать каждый acceptance с конкретным тестом/командой/exit или UNVERIFIED. Обновить матрицу, не переписывая старые доказательства.

Выход: специалисты и Controller могут выбирать разрешённый effort в одном loop; поддержан native и старый config v1; нет специальных ограничителей reasoning, второго scheduler или подтверждающего gate; ошибки понятны пользователю; durable route/retry/resources корректны. Только тогда C11R implementation complete. C12 повторно проверяет интегрированный продукт, включая это расширение.

Все фикстуры, тесты, экспериментальные traces, ledger и отчёты находятся под development/. Постоянные документы и продукт не читают этот каталог.
