# C12R — Стабилизация и повышение качества Role Orchestrator

## 1. Назначение и вход в работу

C12R — корректирующий инженерный этап C12 по результатам нативной эксплуатации. Он устраняет препятствия для самостоятельной модельной координации, а не задаёт алгоритм рассуждения модели. Это план исходных инженерных шагов C12R.0–.7, не инструкция запускать их заново. Актуальные последующие корректировки описаны в [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md), включая [C12R.9](C12R9_CONTEXT_CONTINUITY.md); следующий шаг и статусы определяются [STATUS](STATUS.md).

Baseline исходников: `4ebaf262b98d541120745e04f697ebbb3404fc88`, ветка `greenfield/model-first-core`. C12.0–C12.2 и C12.5–C12.9 инженерно реализованы; C12.3/C12.4 и native NixOS acceptance не закрыты. Исторический CI PASS не подтверждает новый HEAD. Текущий статус — [STATUS](STATUS.md).

Исторические инструкции исполнения исходных шагов C12R.0–.7 (не повторять уже закрытое):
- получить актуальный HEAD, прочитать [AGENTS.md](../../AGENTS.md), [STATUS](STATUS.md), [активный план](IMPLEMENTATION_PLAN.md), [.agents/REASONING.md](../../.agents/REASONING.md), применимые engineering-инструкции и предметные документы;
- проверить применимость требований к текущим исходникам, не повторять уже выполненное;
- исходная последовательность начиналась с C12R.0 и инженерно завершена; для новых исправлений начинать с шага, указанного в STATUS/активном плане, не повторяя закрытые кластеры;
- фиксировать каждый самостоятельный шаг отдельным коммитом с тестами и актуализацией STATUS. Публиковать только в рабочую ветку. Отсутствие реальной native среды не останавливает независимые инженерные исправления, но исключает объявление native PASS.

## 2. Неизменяемые границы

Нормативные инварианты задают [AGENTS.md](../../AGENTS.md) и [ARCHITECTURE](../ARCHITECTURE.md). Модель владеет смыслом задачи, стратегией, декомпозицией, исполнителями, reasoning effort, перепланированием, interpretation evidence/findings и достаточностью результата. Прямой ответ одной модели — полноценный путь. Host владеет технической координацией, trusted authority, разрешениями, ресурсами, корреляцией, durable state, lifecycle, cancellation и provenance. Исполнитель владеет инструментами. Проверка формы, ссылок, объективных capabilities и технических зависимостей не является семантическим verdict.

Не вводить обязательные Planner/Coder/Reviewer/Validator, стадии reasoning, количество Workers или ходов, искусственные ограничения смены effort, обязательное внешнее событие между самостоятельными ходами, Host-эвристики выбора стратегии. Нет второго scheduler/state machine, provider-specific logic в Core, Host isolation, виртуального workspace, source-file CAS, обязательного VCS discovery или принудительного reconciliation изменяемой среды. Нет blind replay неизвестных эффектов; сохранять действующие permissions, бюджеты, cancellation provenance, acceptance contracts и достоверность наблюдений.

**Вне scope:** новый context compaction, общий бюджет prompt, автоматическая summarization/reorganization, Compactor, новый retrieval/chunking, подавление native skill discovery Controller, управление native subagents. Существующие compactContext(), model_summary, ContextPort.list/fetch, ограничения истории и отдельных записей сохраняются; исправлять только конкретный дефект существующего контракта. Не расширять контекстный scope Worker. Не превращать model claims в инструментальные факты. Невыполненные проверки — UNVERIFIED.

## 3. C12R.0 — Baseline и воспроизведение (P1)

Зафиксировать доступные материалы трёх обсуждавшихся native runs: operation/decision/action/attempt/session IDs, commit, версии Role Orchestrator, клиента, адаптеров/исполнителей, профили, уровни effort, действия и результаты, cancellation, доступные observations, ограничения диагностики. Исходные приватные traces не публиковать; только безопасно редактированные evidence и ссылки. Отделять OBSERVED, SUPPORTED исходниками, воспроизведённые тестами дефекты, model claims, HYPOTHESIS и UNVERIFIED. Если исходные материалы недоступны, не восстанавливать события по предположениям; зарегистрировать gap и продолжить подтверждаемые работы.

