# C08 — Generic ACP adapter

Вход: C07 и общий ProviderPort suite. Версия SDK/протокола проверяется по официальной спецификации и фактическому исполнителю. Имена методов не придумывать из аналогии.

## C08.1 — Protocol mapping

Составить в development report точную таблицу generic ports -> supported ACP messages/events, включая initialize, session, prompt, tool events, permission, cancel. Доступные API подтвердить пакетами/types и спецификацией. Не изменять core под внутренний объект SDK.

## C08.2 — Connection/session ownership

Реализовать start/initialize/negotiation/open/close; отдельно provider session id и Host operation id. Sessions переиспользуются только при подтверждённом контракте и корректном контексте; один adapter instance не смешивает два чужих диалога. Tests: start race, init failure, reconnect, incompatible protocol, session close cleanup.

## C08.3 — Prompt и события

Преобразовать supported text/resource/image blocks, streaming и terminal outcome. Неподдерживаемая обязательная modality -> capability error; optional progress может отсутствовать. Tests: события до/после terminal, duplicate updates, lost connection, unknown terminal, bounded raw data.

## C08.4 — Permissions

Точно связать provider permission request с attempt и внешним PermissionPort. Передать options без изменения смысла; validate selected id; cancel pending на termination. Tests: allow/deny, late user response, unknown option, несколько параллельных permission requests, reuse standing decision только по реальному контракту.

## C08.5 — Client tool bridge

Если исполнитель требует клиентские ACP filesystem/terminal capabilities, подключать их только через явно доступный внешний клиентский port, сохраняя permission и correlation. Не писать собственный файловый/terminal runtime в core. При CLI Host без такого клиента provider должен иметь собственные инструменты или объявить недоступность требуемой capability. Tests: passthrough result/error/cancel, отсутствие bridge, запрет ложной рекламы поддержки.

## C08.6 — Model/settings mapping

Поддерживаемые native settings/выбор модели передать adapter-local способом и подтвердить фактически выбранный профиль, если протокол это позволяет. Не выполнять silent model downgrade. Tests: unsupported model setting, unknown actual setting, различия capabilities двух fixtures без branching в core.

## C08.7 — Cancel и failure

Различать provider cancellation и клиентскую отмену; потеря транспорта после dispatch допускает неизвестный эффект. Cleanup owned process/connection без global process search. Tests: pending permission при disconnect, late terminal после cancel, malformed provider response, process exit до ACK.

## C08.8 — Общий контракт и native probe

Прогнать ProviderPort suite и ACP protocol fixture suite. Затем один реальный агент при доступности: prompt, tools, model selection, deny/cancel, resume limitation. Моки не подтверждают реальный Zed. Закрыть A18/A20/A38 adapter checks; host-facing ACP строится отдельно в C10.
