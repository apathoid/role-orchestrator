# Расширения Role Orchestrator

## Подключение

Плагин — доверенный ESM-модуль с правами процесса. Фабрика получает идентификатор своего endpoint, его конфигурацию и функцию регистрации cleanup. Host сохраняет владение журналом операций, разрешениями и бюджетом.

Укажите модуль в доверенном JSON-конфиге. Абсолютный путь используется напрямую. Относительный путь с `./` или `../` разрешается от переданного доверенного каталога `directory`. Имя npm-пакета разрешается Node.js относительно установки Role Orchestrator.

Следующий конфиг добавляет текстовый Worker и skill. Controller в примере остаётся на отдельном настроенном профиле.

```json
{
  "schemaVersion": 1,
  "providers": {
    "codex": {
      "adapter": "codex-cli",
      "launch": { "command": "codex" },
      "mcpBridge": true
    },
    "echo": { "adapter": "example-review" }
  },
  "profiles": {
    "controller": { "provider": "codex", "model": "your-codex-model" },
    "text-worker": { "provider": "echo", "model": "literal-text" }
  },
  "controllerProfile": "controller",
  "plugins": [{ "id": "example-review", "module": "./review-plugin.mjs" }],
  "skills": [{ "id": "review-guide", "source": "example-review" }]
}
```

В программном Host передайте результат `decodeConfiguration` в `loadExtensions`. `directory` задаёт доверенную директорию конфигурации, а `projectText` при наличии передаёт текст проектных предпочтений.

```js
import { randomUUID } from 'node:crypto';
import { decodeConfiguration, loadExtensions } from 'role-orchestrator';

export async function configureExtensions(trustedJson, directory, projectText) {
  const decoded = await decodeConfiguration(trustedJson);
  if (decoded.kind === 'rejected') throw new Error(JSON.stringify(decoded.reason));
  return loadExtensions(decoded.value, {
    directory,
    projectText,
    clock: { now: Date.now, monotonicNow: () => performance.now() },
    ids: { newId: randomUUID },
  });
}
```

`extensions.selection` содержит разрешённую эффективную конфигурацию или ошибку предпочтений. `await extensions.selectController()` возвращает выбранный `profile` и `provider` либо причину недоступности. Host может отдельно выбрать допустимый профиль через `selectController(profileId)`. Передайте `profile`, `provider`, `extensions.catalog`, `extensions.providerFor` и при наличии `extensions.tools` в `createOrchestrator` вместе с остальными портами Host. Разрешённые профили определяет доверенный grant. После остановки использующих реестр операций вызовите `await extensions.close()`.

Чтобы отключить плагин, укажите `enabled: false` или удалите его запись из доверенного конфига и соберите новый реестр. Уже записанные findings, observations и outcomes остаются доступны в прежнем хранилище. Новые вызовы недоступного профиля получают адресный отказ.

## Минимальная фабрика

Создайте `review-plugin.mjs` рядом с доверенным конфигом. Manifest объявляет `id`, версию поставки `version`, major API `apiVersion: 1` и имена используемых exports. `providers.<id>.adapter` выбирает плагин по manifest id. `providerId` в `describe()` совпадает с переданным идентификатором endpoint.

```js
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const manifest = {
  id: 'example-review',
  version: '1.0.0',
  apiVersion: 1,
  exports: ['createProvider', 'loadSkill'],
};

export function createProvider({ providerId }) {
  return {
    async describe() {
      return {
        providerId,
        maxConcurrency: null,
        capabilities: {
          'input.text': { support: 'supported', source: 'configured' },
          'output.decision': { support: 'unsupported', source: 'configured' },
        },
      };
    },
    async open(profile, signal) {
      signal.throwIfAborted();
      if (profile.providerId !== providerId) throw new Error('Unexpected provider');
      return { sessionId: randomUUID() };
    },
    async invoke(_session, { attemptId, objective, signal }) {
      const cancelled = signal.aborted;
      return {
        dispatchCertainty: cancelled ? 'not_sent' : 'sent',
        outcome: {
          schemaVersion: 1,
          attemptId,
          terminal: cancelled ? 'cancelled' : 'completed',
          effect: 'none',
          diagnostics: cancelled ? [{ code: 'CANCELLED' }] : [],
          outputRefs: [],
          usage: { inputTokens: null, outputTokens: null, cost: null },
        },
        output: cancelled ? undefined : objective,
      };
    },
    async cancel() {},
    async close() {},
  };
}

export async function loadSkill({ id, content, signal }) {
  if (id !== 'review-guide') return undefined;
  const version = '1';
  if (content === 'metadata') {
    return { id, version, description: 'Check a result and its evidence', resources: ['review.txt'] };
  }
  const instructions = await readFile(new URL('./review.txt', import.meta.url), { encoding: 'utf8', signal });
  return { version, instructions };
}
```