Исходники baseline подтверждают:
- `src/application/orchestrator.js`: drive() после локального технического отказа Controller вызывает technicalWait(); reserve() и dispatchWorker() требуют active. Это может блокировать ранее принятые независимые Workers. Проверить starvation при одном слоте и durable recovery; воспроизвести;
- `src/core/snapshot.js`: проверки explicit Controller effort внутри selectable ветки допускают противоречивый native mode, в отличие от Worker. Воспроизвести;
- `src/application/handoff.js`: inline skill instructions включаются в handoff.instructions. `src/application/orchestrator.js` загружает skillInstructions и учитывает их в identity; `src/adapters/invocation-prompt.js` извлекает поле, но не сериализует. Воспроизвести отсутствие доставки и проверить оба пути;
- `src/application/controller-context.js`: существующая инструкция honor applicable skill restrictions неоднозначна в отношении scope. Это основание для уточнения, не доказательство причины поведения конкретной модели.

Зафиксировать CAPABILITY_UNAVAILABLE, PROTOCOL_ERROR и context.unavailable: MISSING по доступным материалам. Не приписывать их reasoning level, длительности или skill без причинного подтверждения. Сопоставить с [единственной acceptance matrix](../../tests/ACCEPTANCE_MATRIX.md). Подготовить адресные regression fixtures и исходные условия сравнения качества; возможны небольшие диагностические исправления раньше других шагов, если нужны для воспроизведения.

**Выход:** перечень подтверждённых дефектов и воспроизводимых проверок, baseline/ограничения native evidence, следующий шаг в STATUS. Не требовать недоступных нативных логов как предпосылку исправления доказанного дефекта.

## 4. C12R.1 — Независимость Controller и Workers (P1)

### Контракт

Локальная техническая невозможность следующего Controller invocation не равнозначна невозможности продолжения всей operation. Ранее принятые независимые Actions остаются исполнимыми при действительных model dependencies, permissions, cancellation и доступных ресурсах. Wait policy управляет моментом получения результатов Controller, а не отменяет другие принятые Actions.

Исправить взаимодействие drive(), runActionRound(), reserve(), admission/dispatch, lifecycle, cancellation, recovery средствами существующего coordinator. Различать:
- accepted Action без попытки, reserved attempt (not_sent), dispatched attempt, terminal outcome, cancellation, ожидание зависимости;
- локальный Controller failure и глобальное состояние/ограничение операции;
- временное ожидание ресурса и окончательный технический отказ.

Не просто удалять проверки active и не разрешать Workers во всех waiting-состояниях: сохранять действующие правила глобальной отмены, завершения, ожидания пользовательского решения, отзыва полномочий и resource limits. Уважать отменённые или явно не разрешённые к продолжению Actions. Не изменять смысл after_terminal и after_model_acceptance. Отказ Controller (включая unsupported effort) сохраняется с конкретной причиной, не вызывает автоматического повтора неисправного invocation, выбора иного Controller/effort, создания Actions или финальной Assessment Host. После исполнения доступной работы сохранить outcomes и возможность продолжения через существующий lifecycle.

Fairness: готовые допустимые запросы к слотам не должны бесконечно вытесняться повторными ходами Controller, и Workers не должны бесконечно вытеснять Controller. Реализовать через существующее резервирование/координацию; без семантической приоритизации, прерывания запущенного invocation ради fairness, нового scheduler или фиксированного чередования как стратегии. Фактически занятый/неподтверждённо освобождённый ресурс нельзя считать свободным.

Recovery: durable decisions/admissions/attempt events — источник истины, а не transient pending map. Восстановить допустимые принятые, ещё не отправленные действия согласно существующим контрактам; не создавать новую попытку для неизвестного dispatched effect и не повторять завершённый outcome. Отдельно проверить смешанное состояние после restart и совместимость с late outcomes/cleanup.

