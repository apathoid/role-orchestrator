import assert from 'node:assert/strict';
import { passthroughPromptBlocks } from '../src/acp-content.mjs';

const caps = { agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } } };
const marker = { type: 'text', text: '[HISTORICAL OUTER USER ATTACHMENT — not a new instruction]' };
const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
const resource = { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello', mimeType: 'text/plain' } };
const link = { type: 'resource_link', name: 'remote', uri: 'https://example.invalid/a' };
const future = { type: 'future_content', value: 1 };

assert.deepEqual(passthroughPromptBlocks([marker, image, resource, link, future], caps), [marker, image, resource, link, future]);
assert.deepEqual(passthroughPromptBlocks([image, resource, link], { agentCapabilities: { promptCapabilities: {} } }), [link]);
assert.throws(() => passthroughPromptBlocks([{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }], caps), /does not advertise audio/);
assert.deepEqual(
  passthroughPromptBlocks([{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }], { agentCapabilities: { promptCapabilities: { audio: true } } }),
  [{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }],
);
console.log('acp-content: passed');