Фабрика реального адаптера регистрирует ресурсы через `onClose(fn)` при их получении, до завершения инициализации. Сессия владеет своими вызовами. Адаптер связывает события с `attemptId`, реагирует на `signal` и `cancel(session, attemptId)`, а `close(session)` подтверждает отсоединение. Если вызов мог уйти во внешний сервис и его результат неизвестен, верните исход с неизвестным эффектом. При передаче структурированного результата Controller используйте контракт Decision v1. [Контракты исполнения](CONTRACTS.md)

## Инструкции skill

Поместите инструкции обычным текстом в `review.txt`. Каталог получает только метаданные. Controller добавляет `review-guide` в `skills` делегирования, чтобы загрузить текст для этого вызова. При изменении текста увеличьте версию источника. Несовпадение версии между каталогом и чтением, отсутствие ресурса и усечение по лимиту передаются исполнителю явно.

Для выбранного Worker Host передаёт отдельно role instructions и структурированные `skillInstructions` (id, version, status, текст/причина). Inline-текст доверенного Catalog — самостоятельный источник, не дублируется через loader; при его отсутствии используется loader, а отсутствующий/несогласованный источник явно unavailable. Controller получает только metadata. Те же материализованные инструкции хешируются и передаются CLI/ACP; исторический hash до исправления доставки не считается доказательством эквивалентного prompt. Native skill discovery Controller не изменяется. Поле `Action.skills` относится **исключительно к Host-managed Catalog**. Отсутствие идентификатора в этом каталоге не означает отсутствия provider-native skill, файлов проекта, инструкций, скриптов или terminal tools. Нативная работа не требует регистрации в каталоге Host; он не сканирует проектные директории и не подменяет средства исполнения. Только ошибочно указанный **явный** Host Catalog ID возвращает адресный `CAPABILITY_UNAVAILABLE`, не вывод о нативных возможностях провайдера.

Для отказа по явно выбранному незарегистрированному skill Controller получает `CAPABILITY_UNAVAILABLE`, category `skill`, resource (ID) и краткое пояснение в bounded action context: native capabilities независимы от Host Catalog. Registered source unavailable сохраняется отдельным статусом материала/metadata; required provider capability failure и permission denial имеют собственные технические причины. Host не удаляет неизвестный ID из Decision и не ищет замену.

Ссылки `resources` описывают ресурсы источника. Они сами по себе не предоставляют доступ к файлам. Явные требования пользователя имеют приоритет при конфликте со skill. Всегда действуют полномочия пользователя и провайдера. Смысл ограничений интерпретирует модель.

## Внешние инструменты

Объявите export `tool` в manifest и включите его id в доверенный `tools` список. Определение содержит `id`, `description`, `resource`, `effect` (`read` или `write`), объектную JSON Schema `inputSchema` и `invoke(input, scope)`. Опциональный `cancel(scope)` запрашивает остановку. `scope` содержит `operationId`, `attemptId`, `callId` и `signal`. `invoke` возвращает JSON-значение. Результат получает коррелированную ссылку наблюдения, а превышение лимита возвращает явный статус усечения.

Перед вызовом Host проверяет схему и запрашивает разрешение для `resource` через связанный с попыткой permission broker. Если разрешение недоступно или отклонено, вызов не начинается. При наличии MCP bridge модель видит схему через `tools/list` и вызывает зарегистрированный инструмент через `tools/call`. Встроенные context tools используют только права и ссылки живой попытки. Нативные terminal, edit и VCS принадлежат провайдеру.

Автор плагина может указать `permissionPreviewFields: ['version', 'target']` для полей, которые безопасно показать пользователю. Broker получает JSON в `action.details` с разрешёнными скалярными значениями верхнего уровня в `arguments`. Остальные поля и вложенные значения скрываются с отметкой `redacted`. Поля, не помещающиеся в предел 4 КиБ, пропускаются целиком с отметкой `truncated`. По умолчанию значения скрыты. Preview предназначен для получателя запроса разрешения и не меняет аргументы, передаваемые в `invoke`.

Прерванный запущенный вызов сначала получает статус и эффект `unknown`. Если вызов позднее возвращает результат в работающем Host, журнал сохраняет отдельное наблюдение с тем же `callId` и отметкой `late: true`. Оно доступно при чтении истории и передаётся в контекст при допустимом продолжении. Эффект остаётся неизвестным, а получение результата само по себе не запускает новый ход.

### Optional transient model activity