### Регрессии и приёмка

- additions + nextController.continue при неподдерживаемом Controller effort; ранее принятый Worker остаётся исполним, причина Controller видна;
- один слот: повторные самостоятельные ходы Controller, несколько ожидающих Workers, обе стороны получают ресурс при его освобождении; параллельные независимые Workers;
- зависимости after_terminal/after_model_acceptance, cancellation между admission/reservation/dispatch, отзыв permissions, глобальный budget, технический отказ Controller без Workers; штатный continue без внешнего события;
- crash/recovery принятого без попытки Action, reserved not_sent, dispatched unknown, terminal, отменённого и зависимого Action; комплексный сценарий: несколько принятых Actions в разных состояниях, технический отказ Controller, restart, корректное продолжение допустимых действий, сохранение outcomes, отсутствие blind replay;
- сохранение/доставка результатов Workers при локальном Controller failure, корректное состояние операции после исчерпания доступной работы; недопуск при действительно запрещающем состоянии.

**Критерий:** локальный отказ не отменяет модельное решение, допустимая независимая работа продолжается; сохраняются тех. причина, ресурсные/authority guarantees и единый источник lifecycle state. Проверить A09–A12, A19–A26, A28, A40, A44–A54 в применимой части.

## 5. C12R.2 — Reasoning provenance (P2)

При explicit Controller reasoningLevel проверять сохранённую связь с decision/reservation, mode selectable, точный level и selectionSource model; согласовать с Worker. Default selectable должен иметь правильный source, native/omission допустимы без explicit selection. Не требовать reasoning provenance от исторически допустимой записи, не противоречащей записанному выбору. Не реконструировать историю из текущего каталога/нативного mapping. Проверить journal и materialized attempts, не повышать schemaVersion исключительно ради исправления проверки.

Регрессии: explicit high; несовпадающий low; native при explicit; неверный selectionSource; отсутствующий reasoning при explicit; корректные native/default selectable и исторические записи без provenance; противоречие journal/attempt. Проверять сохранённый маршрут, а не актуальные настройки провайдера.

**Критерий:** противоречивый snapshot отклоняется без изменения исходного состояния; корректные historical/current snapshots восстанавливаются. Применимые A23–A28, A44–A54.

## 6. C12R.3 — Адресная диагностика (P2)

- Admission/dispatch: различать конкретные подтверждённые причины CAPABILITY_UNAVAILABLE (profile, role, skill, effort, required capability, adapter и прочие действующие причины), отсутствие/unsupported/unknown поддержки. Безопасный resource id, operation/action/attempt correlation, категория. Неполный skill не блокирует любую задачу, если действующий контракт допускает продолжение.
- INVALID_PROPOSAL: доступные field path, expected contract, attempt id, category, объективно допустимые варианты; вернуть модели для correction в существующем цикле/бюджете, не исправлять семантику.
- ACP/CLI: adapter определяет достоверные transport/protocol, malformed response, stop reason, selection rejection, известный limit, timeout/cancel/disconnect; provider-specific детали за портом; неизвестная причина остаётся unknown. Не выводить причину из текста prompt/названия модели/effort.
- Trace/export: correlation operation/decision/action/attempt, последовательность, фактические reason codes, пропуски и недоступность. Diagnostic sink не вторая истина. Необходимая для дальнейшего решения и recovery информация сохраняется в authoritative state/observations независимо от включённой диагностики. Не писать полные prompts/skills/tool bodies/user data по умолчанию; отключение sink не меняет семантику.

**Критерий:** адресная причина либо явная недостаточность диагностики; модель может сама выбрать следующий шаг. Регрессии на соответствующие категории, failure/disabled sink и correlation; A05/A18/A29/A36/A40, применимые reasoning checks.

## 7. C12R.4 — Context, evidence, findings (P2)

