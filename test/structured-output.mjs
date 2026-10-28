import assert from 'node:assert/strict';
import { parseStructuredState, parseStructuredStateOrText } from '../src/structured-output.mjs';

const exploration = {
  summary: 'ok',
  relevantFiles: ['a.ts'],
  constraints: [],
  existingPatterns: [],
  likelyVerification: [],
  unknowns: [],
};

const exact = parseStructuredState({ finalText: JSON.stringify(exploration), unphasedText: '' }, 'exploration');
assert.equal(exact.parsed.summary, 'ok');
assert.equal(exact.source, 'raw-1');

const fenced = parseStructuredState({ finalText: `\`\`\`json\n${JSON.stringify(exploration)}\n\`\`\``, unphasedText: '' }, 'exploration');
assert.equal(fenced.parsed.summary, 'ok');
assert.equal(fenced.source, 'fenced-1');

const embedded = parseStructuredState({ finalText: `Here is the result:\n${JSON.stringify(exploration)}\nDone.`, unphasedText: '' }, 'exploration');
assert.equal(embedded.parsed.summary, 'ok');
assert.equal(embedded.source, 'embedded-1');

assert.throws(
  () => parseStructuredState({ finalText: 'plain prose only', unphasedText: '' }, 'exploration'),
  /No candidate JSON object|Unexpected token|JSON/,
);

const plain = parseStructuredStateOrText({ finalText: 'plain prose only', unphasedText: '' }, 'exploration');
assert.equal(plain.format, 'text');
assert.equal(plain.text, 'plain prose only');
assert.match(plain.parseError, /No candidate JSON object|Unexpected token|JSON/);

const tolerantStructured = parseStructuredStateOrText({ finalText: JSON.stringify(exploration), unphasedText: '' }, 'exploration');
assert.equal(tolerantStructured.format, 'structured');
assert.equal(tolerantStructured.data.summary, 'ok');

console.log('structured-output: passed');
