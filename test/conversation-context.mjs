import assert from 'node:assert/strict';
import { buildSessionContextText, compactSessionTitle } from '../src/conversation-context.mjs';

const session = {
  transcript: [
    { user: 'Первый вопрос', assistant: 'Нашли ограничение A: решение X не подходит.' },
    { user: 'Второй вопрос', assistant: 'Нашли ограничение B: нужен другой путь.' },
    { user: 'Что делать теперь?', assistant: 'Учитываем A и B.', attachments: [{ id: 'att_12345678', type: 'image', mimeType: 'image/png', size: 123, persisted: false, reason: 'single_attachment_limit' }] },
  ],
  history: [
    { user: 'Первый вопрос', result: 'A' },
    { user: 'Второй вопрос', result: 'B' },
    { user: 'Что делать теперь?', result: 'A+B' },
  ],
};

const context = buildSessionContextText(session);
assert.match(context, /Нашли ограничение A: решение X не подходит/);
assert.match(context, /Нашли ограничение B: нужен другой путь/);
assert.match(context, /OUTER CONVERSATION — RECENT TURNS VERBATIM/);
assert.match(context, /id=att_12345678 type=image mimeType=image\/png size=123 persisted=false reason=single_attachment_limit/);

const bounded = buildSessionContextText(session, { maxFullTurns: 1, maxChars: 10_000, maxSummaryChars: 10_000 });
assert.match(bounded, /OUTER SESSION WORKFLOW MEMORY/);
assert.match(bounded, /Result: A/);
assert.match(bounded, /Учитываем A и B/);

assert.equal(
  compactSessionTitle('ORCHESTRATOR ROLE BOUNDARY: Исправить адаптивную ширину колонок и очень длинный хвост с инструкциями'),
  'Исправить адаптивную ширину колонок и очень длинный хвост',
);
assert.equal(compactSessionTitle('', 'Проверить контекст диалога в Zed'), 'Проверить контекст диалога в Zed');

console.log('conversation-context: passed');