Проверить Action.contextRefs → handoffContext → Invocation → contextAccess; однозначность refs и provenance, включая provider-local refs разных attempts, Finding → Observation → Attempt → Provider/Tool. Проверить operationHistory и канонические providerEvidenceRef: использование первого совпадения допустимо только при доказанном инварианте однозначности; неоднозначность не разрешать произвольно. Различать неизвестную ссылку, известную запись вне текущего prompt, недоступный payload, truncated, permission denied, retention, budget, integrity error и другие действующие причины. Не обещать fetch недоступного материала.

Сохранять существующий ContextPort.list/fetch, scope, capability, limits и provenance при передаче/усечении. Controller может обнаруживать записи, извлекать доступные детали, сопоставлять findings разных Workers. model_summary остаётся отдельным model claim с авторством и covered observation refs, не заменяет оригинал и не повышает его достоверность. Assessment различает наблюдения, provider reports, model claims, findings и существенные неопределённости; сохранять действующий контракт evidence. Историческая запись не становится гарантией актуального workspace.

Не вводить freshness gate, обязательный re-review/fetch всех записей, Host verdict о релевантности/достаточности, автоматический провал за необязательную ссылку, расширение scope или новый retrieval/compaction.

Регрессии: повторяющиеся provider-local refs, неизвестная/неоднозначная ссылка, запись не в prompt но доступна fetch, известный недоступный payload, truncated, budget/retention/integrity/permissions, неподдерживаемый retrieval, запрет неразрешённого fetch Worker, findings из разных attempts, summary и исходные записи, противоречащие findings. Не вводить semantic verdict Host при синтезе.

**Критерий:** корректная адресация, доступность в рамках существующего контракта и provenance; модель определяет применимость/достаточность. A08/A13/A29/A33–A36/A40.

## 8. C12R.5 — ACP и ресурсы (P2)

Исследовать наблюдавшийся длительный deep invocation с PROTOCOL_ERROR: message limits, accumulated output, streaming/terminal events, session lifecycle, timeout, cleanup. Проверить альтернативные причины; не повышать timeout/limits без подтверждённого основания. Сохранить доступные частичные observations с provenance/completeness; отличать инструментальные факты, незавершённый model text, final response и terminal outcome. Не превращать частичный ответ в успешный invocation/finding.

Проверить cancel/disconnect/late results/recovery, освобождение слотов, закрытие owned session/process. Сохранить корреляцию поздних событий и не возрождать отменённую работу. Не считать cleanup завершённым без подтверждения detachment; при зависшем cleanup наблюдаемая причина недоступности ресурса должна быть доступна, а дальнейшее допустимое продолжение/recovery определяется существующим lifecycle. Не маскировать бессрочную блокировку общим RESOURCE_LIMIT, не освобождать реально занятый ресурс, не убивать чужие процессы, не вводить provider-specific fallback или blind replay. Независимость Worker ограничена реально доступным ресурсом.

Usage: сохранять только подтверждённые provider measurements, с attempt correlation; неизвестное остаётся unknown, оценка не факт.

Регрессии: длительный success, failure после partial output, invalid terminal, known limit, cancel + late result, disconnect/recovery, completed/unfinished cleanup и позднее detachment, конкуренция за слот при неподтверждённом cleanup, available/unknown usage, отсутствие replay. Проверить взаимодействие с C12R.1.

**Критерий:** фактически подтверждённые причины классифицируются, доступные observations и late correlation сохранены, resource lifecycle достоверен, новых эффектов вследствие recovery не возникает. A19–A25/A28/A29/A36/A40.

## 9. C12R.6 — Skills и модельная координация

### C12R.6.0 — Instruction scope и доставка (P1 delivery, P2 prompt clarification)

Выполнить рано, до оценки модельной стратегии. Role Orchestrator delegation — Controller создаёт Action через Coordinator. Provider-native delegation — модель использует собственных субагентов внутри Invocation. Skill выбранный для Worker регулирует исполнение его Action; локальный запрет внутренней делегации не становится автоматически запретом Controller создавать Actions. Scope задаётся происхождением, назначением и существующим Invocation contract, не анализом текста Host. Модель интерпретирует смысл и содержательные конфликты. Явные требования пользователя ко всей operation и trusted authority сохраняются. Skill/role не предоставляют permissions/capabilities и не меняют исполнителя.

