# C24 — Unified User Configuration & Native Input Capabilities

**Статус: implementation delivered, engineering CI PASS at dc00645e; native integration UNVERIFIED; independent review pending.**

- Repository: apathoid/role-orchestrator.
- Рабочая ветка: feature/unified-user-configuration.
- Implementation baseline: a8888fdaaf6990d16c259ae511f16edf607395ec (master, D27 provider-first). C23 merged в master коммитом 02e6871cbaf9a712d835b6c0e79decec9ed634b3 (PR #6).
- Planning HEAD: коммит данной версии плана в рабочей ветке; точный SHA получить из Git, сверить с заданием и ancestry перед изменениями. Не менять baseline задним числом.
- Единственная матрица приёмки: [A132–A142](../../tests/ACCEPTANCE_MATRIX.md). Сценарии ниже детализируют её, не создают вторую матрицу.
- Baseline CI: [run 46151224720](https://github.com/apathoid/role-orchestrator/actions/runs/46151224720), на момент подготовки наблюдался in_progress; проверить итог и CI точного planning HEAD. Исторический C23 PASS не подтверждает C24. Native C23 остаётся UNVERIFIED.

## 1. Цель и критерий успеха

Пользователь должен иметь возможность работать через RO максимально близко к непосредственному использованию выбранного нативного агента: писать обычные промпты, выбирать Controller profile и нативные настройки, вставлять скриншоты, прикреплять файлы и ссылки на ресурсы, пользоваться контекстными действиями клиента и shortcuts скиллов. RO должен быть максимально незаметен там, где оркестрирование не требуется, и максимально полезен там, где оно действительно необходимо.

C24 устраняет собственные препятствия RO, а не создаёт собственный аналог возможностей клиента или провайдера. Приоритет — реальная сквозная доставка пользовательских данных и настроек, а не количество реализованных Host abstractions. Сохранить весь действующий execution lifecycle и возможность простого прямого ответа одной моделью. Не обещать поддержку всех функций всех клиентов/провайдеров.

Согласованный scope:
- Controller profile selector; пользовательский Controller default reasoning; Controller-only native collaboration mode; общий logical approval preset для совместимых invocations.
- Переиспользуемые trusted feature templates, явные profile references и provider-scoped native bindings.
- Общая реализация settings для ACP, CLI, Public API, пригодная для будущего TUI без его реализации.
- Global/project Agent Skills shortcuts из реального окружения.
- Сквозной ordered user content: text, image, audio при нативной поддержке, embedded resource, resource link; initial, follow-up, history, recovery и model-selected handoff.
- Стандартные ACP config options, commands и capabilities; CLI и Public API; существующий допустимый local control path.

## 2. Обязательные архитектурные границы

Перед началом изучить [AGENTS](../../AGENTS.md), [.agents/REASONING](../../.agents/REASONING.md), применимые engineering instructions, [STATUS](STATUS.md), [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md), [PRODUCT](../PRODUCT.md), [ARCHITECTURE](../ARCHITECTURE.md), [DECISIONS D27](../DECISIONS.md), [CONTRACTS](../CONTRACTS.md), [EXECUTION](../EXECUTION.md), [REASONING_EFFORT](../REASONING_EFFORT.md), [PROVIDERS_AND_CONFIGURATION](../PROVIDERS_AND_CONFIGURATION.md), [CONTEXT_AND_RECOVERY](../CONTEXT_AND_RECOVERY.md), [EXTENSIONS](../EXTENSIONS.md), [CAPABILITIES](../CAPABILITIES.md), [DIAGNOSTICS](../DIAGNOSTICS.md), C23 и матрицу. Проверить фактический HEAD, рабочее дерево, CI, SDK и доступные native versions; сохранять пользовательские и сторонние изменения. JavaScript ESM, Node 24, JSDoc/checkJs, существующие Nix и package contracts.

- Model-first: Host не интерпретирует задачу, не выбирает стратегию, роли, инструменты, skills, Workers или релевантность данных. Model-owned Decision/Intent/Action, самостоятельные Controller turns, reasoning selection и admission semantics сохраняются.
- Provider-first: сначала проверить существующий native/client/protocol contract; использовать минимальный мост. Не воспроизводить native permissions, Plan mode, tools, resource management или клиентские UI actions. Не сводить возможности к общему минимуму.
- Provider-agnostic: техническая специфика локализована за портами. Core не знает ACP wire types, Zed, Codex, Claude или executable names. Сторонние ProviderPort plugins без новых features продолжают работать; existing reasoning support сохраняется.
- Реальный workspace: никаких virtual FS, sandbox, source CAS, VCS gates, freshness, обязательных inventories, reconciliation или snapshot внешних файлов.
- Host отвечает за технические contracts: trusted authority, request identity, correlation, durable accepted input, lifecycle, resources, cancellation, recovery, unknown effects и truthful provenance. Provider-first их не ослабляет.
- Не создавать второй scheduler, feature engine, state machine настройки, persistent Controller session, новый retrieval engine, универсальный resource loader, capability registry/cache, discovery session, watchdog или execution/tool/startup timeout. Не выполнять скрытые retries/fallbacks или дополнительный model prompt ради настройки.
- Общий Application layer — логическое владение, не требование новых сервисов/файлов. Использовать существующие resolver/catalog/API/ports. Host-specific state/presentation и adapter-specific protocol remain at boundaries.
- При отсутствии новых возможностей обычный text-only путь не должен получать новых обязательных RPC, prompt sections, discovery/retrieval или стадий. Не оптимизировать ценой потери нативных возможностей.

Любой собственный механизм обосновать конкретной обязанностью RO. Ограничение — конкретным техническим инвариантом или фактическим нативным контрактом. Не превращать проверки разработчика в runtime workflow.

## 3. C24.0 — Baseline и ограниченное native contract исследование

Проверить реальные участки: application/configuration/config-v1.schema.json, decode-config.js, resolve-config.js, catalog.js, orchestrator.js, controller-context.js, context-access.js, handoff.js, controller-preflight.js, worker-request-identity.js; core/contracts.js, ports.js, operation.js, snapshot/recovery; adapters/acp/input.js и provider.js, invocation-prompt.js, CLI adapter; main/extensions.js, runtime.js, skill-registry.js, acp.js; hosts/acp.js, acp-history.js, cli.js, commands.js, local-control.js, cli-owner.js и state/artifact adapters. Пути относятся к src; уточнить реальные модули, не создавать файлы по названию из плана.

На baseline обнаружены конкретные ограничения: внешний ACP host объявляет image/audio/embeddedContext false и принимает только text; Request.attachments существует, follow-up text-only; Controller invocation, handoff, Controller context/preflight используют преимущественно первоначальные attachments; ACP adapter имеет attachmentBlocks/resolveAttachment, но штатное wiring и ordered mixed input требуют проверки. User-turn chronology C16 и context/evidence distinction не изменять.

Исследовать установленный ACP SDK (на baseline 2.4.0, codex-acp 2.5.0 в package.json), актуальные protocol contracts и доступные агенты: ContentBlock variants и metadata, promptCapabilities, configOptions, session/set_config_option, config_option_update, session/set_mode, available_commands_update; exact selector IDs, option value types, ordering и acknowledgment; возможность передачи mode/reasoning/approval в существующих CLI adapters; возможность нативной доставки контента и ссылки на него в повторном вызове, history/session/load и provider prompt. Проверить реальное поведение контекстных действий клиента (например @, clipboard, selection) на уровне полученных blocks, а не реализовывать UI.

Не считать идентификаторы из иллюстраций ниже проверенными. Фиксировать версию, источник, наблюдение и предел применимости. Использовать детерминированные fixtures и при наличии native smoke probes; не запускать discovery в production runtime и не расследовать внутренности внешних систем. Native недоступность обозначать UNVERIFIED. До production changes определить минимальный ordered input representation и путь фактической доставки historical/user-selected content; выбрать наименьшее решение, не проектируя общий мультимодальный retrieval. Если существующий контракт нативно не позволяет выполнить часть scope, зафиксировать точный blocker и не обходить его эмуляцией или скрытой потерей данных.

RED-first по реальным публичным ограничениям: mixed prompt отклоняется; follow-up attachment теряется; нет profile selector до prompt; изменение профиля не обновляет features; нет flags и native modes; нет shortcuts. Сначала определить исполняемый контракт новых данных, затем соответствующий RED. Не создавать искусственные failures ради количества тестов.

## 4. C24.1 — Trusted feature templates и provider bindings

Добавить необязательную верхнеуровневую секцию features с тремя известными kinds reasoningEffort, collaborationMode, approvalMode. Каждый kind — map именованных templates с default и непустым options. Профиль явно ссылается на template данного kind; отсутствие ссылки означает отсутствие управления этой настройкой RO, не отсутствие native capability.

Иллюстрация структуры (native IDs/value не проверены; заменить рабочими примерами после C24.0):

~~~json
{
  "features": {
    "reasoningEffort": {
      "extended": {
        "default": "medium",
        "options": [
          {"id":"native"},
          {"id":"medium","nativeValue":"medium"},
          {"id":"high","nativeValue":"high"},
          {"id":"xhigh","nativeValue":"xhigh"}
        ]
      }
    },
    "collaborationMode": {
      "standard": {
        "default":"default",
        "options":[{"id":"default","nativeValue":"default"},{"id":"plan","nativeValue":"plan"}]
      }
    },
    "approvalMode": {
      "a": {
        "default":"review",
        "options":[{"id":"native"},{"id":"review","nativeValue":"agent"},{"id":"full-access","nativeValue":"agent-full-access"}]
      },
      "b": {
        "default":"review",
        "options":[{"id":"native"},{"id":"review","nativeValue":"confirm"}]
      }
    }
  },
  "providers": {
    "cloud": {
      "adapter":"acp",
      "launch":{"command":"codex-acp"},
      "featureBindings":{
        "collaborationMode":{"kind":"configOption","id":"collaboration_mode"},
        "approvalMode":{"kind":"configOption","id":"mode"}
      }
    },
    "other": {
      "adapter":"acp",
      "launch":{"command":"another-agent"},
      "featureBindings":{"approvalMode":{"kind":"sessionMode"}}
    }
  },
  "profiles":{
    "large":{"provider":"cloud","model":"model-a","features":{"reasoningEffort":"extended","collaborationMode":"standard","approvalMode":"a"}},
    "small":{"provider":"other","model":"model-b","features":{"approvalMode":"b"}}
  },
  "controllerProfile":"large"
}
~~~

Это фрагмент схемы, не полный валидный config. Определения options: уникальные непустые logical id, opaque nativeValue допустимого технического типа, optional name/description (fallback name=id); default должен ссылаться на option. Reasoning сохраняет существующие допустимые logical levels; approval/collaboration IDs определяет пользователь, без интерпретации Host. Одинаковые nativeValue допустимы как явные aliases. Не вводить inheritance, models section, cascading templates, arbitrary conditions, глобальное auto-enable.

Зарезервированный logical id native (только если явно объявлен) означает отсутствие override, nativeValue отсутствует. Не отправлять буквальный native; не считать его уровнем мощности. Базовая native configuration сохраняется. Любой другой option обязан иметь nativeValue. Не добавлять native автоматически.

Provider featureBindings отвечает за способ передачи, template — за значение, profile — за подключение. ACP: configOption с точным configId; sessionMode — legacy modeId. Adapter-specific binding может отличаться; валидирует/применяет адаптер, не Core. Разрешение: явный trusted binding (использовать исключительно его) > подтверждённый технический контракт адаптера (например существующий однозначный thought_level) > адресная недоступность. Запрещено угадывание по name/description/substring/value, executable/provider name или произвольной ACP category. Не искать альтернативный selector при отсутствии явно заданного. CLI: использовать только проверенный нативный контракт адаптера, отдельные argv, без shell interpolation и универсальных argv templates.

Валидация: exact JSON path для неизвестных kinds/templates, duplicate id, пустых options, missing/invalid default/nativeValue, misuse native, invalid level, invalid binding, конфликтующих активных bindings к одному параметру. Различать invalid config, adapter unsupported, configured, native unavailable, native rejected. Структурная ошибка — ошибка trusted config; неподдерживаемая дополнительная feature сама по себе не лишает профиль доступа, если invocation не требует её применения. Явно требуемая настройка без способа передачи — адресная ошибка, не fallback. Не маскировать default как неявно применённый при его недоступности. Существующие strict reasoning contracts не ослаблять. Не создавать глобальный capability gate; разрешённые независимые profiles/operations продолжают работать. Project preferences, модель и skill не могут добавлять mappings, bindings, profiles, полномочия или расширять limits.

Перенести существующие profile.reasoningEffort / defaultReasoningLevel в template references; greenfield: удалить старую декларацию, обновить fixtures/docs, не вводить миграцию или постоянную поддержку двух форм. Проверить действующее правило schema version и зафиксировать необходимое решение; не вводить новую versioning subsystem. Исторические route не переписывать. Config без features и сторонние adapters работают как раньше.

## 5. C24.2 — Общие пользовательские settings

Расширить существующий Application API/resolver/catalog; не заводить второй configuration owner. Независимые от UI descriptors: Controller profile current/available (только разрешённые и доступные profiles), для подключённых и технически поддержанных features — current/available logical id, optional label/description, источник/статус при необходимости. Не выдавать configured support за native verified. Не публиковать launch/env/credentials/bindings/native values. Не запускать provider для чтения, изменения settings или открытия UI.

Приоритет: built-in/trusted defaults < существующие разрешённые project preferences < trusted launch preferences < явные разрешённые user selections. Не изменять authority/limits. При смене profile: пересчитать descriptors и defaults; если ранее был явный logical override и новый template содержит его, сохранить его и заново разрешить nativeValue; иначе использовать новый default; отсутствующая feature не имеет descriptor/override. Не переносить nativeValue напрямую, не хранить per-profile UI history. Одинаковый logical ID в разных templates — декларация пользователя о переносимости выбора, не доказанная эквивалентность native behavior. Invalid update не меняет предыдущие settings. В UI показать фактический новый current, не скрывать переход на другой default.

Владение:
- Пользователь выбирает Controller profile/default reasoning, collaboration, approval.
- Модель сохраняет выбор Worker profile/role/reasoning и nextController.reasoningLevel. Не добавлять collaboration/approval в Decision/Action. Controller user default не меняет Worker default того же профиля.
- Effective Controller default и текущий reasoning видны Controller через имеющиеся invocation-specific facts; global Profile/Catalog immutable относительно конкретного выбора. Допустимые levels остаются общими, Worker default определяется собственным template.
- Явно объявленный native допустим и для модельного reasoning selection (Action/nextController). Отсутствие reasoningLevel использует эффективный default; native не override. Одноразовый pending выбор потребляется ровно существующим next invocation path; correction/recovery/redelivery и explicit user continuation сохраняют C16/C18 reasoning semantics. Не сбрасывать pending selection при техническом recovery; новый принятый пользовательский turn использует существующее правило сброса. Provenance различает model/user/config default и native selection там, где известно.

Descriptors и settings не требуют общей UI session: ACP — scoped user session, CLI — конкретный run/resume, API — request. Future TUI использует этот же API, без реализации TUI в C24.

## 6. C24.3 — Materialization, identity, persistence и recovery

Submit и explicit continuation materialize effective settings один раз в рамках принятия запроса/generation. Изменение UI controls не создаёт prompt/invocation/Operation и не меняет уже принятую generation или active invocations. Сохранять session selections отдельно от effective accepted settings в существующих state paths C23. Не изменять JSON config, не вводить live steering/permanent native session/new scheduler.

Scope продолжения (явно выбранное проектное решение для предсказуемости): ACP использует текущие session selections при новом принятом turn. CLI/API explicit continuation сохраняет прежние **явные user overrides** для неизменённых settings, если пользователь не передал новые; defaults без явного override разрешаются действующим resolver; при смене профиля действует правило §5 (перенос только допустимого logical ID), новые явные flags проверяются относительно целевого профиля. Не менять существующие authority/launch compatibility semantics. Если предыдущего выбора нет, использовать действующие defaults. Plain technical resume/recovery без нового пользовательского ввода использует сохранённую generation, не текущие UI settings; flags, требующие нового выбора, не должны синтезировать prompt или незаметно превращать recovery в user continuation. При несовместимости с текущим trusted config применить действующий ResumeAuthority и адресный отказ, не fallback.

ACP session/load восстанавливает UI selection и актуальные descriptors относительно текущего trusted config; недоступный прежний выбор для **будущего** запроса явно отмечается, можно показать текущий допустимый default, не меняя принятые операции/route. Concurrent update/load/close/submit — существующая сериализация state или минимальная атомарная граница.

Различать входную идентичность и effective execution identity в текущем dedup path (не обязательно два новых hash):
- Request ID + фактически переданные данные, content order/identity, явные per-request overrides и continuation/supersession идентифицируют запрос.
- При новом запросе зафиксировать effective route/settings с accepted request. При redelivery сначала найти сохранённую привязку; изменение session default между доставками не конфликт и не повод пересчитать settings. Повтор ID с другим фактически переданным контентом/явным override — identity conflict.
- Materialization и durable request acceptance согласованы относительно concurrent settings changes; crash-gap не меняет уже принятую привязку. Повтор не создаёт новый dispatch. Не менять существующую idempotency систему.
- Native retry equivalence учитывает фактический model, native values/bindings, content и существующий requestHash. Один logical ID/URI/ref не доказывает эквивалентность. Сохранить запрет provider_idempotency при изменяемых внешних attachments без доказанной byte identity; C24 не расширяет автоматические replay guarantees даже для embedded payload. Не хешировать исходники workspace ради обычного выполнения. Не изменять неизвестные эффекты, authority, cancellation или recovery policy.

Provenance: profile/provider/model/configurationRef, logical selection, effective native value/binding (где применимо), source, факты submission/acknowledgment/неприменимости. Использовать существующие route/observations, не дублировать историю или хранить secrets. Не восстанавливать старые native values из нового mapping. Отсутствие старой информации — not_recorded/unknown, не текущий default. Ошибка до prompt — not_sent только при фактическом основании; после возможной отправки действующий unknown-effect contract. Не вводить миграцию истории; изменение durable schema не должно уничтожать или переписывать существующие accepted records; следовать действующим decoder/version contracts.

## 7. C24.4 — Применение native features

### 7.1 Различная семантика

Reasoning: effective Controller user/config default, одноразовый model selection, Worker собственный default/model selection. Не распространять Controller default на Workers.

Collaboration: передавать только Controller. RO не реализует Plan workflow, read-only/write restriction, запрет Coder, обязательное планирование/согласование, изменение Action schema, auto-propagation на Worker или семантическую интерпретацию preset. Нативные ограничения провайдера не обходить. Fixture проверяет, что RO не блокирует разрешённое делегирование в Plan; native smoke проверяет конкретную совместимость ControllerIntent/Decision text или MCP с режимом, не требует от любого агента способности делегировать. Не синтезировать Decision из плана.

Approval: effective Controller logical default или user selection распространяется в пределах принятой generation на совместимые Controller/Worker invocations. Для каждого реального профиля разрешить тот же logical ID через его template/binding. Если Worker не объявляет approval или mapping данного ID отсутствует, оставить native configuration, без подстановки Worker default и без запрета выбора Worker. Если mapping есть и требуемая передача явно не поддержана/отклонена — адресная invocation error. Native selection не переопределяет базовую конфигурацию. Controller без approval declaration не создаёт общего override. Default Worker template сам по себе не дополнительная operation policy. Это запрос нативной настройки, не универсальная гарантия безопасности, не эквивалентность policies. Сохранить permission broker/authority. Не делать отдельный analyzer совместимости или модельные советы о выборе Workers. Факты applicability/отказа доступны через существующие catalog/context/outcome/provenance в необходимом объёме; не раздувать prompt всеми bindings/metadata.

### 7.2 ACP и CLI adapters

Расширить обычный native lifecycle (launch, initialize, session/new, configure, prompt, cleanup) без дополнительных процессов или prompts. Установить model и применимые settings в конечном порядке, подтверждённом C24.0. Использовать точные ID/expected technical type/value, свежие session options и стандартные responses/updates. Проверять фактически доступное readback, не отправлять RPC повторно при достоверном совпадении. Если настройка влияет на доступность другой, учитывать подтверждённый контракт. Никакого runtime поиска порядка RPC, циклов reconciliation, повторных запусков, специальных веток по названию провайдера или попыток исправления его внутреннего дефекта. Нативная несовместимость — адресная причина.

Сохранить nativeSettings.mode и другие базовые native settings при отсутствии feature override. Явное feature value имеет приоритет над базовой настройкой того же параметра; native сохраняет базовую. Конфликт двух активных features на одном selector — технический отказ до prompt, не случайный порядок.

Отсутствие достоверного способа передачи или явный reject/reset отличается от отсутствия отдельного acknowledgment/readback: если контракт предусматривает передачу без readback, продолжать, отмечая submission и unknown acknowledgment. Не вводить universal confirmed gate. CLI передаёт только подтверждённые параметры, no shell interpolation. Не требовать всем provider plugins поддержать новые features; существующие optional ProviderPort capability contracts расширять минимально.

Controller failure — существующий waiting/result path; Worker failure — коррелированный outcome/diagnostic для Controller. Независимые разрешённые invocations не отменять. No fallback на другую модель/mode, auto correction session или replay.

## 8. C24.5 — Agent Skills shortcuts, не skill runtime

Общий пользовательский discovery в ~/.agents/skills/ и <workspace>/.agents/skills/ из фактического cwd/session, без Git root/parent traversal. Стандартный SKILL.md YAML frontmatter name/description; metadata и ссылка на реальный файл. Использовать корректный YAML parser (не regex parser); dependency только если нужна, обновить lock/Nix hashes по существующим правилам. Не читать тела всех skills в prompt, не регистрировать их как trusted plugins. Project приоритет над global при одинаковом name; global доступен явным путём; неоднозначность внутри источника не решать случайным порядком. Сохранять выбранный путь/источник, не дублировать command names.

Переиспользовать metadata utilities существующего skill-registry там, где контракты совпадают. Discovered file НЕ Host-managed Catalog skill; Action.skills остаётся для registered IDs/versions/loader. Discovery не inventory возможностей модели, отсутствие/malformed metadata не делает файл недоступным её native tools. Не ограничивать другие dirs/skills/scripts/subagents. Не копировать дерево, не хешировать source, не выполнять scripts, не проверять неизменность или полномочия по metadata.

ACP: available_commands_update с валидными shortcut names, после session/new/load и при поддерживаемом явном refresh; не запрашивать native agent ради списка, не делать polling/watcher. Не перехватывать unknown slash text. Разрешать только явно выбранный shortcut (например /changed в установленном синтаксисе или explicit structured selection); сохранить original user input и отдельную ссылку на текущий SKILL.md с user provenance. Не классифицировать свободный текст, не преобразовывать инструкции в workflow, не повышать trust найденного файла, не автоматически добавлять его в системные инструкции. Metadata untrusted; безопасный parser, bounded read, malformed/permission errors локальны; обычный prompt и создание сессии не блокируются. Скилл может измениться после discovery — работа модели с реальным файлом не блокируется.

CLI: сохранить смысл существующего --skill для registered preference; если нельзя однозначно совместить, один минимальный явный способ выбора discovered file (например --agent-skill или explicit path/shortcut), без silent reinterpretation. Общий discovery доступен через API/CLI listing. Native slash-command relay не реализуется в C24, но не запрещён архитектурно; никакого перехвата нативной работы.

## 9. C24.6 — Ordered user content и минимальный мост

### 9.1 Реальный пользовательский сценарий

Приём text + image + text + resource/resource_link, audio где поддержано, attachment-only initial/follow-up, сохранение порядка и MIME/URI/значимых metadata. Пользовательский контент клиента (selected code, file reference, clipboard, context action) передавать по стандартному ContentBlock contract, не создавать аналоги @, DnD, clipboard или client editor logic. Нативный провайдер определяет способ обработки файла; не объявлять поддержку PDF/video/DOCX анализом лишь потому, что reference доставлен.

Нейтральное упорядоченное представление (text segments + typed refs/payload metadata) за Core ports, без ACP SDK/wire union в Core. Расширить Request, followup, accepted user-turn journal, Invocation, history, handoff и native rendering настолько, насколько требуется. Единственный источник исходного пользовательского контента; не поддерживать две конкурирующие копии text/attachments. Preserve original objective и literal C16 user turns; chronological latest не является новой host-assigned intent. Не собирать весь текст в один блок с изображениями после него. Технические инструкции RO сохраняются отдельно; пользовательские blocks остаются авторизованным user input, а не agent messages, evidence или trusted instructions. Attachment-only допустим без synthetic user prompt.

### 9.2 Payload и references

Различать embedded bytes, действительно полученные от клиента, и ссылки на изменяемое окружение. Embedded payload сохранить durable до подтверждения принятия, предпочтительно в существующем RO-owned artifact store с scoped ref/size/type и технической идентичностью; не дублировать base64 в snapshot/history/diagnostics. Reuse resolveAttachment/extension wiring, расширив только необходимый контракт. Сохранение embedded data не является workspace virtualization.

Resource reference сохраняет URI/path/metadata; не означает чтение файла, загрузку URL или гарантию неизменности. Передавать native reference без dereference, когда это поддержано. Не превращать resolver в общий HTTP/file/custom URI loader, не конвертировать документы/OCR/кадры, не автоматически делегировать. Явно предоставленный файл CLI может быть передан как reference или embedded bytes согласно явно документированному интерфейсу и реальному transport contract; не заявлять эквивалентность этих вариантов. Не обходить существующие authority и context sharing.

Durable lifecycle: submit/follow-up, failure/cancel during save/resolve, retry/redelivery, disconnect/load/restart/recovery, existing retention/cleanup. Не выдавать неполный запрос за принятый; не удалять payload, нужный ещё доступному accepted request. Не вводить отдельный cleanup service; переиспользовать существующие retention/storage contracts. Scoped refs не позволяют cross-session/cross-Store подмену/чтение. Сохранить разрешённый existing cross-operation sharing, если он применим, без расширения grants.

### 9.3 Controller, history и Workers

Controller получает полный новый пользовательский turn в исходном порядке, без обязательного retrieval и без перекладывания прямой доставки на модель. Расширить существующие C16 user-turn projection, attachment ref listing, history, Controller preflight/admission и Action.contextRefs так, чтобы новые вложения follow-up были доступны как первоначальные. Не считать attachment ref observation/finding/evidence; сохранить проверки C22.

Для последующих Controller calls использовать существующую политику user-turn context, не изобретать отдельный host semantic selector. C24.0 должен подтвердить конкретный минимальный способ фактической доставки прежних мультимодальных блоков: прямое представление в существующей проекции либо уже поддерживаемый model-selected reference/materialization path. Если требуется расширить текущий context/handoff contract для фактической доставки выбранного вложения, сделать это точечно. Не считать base64 в текстовом ContextPort равнозначным изображению. Не делать обязательный retrieval, специальный мультимодальный catalog, автоматическую summarization, повторное чтение всех файлов или безусловное дублирование payload. Не отбрасывать доступный контент по эвристике; при техническом ограничении явно сохранить ref, attribution и availability/причину, не выдавать неполный контекст за полный. В первом вызове с новым пользовательским вложением неподдерживаемая доставка — адресная ошибка; при последующих вызовах не скрывать недоступность ранее принятого ресурса. Не вводить скрытый fallback профиля.

Проверяемый сценарий: пользователь отправил изображение A, получил ответ, затем отправил B с просьбой сравнить; Controller получает B и имеет реальную доступность A согласно поддерживаемому native path (на fixture с поддержкой обоих); может самостоятельно выбрать refs A/B для Worker, включая из follow-up. Worker получает только выбранный моделью контент/контекст через существующий handoff, а не все user attachments автоматически. Нативная недоступность выбранного содержимого передаётся Controller адресным outcome; дальнейшее решение принадлежит модели. Доказательство доступности по refs не заменяет wire-level тест фактической доставки.

### 9.4 Capabilities, limits и diagnostics

Различать endpoint acceptance, adapter transport support, negotiated provider session/model support и способность модели интерпретировать данные. ACP initialize — стандартные connection-level promptCapabilities только для реально реализованного сквозного транспорта; не отключать весь endpoint из-за text-only profile и не добавлять dynamic Zed-specific protocol. Проверить C24.0 фактическую семантику стандарта; при несовместимости выразить честную границу. Не рекламировать неработающий transport. Проверять обязательную modality в обычном invocation по известному техническому контракту, не угадывать способности из имени модели или MIME. Unknown не универсальный запрет. Если новый контент не доставим, адресная ошибка, не удаление блоков и не auto-switch. При поддержке transport, но reject provider — достоверно сообщить.

Пересмотреть maxMessageBytes внешнего ACP (baseline 1 MiB), native ACP, local control, storage/materialization, history и diagnostics. Обычный скриншот больше прежнего лимита проходит end-to-end в пределах технически обоснованного и конфигурируемого resource limit; проверить base64 overhead и memory. Не связывать multimedia payload/transport с history context.maxBytes, не вводить новые execution timeouts. Размеры определить по реальным тестам и существующим resource contracts; не создавать лишних настроек без необходимости. Text-only не несёт overhead материализации пустых вложений.

Не дублировать большие payload в diagnostics/stdout/trace/prompt capture/export/history JSON; обычные diagnostics — refs, types, sizes, observed delivery facts, truthful omissions. Сохранить C23 offline redaction, не обещать обнаружение секретов внутри произвольного изображения. Нативный prompt и transcript передают сами пользовательские данные; diagnostic capture не должен превращаться в второе хранилище. При ошибке storage/limit — адресное сообщение и корректный cleanup, не молчаливое усечение.

## 10. C24.7 — ACP client-facing bridge

- Standard configOptions в session/new и session/load; session/set_config_option и config_option_update по поддерживаемому SDK. IDs controllerProfile (category model), reasoningEffort (thought_level), collaborationMode/approvalMode (подходящая standard category либо без неё). UI placement — клиент, не Zed-specific extension. Доступно до первого prompt без native launches. При смене profile вернуть полный актуальный набор; invalid update атомарно отклоняется. Persist scoped ACP selections.
- available_commands_update для известных Agent Skills; no native discovery launch. Unknown slash text не перехватывать. Сохранять selection provenance.
- session/prompt: принимать реальные supported blocks, initial/follow-up/attachment-only, правильный order, request identity. session/load воспроизводит accepted user turns, не выдаёт blocks за agent output/observations. Не терять input из-за compact presentation. Использовать стандартный ACP протокол; no arbitrary passthrough extensions или client-supplied MCP servers в scope C24.
- Сохранить permissions/native forms/terminal и FS relay, native activity/plan, tool calls, Controller Decision/MCP delivery, cancellation/supersession, session history и C23 state. Не синтезировать model thoughts или планы. Context actions должны работать через фактически полученные native content blocks.

## 11. C24.8 — CLI, Public API и local control

Переиспользовать существующий run --profile; не добавлять второй независимый selector. Новые logical flags --reasoning-effort, --collaboration-mode, --approval-mode для run и explicit continuation, --profile там же. Пример:
    
    role-orchestrator run --profile large --reasoning-effort high --collaboration-mode plan --approval-mode review "Подготовь план"
    role-orchestrator resume OPERATION_ID --collaboration-mode default "Приступай к реализации"

Не передавать native values напрямую из flags. Plain resume semantics unchanged (§6). Доступные settings: команда settings [--profile ID] [--format json] или эквивалентный существующий интерфейс; те же descriptors, без native launches, execution operation и ненужного writer lock. Skill listing/selection §8. CLI input: существующий механизм или минимальный repeatable --attachment PATH с документированной semantics reference vs embedded, не multipart UI. Complex mixed ordering доступно программному API.

Public API: read settings descriptors, logical selections, discovered skills metadata, ordered content, submit/explicit continuation; без ACP/TTY/session dependency. Не создавать отдельный orchestration API/lifecycle.

Local control: только уже разрешённые совместимые run/resume к владельцу (на baseline ACP owner отклоняет local run/resume — сохранить). Передавать settings/content refs или payload фактическому владельцу, не оставлять только локальными launch parameters и не мутировать owner launch preferences. C23 configurationRef/directory compatibility, tokens, authority, request/answer/reconnect binding, single writer, independent Store scopes unchanged. Не расширять local control до arbitrary submit в ACP runtime. Offline inspect/trace/cancel/export semantics не меняются; не требовать valid feature config для offline management.

## 12. C24.9 — Verification / acceptance

Инженерные checkpoints (не runtime stages): baseline+RED; feature/resolver/settings+native modes; durable identities/recovery; skills; ordered input bridge/history/handoff; client/CLI/API integration; full regression/native verification/docs. Порядок независимых работ выбирает исполнитель. Проверять промежуточные целостные изменения, не массовый рефакторинг.

Обязательные сценарии (объединение в parameterized tests допустимо; не требовать отдельного framework):

| Acceptance | Наблюдаемые проверки |
|---|---|
| A132 | Shared templates/references, different providers, native/default/alias, invalid paths/duplicates/kinds/bindings/conflict, explicit selector priority, no features, old config rejected, no project escalation; unsupported optional feature не делает unrelated invocation недоступным |
| A133 | Existing reasoning regressions, model-native option when declared, effective user default vs Worker/profile default, shared profile concurrent operations, pending/consumed/reset/recovery/correction, truthful provenance |
| A134 | Same descriptors ACP/CLI/API, profile change recompute/remove controls, logical transfer/default/reset, invalid update atomic, independent settings, zero native launches before prompt, API without TTY |
| A135 | ACP session persistence/load/config change, concurrent update vs acceptance, redelivery after UI change vs explicitly changed payload/override, generation immutability, partial explicit continuation, technical recovery, historical route, changed native mapping/external resource no idempotency replay, C23 scopes |
| A136 | Generic deterministic ACP exact config IDs/type/value, arbitrary IDs, legacy sessionMode, dynamic options after model/mode, reset/reject/not_sent, no readback case, base native settings/native sentinel, CLI safe argv, existing plugin without new feature support, no heuristics/fallback/reconciliation |
| A137 | Native collaboration only Controller, no Host Plan workflow/worker gate, approval mapping across different providers, absent feature/mapping leaves native Worker usable, reject mapped value locally, no independent Worker cancellation, permissions preserved |
| A138 | Global/project skills/precedence/explicit path, malformed/bounded metadata, unknown slash normal prompt, real file can change, no registry gate outside discovery, no privileges/native discovery, shared ACP/CLI/API path, preserve registered --skill |
| A139 | Real SDK mixed blocks order text-image-text-image, image-only, audio/resource/link, follow-up and actual A/B delivery, selected historical attachment Worker, no auto fan-out, unsupported Controller/Worker, mutable reference no auto dereference, retention/cancel/store/error/recovery, ordinary large screenshot end-to-end, limit, no base64 diagnostic duplication |
| A140 | Standard ACP options and commands before prompt, profile switch, actual wire capabilities/content, session/load replay user attribution, compact/detailed regression, existing forms/permissions/relay/activity/cancel/Decision transport; no client-specific fields |
| A141 | CLI flags/partial resume, common settings/skills listing no writer lock/native launch, attachments/API ordered input, compatible attach owner receives settings/content, conflicting request and concurrent runs, no owner mutation or ACP owner policy change, offline commands unchanged |
| A142 | Exact-SHA regression/CI/Nix/PTY/native comparison evidence, old text-only path no new RPC/launch/stage/prompt overhead, memory/bytes/cost observations, architecture D27 negative checks, actual native gaps honestly UNVERIFIED |

Use deterministic fixtures with actual ACP SDK/protocol/subprocess, not only mock internal calls; assert real rendered/wire payload order, acceptance, route/outcome/provenance. Preserve existing test suites, do not weaken assertions or adapt fixture semantics merely to pass. Update tests and fixtures for new reasoning schema while retaining original meaning. Existing A01–A131 remain mandatory.

Native smoke when available: standard ACP client (Zed or other); at least Codex ACP and independent ACP provider where possible, existing CLI provider adapter. Check only actual supported capabilities. Native versions/credentials/client unavailable -> UNVERIFIED, not automatic engineering failure unless RO's own required contract proven broken. Do not claim native integration verified from fixtures.

Compare same applicable user scenarios directly via native provider and via RO: plain prompt, profile/mode/reasoning, file link/context selection, clipboard image, mixed input and continuation, skill shortcut, cancellation and history. Aim is loss caused by RO, not identical reasoning output or timing. Measure provider launches, pre-prompt RPC, text-only prompt bytes/time, memory/base64 copies/history/diagnostic size for large input. No arbitrary new tool-call count limits. Record measured vs unverified performance; don't invent thresholds or provider guarantees.

Run mandatory checks on actual implementation HEAD: npm run check, npm test, npm run check:package; existing contract/integration/acceptance, applicable native, Linux PTY, historical comparators/resource probes, locked Nix build/install/package/NixOS evaluation/release checks per CI. Use Node24. If local environment lacks tools, use existing CI with exact SHA; record exits/runs. Historical PASS never proves new SHA. No false native PASS. Specification checker range already extended by planning commit; preserve all requirements.

## 13. Non-goals and review gates (development only)

No universal feature framework/negotiation, discovery sessions, persistent Controller sessions, Fast mode, TUI implementation, native slash command enumeration/passthrough, provider-specific skill inventory, client-specific wire fields, Worker UI controls, own Plan/approval/sandbox, virtual workspace/source CAS, OCR/conversion/resource fetcher, automatic model selection, arbitrary ACP passthrough, new scheduler/timeouts/watchdog/migration, external bug investigations.

Reject implementation that: changes model-owned decisions, restricts unrelated native capabilities, introduces global profile gate, loses content silently, confuses attachment with evidence, weakens authority/recovery or rewrites historical routes, adds provider-name branches in Core, creates hidden fallback/launches, replicates provider policy or creates duplicate state, broadens existing local control ownership, or makes text-only path require new work. Absence of an unneeded abstraction is not a defect. A concrete unsupported native feature is a truthful limitation, not a requirement to emulate it.

## 14. Documentation, handoff, Definition of Done

Update only actual changed normative contracts: PROVIDERS_AND_CONFIGURATION (features, bindings, verified examples, capabilities), REASONING_EFFORT (schema and selection semantics), CONTRACTS/EXECUTION/CONTEXT_AND_RECOVERY (input, scope, recovery), ARCHITECTURE/EXTENSIONS (boundary of shortcut discovery vs registered catalog), DIAGNOSTICS, PRODUCT/README/CAPABILITIES as applicable. Preserve D27 and existing invariants; record new significant decisions in DECISIONS, product changes in CHANGELOG, exact evidence and implementation status in STATUS, summary in IMPLEMENTATION_PLAN, acceptance evidence in existing matrix. Do not duplicate specification everywhere or mark unimplemented features as current. Provide checked examples of minimal config, shared reasoning template, cross-provider approval, explicit native binding, CLI flags, skills and mixed input. No automatic migration.

Done means user can actually select supported settings before prompt, change profile without restart, use real skills shortcuts and mixed content incl follow-up, with common ACP/CLI/API contracts, no model/provider suppression, correct scope/identity/recovery, unchanged C23 and all required regressions. Distinguish implementation complete, regression verified, native integration verified and independent architecture review. If a native contract prevents some behavior, disclose exact scope/blocker and evidence; do not mark that behavior complete by substituting a mock or alternative semantic mechanism.

Final report: implementation baseline, branch and exact HEAD; implemented contracts and minimal design choices, final schema/checked native IDs; RED/GREEN, CI/Nix/PTY/native evidence and performance comparison, limitations and UNVERIFIED items; decisions taken without explicit user instruction. Answer whether existing third-party adapter and future TUI can use interfaces without Core/provider-specific changes; whether model still chooses Worker/reasoning/strategy; whether new launches/gates/extra prompts exist; whether text-only/no features and C23 authority/cancel/recovery remain intact.

No merge to master before independent review and user agreement.

### C24-R2 corrective candidate

The existing plan and A132–A142 are unchanged in scope. Corrective contracts: exact historical native refs through existing contextRequest; explicit workMap page/current skill before optional previews; no duplicate literal initial objective; legacy text block boundaries without changing stored offsets; exact delivered block attribution and typed-field ownership; per-admitted-Worker approval compatibility and legacy recovery settings; current CLI result and structured content refusal; negotiated capabilities consistent with admission; durable CLI skill redelivery and honest unassociated ordered replay. Accepted embedded content retention is unchanged. See normative documents and STATUS for verification; deterministic SDK fixtures do not establish native acceptance.
