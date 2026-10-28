# Role Orchestrator — технический отчёт о стабилизации Review Pipeline

**Дата:** 27 октября 2026 года.
**Исходная версия:** `role-orchestrator-stabilized-2026-10-27(1).zip`.
**План:** приложенный `Pasted text(5).txt` (P1–P6 и три аудиторских прохода).
**Источники диагностики:** `review-role-orchestrator(6).md`, `role-orchestrator-independent-remediation-report-2026-10-27(1).md`.

## 1. Итог и границы

Реализованы согласованные изменения существующего review-ledger, независимого evidence-based adjudication, deterministic renderer, observability и интеграции workflow. Существующие Review Work Units, checkpoints, quality gates, review scope, host-neutral interfaces и политика read-only не заменены. **Подтверждение production-ready не заявляется:** окружение не позволяет запустить реальные ACP SDK-зависимые интеграции и не соответствует `engines.node`.

Статусы: **CONFIRMED** — воспроизведён на исходниках/тестом; **EXPECTED_BEHAVIOR** — соответствует контракту; **NOT_VERIFIED** — данных недостаточно для доказательства.

## 2. Исходная диагностика и первопричины

| ID | Статус на исходной версии | Причина/эффект | Исправление |
|---|---|---|---|
| RS-01 | CONFIRMED | При canonical reconciliation оставалась только первая `issue` и агрегированный `evidence` (ограниченный); severity/origin второго и третьего сообщения и полные observation records не сохранялись в ledger. Порядок batches определял видимую severity. | Сохраняются все observations, batch/unit provenance, исходные evidence, source locations, severity/origin variants. Выбор видимого сообщения независим от порядка входа и batch ID. Severity показывается по максимально заявленной значимости; конфликт origin переводит итоговую оценку в `unknown`. |
| RS-02 | CONFIRMED | Adjudicator использовал DSU и объединял A–B и B–C без проверки совместимости полной группы; при пустом ключе у B могли объединиться противоречащие A и C. ID группы зависел от первого элемента. | Перед каждым union проверяются все явно заданные reproduction keys в объединяемой группе; несовместимые транзитивные цепочки отвергаются; canonical ID выбирается детерминированно из IDs подтверждённых членов, прежние IDs сохраняются как aliases. |
| RS-03 | CONFIRMED | После adjudication ссылки на кандидаты могли исчезнуть при выборе другого representative. Потенциальные пары раньше считались по общему `path`/`contract`, что завышало показатель. | Общий similarity primitive (`src/evidence/similarity.mjs`); пары обнаруживаются по конкретным сигналам, но никогда не служат разрешением на merge. После подтверждённого объединения потенциальные связи проецируются из исходных candidate edges, включая aliases. |
| RS-04 | CONFIRMED | `implementationComplete: true` при read-only review возникал из общего `planCompleted`. | `implementationComplete` применим только к mode `change`, `reviewComplete` независимо сообщает статус покрытия review. |
| RS-05 | CONFIRMED | Отсутствовало однозначное разделение канонических записей, raw observations, доказательно объединённых и потенциальных пар в telemetry/renderer. | Старые поля сохранены, добавлены `reviewObservations`, `reviewCanonicalFindings`, `reviewConfirmedMerges`, `reviewPotentialDuplicatePairs` и уточнения в итоговом тексте. `reviewFindingsUnique` — **legacy count canonical records**, не доказательство семантической уникальности. |
| RS-06 | CONFIRMED | Evidence rejection отображался только общим счётчиком; оператор не видел категорий ошибок. | `reviewRiskEvidenceRejectedReasons` содержит только allowlisted агрегированные коды, без risk ID, prompts, evidence, paths; сохраняется в sanitized efficiency history. |
| RS-07 | CONFIRMED | `reviewFilesVerified` и `verificationChecks` было легко неверно трактовать как независимо выполненные тесты; наблюдаемые tool events не эквивалентны исполненным проверкам. | Дополнены `reviewFilesCoverageSource`, `reviewVerificationSource`, `reviewObservedExecuteCalls`, `reviewQualityGateMode`; прежние поля не переопределены. |
| RS-08 | CONFIRMED | `review_semantic_adjudicated.merged` сообщал общий `raw - canonical` (включая exact merge), а не число новых adjudication merges. | Событие теперь содержит приращение `baseline.unique - adjudicated.unique`. |