Уточнить неоднозначную instruction Controller минимально: выбранные для Worker инструкции относятся к его задаче; native subagents и orchestration различны; делегирование по целесообразности, direct answer допустим. Не выводить обратное правило «Controller игнорирует все skills»: при непосредственном выполнении задачи применимые task-specific инструкции и пользовательские ограничения сохраняют силу. Это уточнение scope, не новый Controller skill selection mechanism. Никаких regex/keyword lists/исключений. Native auto-discovery Controller не менять и не подавлять; не гарантировать, что модель никогда самостоятельно не прочитает skill или не изменит поведение.

Исправить оба существующих пути: catalog inline → handoff.instructions и catalog.loadSkill() → Invocation.skillInstructions → renderer. Обеспечить фактическую доставку выбранного материала на границе адаптера (CLI/ACP и общий provider-independent contract). Согласовать источники, версии и статусы по существующему контракту SkillMetadata/SkillInstructions; не считать разные источники эквивалентными без основания, не дедуплицировать семантическим сравнением, не дублировать одну инструкцию. Исследовать назначение inline/full/fallback перед выбором минимального целостного решения. Сохранять skill ID, version, status complete/truncated/unavailable, доступный текст и техническую причину недоступности; отсутствие loader или полного текста не успешная доставка. Не передавать невыбранные skills, не подмешивать Worker instructions в Controller. Ограничения размера сохраняются; новый общий бюджет prompt не входит.

Worker request identity: учитывать контролируемые семантически значимые входы (выбранные skills, versions/statuses, фактически передаваемый текст, role instructions, context, user constraints, прочие значимые поля). Проверить соответствие хешируемого материала фактическому Invocation на dispatch, включая изменения версий/текста и повторную материализацию context. Изменённый значимый материал не должен ошибочно использовать прежний idempotency key. Не требовать hash конечного provider-native prompt и не переносить rendering в Core; не вводить source CAS/fingerprint. Не считать исторический request hash доказательством фактической доставки ранее пропущенного текста; проверить retry/recovery и совместимость уже записанных attempts без blind replay.

Исходная область: controller-context.js, orchestrator.js, handoff.js, worker-request-identity.js, invocation-prompt.js, skill-registry.js при необходимости; integration/handoff, codex-provider, contracts/acp-provider и применимые skill/plugin tests. Не обязательно изменять все файлы.

Контрактные регрессии:
- Controller получает metadata, не все тексты; Worker получает только выбранные инструкции с правильным статусом; inline и loaded согласованы без дублирования/смешения версий;
- фактический request CLI/ACP содержит skillInstructions (не только Invocation/hash); complete/truncated/unavailable и отсутствие loader; изменение фактически доставленного материала меняет identity; согласованность на dispatch и безопасный retry;
- skill не расширяет trusted permissions; fixture Decision с двумя Actions с локальным no-native-subagents skill допускается, оба получают инструкции; Host не классифицирует текст; direct Controller без Worker остаётся допустимым; явное operation-wide ограничение пользователя не отменяется skill. Семантическое соблюдение текста проверяется моделью, не Host keyword gate.

Native: задача с явной просьбой распределить работу; отличать технический допуск, корректный Decision, реальный выбор модели и доставку/исполнение Worker. По возможности сопоставить одинаковую задачу с локальным запретом native delegation и без него. Одиночная стратегия без пользовательской просьбы сама по себе не дефект. Если native auto-discovery влияет на результат, отметить ограничение эксперимента, не расширять scope.

**Критерий:** выбранный skill фактически доставлен с корректной атрибуцией/identity; Host не подменяет семантику и не смешивает scope. A08/A18/A30/A32/A38/A39 и применимые reasoning/idempotency checks.

### C12R.6.1 — Оптимизация controllerInstructions (P2)

