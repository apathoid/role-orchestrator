# C23 — Configuration-scoped State & Concurrent Runtime Support

**Статус: C23-R implementation complete; engineering PASS at 0c519ebf; native UNVERIFIED; repeat architecture review pending.**

Baseline `e96b036b57495d3171ce68d98bbada3c97e4feb8` / [CI #45881827539](https://github.com/apathoid/role-orchestrator/actions/runs/45881827539) SUCCESS. Planning HEAD `a0a3c5821d59f50974f8caeecff6e70e36c2cf6a` / [CI #46019452297](https://github.com/apathoid/role-orchestrator/actions/runs/46019452297) failed the stale A01–A125 specification assertion. RED `254d371b09c243b6f242b59e8642da9b81d294de` / [CI #46019958951](https://github.com/apathoid/role-orchestrator/actions/runs/46019958951): four expected C23 integration failures. Production GREEN `b9f8fa5414cce5c90f3fbfb057ce310964ee1699` / [CI #46020346402](https://github.com/apathoid/role-orchestrator/actions/runs/46020346402) SUCCESS: root 726/726, integration 589/589, Linux PTY 15/15, checkJs/import boundaries, all historical comparators, locked Nix build/package/install and release checks. All four initial RED tests pass. Expanded engineering verification: `d45fcfa2d188f0df2d08f59fc1bf0adaed309e3d` / [CI #46021141243](https://github.com/apathoid/role-orchestrator/actions/runs/46021141243) SUCCESS on Node 24.21.0: 596/596 integration (all 11 C23 tests), 733/733 root, 15/15 Linux PTY, zero skipped/failed; specification/checkJs/import boundaries, historical comparators/resource probes, locked Nix build/package/install, NixOS evaluation and release checks PASS. Actual overlapping RO subprocesses, actual ACP SDK transport and same-process API tested with deterministic provider fixtures. Native real providers/clients and NixOS runtime remain UNVERIFIED. This evidence-only follow-up has its own CI; engineering evidence refers to the exact tested SHA. Local checkout inaccessible (GitHub DNS; local Node22, no Nix); edits via expected-HEAD fast-forward commits, no master merge.

C23-R: RED `af6d7b8ae2f144ce2021eae41fb5d0ba65ff0e7f` / [CI #46024912586 attempt 2](https://github.com/apathoid/role-orchestrator/actions/runs/46024912586/attempts/2): 596/597 integration, expected STATE_STORE_IN_USE for all three read commands. Implementation `0c519ebfa5c57ab0c8eb59a87d386d71f88d6767` / [CI #46025557401](https://github.com/apathoid/role-orchestrator/actions/runs/46025557401) and [CI #46025547994](https://github.com/apathoid/role-orchestrator/actions/runs/46025547994) SUCCESS, 39/39 steps each, root 738/738, integration 601/601, PTY 15/15. See [STATUS](STATUS.md) for fixture correction and evidence boundaries.

- Repository: `apathoid/role-orchestrator`
- Рабочая ветка: `feature/configuration-scoped-state`
- Implementation baseline: `e96b036b57495d3171ce68d98bbada3c97e4feb8` (master), [CI #45881827539](https://github.com/apathoid/role-orchestrator/actions/runs/45881827539) SUCCESS.
- Research baseline первоначального предложения: `8061e88e0b6f40f05e41f43924e735f0d9b78908`; он не является текущим implementation baseline.
- Planning HEAD: `a0a3c5821d59f50974f8caeecff6e70e36c2cf6a`. Перед работой проверить фактический HEAD, ancestry, рабочее дерево и CI точного SHA. Не перезаписывать чужие изменения.
- Единственная матрица приёмки: [A126–A131](../../tests/ACCEPTANCE_MATRIX.md). Сценарии ниже — детализация этих строк, не параллельная постоянная матрица.

## 1. Цель и согласованные решения

Устранить необоснованный конфликт независимых CLI/ACP runtime, когда разные конфигурационные файлы без явного storage.directory сейчас выбирают один каталог состояния. Одновременно устранить зависимость пользовательского управления существующей Operation от совпадения конфигурации исполнения и лишней инициализации providers/plugins.

**Путь конфигурации выбирает автоматический State Store; конфигурация определяет параметры исполнения; State Store определяет область хранения и эксклюзивность writer.** Эти функции независимы. Два файла с байт-в-байт одинаковым содержимым по разным логическим путям по умолчанию получают разные Stores. Редактирование содержимого не меняет автоматический Store. Явный общий каталог для разных конфигов разрешён; один активный writer на физический Store сохраняется. Не навязывать пользователю независимые каталоги, если он явно выбрал общий.

Команды, которые не инициируют исполнение, адресуются выбранному Store и Operation, не конкретному fingerprint конфигурации. Для run/resume сохраняется проверка совместимости с живым владельцем, его действующие launch preferences и полномочия. При отсутствии владельца resume использует существующие правила trusted reconfiguration, recovery и ResumeAuthority; исторический configurationRef не превращается в gate.

Никаких миграций, копирования, объединения истории, fallback или discovery по другим Stores. Стандартная конфигурация сохраняет прежний каталог; прежняя история дополнительных конфигов остаётся там, где была записана, и доступна через явный выбор Store. Конфигурация может быть удалена/повреждена: при явном Store управляющие команды должны оставаться доступны.

Параллельная работа в одном workspace — право и ответственность пользователя. Конкурентные изменения файлов, инструменты, Git, skills, scripts, сторонние caches, module-level state plugins, RAM/VRAM/CPU/inference server и параллельные возможности внешних исполнителей не регулируются RO. RO корректно владеет только своими ресурсами. Не исправлять внешние компоненты.

## 2. Нормативные границы и организация работы

До изменений изучить AGENTS.md, .agents/REASONING.md, применимые .agents/engineering/*, STATUS, IMPLEMENTATION_PLAN, ARCHITECTURE, CONTEXT_AND_RECOVERY, PROVIDERS_AND_CONFIGURATION, DIAGNOSTICS, DECISIONS (D05, D07, D08), действующую acceptance matrix и существующие тесты. JavaScript ESM/Node24/JSDoc/checkJs; полный Nix/package/CI остаётся обязательным.

- Не менять model-facing prompts, Controller/Decision/Intent/Action/Outcome/Assessment, tool discovery/skills, стратегию, бюджеты, admission, cancellation provenance, unknown effects, ResumeAuthority, authority или permissions. Исключение только уточнение host-local admission конкретных административных команд, описанное в §5; это не новое модельное полномочие.
- Не вводить новый scheduler, daemon, instance manager, global registry, leases, heartbeat, process/PID watchdog, global budget, workspace lock, source CAS, изоляцию, VCS gate, mandatory reconciliation или provider-specific логику. Не добавлять таймаутов. Не перерабатывать имеющиеся control discovery/startup bounds в C23; при обнаружении отдельного дефекта зафиксировать его отдельно.
- Сохранять текущий wire protocol ACP; не добавлять нестандартных notifications и зависимости от конкретного клиента, включая Zed. Local-control v1 сохранять максимально, любые необходимые локальные изменения объяснить и протестировать.
- Не менять Core, если задача решается на composition/host/storage boundary. Не делать новую доменную сущность, второй журнал, вторую модель состояния, абстрактный state manager или второй Coordinator. Не изменять файлы ради формального соответствия списку.
- Этапы ниже — инженерная организация разработки, не runtime workflow; связанные правки можно объединять. RED/GREEN для фактических проблем, регрессионные проверки для сохраняемых свойств; не искусственно требовать RED для уже правильного поведения.

## 3. C23.0 — Исследование и исходные наблюдения

На baseline проверить следующие SUPPORTED по исходникам обстоятельства (не считать экспериментально воспроизведёнными):
1. src/main/cli-config.js: default XDG state directory одинаков для всех файлов без storage.directory.
2. src/adapters/state/local-store.js: SQLite BEGIN IMMEDIATE на .writer.sqlite; load требует open, open выполняет cleanup и опциональный retention. Атомарная публикация snapshot и проверка его identity/schema — действующий источник истины.
3. src/main/cli.js: все команды читают/декодируют конфиг до local control; fallback открывает полноценный openRuntime даже для inspect/trace/export/cancel; offline cancel возвращает no_live_execution, не вызывает coordinator.cancel.
4. src/main/runtime.js: openRuntime создаёт диагностическую инфраструктуру, store, extensions/providers и Coordinator; configurationRef — SHA-256 исходного текста JSON. trace использует current known secrets из configured provider launch.env references.
5. src/hosts/local-control.js: version/token, затем безусловный configurationRef и launch compatibility, request identity/dedup, owner binding/answerKey/reconnect; descriptor содержит socket path/token/pid; mkdtemp для сокета и token-guarded cleanup. src/main/extensions.js: относительные module paths разрешаются относительно configurationDirectory. Одинаковый JSON в разных каталогах не обязательно задаёт одинаковое исполнение.
6. src/main/acp.js и src/hosts/acp.js: runtime открывается при старте, sessions в выбранном Store; ACP владелец не принимает CLI run/resume; закрытие соединения и shutdown — действующий lifecycle.
7. src/hosts/commands.js / src/application/orchestrator.js: inspect читает store.load; cancel выполняется существующим владельцем; operationTrace строится из durable journal и использует redactDiagnostic. Redaction базовый без secrets уже поддерживается. Offline redaction даже до C23 знает только текущие, не исторические значения.
8. Исследовать RO-owned resources: snapshots/artifacts, diagnostics/rotation, ACP sessions, control descriptor/socket/request bindings, tmp files, built-in adapter/extension resources и partial startup/shutdown. Для каждого найденного общего ресурса назвать владельца, lifetime, cleanup. Не расширять анализ до внутренних механизмов внешних providers/plugins. Исправлять только доказанный конфликт в собственной инфраструктуре.

RED: два разных конфигурационных файла без explicit store (в т.ч. одинаковое содержимое) конфликтуют при перекрывающихся активных Operations; CLI vs ACP; live cancel/inspect/trace/export после изменения JSON; administrative command с явным Store без валидного конфига; offline inspect запускает extension factory (fixture marker/throw/hang только управляемая fixture). Отдельно проверить сохранение writer exclusivity и existing compatible attach. Зафиксировать точные команды, expected/actual, baseline и exit. Не считать отказ сторонней системы RED для RO.

## 4. C23.1–.2 — Единый выбор State Store и CLI/ACP --state-dir

### 4.1. Контракт путей

Для CLI/ACP порядок: explicit `--state-dir PATH` > trusted config `storage.directory` > deterministic automatic Store. Для API: RuntimeOptions.stateDirectory > storage.directory > текущий контракт (при отсутствии подходящего каталога действующая INVALID_CONFIGURATION; не придумывать file identity или новый API default).

Стандартный конфиг: `${XDG_CONFIG_HOME:-$HOME/.config}/role-orchestrator/config.json`. Стандартный Store: `${XDG_STATE_HOME:-$HOME/.local/state}/role-orchestrator`. При валидных абсолютных XDG paths сохраняется точный старый путь; явный --config стандартного файла равнозначен отсутствию --config. Другой файл с basename config.json не является стандартным.

Дополнительный конфиг: `<state-root>/configurations/<safe-basename>-<sha256-of-normalized-absolute-logical-config-path>/`. Предпочесть полный SHA-256; безопасный ограниченный по байтам компонент basename, без разделителей, traversal и платформенно недопустимых имён; человекочитаемая часть не идентичность. Разные basename/одинаковые basename в разных директориях, Unicode/длинные имена — проверить. Не использовать fingerprint содержимого, PID, UUID, timestamp, workspace, Git или launch preferences. Без registry.

Identity — нормализованный абсолютный логический путь от launch cwd; нормализовать . и ..; не использовать обязательный realpath конфигурации, чтобы symlink на управляемый файл (в том числе Nix store) не менял Store при смене target. Разные логические symlink paths могут выбирать разные Stores. Не менять правила относительных paths providers/plugins/skills или делать canonicalization workspace. Для store aliases writer exclusivity по фактической SQLite блокировке, не по строке пути; не добавлять inode/PID registry.

Относительный storage.directory — относительно каталога конфига; относительный --state-dir — launch cwd, не --cwd и не config dir. Пустой аргумент — адресная ошибка. Не добавлять env options. Для относительных/нестандартных XDG env values исследовать действующий контракт, проверить единообразие CLI/ACP/diagnose; не менять его молча и не расширять C23 до общей переработки XDG. Если требуется техническая нормализация для однозначности, задокументировать точное поведение и regression case.

### 4.2. Реализация

Единый resolution helper в существующем composition/config entrypoint (src/main/cli-config.js); отдельно разрешение явного Store, логического config path и чтение config по необходимости, без дублей алгоритма. Результат должен позволять указать resolved stateDirectory и source (cli_override/configuration/default_configuration/configuration_path — предлагаемые названия). Не добавлять эти поля в Core/snapshot.

Добавить --state-dir в run/resume/inspect/cancel/trace/export-diagnostics/diagnose и ACP entrypoint, help. Для execution валидная конфигурация обязательна даже при override. Для diagnose сохранять существующую диагностику выбранной конфигурации. Для административных команд явный --state-dir имеет приоритет и достаточен; не требовать чтения/валидации config для маршрутизации. Без override читается config, поскольку он может задавать storage.directory. Если необходимый config отсутствует/невалиден, адресно указать на --state-dir; не угадывать прежний storage.directory и не искать альтернативные Stores. Для trace конфиг может использоваться опционально для masking (§6), но не блокирует вывод при явно заданном Store.

Сохранить текущую схему config, включая обязательность directory в присутствующем storage. Поддержка retention-only storage не входит в C23. Не расширять программный API ради симметрии CLI. Не делать автоматический fallback на старый Store или создание копий операций.

### 4.3. Границы каталогов

Стандартный Store с вложенным configurations/ допустим: baseline local-store readdir/filter/cleanup и diagnostic rotation работают в своей области. Подтвердить это тестами. Если для предложенной автоматической структуры понадобится сложная защита, выбрать минимальную альтернативу с непересекающимися соседними каталогами, сохранить старый default и обосновать изменение. Не вводить ancestor/descendant validation, обход пользовательских Stores или запрет пользовательских nested paths; не защищать произвольные внешние перемещения/удаления/symlink races каталогов. RO не удаляет чужие ресурсы своими штатными действиями.

## 5. C23.3 — Управляющие команды и live local control

| Команда | Валидный config | Проверка совместимости с live owner | Исполнение |
|---|---|---|---|
| run, resume | Да | Да | существующий runtime/attach |
| acp | Да | Не применимо к новому процессу | existing ACP lifecycle |
| cancel | Только если нужен для выбора Store | Нет | существующий владелец либо no_live_execution |
| inspect | Аналогично | Нет | owner или minimal storage read |
| trace, export-diagnostics | Аналогично; optional redaction enrichment | Нет | owner или minimal storage read |
| diagnose | Да | Нет | static diagnosis |

Изменить именно host-local contract: cancel/inspect/trace/export-diagnostics не требуют совпадения configurationRef или launch preferences вызывающего клиента. Проверка token, protocol version, command/operation/request identity, доверенной локальной границы, existing owner routing остаются. configurationRef не является секретом или самостоятельным permission. Явное управление доступной пользователю Operation в выбранном Store не предоставляет authority на новое исполнение, permission grants или ответ на native interaction.

- Разделять команды исчерпывающе по уже существующему action, не классифицировать user task. Для internal subscribe/pending/answer и reconnect оставить действующие проверки и ownerRequestId/answerKey/reconnectKey/session correlation, не распространять ослабление автоматически. Не менять dedup/cancellation provenance. Для административной команды optional configurationRef/совместимый wire representation без фиктивного fingerprint; не считать отсутствующую или изменённую конфигурацию новым execution identity. Не ослаблять run/resume, в том числе через отсутствующий ref, несовместимые launch overrides, forged command или повторную доставку. Сохранить существующий machine error там, где проверка применима. Если payload fingerprint дедупликации включает configurationRef, исключить только незначимые для этих четырёх команд поля либо сохранить проверенную эквивалентность retries; не менять identity execution/answer/reconnect и не допускать reuse requestId с другим action/operation.
- Для run/resume live attach устранить ложную совместимость одинакового JSON с разным каталогом разрешения relative plugins: минимально учесть нормализованный configurationDirectory в техническом compatibility contract. Не менять исторический configurationRef, Request/Attempt/snapshot provenance; не fingerprint plugins/skills/env/workspace. Не требовать совпадения логического имени файла, если реальный известный контекст исполнения одинаков. Исследовать существующий v1 payload, выбрать минимальное локальное расширение или отдельный host-local execution compatibility reference, не делать универсальный runtime identity. Несовместимый/неизвестный контекст execution attach должен давать адресный отказ, не молча выполнять под другим runtime; проверить поведение mixed versions и документировать ограничения. Не вводить новую протокольную инфраструктуру ради совместимости.
- Все команды используют единожды разрешённый Store, descriptor scoped to Store и существующий token. Не искать операции в других Stores. При потерянном ответе после admission — прежние правила reconnect/unknown effects; не переадресовывать принятую работу другому owner и не повторять автоматически.
- Live cancel после изменения, удаления, повреждения config с явным --state-dir направляется владельцу; действует existing cancellation mechanism, не отправляет произвольные signals/PID kill. Если owner недоступен, не выдавать это за доказательство отсутствия исполнения.
- CLI run/resume с ACP owner: сохранить CONTROL_ACP_SESSION_REQUIRED при совместимой конфигурации, не создавать multi-transport ACP runtime. ACP sessions продолжаются согласно текущим правилам.

## 6. C23.4 — Offline management без инфраструктуры исполнения

Предпочесть переиспользование существующего snapshot lookup/read/decode в local-store adapter и operationView/operationTrace в host; не читать JSON в CLI обходным путём, не копировать decoder/identity/corruption checks. Минимальный read path для inspect/trace/export при отсутствии reachable owner: не создавать Store/descriptor, не запускать providers/plugins/extensions/Coordinator/permissions brokers/diagnostics sink и не инициировать retention/cleanup/изменение snapshots. Допускается локальное выделение существующего read-only primitive из adapter, либо минимальное разделение open/read и maintenance с доказанными текущими гарантиями; это не второй StateStore API для Core или универсальный read service. Не добавлять сложную синхронизацию только ради чтения. Сохранить существующую atomic snapshot semantics; при concurrent publication вернуть корректный наблюдённый snapshot или адресную ошибку, не обещать newest revision. C23-R уточнение: inspect/trace/export при отсутствии endpoint или недоступности соединения до отправки запроса читают snapshot непосредственно, в том числе при занятом writer, без acquisition writer lock. Ошибки live authority/protocol/command и lost response не разрешают fallback. Не считать descriptor доказательством ownership. Проверить races с новым writer. Не открывать полноценный runtime даже как fallback при ошибке чтения.

Offline cancel: сначала проверить сохранённый snapshot для сохранения диагностики, затем выполнить существующий ownership probe (busy сохраняет существующий discovery/отказ, даже если snapshot недоступен). Не удерживать lock во время чтения. Сохранить существующий `{operationId,status:'no_live_execution'}` при подтверждённом отсутствии RO writer (использовать существующий минимальный lock/ownership path, не запускать runtime или maintenance). Не изменять сохранённую Operation, не запускать recovery, не превращать unknown effects в none. Не сообщать no_live_execution при занятом writer без доступного endpoint, inaccessible/corrupt store или неопределённом владении; адресный существующий storage/control failure. Не создавать отсутствующий Store ради cancellation, если его отсутствие можно наблюдать без побочных эффектов; определить минимальную семантику для отсутствующего каталога, сохранить совместимый machine result там, где отсутствие live owner установлено. Не вводить PID-probe/lease/heartbeat. Проверка lock относится только к RO ownership в момент наблюдения, не гарантирует отсутствия внешних процессов. Не выполнять прямое изменение snapshot из административного клиента.

### 6.1. Offline trace/export redaction — согласованный компромисс

Всегда использовать существующий operationTrace() и redactDiagnostic() с базовым masking, исключением bodies и теми же ограничениями проекции. Не экспортировать raw prompts/native logs/observations/tool bodies. Live owner использует собственные in-memory known secret values. Offline, если доступен выбранный валидный конфиг, дополнительно использовать текущие значения только из existing configured provider launch.env references, без import/initialization и без сканирования произвольных env/files. При явно указанном Store и отсутствии/повреждении config или недоступных env использовать базовый redaction; команда не блокируется. Не подменять ошибки storage/export destination успехом. Опциональную конфигурационную информацию не загружать при live cancel/inspect, не превращать сбой enrichment в отказ trace/export. Переиспользовать извлечение known secrets, если это нужно для одинаковой семантики.

Честно сообщить об ограниченном покрытии masking (предпочтительно additive metadata existing trace/manifest, например knownSecretMasking: available_current_values / unavailable, с ясной семантикой partial; либо минимальное совместимое диагностическое представление). Не обещать историческую полноту при доступном текущем config: ключи могли быть заменены, а произвольная строка может содержать нераспознанный секрет. Не выводить значение секрета, env contents, token или приватный config в metadata/errors. При отсутствии usable known values сохранить базовый redaction и явно указать отсутствие дополнительного покрытия. Сохранить machine JSON shape/exit semantics, не добавлять предупреждения в ACP stdout, сохранить атомарный non-overwrite export. Документировать: redacted=true обозначает применённую проекцию, не гарантию отсутствия всех секретов; пользователю следует проверить export перед внешней передачей. Проверить тестами чувствительные имена, credentials URL, Bearer/Basic, bodies exclusion, известные значения внутри arbitrary string и JSON-escaped формы, смену/удаление конфигурации/secret, отсутствие env, malformed config, trace/export эквивалентность. При недоступности известных значений тест должен честно показывать residual limitation, не утверждать, что произвольная строка очищена.

Не сохранять секреты/хеши/историю конфигураций, не менять оригинальные snapshots/findings/evidence, не вводить redaction registry, новую модельную проверку, второй журнал или обязательную конфигурацию ради экспорта. Не пытаться универсально решать исторический secret discovery: существующая known-secret защита уже зависит от текущих значений.

## 7. C23.5 — Ownership, lifecycle, ACP и API

Сохранить SQLite writer lock и state-local descriptor. Единственный источник эксклюзивного writer — существующий lock; descriptor содержит зарегистрированную metadata и endpoint, не доказательство живого процесса. Не снимать lock из-за возраста, PID или socket failure; не удалять .writer.sqlite; не завершать чужой runtime. Не добавлять сложный discovery, probe protocol, heartbeat или global coordination. Использовать existing bounded control discovery/адресную ошибку; не блокировать независимый Store в попытке определить владельца соседнего.

Проверить последовательность acquire lock -> publish descriptor -> runtime ready, stale descriptor after crash, simultaneous first launch, owner shutdown/reconnect, cleanup partial failure. Не перезаписывать descriptor живого owner другим writer; cleanup удаляет только свои resources/token. При race с новым owner не переисполнять неизвестный эффект и не выдумывать состояние. Если выявлен существующий дефект, ограничить исправление конкретной RO-owned boundary; не чинить внешние процессы. Приоритет — минимальная реализация.

ACP --state-dir использует те же правила. Конфиг читается при новом запуске, работающий runtime не hot reload. Штатное закрытие ACP/новый процесс с изменённым JSON на том же логическом пути и прежним storage override открывает тот же Store; persisted session/load остаётся доступен, новые запросы используют новый config и existing authority. Изменение storage.directory/override может направить в другой Store, где прежней session нет. Если старый process ещё удерживает lock, existing отказ, без takeover. Проверять стандартным ACP fixture, не требовать реализации Zed Reload Agent. Native Zed перезапуск — отдельная проверка при доступности.

API: два openOrchestrator с разными explicit stateDirectory внутри одного процесса, независимые RO-owned instances/registries/brokers/diagnostics/close; закрытие A не закрывает B. Не гарантировать отсутствие module-level state стороннего JS plugin или внешнего provider. Не вводить module loader/threads/isolation. Same physical Store — второй writer не допускается.

## 8. C23.6 — Регрессии и сценарии приёмки

Использовать действующие test fixtures, actual OS subprocesses для многопроцессных кейсов, управляемые readiness/acceptance barriers и перекрытие времени активных Operations; не доказывать concurrency только sleep. Таймауты тестового harness допустимы как тестовая защита, не как новые runtime deadlines. Для API внутри одного процесса — отдельная проверка. Сценарии объединять по смыслу; не требовать отдельный production mechanism на каждый test.

### A126 — Выбор Store / пользовательская конфигурация (U/I)
- Default implicit/explicit, XDG set/unset, другой config.json, одинаковое содержимое разных путей, одинаковые basename разных dirs, relative/absolute/dot/dotdot, stable symlink retarget и distinct logical aliases.
- Изменение моделей, reasoning, профилей, limits и форматирования сохраняет automatic Store; rename/move может менять его. Long/Unicode/space names; безопасный bounded component.
- Precedence всех трёх источников, relative storage.directory vs launch cwd override, --cwd independent, empty/missing argument errors, no storage object + --state-dir, API unchanged missing/explicit path contract.
- CLI всех команд и ACP/diagnose выбирают одинаковый Store при одинаковых входах; invalid config execution rejected. Explicit old Store доступен; default behaviour прежний; никакой миграции/fallback.

### A127 — Concurrent runtime / собственные ресурсы (I/SDK)
- Два CLI, CLI+ACP, два ACP с разными конфигами: реально одновременно активные операции. Два одинаковых JSON в разных файлах; один конфиг + два overrides; shared workspace, нет новых блокировок/гейтов; unchanged model-facing/role/tool contracts.
- Один Store: compatible CLI attach; different config explicit common Store execution conflict; два физически одинаковых каталога через path aliases — single writer. Same ACP Store не получает второй транспорт.
- Snapshots/artifacts/diagnostic files/session files/descriptors/request bindings, включая одинаковый requestId в разных Stores, независимы. Permission/native input/cancel не затрагивают соседний Store, activity/reconnect bound to original owner. Retention/cleanup A не затрагивает B, в том числе default + automatically nested configurations. Close/crash A while B active; API A/B same process; existing recovery A после crash; no global budget.
- Partial startup/extension failure только собственный cleanup. Внешние limitations не компенсировать; fixture PASS не является native PASS.

### A128 — Live administrative control и execution compatibility (I)
- После изменения/форматирования JSON live inspect/cancel/trace/export с тем же resolved Store работают; другая валидная конфигурация с explicit shared Store тоже; удалённый/невалидный config + --state-dir работает даже без default config.
- Проверить owner-side redaction при несовпадении client config, cancel provenance/unknown effects, no cancel соседней Operation. Неверный token/version/operation/request binding rejected; requests with same ID but different action/op rejected. Internal subscribe/pending/answer/reconnect и permission ownership остаются прежними; отсутствие ref не даёт run/resume authority.
- run/resume при изменении config — адресный mismatch. Одинаковый JSON и разные configurationDirectory/relative plugins в общем Store не выполняются под чужим context; same compatible context attach сохранён. Launch preferences и ACP restrictions сохранены. Historical resume после освобождения Store сохраняет существующую authority/recovery, не gate по старому fingerprint.

### A129 — Offline management и redaction (I)
- Inspect/trace/export с явным Store при удалённом, повреждённом, невалидном или изменённом config, при отсутствии default config; валидный config с explicit storage.directory также адресует историю. Fixture factory marker доказывает ноль extension/provider initialization, нет runtime/recovery/maintenance, нет изменения snapshots/artifacts/diagnostics/descriptor, отсутствующий Store не создаётся.
- Read path сохраняет decoder, exact identity, errors для отсутствующего/corrupt/unsupported snapshot, корректность atomic publication и machine output. Ошибка указывает выбранный Store (без секретов). Не fallback к другому Store.
- Offline cancel no_live_execution только при установленном отсутствии RO owner, без mutation/recovery/maintenance; busy/unreachable owner не превращается в no_live_execution. Не инициировать external cancellation без владельца.
- Base redaction, known values when available, unavailable/partial enrichment metadata, residual historical limitation, non-overwrite/atomic output, JSON format и exit/stderr; при malformed config + explicit Store отсутствие enrichment не блокирует export. Live redaction unchanged. No raw bodies or persisted secret registry.

### A130 — Ownership races, ACP restart, diagnostics (I/SDK/PTY)
- Одновременный first open, lock before descriptor, stale descriptor, owner shutdown/crash, alias path, failed startup, inaccessible endpoint, lost response/reconnect: no second writer, no foreign cleanup, no replay. Без глобального discovery и новых timeouts.
- ACP initialize/new/prompt/load/cancel/permissions/input/shutdown; штатный close, re-open с изменённым config, прежняя session и новый профиль/настройки для новой работы; другой Store — session not found согласно existing contract; busy old owner — отказ.
- Diagnose static: resolved config/store/source, not-created state, no mkdir/provider/lock/maintenance; descriptor metadata optional и явно registered/unverified, no tokens. Existing machine codes, stdout/stderr, CLI progress/Operation ID/live notices/Ctrl+C/reconnect, ACP stdout protocol-only. Никакой Zed-specific реализации.

### A131 — Полная инженерная и отдельная native-приёмка (I/N)
- Mandatory full suite, checkJs/noEmit, architecture/specification checks, existing historical comparators/resource probes, Linux PTY, Nix build/install/package/release checks, CI exact implementation HEAD. Никакой замены существующих тестов новыми fixtures ради PASS.
- Native при доступности: два CLI с нативными providers, CLI+ACP, два независимых ACP clients, штатный restart/reload после изменения config и восстановление session, явный resume сохранённой Operation, crash A при живом B. Фиксировать версии, config paths без секретов, фактические результаты и blockers; внешние ограничения отдельно от RO bugs. Недоступное — UNVERIFIED, не fixture-based PASS.
- Отдельная большая сравнительная кампания качества reasoning не обязательна: scope не меняет model-facing behavior. Подтвердить отсутствие таких изменений review/diff и действующими regression tests.

## 9. C23.7 — Документация, границы реализации и сдача

Основная ожидаемая область: src/main/cli-config.js, cli.js, acp.js, src/hosts/cli.js, local-control.js, commands.js; при необходимости src/main/runtime.js для reuse known secrets, src/adapters/state/local-store.js для минимального validated storage read/ownership path, existing redaction helper. Проверить src/main/index.js, extensions.js, ACP/MCP adapters только в пределах RO-owned resources. Изменения src/core/ и semantic application layer не ожидаются; существенное отклонение от границ обосновать и согласовать отдельно.

Тесты расширять в существующих configuration/local-store/runtime/host-cli/host-acp/local-control/diagnostic-export/resume suites и текущих fixtures; специализированный multi-process test допустим, если existing tests не подходят. Не вводить отдельную постоянную матрицу.

После реализации обновить применимые нормативные документы: PROVIDERS_AND_CONFIGURATION (resolution/override/API/XDG/symlinks/restart/old Store access), CONTEXT_AND_RECOVERY (ownership/explicit selection/administrative access), ARCHITECTURE (local control execution compatibility vs management и minimal offline read), DIAGNOSTICS (source/path/errors/known-secret coverage), DECISIONS D05 и связанные решения без дублирования, CLI/ACP help, README/примеры если затронуты, CHANGELOG. Обновить STATUS/IMPLEMENTATION_PLAN и A126–A131 evidence. Planning docs не выдавать за уже реализованный продукт.

Примеры целевого использования:
```sh
role-orchestrator run --config cloud.json "Task A"
role-orchestrator run --config local.json "Task B"
role-orchestrator acp --config local.json --state-dir /path/to/local-state
role-orchestrator inspect "$ID" --config local.json
role-orchestrator cancel "$ID" --state-dir /path/to/local-state
role-orchestrator trace "$ID" --state-dir /path/to/local-state
role-orchestrator export-diagnostics "$ID" --state-dir /path/to/local-state --output ./trace.json
role-orchestrator diagnose --config local.json --format json
# Прежняя история дополнительных конфигов, без миграции:
role-orchestrator inspect "$OLD_ID" --state-dir "${XDG_STATE_HOME:-$HOME/.local/state}/role-orchestrator"
```
В примерах последние команды не требуют исходного конфига при explicit Store, кроме diagnose. Relative --state-dir resolves from launch cwd.

Итоговый отчёт: baseline/planning/implementation SHA, commits и фактический diff; RED/GREEN и full CI ссылки с точным SHA/exit, test paths; actual ownership/read path, compatibility contract, precedence, redaction coverage/limitations, old history access и ACP restart; результаты ресурсного исследования, native status и blockers; подтверждение неизменности model-facing/authority/recovery/permissions/unknown effects contracts; документация и отклонения. Разделять implementation complete, regression verified, native verified. Не заявлять PASS без проверок, исторический PASS не подтверждает новый HEAD. Не сливать в master автоматически; передать на review.

**Критерий соразмерности:** C23 должен убрать необоснованные зависимости, а не создать новую систему управления экземплярами. Если решение требует второго scheduler/registry/StateStore/Coordinator, обязательной конфигурации для управления существующей Operation, новой универсальной reliability/security инфраструктуры, hot reload, миграции или изменений семантики моделей — остановиться на конкретном finding и пересмотреть минимальность решения.