ProviderPort.invoke accepts an optional fourth callback, `activity`. A trusted adapter may report a native event as `activity?.({ kind: 'reasoning', payload: nativeData, nativeId })`; do not call this with inferred findings, synthetic thinking, or ambiguous final-message content. Programmatic hosts use `api.subscribeActivity({ operationId }, listener)` (optionally an attemptId), for example in the existing submit accepted callback before dispatch. The callback receives the coordinator-bound envelope or gap; unsubscribe on consumer teardown. See [Contracts](CONTRACTS.md#model-activity-transient). This does not persist events or change provider results, permissions or task state.

### Local control live notices and interactions

The existing local-control v1 JSON-line endpoint accepts optional `payload.stream: "live"` on run/resume, with `notice` frames `{requestId,notice:{channel:"activity"|"execution",event}}` alongside the existing accepted/outcome/error. `subscribe` with operationId is a scoped, connection-lifetime observer (accepted + live notices, disconnect to detach, no replay). `pending` with operationId returns current pending input requests. `answer` with operationId and payload `{ownerRequestId,answerKey,reply}` requires the binding returned only in the accepted interactive work response and matching operation/attempt/native request; the broker permits only manual answers. A repeated identical control request uses existing requestId dedup. The same token/configurationRef/launch checks apply; ACP owner still rejects local run/resume. Observer subscription confers no answer binding, and handler-owned native requests cannot be answered through this route. No second daemon or writer. `api.subscribeExecution(scope,listener)`, `api.pendingInteractions(operationId)` and `api.respondInteraction(reply)` are available independently of CLI/ACP presentation. Local notice receiver also bounds queued callbacks; overflow is `channel:"gap"` with droppedCount/reason. Disconnect detaches notices, not execution. The last original owner disconnect settles its pending input unavailable; reconnect of the same live work request requires original answerKey in payload.reconnectKey, preserves original interactive capability, and restores only future input. Observer duplicate receives no key. Interactive input-only clients need no stream subscription. On lost/rejected reply, inspect pending state; no new automatic answer or inference of acceptance from disappearance. Terminal response failure remains CONTROL_RESPONSE_LOST, inspect or safe same-binding reconnect, never automatic new dispatch. Close the subscription socket explicitly; owner shutdown closes observers without waiting for their completion.

Execution notices may carry committed finding records beside the redacted event. Normal finish drains already queued presentation for a bounded 250 ms per subscriber and may report channel gap (finish_unconfirmed); disconnect closes immediately. Final/interaction replies remain separate. No replay of dropped notices. Standard ACP notice is negotiated separately from explicit extension relay; no changes to opaque extension payloads or permissions.

## C18 — Internal decision control tool versus extensions

`submit_decision` is a built-in, attempt-scoped MCP **Controller-only** control tool when opted-in and negotiated. It is not added to `AttemptTools`, `externalTools.list()`, the RO Tool Catalog, or an extension permission resource. Its bounded call/input capacity is separate from the original general-purpose MCP bridge (`context_list/context_fetch` and configured external tools). It never bypasses native permissions, creates a Worker, suppresses other native providers' tools or authorizes new effects. The URL/token identifies a currently active Controller attempt to the extent an HTTP bearer is secret; it cannot prove that the root model rather than an authorized native subagent initiated a call.

### C18R — Collision-free MCP tool namespace

The Controller-only built-in `submit_decision` is not a reserved **external ToolPort ID**: already configured external tools with that ID remain reachable. If present, the invocation-scoped MCP bridge advertises its control tool under the first free `role_orchestrator_submit_decision` / `role_orchestrator_submit_decision_N` alias and reflects that exact name in the Controller's model-facing instructions. Native callers use the advertised name, never a silently shadowed external handler. Tool authorization remains with the original ToolPort; RO does not infer model strategy from names or prohibit provider-native tools. Workers never receive the built-in Controller capability.

## C18N — Built-in discovery namespace and ordinary MCP request lifetime

Optional invocation-scoped RO `evidence_list/evidence_fetch` exposes accepted observations with canonical refs. It is **not** an extension ToolPort, Host-native skill inventory, or a substitute for the provider's terminal/files/subagents. The built-ins `context_list/context_fetch`, `evidence_list/evidence_fetch` and `submit_decision` select distinct deterministic aliases on collision, never shadow a configured external ID; actual names are advertised via MCP and the Controller prompt. The external extension's declared `effect` does not select different request deduplication or replay policies.

Ordinary MCP requests retain only **active** ID correlation. Identical concurrent requests share one pending invocation, conflicting concurrent requests return a technical protocol error, and completed-state eviction permits a later identical or changed ID to execute as a new request. This intentionally trades away arbitrary completed-ID exactly-once to avoid indefinite payload retention and a cumulative 64-call barrier. The extension's original permissions, callId/late receipts, cancellation, unknown-effect provenance and no blind Host replay remain authoritative. `submit_decision` is not ordinary traffic: its request identity, proposal lineage and durable Decision path remain separate and stricter.

### C18N-R — Registered names and real External ToolPort throughput

The registration contract now accepts the syntactically valid external IDs `context_list`, `context_fetch`, `evidence_list`, `evidence_fetch` and `submit_decision`. The existing MCP bridge assigns each active RO built-in a deterministic free alias; an external tool ID is never silently shadowed. This uses the original `compileExternalTool` + `ToolPort` permission/schema route, not only a synthetic bridge catalog. The historical per-invocation **32-call cumulative** External ToolPort quota was removed; no substitute count quota was introduced. Input/output byte limits, authorization, permission decisions, cancellation, late ToolReceipts and truthful effect/provenance retain their prior contract. Ordinary transport replay remains at-most active correlated and is **not** exactly-once once the active request is freed. Actual ToolReceipts remain accepted observations even when completed transport state is discarded.