После технических исправлений оценить поведение до масштабного изменения инструкций. Исправлять только обнаруженные неоднозначности, конфликты или избыточные формулировки, сохранять корректные существующие инструкции. Не обязательно вносить изменения, если проблем не обнаружено. Предпочитать замену/объединение вместо добавления.

Общий ориентир: выбирай дальнейшие действия исходя из цели пользователя, доступных evidence, существенных неопределённостей и ожидаемой пользы; самостоятельно решай, достаточно ли результата или нужны исследование, делегирование, самостоятельное reasoning или проверка. Не добавлять ходов без ожидаемой пользы. Это не checklist на каждый Decision, не обязательное обоснование сложности/effort/делегирования и не требование экономить вызовы ценой качества. Сохранить технические инструкции Decision/Actions/retry/cancellation/evidence/Assessment.

### C12R.6.2 — Динамическое делегирование (P2)

Проверить существующие возможности: direct/one/multiple Workers, независимая работа, адресные отказы, replan при новых evidence, отмена ненужных Actions, синтез противоречащих результатов, продолжение при отказе исполнителя, scope skills. Не требовать делегирования, количественных норм или фиксированных маршрутов. Исправлять подтверждённые контрактные дефекты, не заставлять модель выбирать определённую стратегию.

### C12R.6.3 — Адаптивный effort (P2)

Проверить выбор Worker effort, следующий собственный Controller effort, самостоятельное продолжение без внешнего события, unsupported level (видимый technical result), несколько последовательных изменений, reasoning provenance и независимость Workers. Логические levels не универсальная шкала интеллекта; никакого искусственного лимита смены или Host escalation/downgrade. Различать техническую возможность, наблюдавшийся выбор и его полезность.

### C12R.6.4 — Assessment (P2)

Проверить существующие инструкции и при необходимости точечно уточнить представление инструментальных наблюдений, model claims, существенных неопределённостей, выполненных/частичных/непроверенных требований и недоступных evidence. Модель выбирает дополнительное исследование, если оправдано. Host проверяет форму/ссылки/технические контракты, не выносит verdict качества/достаточности. Не вводить обязательный Assessment invocation или повторный анализ достаточного результата.

**Критерий C12R.6:** модель располагает корректными инструкциями, контекстом и возможностями координации; свободно выбирает/меняет стратегию. Нет обязательного workflow или увеличения числа вызовов по умолчанию. Применимые A04–A06/A08–A14/A29/A32–A35/A44–A54.

## 10. C12R.7 — Регрессия, native acceptance и эффективность

### Engineering

После каждого самостоятельного исправления — адресная регрессия. Перед закрытием инженерной части: npm ci, npm run check, npm test, npm run check:package, npm run check:removal, применимые Nix flake check/build/install и NixOS evaluation, архитектурные границы и [acceptance matrix](../../tests/ACCEPTANCE_MATRIX.md). Использовать действующие команды CI и docs; сравнить смысл тестов/гарантий, не только counts. Отсутствие обязательного harness — не PASS; фактические commands/exits/commit/версии/CI в STATUS. Не ослаблять прежние проверки ради зелёного результата.

### Native

Использовать [NATIVE_ACCEPTANCE](NATIVE_ACCEPTANCE.md), безопасные реальные условия, действующие permissions. Проверить direct task; делегирование Sol/Astra; параллельные независимые Workers; Worker/Controller effort и continue; локальный Controller failure при ожидающем Worker; skill scope и actual delivery; неполный context/fetch; ACP failure с частичными observations и дальнейшим модельным решением; cancel/late/resume; синтез findings и replan после противоречащих evidence. Для опасных/невоспроизводимых ошибок использовать fault-injection fixtures отдельно от native результатов. Контрактный тест подтверждает техническую способность, не фактическое поведение LLM. Один native запуск не доказывает устойчивый эффект; повторять существенные сравнения соразмерно ресурсам.

