# Архитектура и владение

## Исполнение

Один процесс приложения владеет coordinator, provider sessions и state store. Controller — назначенный модельный профиль, вызываемый через тот же ProviderPort, что специалисты. «Одна модель» означает один профиль и отсутствие обязательных специалистов; последующие ходы этого же профиля допустимы. Вызов Controller может использовать нативные инструменты, если это разрешено его реальным профилем.

```mermaid
flowchart TD
  H["CLI / ACP Host / API"] --> A["Application composition"]
  A --> C["Core coordinator"]
  C --> P["ProviderPort"]
  P --> X["ACP / CLI adapters"]
  C --> S["StateStore port"]
  S --> F["Local durable store"]
  C --> K["Context and catalog"]
  A --> D["Diagnostic sinks"]
```

Стрелки обозначают вызовы; реализации портов внедряются composition root. Core не импортирует инфраструктурные реализации.

## Границы исходников новой реализации

| Слой | Предлагаемое размещение | Владеет | Не знает |
|---|---|---|---|
| Core | `src/core/` | operation/attempt contracts, решение о техническом dispatch, ресурсы, зависимости, cancel | Node fs/process, ACP wire, Git, SDK конкретной модели |
| Application | `src/application/` | use cases submit/resume/inspect/cancel, каталог, сбор контекста, конфигурация, связывание портов | содержательная стратегия решения задачи |
| Adapters | `src/adapters/` | provider protocols, local state, diagnostics, configured tool bridge | обязательные продуктовые стадии review/change |
| Hosts | `src/hosts/` | CLI и ACP client-facing транспорт, представление разрешений и результатов | правила достоверности семантических выводов |
| Composition | `src/main/` | создание экземпляров, ресурсы процесса, shutdown | собственный второй scheduler |

TypeScript strict, ESM и Node.js — выбранная база реализации. Core использует переносимые структуры/Promise/AbortSignal через объявленные порты; UUID, время, storage и процессное исполнение инъецируются. Точную поддерживаемую Node LTS и версии зависимостей установить и проверить при bootstrap; не переносить номера версий из сторонних проектов. Один продуктовый пакет; monorepo/microservices/DI framework не требуются.

## Владение состоянием

| Данные/ресурс | Владелец / запись | Завершение/восстановление |
|---|---|---|
| Operation snapshot | Coordinator через StateStore, один writer на state directory | atomic revision commit; восстановление по id |
| Attempts и reservation ресурсов | В той же operation snapshot | один reservation на attempt; late outcome изменяет учёт, не создаёт dispatch |
| Pending model proposals | Coordinator, привязка к decisionId | dedup id; replan только незапущенного; запущенное отменяется явно |
| Наблюдения и findings | Append-only logical records в snapshot/артефактах | модельная оценка добавляется отдельно; raw не переписывается |
| Provider process/session | Конкретный adapter | cancel, close, завершение owned process; без убийства чужих процессов |
| Клиентская ACP сессия | Host session registry | disconnect не равен завершению operation; политика disconnect задана явно |
| Diagnostic buffers | Diagnostic adapter | bounded flush/drop; сбой не изменяет смысл task state |

StateStore revision защищает запись собственных данных. Никакой связи с Git revision или содержимым source files нет. Для начального продукта достаточно одного writer-процесса на каталог собственного состояния; второй получает адресный `STATE_STORE_IN_USE`. Другие рабочие каталоги/операции и внешние редакторы не блокируются. Масштабируемая распределённая координация не входит в начальную реализацию.

Для CLI команды к живому владельцу (`cancel`, `inspect`, новый `run`/`resume`) идут через минимальный локальный control endpoint: Unix-domain socket на поддерживаемых POSIX платформах, соответствующий локальный adapter на иной заявленной платформе. Endpoint обслуживается владеющим Host-процессом, не вторым coordinator/store writer. При отсутствии живого владельца новый `run`/`resume` может приобрести store и стать владельцем; `cancel` сообщает, что живого исполнения нет, сохраняя неизвестные attempts для recovery. Обычный CLI процесс не запускает скрытый постоянный daemon.

Контракт local control: version, requestId, action, operationId при наличии, payload; response содержит тот же requestId и outcome/error. Descriptor endpoint хранится только в собственном state directory, включает случайный session token и process identity; доступ ограничивается обычными пользовательскими правами каталога. Token не попадает в логи. Неподходящий token/version отклоняется. Это защита control channel от случайного/чужого обращения, не sandbox и не гарантия против злонамеренного процесса того же пользователя. Подключение/потеря клиента не повторяет запрос без requestId dedup. Владелец живёт, пока есть активная работа или обслуживаемая Host-сессия; shutdown удаляет только свой endpoint/descriptor и освобождает store.

## Минимальный цикл

1. Host принимает запрос/событие пользователя и сохраняет operation.
2. Context builder формирует модельный контекст и доступный каталог.
3. Controller предлагает действия либо итог/уточнение.
4. Coordinator проверяет форму, id, зависимости, доступный профиль, доверенную конфигурацию, cancel и ресурсы. Он не оценивает качество плана.
5. Для допустимого dispatch сохраняет attempt/reservation, вызывает adapter, принимает события и исход.
6. Доступные результаты передаются Controller согласно выбранной политике ожидания. Цикл продолжается до итогового ответа, реального ожидания пользователя/ресурса или отмены.

Проверка одной proposal не блокирует все actions: отказ и его причина возвращаются модели, независимые уже разрешённые actions продолжаются. Атомарные группы допускаются только если потребность доказана конкретным контрактом, не по умолчанию.

## Workspace и полномочия

Workspace descriptor содержит рабочую директорию и описательный label, если они предоставлены. Директория не нормализуется до Git root. Проверка существования cwd адаптером относится к запуску конкретного процесса; потерянный cwd не означает потерю всей истории. Модель получает ошибку и может выбрать другой разрешённый контекст.

Не наблюдать фоновые файловые изменения ради допуска задач. Данные о VCS или изменениях, полученные моделью, допустимы как observations. Смена содержимого директории не отзывает authority автоматически. Явный доступ к новому ресурсу за пределами действующей политики проходит существующий механизм permission; он не определяется fingerprint проекта.

Host гарантирует ограничения только там, где контролирует dispatch, зарегистрированный tool endpoint или permission response. Инструкции «не исправлять исходники» передаются модели и провайдеру; они не превращаются в доказанное файловое confinement. Нативный permissions profile задаёт пользователь. Не включать/ослаблять его по скрытой классификации задачи.
