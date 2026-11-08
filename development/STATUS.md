# Состояние реализации

| Показатель | Значение |
|---|---|
| Specification prepared | YES |
| Production implementation started | YES, переносимое ядро и прямой Controller path |
| Последний локально проверенный шаг | C06.5, mutable environment |
| Следующий шаг | C06.6, assessment по требованиям |
| Functional implementation complete | NO |
| Local regression verified | OBSERVED для C00–C06.5 с тестовыми портами и локальным store на Linux |
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
- OBSERVED: итоговый локальный прогон `check`, `test:foundation` (4), `test:core` (9), `test:integration` (23), `check:package`, `check:removal`, exit 0. [CI для C03.10](https://github.com/apathoid/role-orchestrator/actions/runs/42389823781) success на `b5adc03`. Durable restart и нативные провайдеры UNVERIFIED.

## C04 — конфигурация и полномочия

- C04.1 — JSON Schema v1 и runtime validation. Ajv 8.20.0 закреплён в npm lock как реализация стандартного валидатора; исходные ACP версии и Nix lock сохранены. Ошибки формы содержат JSON Pointer и имя ограничения без входного значения. Ссылки провайдеров, профилей и ролей проверяются после схемы.
- C04.2 — merge по отдельным полям: defaults → trusted user config → ограниченные project preferences → trusted launch options. Project preferences могут выбрать существующие profile/role/skills и снизить лимиты. Читается только явно указанный файл или `.role-orchestrator.json` из выбранной директории.
- C04.3 — immutable model-facing catalog отделяет профиль, модель и capability provenance от launch/settings и secret refs. Две модели могут использовать один provider port.
- C04.4 — обязательные capability проверяются до открытия сессии. Недоступный image input даёт `CAPABILITY_UNAVAILABLE` с `not_sent`; необязательный usage сохраняется как unknown.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (9), `test:integration` (31), `check:package`, `check:removal`, exit 0. Результат относится к синтетическим портам. [CI для C04.1–C04.4](https://github.com/apathoid/role-orchestrator/actions/runs/42390386124) success на `ec2bfcf`.

- C04.5–C04.6 — доверенный grant ограничивает запуск выбранными профилями, проверяется до open и перед dispatch. Permission bridge сопоставляет host request id, attempt id, native request id и предложенную опцию. Standing decision не открывает повторный prompt. Отмена закрывает запрос; поздний или повторный ответ не применяется. Отсутствие UI возвращает unavailable.
- C04.7–C04.8 — regression меняет файл, Git index и branch во время попытки. Orchestrator завершает исходную попытку с прежним authority ref без повторного вызова. Runtime остаётся проверяемым без Git. Область гарантий описана в документации. Нативные permission settings проверяются вместе с реальными адаптерами.
- Итоговый локальный набор: `check`, `test:foundation` (4), `test:core` (9), `test:integration` (38), `check:package`, `check:removal`, exit 0. Removal smoke также загружает схему из реального npm tarball. Durable state/recovery, context retention, реальные адаптеры, CLI/ACP hosts, эксплуатационные и native acceptance checks относятся к C05–C12.

После C04.8 добавлен regression на независимое делегирование: `all_requested` задаёт момент следующего ответа Controller, а ready action вне списка ожидания выполняется параллельно.

### Исправления после ревью C02–C04

- Активные делегаты принадлежат operation и сохраняют один handle ожидания и отмены между уточнением и resume. Проверено, что Controller дожидается прежнего attempt и не тратит бюджет на повторные вызовы, пока тот выполняется.
- Контекст нового Controller содержит прежние решения, заданный вопрос и доставленный ответ с модельной атрибуцией. Текст пользователя сохраняет отдельную атрибуцию.
- Coordinator завершает ограниченное ожидание даже при зависшем invoke или cancel. После возможной отправки остаётся unknown, поздний результат не завершает operation, а неподтверждённое закрытие удерживает слот. Проверено с тестовым адаптером; нативный cleanup UNVERIFIED.
- Локально: `check`, `test:foundation` (4), `test:core` (9), `test:integration` (42), `check:package`, `check:removal`.

## C05 — долговременное состояние и recovery

- C05.1 — snapshot codec v1 сохраняет operation, историю действий и контекста, reservations и точные unknown outcomes. Проверены round-trip, отсутствующие optional поля, неизвестная версия, повреждённый ledger и отказ от runtime handles. Null usage отличается от нуля.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (42), `check:package`, `check:removal`, exit 0. Следующий шаг — C05.2, atomic local store.

- C05.2 — локальный StateStore загружает и перечисляет целые snapshots, сравнивает ожидаемую revision и публикует следующую через temp write, file sync, rename и directory sync. Инъекции ошибок проверяют частичную запись, сбой rename и видимую новую revision после ошибки directory sync.
- C05.3 — writer удерживает SQLite-блокировку собственного state directory через встроенный `node:sqlite`. Проверено на Linux с двумя процессами: отказ живому конкуренту, повторное открытие после close и SIGKILL, отсутствие takeover по возрасту файла. State directory должен существовать к открытию.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (47), `check:package`, `check:removal`. Следующий шаг — C05.4, bounded artifacts. Применение durable store в сценариях reserve/dispatch и recovery проверяется в следующих шагах. NixOS и нативные провайдеры UNVERIFIED.

- C05.4 — bounded artifacts публикуются до выдачи ссылки с SHA-256, размером и truncation metadata. Чтение ограничено байтами и различает unavailable и integrity_error. Инъекция частичной записи проверяет отсутствие опубликованной ссылки. Повторное открытие под writer lock очищает только именованные временные файлы; проверено сохранение blob, на который ссылается snapshot.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (49), `check:package`, `check:removal`. Следующий шаг — C05.5, durable reservation и crash gap до dispatch.

- C05.5 — координатор допускает внешний вызов после подтверждённых commit reservation и dispatch. При неподтверждённой записи перечитывает snapshot для корреляции и прекращает текущую попытку dispatch. Проверены четыре subprocess crash boundaries вокруг reserve и dispatch, сохранённый остаток бюджета и фактическое число внешних эффектов после повторной доставки requestId. Отдельный тест читает terminal unknown после закрытия и повторного открытия durable store.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (55), `check:package`, `check:removal`. Следующий шаг — C05.6, подтверждение outcome commit и повторная доставка. Активное возобновление после сбоя и статус прежнего провайдера относятся к C05.7.

- C05.6 — при CAS conflict исход повторно применяется к сохранённой revision с тем же eventId. Если итог уже виден после потерянного ACK store, точное совпадение позволяет повторно подтвердить запись без изменения revision. Проверены реальный конфликт CAS, повторная доставка requestId после SIGKILL между final commit и доставкой, сохранение единственного outcome и отсутствие повторного вызова провайдера.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (57), `check:package`, `check:removal`. Следующий шаг — C05.7, активный resume после перезапуска с текущей доверенной конфигурацией и capability status lookup.

- C05.7 — явный resume восстанавливает ledger и историю, применяет текущий grant, лимиты и каталог. Unresolved attempts передаются Controller. Status lookup требует действующей авторизации, совпадающего маршрута и negotiated capability; ожидание ограничено. Проверены SIGKILL, другой провайдер и конфигурация, изменившийся файл вне Git, успешный и зависший lookup и configured-only capability.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (61), `check:package`, `check:removal`. Следующий шаг — C05.8, явный retry и независимые действия при unknown. Нативная интеграция UNVERIFIED.

- C05.8 — явно предложенный retry сопоставляется с исходным attempt. Проверены отказ при трёх неподтверждённых основаниях, доступность независимого чтения, известный no-effect, доверенное scoped-разрешение и повтор с тем же ключом по контракту адаптера. Счётчик эффекта при идемпотентном повторе остался равен одному.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (67), `check:package`, `check:removal`. Следующий шаг — C05.9, изоляция ошибок store.

- C05.9 — list различает здоровые, повреждённые и несовместимые snapshots. Адресный отказ защищает повторную доставку начального requestId повреждённой операции, а другие операции работают. Проверены сохранность повреждённых байтов, чтение и commit раннего имени файла, инъекция EROFS и продолжение после восстановления записи без повторения внешнего эффекта.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (70), `check:package`, `check:removal`. Следующий шаг — C05.10, итоговая crash matrix.

- C05.10 — девять subprocess crash boundaries от reservation до доставки. Проверены число внешних эффектов, сохранённый расход, явный resume, повторная доставка, корреляция commit revision и attemptId и сохранность результата при отказе diagnostic sink. C05 закрыт на уровне локального Linux store и тестовых портов. A23–A28 отражены в acceptance matrix с границами доказательства.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (13), `test:integration` (76), `check:package`, `check:removal`. Следующий шаг — C06.1, provenance. Нативные адаптеры, CLI/ACP delivery и NixOS остаются UNVERIFIED.

### C05 — исправления после ревью

- Snapshot codec сверяет status, dispatch certainty, timestamps, маршрут и итог attempt с последовательностью сохранённых событий. Несогласованная запись возвращает corrupt_snapshot, остаётся на диске и не допускает resume или dispatch.
- После abort coordinator ограничивает ожидание и завершает модельный ход, но до подтверждения отсоединения сохраняет коррелированные поздние факты. Проверены late outcome и расход, дедупликация observations, сохранение после дедлайна cleanup и отсутствие повторного модельного хода.
- OBSERVED локально: `check`, `test:foundation` (4), `test:core` (14), `test:integration` (79), `check:package`, `check:removal` (из локального npm cache). Следующий шаг — C06.1.


## C06 — контекст, findings и acceptance

- C06.1 — история различает пользовательские сообщения, модельные сообщения, отчёты провайдера, события инструментов и наблюдения транспорта. Сохранены идентификатор источника, время приёма, доступный вывод и полнота. Порядок доставки восстанавливается из revision и позиции записи в событии. Снимки v1 без новых полей остаются читаемыми.
- OBSERVED: после повторного открытия Linux store выход процесса агента с кодом 0 и сообщение модели о прошедших тестах видны отдельно. Код завершения инструмента появляется только из отдельного структурированного события. Проверены противоречивый provenance в snapshot и дедупликация позднего события с другим временем доставки.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (80), `check:package`, `check:removal`, exit 0. Адаптеры CLI/ACP и локальная проверка Nix остаются UNVERIFIED. Следующий шаг — C06.2.


- C06.2 — Controller и специалисты могут добавлять структурированные findings с claim, subject, supports, author и uncertainties. `supersedes` связывает новую запись с предыдущей. Проверяются идентификаторы, авторство и ссылки в пределах операции. История сохраняет каждую находку и её опоры.
- OBSERVED: противоположные выводы двух профилей об одном файле сосуществуют. После повторного открытия store доступны оба вывода, модельная ревизия, исходные observations и предыдущая итоговая assessment. Невалидная находка специалиста оставляет исход вызова и raw output доступными. Проверены адресные ошибки для чужих ссылок, повторных ID и несовпадающего автора.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (83), `check:package`, `check:removal`, exit 0. Реальные CLI/ACP-адаптеры остаются UNVERIFIED. Следующий шаг — C06.3.


- C06.3 — доверенная настройка `context.maxBytes` ограничивает необязательную историю в UTF-8 JSON. Controller получает приоритет недавних записей, специалист получает выбранные ссылки и обязательные сведения об отмене и неизвестных эффектах перед dispatch. Цель, пользовательский текст и ограничения передаются дословно.
- OBSERVED: большие записи доставляются как помеченные фрагменты с provenance и ссылкой. Пропуск по лимиту, неизвестная ссылка и зарегистрированный вывод без payload различаются. Проверены многобайтный текст, лимит в один байт, сохранение исходного вывода и отсутствие невыбранной истории в handoff.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (85), `check:package`, `check:removal`, exit 0. Лимит относится к истории, а размер нативного окна зависит от адаптера. CLI/ACP остаются UNVERIFIED. Следующий шаг — C06.4.


- C06.4 — fetch привязан к вызову, выбранным ссылкам специалиста и операции. Доступ к другой операции требует точного доверенного разрешения. Адаптер публикует байты артефакта перед записью ссылки; лимит `context.maxBytes` применяется к записи и выдаче байтов. Модельные резюме сохраняют автора и ссылки на исходные наблюдения.
- OBSERVED: запрос деталей и ограниченного артефакта после повторного открытия store, явная недоступность удалённого файла, отказ при чтении невыбранной ссылки и при доступе к другой операции без разрешения. Проверено, что переданный моделью хеш не предоставляет доступ к байтам, а резюме сохраняется с `model_claim` рядом с исходными данными.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (87), `check:package`, `check:removal`, exit 0. Чистая установка прошла при отдельном повторном запуске после ошибки очистки временного каталога. Нативные CLI/ACP остаются UNVERIFIED. Следующий шаг — C06.5.


- C06.5 — observations могут содержать сообщённые источником место, версию и время в `reportedContext`. Controller и специалист получают эту информацию в обычном контексте и по выбранным ссылкам. Ранее сохранённые findings остаются доступны вместе с исходными наблюдениями.
- OBSERVED: правка постороннего файла сохраняет находку и даёт три предусмотренных вызова. После правки проверяемого файла Controller запрашивает одно целевое повторное чтение, всего пять вызовов. Правка файла, обновление индекса и смена Git-ветки во время активного вызова оставляют один исходный dispatch. Проверены фактические вызовы, журнал dispatch и round-trip снимка.
- Локально на Node 24.22.1: `npm --prefix development run check`, `test:foundation` (4), `test:core` (15), `test:integration` (89), `check:package`, `check:removal`, exit 0. Нативные CLI/ACP остаются UNVERIFIED. Следующий шаг — C06.6.
