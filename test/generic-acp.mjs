import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GenericAcpProvider } from '../src/providers/acp/generic-acp.mjs';

const root = await mkdtemp(join(tmpdir(), 'role-orchestrator-generic-acp-'));
const fake = resolve(new URL('./fake-codex-acp.mjs', import.meta.url).pathname);
await writeFile(join(root, 'greeting.txt'), 'hello\n');
const provider = new GenericAcpProvider('generic-test', {
  adapter: 'acp-agent',
  command: fake,
  workspaceModes: { readOnly: 'read-only', write: 'agent' },
  reasoningConfigId: 'reasoning_effort',
  supportsFastMode: true,
  fastModeConfigId: 'speed-tier',
  capabilities: { nativePlan: true, reasoningStream: true, mcp: { stdio: true } },
  timeoutMs: 10_000,
});
try {
  await provider.prepare();
  const caps = provider.capabilities();
  assert.equal(caps.images, true, 'image support is discovered from ACP initialize');
  assert.equal(caps.embeddedResources, true, 'embedded resource support is discovered from ACP initialize');
  assert.equal(caps.workspaceModes.readOnly, true);
  assert.equal(caps.workspaceModes.write, true);

  const sentConfigs = [];
  const originalSetConfig = provider.setConfig.bind(provider);
  provider.setConfig = async (sessionId, id, value) => {
    sentConfigs.push({ id, value });
    return originalSetConfig(sessionId, id, value);
  };
  const result = await provider.invoke({
    profileName: 'generic-profile',
    profile: { model: 'generic-model', reasoningEffort: 'medium', contextWindow: 100_000, fastMode: true },
    role: 'investigator',
    prompt: 'Synthesize a read-only investigation from repository evidence.',
    schemaKind: null,
    schema: null,
    cwd: root,
    sandboxMode: 'read-only',
    promptBlocks: [],
    mcpServers: [],
    additionalDirectories: [],
  });
  assert.match(String(result.output), /greeting\.txt/);
  assert(sentConfigs.some((entry) => entry.id === 'speed-tier' && entry.value === true),
    'generic ACP must send its configured fast mode control, not silently ignore it');

  const active = await provider.invoke({
    profileName: 'generic-profile',
    profile: { model: 'generic-model', reasoningEffort: 'medium', idleTimeoutMs: 55, turnDeadlineMs: 500 },
    role: 'investigator',
    prompt: 'Synthesize a read-only investigation from repository evidence. ACTIVITY_EXTENDS_IDLE_TEST',
    schemaKind: null,
    schema: null,
    cwd: root,
    sandboxMode: 'read-only',
    promptBlocks: [],
    mcpServers: [],
    additionalDirectories: [],
  });
  assert.match(String(active.output), /greeting\.txt/);
  assert.deepEqual(active.meta.timing, { idleTimeoutMs: 55, turnDeadlineMs: 500 });

  await assert.rejects(() => provider.invoke({
    profileName: 'generic-profile',
    profile: { model: 'generic-model', reasoningEffort: 'medium', idleTimeoutMs: 55, turnDeadlineMs: 500 },
    role: 'investigator',
    prompt: 'Synthesize a read-only investigation from repository evidence. IDLE_TIMEOUT_TEST',
    schemaKind: null,
    schema: null,
    cwd: root,
    sandboxMode: 'read-only',
    promptBlocks: [],
    mcpServers: [],
    additionalDirectories: [],
  }), (error) => {
    assert.match(error.message, /idle timeout after 55 ms/i);
    assert.equal(error.diagnostics?.innerAcp?.localTimeout?.kind, 'idle');
    assert.equal(error.diagnostics?.innerAcp?.outgoingCancels?.at(-1)?.reason, 'idle_timeout');
    return true;
  });

  await assert.rejects(() => provider.invoke({
    profileName: 'generic-profile',
    profile: { model: 'generic-model', reasoningEffort: 'medium', contextWindow: 100_000 },
    role: 'investigator',
    prompt: 'Synthesize a read-only investigation from repository evidence. PROVIDER_CANCELLED_TEST',
    schemaKind: null,
    schema: null,
    cwd: root,
    sandboxMode: 'read-only',
    promptBlocks: [],
    mcpServers: [],
    additionalDirectories: [],
  }), (error) => {
    assert.equal(error.code, 'CANCELLED');
    assert.equal(error.retryable, true);
    assert.equal(error.diagnostics?.reason, 'PROVIDER_CANCELLED');
    assert.equal(error.diagnostics?.expected, false);
    assert.match(error.message, /stopReason=cancelled/i);
    assert.equal(error.diagnostics.innerAcp.outgoingCancelCount, 0);
    assert.deepEqual(error.diagnostics.innerAcp.configuredTiming, { idleTimeoutMs: 10_000, turnDeadlineMs: 10_000 });
    assert.equal(error.diagnostics.innerAcp.turnNumber, 1);
    return true;
  });
} finally {
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
console.log('generic-acp: passed');
