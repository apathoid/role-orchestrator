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

Ссылки `resources` описывают ресурсы источника. Они сами по себе не предоставляют доступ к файлам. Явные требования пользователя имеют приоритет при конфликте со skill. Всегда действуют полномочия пользователя и провайдера. Смысл ограничений интерпретирует модель.

## Внешние инструменты

Объявите export `tool` в manifest и включите его id в доверенный `tools` список. Определение содержит `id`, `description`, `resource`, `effect` (`read` или `write`), объектную JSON Schema `inputSchema` и `invoke(input, scope)`. Опциональный `cancel(scope)` запрашивает остановку. `scope` содержит `operationId`, `attemptId`, `callId` и `signal`. `invoke` возвращает JSON-значение. Результат получает коррелированную ссылку наблюдения, а превышение лимита возвращает явный статус усечения.

Перед вызовом Host проверяет схему и запрашивает разрешение для `resource` через связанный с попыткой permission broker. Если разрешение недоступно или отклонено, вызов не начинается. Прерванный вызов с возможным эффектом получает `unknown`. При наличии MCP bridge модель видит схему через `tools/list` и вызывает зарегистрированный инструмент через `tools/call`. Встроенные context tools используют только права и ссылки живой попытки. Нативные terminal, edit и VCS принадлежат провайдеру.