**EXPECTED_BEHAVIOR:** quality mode `off`/`observe` может давать `not_enforced`; 8/8 структурно проверенных Units без tool verification не означает 8 независимо подтверждённых дефектов; `router-context: observe/legacy/manifest_missing` является корректным fail-safe fallback при отсутствии manifest. Значения `reviewBatches: 3` и `reviewEstimatedInvocations: 2` не противоречат друг другу: второе поле — оценка, а не фактическое число вызовов.

**NOT_VERIFIED:** реальные первопричины 18 проблем в стороннем проекте нельзя независимо подтвердить по одному экспорту review. Не выведены новые reproduction/contract keys из похожего текста; без независимого witness эти findings **не объединены**.

## 3. Контракты после изменений

- **Authority:** checkpoint содержит исходные reports и unit evidence; ledger — детерминированная производная, не второй реестр с собственным lifecycle. Source observations сохраняются полностью в `ledger[].observations`; человеко-читаемый evidence preview может быть ограничен по размеру и не должен считаться исчерпывающим доказательством.
- **Canonical identity:** при достаточных `contractId`/`reproductionKey`/`path` и failure semantics получается стабильный hash. Слабые совпадения текста не объединяются. Отбор representative независим от порядка batches/свойств JSON.
- **Semantic candidates:** только гипотезы; различные явно заданные reproduction keys исключают недоказанное сближение. Число candidate pairs не равно числу истинных дублей.
- **Adjudication:** принимает только решения host callback с подтверждённым digest; для cross-file нужны `crossFile` и общий `rootCauseKey`. Даже в присутствии host witness противоречащие explicit reproduction keys группы запрещают union. Сохранены все ID aliases и source observations. Trust boundary на стороне host: SDK сам не удостоверяет содержание предоставленного witness, поэтому провайдер не должен подписывать его самостоятельно.
- **Presentation:** детерминированные sections и skill-driven перестановка заголовков сохраняются; все canonical findings обязательно выводятся по одному. Reviewer/Responder не могут удалить отдельный canonical record через prose.
- **Observability:** `reviewComplete`/coverage — модельно-отчётная структурная проверка, `implementationComplete` — только change. `reviewFilesVerified` сохраняется для совместимости и означает число файлов с принятым структурным покрытием reviewer (не независимые tests). `verificationChecks` — только checks workflow; `reviewObservedExecuteCalls` отдельно считает наблюдённые завершённые execute calls без утверждения об успешном результате тестов. Неизвестные provider tokens остаются `null`.
- **Persistence:** версия хранилища не увеличена, новые поля опциональны и allowlisted. Старые сессии с отсутствующими полями читаются как `null`, а не как ложный ноль.
- **Quality mode:** значения по умолчанию и существующие `off`/`observe`/`enforce` не изменялись. Обязательные незакрытые риски в `enforce` продолжают блокировать успешное завершение.

## 4. Сравнение до/после

Реальный пользовательский экспорт разобран как 18 текстовых записей, **не как исходная сериализация model-generated JSON**. Отсутствующие `contractId`/`reproductionKey` не были придуманы. Replay старого и нового reconciliation на извлечённых текстовых данных:

| Измерение | Исходная версия | Исправленная версия |
|---|---:|---:|
| Raw observations | 18 | 18 |
| Canonical records | 18 | 18 |
| Potential duplicates / pair candidates | 13 (path-level эвристика) | 1 (pairwise similarity) |
| Independently confirmed semantic merges | 0 | 0 |
| Полные observation records в derived ledger | 0 | 18 |

Контролируемый fixture с одним доказуемо общим reproduction/key в трёх batches: raw=3 и canonical=1 в обеих версиях; исходная версия показывала `minor` (порядок-входа), новая — `blocking` (максимальный impact); новые `observations` сохраняют все 3 provenance/evidence records. Это улучшение точности, **не измерение сокращения реального количества дефектов**.

Подготовленный context и provider usage: изменение числа оплаченных токенов или wall time **не доказано**. Существующий bounded handoff и проверка instruction manifest сохранены. Не убраны обязательные проектные правила только ради уменьшения длины prompt. Рост/падение токенов нельзя выводить из числа байтов/символов.

Машинное сравнение: `before-after.json`, построенное из `review-observations-extracted.json` и исходного/нового reconciler.

## 5. Тесты, среда, воспроизведения

Доступный runtime — **Node v22.16.0**, проект требует **Node >=22.20.0**. `npm ci --ignore-scripts --offline` останавливается на `ENOTCACHED zod@4.6.5`; registry DNS в среде недоступен. Зависимость `@agentclientprotocol/sdk` не установлена.

