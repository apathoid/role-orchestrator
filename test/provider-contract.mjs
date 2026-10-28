import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertInvocationCapabilities, normalizeCapabilities } from '../src/providers/provider.mjs';
import { normalizeProviderError, AgentProviderError } from '../src/providers/errors.mjs';
import { normalizeAgentEvent } from '../src/providers/events.mjs';

const readOnlyProvider = {
  name: 'fake-readonly',
  capabilities: () => normalizeCapabilities({
    text: true,
    workspaceModes: { readOnly: true, write: false },
    images: false,
    resourceLinks: true,
  }),
};
assert.doesNotThrow(() => assertInvocationCapabilities(readOnlyProvider, { sandboxMode: 'read-only' }));
assert.throws(() => assertInvocationCapabilities(readOnlyProvider, { sandboxMode: 'workspace-write' }), /cannot enforce workspace-write/i);
assert.throws(() => assertInvocationCapabilities(readOnlyProvider, { sandboxMode: 'read-only', promptBlocks: [{ type: 'image' }] }), /does not support image/i);
assert.deepEqual(normalizeAgentEvent({ type: 'reasoning', text: 'x' }), { type: 'reasoning', text: 'x' });
assert.equal(normalizeProviderError(new Error('429 rate limit'), 'p').code, 'RATE_LIMIT');
assert.equal(normalizeProviderError(new Error('model foo is not enabled'), 'p').code, 'MODEL_UNAVAILABLE');
assert.equal(normalizeProviderError(Object.assign(new Error('no image'), { code: 'CAPABILITY_UNSUPPORTED' }), 'p').code, 'CAPABILITY_UNSUPPORTED');
assert.ok(normalizeProviderError(new Error('boom'), 'p') instanceof AgentProviderError);

const workflow = await readFile(new URL('../src/workflow.mjs', import.meta.url), 'utf8');
for (const forbidden of ['codex', 'claude', 'anthropic', 'deepseek', 'openai', 'wire_api', 'collaboration_mode']) {
  assert.equal(new RegExp(forbidden, 'i').test(workflow), false, `workflow core must not contain provider-specific concept: ${forbidden}`);
}
console.log('provider-contract: passed');