Сохраняются C12.3/C12.4 и native NixOS acceptance. Sol/Astra через codex-acp — два профиля/модели в одном пути, не доказательство независимых CLI/ACP adapters. Реальные независимые пути CLI/ACP, внешний Zed, native permissions/cancel/resume и установленный NixOS-пакет остаются отдельными обязательствами. Если недоступны, соответствующие сценарии UNVERIFIED, без ложного PASS.

### Сравнение качества

По возможности три состояния: A — baseline; B — после технических исправлений (минимальные scope/contract prompt changes включены); C — после обоснованной оптимизации Controller instructions. Если C не менялся, не создавать искусственный эксперимент; если исходный baseline недоступен, отметить ограничение. Сопоставимые задачи, workspace, доступные profiles/models, limits, user constraints, версии, критерии результата; не создавать обязательный VCS fingerprint или отдельный runtime. Нативные модели стохастичны; повторять репрезентативные прогоны при существенных изменениях.

Оценивать качество/полноту результата относительно пользовательских требований, корректность evidence, полезный вклад Workers, адаптивность/replan, invocation count (включая повторные), wall-clock, ожидание слотов, подтверждённый token usage, доступность context, размер фактически отправленного Invocation (без сохранения чувствительного текста), потерянную/сохранённую полезную работу при отказе. Отделять рост prompt из-за исправленной доставки skills от координационных накладных расходов. Не считать больше Workers/effort улучшением, меньше вызовов/времени — улучшением при падении качества. Дублирующее исследование может быть оправданным независимой проверкой. Не требовать числовой нормы, автоматического semantic scoring или новой benchmark/monitoring инфраструктуры. При ухудшении исследовать вероятную причину прежде, чем расширять scope. Недоступные измерения unknown/UNVERIFIED.

**Критерий:** исправленные дефекты и regression verified; native evidence с provenance и ограничениями; влияние на качество/эффективность описано по реально доступным измерениям. Не выдавать отсутствие данных за доказательство улучшения.

## 11. Порядок, документация и завершение

Инженерная последовательность: C12R.0 → C12R.6.0 → C12R.1 → C12R.2 → C12R.3 → C12R.4 → C12R.5 → C12R.6.1–6.4 → C12R.7. Приоритеты P1/P2 относятся к инженерным работам, не runtime. Допустима корректировка при реальных зависимостях с кратким обоснованием в STATUS; не компенсировать инфраструктурный дефект prompt-правилами.

Обновлять знания по назначению согласно AGENTS.md: нормативные docs EXECUTION, PROVIDERS_AND_CONFIGURATION, REASONING_EFFORT, CONTEXT_AND_RECOVERY, DIAGNOSTICS — по реально изменённым контрактам; DECISIONS — существенные решения и альтернативы; CHANGELOG — продуктовые исправления; единственная acceptance matrix — тестовые связи и наблюдаемые результаты; STATUS — прогресс, next step, commits, checks, native gaps. Не дублировать все требования в каждом файле, не создавать development/ и альтернативную матрицу. Упомянутые сценарии C12R — регрессии существующих R/A, не новая нумерация требований. Для каждого самостоятельного инженерного шага — отдельный commit.

Различать:
- **Implementation complete:** подтверждённые дефекты исправлены, контракты/документация согласованы, нет известных блокирующих инженерную приёмку дефектов. Неподтверждённые причины не объявляются исправленными без evidence.
- **Regression verified:** адресные и общие проверки фактически выполнены на проверяемом commit; package/install и применимые Nix/NixOS engineering checks подтверждены.
- **Native integration verified:** необходимые реальные сценарии выполнены, capabilities и результаты с provenance, оценка качества/эффективности с ограничениями. Не закрывать native при недоступной среде.

Если native environment недоступен, завершить доступную инженерную часть C12R, оставить точные native gaps в STATUS и матрице. Полное закрытие C12 зависит от C12.3/C12.4 и native NixOS acceptance; успешный CI или fixtures их не заменяют.

Итог: Host обеспечивает исполнимость, надёжность и наблюдаемость модельных решений. Модель определяет стратегию, исполнителей, последующие действия и достаточность результата. Context compaction и изменение native skill discovery остаются вне C12R.
