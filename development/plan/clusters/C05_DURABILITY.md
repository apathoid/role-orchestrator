# C05 — Долговременное состояние и recovery

Вход: C04, CONTEXT_AND_RECOVERY. Store защищает только данные оркестратора. Никакой координации записи исходников и глобальных project hashes.

## C05.1 — Snapshot schema

Определить сериализуемые operation/attempt/action/context references и ledger. Не сериализовать AbortSignal, живые permissions tokens, adapter objects или secrets. Tests: round-trip, отсутствующие optional поля, unknown major version, сохранение точных unknown outcomes.

## C05.2 — Atomic local store

Реализовать load/commit/list с expectedRevision, temp write/flush/rename и error mapping. Один snapshot — источник истины, diagnostic log не восстанавливает пропавшие решения. Tests с fault injection: ошибка записи/rename, чтение старой либо новой целостной записи, отсутствие частичного JSON.

## C05.3 — Writer ownership

Выбрать проверенный механизм блокировки собственного state directory. Установить acquire/release/crash behavior и платформенные ограничения. Второй живой writer получает STATE_STORE_IN_USE, но не затрагивает workspace. Tests: два процесса, нормальный close, crash, устаревший lock с доказанно мёртвым владельцем; не снимать по одному возрасту.

## C05.4 — Артефакты

Atomic bounded artifact write до публикации ссылки; hash проверяет байты. Отсутствующий/повреждённый artifact возвращает unavailable/integrity_error, не делает всю operation успешной/неуспешной автоматически. Tests: truncation metadata, отсутствующий blob, неполная запись, cleanup orphan temp без удаления reachable data.

## C05.5 — Commit перед dispatch

Встроить durable reservation и attempt identity до внешнего вызова. Если commit failed/unknown — load, не dispatch наугад. После reserve отмечать dispatch/terminal с учётом crash gap. Tests: process stop в каждой границе; один command ни в одном сценарии не повторяется автоматически после uncertainty.

## C05.6 — Outcome commit и доставка

Сохранять результат до final delivery; duplicate outcome идемпотентен. Потеря ACK клиента ведёт к повтору сообщения, не вызова провайдера. Tests: событие получено дважды, crash после terminal commit, CAS conflict и повтор исключительно локальной записи.

## C05.7 — Resume

Загрузить history/ledger/unknown и актуальные доверенные ограничения. Controller получает список unresolved attempts и реальные capabilities status lookup. Нет preflight Git/source check. Tests: resume без репозитория, при другой версии config, с изменившимися файлами, с недоступным прежним provider и доступным альтернативным профилем.

## C05.8 — Независимое продолжение при unknown

Запретить automatic replay прежнего неопределённого attempt. Разрешить новые независимые действия модели; retryOf с возможным необратимым эффектом требует объявленного безопасного основания или информированного разрешения. Не писать семантический command-equivalence engine. Tests: unknown external write -> чтение/уточнение разрешены, слепой replay запрещён, provider idempotency contract работает только при его наличии.

## C05.9 — Область неисправности

Повреждение/несовместимость одной operation адресно диагностируется; list показывает её unavailable, другие доступны. Store unavailable останавливает новый dispatch там, где не обеспечена обязательная запись, но не превращается в source reconciliation. Tests: read-only state filesystem, одна corrupt запись, восстановленный диск без дублирования ранее отправленного.

## C05.10 — Crash matrix

Автоматизировать subprocess crash fixtures в harness на точках до/после reserve, dispatch, result, commit, delivery. Сверить фактический count external effects и остаток бюджета. Закрыть A23–A28; trace показывает commit revision и attempt id без hashes пользовательского проекта.
