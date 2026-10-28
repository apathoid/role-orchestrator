import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAcpProvider } from '../src/providers/codex-acp.mjs';
import { normalizeProviderError } from '../src/providers/errors.mjs';

const cwd = await mkdtemp(join(tmpdir(), 'role-orchestrator-codex-cancellation-'));
const fake = fileURLToPath(new URL('./fake-codex-acp.mjs', import.meta.url));
const provider = new CodexAcpProvider('subscription', { idleTimeoutMs: 500, turnDeadlineMs: 2000 });
provider.resolveCommand = () => ({ command: process.execPath, args: [fake] });
const request = {
  profileName: 'strong', profile: { model: 'fake-model', reasoningEffort: 'high' },
  role: 'reviewerMedium', cwd, sandboxMode: 'read-only',
  prompt: 'PROVIDER_CANCELLED_TEST', schemaKind: null, schema: null,
};
try {
  await writeFile(join(cwd, 'greeting.txt'), 'hello\n');
  await assert.rejects(provider.invoke(request), (error) => {
    assert.equal(error.code, 'CANCELLED');
    assert.equal(error.diagnostics?.reason, 'PROVIDER_CANCELLED');
    assert.equal(error.diagnostics?.innerAcp?.configuredTiming?.idleTimeoutMs, 500);
    assert.equal(error.diagnostics?.innerAcp?.configuredTiming?.turnDeadlineMs, 2000);
    assert.equal(error.diagnostics?.innerAcp?.outgoingCancelCount, 0);
    assert.equal(error.diagnostics?.innerAcp?.turnNumber, 1);
    assert.equal(error.diagnostics?.innerAcp?.acpUpdateCount, 0);
    return true;
  });

  await assert.rejects(provider.invoke({
    ...request, prompt: 'IDLE_TIMEOUT_TEST',
    profile: { ...request.profile, idleTimeoutMs: 60, turnDeadlineMs: 2000 },
  }), (error) => {
    const normalized = normalizeProviderError(error, 'subscription');
    assert.equal(normalized.code, 'TIMEOUT');
    assert.equal(normalized.diagnostics?.source, 'orchestrator_timing');
    assert.equal(normalized.diagnostics?.innerAcp?.localTimeout?.kind, 'idle');
    assert.equal(normalized.diagnostics?.innerAcp?.outgoingCancelCount, 1);
    assert.equal(normalized.diagnostics?.innerAcp?.outgoingCancels?.[0]?.reason, 'idle_timeout');
    assert.ok(normalized.diagnostics?.innerAcp?.acpUpdateCount > 0);
    return true;
  });
} finally {
  await provider.close();
  await rm(cwd, { recursive: true, force: true });
}
console.log('codex-acp-cancellation: passed');