- `npm run check`: **PASS** (исходная и итоговая версия).
- `node test/review-stabilization.mjs`: **PASS** — baseline bug сначала воспроизведён до исправления; теперь covered provenance/severity/origin, permutation, hostile metadata, semantic ambiguity, witness trust, metrics, candidate linkage, canonical count.
- Широкая независимая матрица `test/*.mjs` + `test/evaluation/*.mjs` (кроме test helper/runner): **93 сценария, 89 PASS, 4 SDK_BLOCKED, 0 TIMEOUT**. SDK_BLOCKED: `test/codex-acp-cancellation.mjs`, `test/generic-acp.mjs`, `test/provider-progress.mjs`, `test/smoke.mjs` с `ERR_MODULE_NOT_FOUND @agentclientprotocol/sdk`. Эти блокировки — не assertion failures production-кода, но и не PASS.
- `npm test`: **BLOCKED** из-за той же отсутствующей зависимости (не объявлять полный PASS).
- `node test/review-efficiency.mjs`, `node test/review-completion.mjs`, `node test/review-quality-workflow.mjs`, `node test/review-output-skill.mjs`, `node test/review-scope-hardening.mjs`, `node test/review-operation-continuity.mjs`, `node test/review-optimization-v2.mjs`, `node test/session-store.mjs`: **PASS** в текущем окружении.

Логи: `final-check.log`, `full-matrix-final.log`, `full-npm-test-final.log` и `audits/*.log` размещены в отдельном архиве с техническими свидетельствами.

## 6. Три аудиторских прохода

**A — Correctness:** повторная проверка сильной/слабой идентичности, входного порядка, максимальной severity, противоречий origin, сохранения observations и transitive merge; при повторном просмотре найдено влияние batch provenance на primary selection. Исправлено сортировкой по semantic fields, тесты `review-stabilization`, `review-operation-continuity`, `evidence-driven-completion`, `efficiency-architecture` — PASS.

**B — Architecture & Integration:** прослежены границы checkpoint → review ledger → semantic candidate → independent adjudication → deterministic renderer → `/efficiency export`. Выявлены завышенное значение `review_semantic_adjudicated.merged`, неоднозначная completion metric, недостаток diagnostics rejections; исправлены без вторых источников истины и изменения режима gate. `review-efficiency`, `review-completion`, `review-quality-workflow`, `review-output-skill`, `review-scope-hardening`, `p3-monitoring-production` — PASS.

**C — Adversarial & Regression:** проверены отсутствующий/поддельный witness, разные reproduction keys, transitive conflicts, cross-file authority, небезопасная мета-разметка, инъекция произвольных telemetry keys (`__proto__`), 75 observations с перестановкой batch order, сохранение кандидатных связей при смене representative, read-only/security и персистентность. Исправлены утрата candidate edges после adjudication и телеметрия со слишком широкими reason keys. `review-stabilization`, `review-optimization-v2`, `review-quality-depth`, `security`, `session-store` — PASS.

Эти проходы целевые, а не исчерпывающий анализ всех execution paths или live ACP.

## 7. Остаточные ограничения

1. Реальная интеграция с ACP SDK 2.0.2 / Codex ACP 2.3.0, Zed, сетевые timeout/cancel и long-running provider sessions **NOT_VERIFIED** в данной среде; необходим прогон `npm ci && npm test` с Node >=22.20.0 и рабочими зависимостями.
2. Не проверено совпадение подготовленного prompt profile с платёжными provider token counters. Фактическая стоимость/снижение токенов **NOT_VERIFIED**.
3. Проверка исходных user findings требует исходного repository checkout и host verifier. Из экспортированного Markdown нельзя восстановить доказательную семантику 18 дефектов.
4. Bounded human-readable evidence preview не содержит всех полных текстов. Полные записи доступны в структурированном derived ledger и checkpoint reports.
5. При добавлении новой *неэквивалентной по identity* observation и последующем независимом semantic merge canonical ID может выбрать меньший hash из нового состава. Прежние IDs сохраняются в aliases; стабильность неизменной canonical identity проверена. Не обещается абсолютная неизменность ID при **изменении доказанной группы**.
6. Trust `verifiedWitnessDigests` принадлежит интегрирующему host; само наличие 64-байтного digest не означает объективную независимую проверку реального дефекта.

**Вывод:** локально подтверждённые ошибки согласования и observability закрыты и защищены regression tests. Полное выполнение критериев production-ready и end-to-end в реальном ACP окружении **не подтверждено**, прежде всего из-за неустановленных зависимостей и неподдерживаемой версии Node.js.
