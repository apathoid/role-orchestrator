# Состояние реализации

| Показатель | Значение |
|---|---|
| Specification prepared | YES |
| Production implementation started | YES, переносимое ядро и прямой Controller path |
| Последний локально проверенный шаг | C03.10, сценарии модельного выбора |
| Следующий шаг | C04.1, строгий конфиг v1 и доверенные источники |
| Functional implementation complete | NO |
| Local regression verified | OBSERVED для C00–C03 с тестовыми портами |
| Native integration verified | UNVERIFIED |
| Production ready | NO |

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
- OBSERVED: итоговый локальный прогон `check`, `test:foundation` (4), `test:core` (9), `test:integration` (23), `check:package`, `check:removal`, exit 0. Полные permission/configuration, durable restart и нативные провайдеры UNVERIFIED, следующие кластеры C04–C12.
