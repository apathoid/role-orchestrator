# C04 — Конфигурация, каталог и полномочия

Вход: C03, PROVIDERS_AND_CONFIGURATION. Цель: реальная настройка доступных возможностей, без environment confinement.

## C04.1 — JSON config и схема

Реализовать versioned decoder и схему: providers, profiles, controllerProfile, roles, resources, storage, diagnostics, plugins, skills, tools. Ошибки содержат field path; secrets не выводятся. Tests: unknown keys/versions, несуществующий profile reference, отсутствующий controller, неверные limits.

## C04.2 — Источники и merge

User config/явные launch options доверенные; project preferences ограничены. Project file читается только по явному пути/в cwd. Описать per-field replacement/merge. Tests: проект выбирает известный профиль и уменьшает limit; попытка добавить endpoint/plugin/повысить authority отклоняется адресно; никакого Git root discovery.

## C04.3 — Catalog

Создать immutable catalog snapshot и resolver для ids, roles и capabilities. Controller получает переносимое представление и может выбрать другой профиль после ошибки. Tests: одинаковый порт обслуживает несколько моделей, неизвестный id локально отклоняется, смена профиля не reset ресурсы.

## C04.4 — Capability requirements

Различать необходимые и необязательные возможности, configured/negotiated. Не требовать read-only capability из-за слова review. Tests: отсутствие image input для image-required request -> локальная ошибка; отсутствие streaming/точного usage -> честная деградация; unknown не блокирует все действия.

## C04.5 — Trusted authority

Ввести reference на действительные пользовательские/провайдерские решения, scope доступных контролируемых ресурсов и revocation. Handoff наследует ограничения. Не считать text writeIntent самостоятельно выданным grant и не запрашивать новый grant, когда standing authorization покрывает действие. Tests: модель/skill/config не повышают права; уже разрешённая работа продолжается без повторного prompt.

## C04.6 — Permission bridge

PermissionPort сохраняет request correlation, options и статус; ответ применим только к соответствующей живой попытке. Tests: allow/deny, неизвестный option, late answer после cancel, повторный ответ; отсутствие UI возвращается как permission unavailable, не auto-allow.

## C04.7 — Mutable workspace без слежения

Передавать cwd как рабочий контекст, не repoRoot. Поменять файлы/индекс/branch/содержимое директории во время fake attempt; coordinator не должен ничего автоматически инвалидировать. Tests: отсутствующий Git binary; директория без Git; текущие permissions сохраняются при обычном drift; новый ресурс вне политики проходит native/контролируемый permission.

## C04.8 — Проверка гарантий

Документировать фактическую enforcement границу каждого adapter profile. Host не аттестует read-only filesystem. Удалить любые introduced hooks для source fingerprint/rollback/глобальной актуальности, если появились при реализации. Закрыть A15–A18, A30–A32; диагностика config error не раскрывает секреты и указывает точный источник.
