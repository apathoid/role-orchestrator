import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAcpProvider } from '../../../../src/main/index.js';
import { setup } from '../../fixtures/application.js';
import { request } from '../../fixtures/core.js';
import { providerContract } from '../../fixtures/provider-contract.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 12_000 };
const profile = { providerId: 'acp', profileId: 'primary', model: 'fixture' };
const script = fileURLToPath(new URL('../../fixtures/acp-contract-agent.js', import.meta.url));

function provider(cwd, scenario, { nativeSettings, ...options } = {}) {
  return createAcpProvider({ providerId: 'acp', defaultCwd: cwd,
    configuration: { adapter: 'acp', launch: { command: process.execPath, args: [script, scenario ?? 'basic'] }, nativeSettings },
    ...options });
}

async function ready(cwd, file) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    try { await access(join(cwd, file)); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(10); }
  }
  assert.fail('fixture did not write ' + file);
}

providerContract('ACP ProviderPort', run => withOwnedRun('C08-contract', cwd => run({
  provider: provider(cwd), profile, workspaceContext: { cwd },
  ready: id => ready(cwd, id + '.ready'),
  release: id => writeFile(join(cwd, id + '.release'), ''),
  knownUsage: { inputTokens: null, outputTokens: null, cost: null },
})), linux);

async function invoke(endpoint, overrides = {}) {
  const signal = new AbortController().signal;
  const input = { attemptId: 'attempt-test', operationId: 'operation', actionId: 'action', kind: 'delegate',
    profile, objective: 'success', instructions: [], context: [], userConstraints: [], authorityRef: 'grant',
    timeoutMs: 5_000, signal, ...overrides };
  const handle = await endpoint.open(input.profile, signal);
  const observations = [];
  const completion = endpoint.invoke(handle, input, item => { observations.push(item); return item.ref; });
  return { handle, completion, observations, close: () => endpoint.close(handle), [Symbol.asyncDispose]: () => endpoint.close(handle) };
}

for (const [scenario, code, certainty] of [
  ['bad-version', 'PROTOCOL_ERROR', 'not_sent'],
  ['init-exit', 'PROVIDER_START_FAILED', 'not_sent'],
  ['disconnect', 'PROVIDER_DISCONNECTED', 'unknown'],
  ['ignore-model', 'CAPABILITY_UNAVAILABLE', 'not_sent'],
]) {
  test('ACP classifies ' + scenario, linux, () => withOwnedRun('C08-' + scenario, async cwd => {
    const endpoint = provider(cwd, scenario);
    const selected = scenario === 'ignore-model' ? { ...profile, model: 'other' } : profile;
    await using call = await invoke(endpoint, { profile: selected });
    const result = await call.completion;
    assert.equal(result.outcome.diagnostics[0]?.code, code);
    assert.equal(result.dispatchCertainty, certainty);
    assert.equal(result.outcome.effect, certainty === 'not_sent' ? 'none' : 'unknown');
    if (scenario === 'disconnect') assert.ok(call.observations.some(item => item.value === 'progress attempt-test'));
  }));
}

test('ACP selects the exact model and closes the negotiated native session', linux, () =>
  withOwnedRun('C08-model', async cwd => {
    const endpoint = provider(cwd, 'selected-model');
    await using rejected = await invoke(endpoint, { profile: { ...profile, model: 'missing' } });
    assert.equal((await rejected.completion).outcome.diagnostics[0].code, 'CAPABILITY_UNAVAILABLE');
    await using call = await invoke(endpoint, { profile: { ...profile, model: 'other' } });
    assert.equal((await call.completion).output, 'other');
    await access(join(cwd, 'closed'));
  }));

test('ACP ignores foreign and repeated tool updates and requires live image negotiation', linux, () =>
  withOwnedRun('C08-events', async cwd => {
    await using events = await invoke(provider(cwd, 'events'));
    assert.equal((await events.completion).output, 'result attempt-test');
    assert.equal(events.observations.filter(item => item.kind === 'provider_tool').length, 1);
    assert.ok(!events.observations.some(item => item.value === 'after terminal'));
    const options = { resolveAttachment: async () => ({ type: 'image', data: 'AA==', mimeType: 'image/png' }) };
    const input = { attachments: [{ ref: 'image', mediaType: 'image/png' }] };
    await using rejected = await invoke(provider(cwd, 'basic', options), input);
    assert.equal((await rejected.completion).outcome.diagnostics[0].code, 'CAPABILITY_UNAVAILABLE');
    await using image = await invoke(provider(cwd, 'image', options), input);
    assert.equal((await image.completion).output, 'image delivered');
  }));

test('ACP forwards tools only to an explicit bridge and passes attempt scope', linux, () =>
  withOwnedRun('C08-bridge', async cwd => {
    await using missing = await invoke(provider(cwd, 'bridge'));
    assert.equal((await missing.completion).output, '-32601');
    await using bridged = await invoke(provider(cwd, 'bridge', { bridge: {
      async 'fs/read_text_file'(params, scope) {
        assert.equal(params.path, '/test/file');
        assert.equal(scope.attemptId, 'attempt-test');
        assert.equal(scope.authorityRef, 'grant');
        return { content: 'external response' };
      },
    } }));
    assert.equal((await bridged.completion).output, 'external response');
  }));

test('ACP preserves permission choices and rejects unrecognized selections', linux, () =>
  withOwnedRun('C08-permissions', async cwd => {
    const requests = [];
    await using call = await invoke(provider(cwd, 'permission'), { permissions: {
      async request(input) {
        requests.push(input);
        return { kind: 'selected', option: ['deny', 'unknown', 'allow'][requests.length - 1] };
      },
    } });
    assert.deepEqual(JSON.parse((await call.completion).output), [
      { outcome: 'selected', optionId: 'deny' }, { outcome: 'cancelled' }, { outcome: 'selected', optionId: 'allow' },
    ]);
    assert.equal(new Set(requests.map(item => item.providerRequestId)).size, 3);
    assert.deepEqual(requests[0].options, [
      { id: 'allow', label: 'Allow always', kind: 'allow', scope: 'always' },
      { id: 'deny', label: 'Reject once', kind: 'deny', scope: 'once' },
    ]);
  }));

test('ACP cancels parallel permission requests and discards late approval', linux, () =>
  withOwnedRun('C08-permission-cancel', async cwd => {
    const endpoint = provider(cwd, 'pending-permission');
    const ready = Promise.withResolvers();
    const permission = Promise.withResolvers();
    let count = 0;
    await using call = await invoke(endpoint, { permissions: {
      request() { if (++count === 3) ready.resolve(); return permission.promise; },
    } });
    await Promise.race([ready.promise, call.completion.then(() => assert.fail('No pending permission requests'))]);
    await endpoint.cancel(call.handle, 'attempt-test');
    assert.equal((await call.completion).outcome.terminal, 'cancelled');
    permission.resolve({ kind: 'selected', option: 'allow' });
    await access(join(cwd, 'permissions-cancelled'));
  }));

test('ACP drives the existing Controller Decision path from streamed chunks', linux, () =>
  withOwnedRun('C08-controller', async cwd => {
    const { api } = setup({ provider: provider(cwd), profile });
    const state = await (await api.submit(request({ workspaceContext: { cwd } }))).completion;
    assert.equal(state.status, 'finished');
    assert.equal(state.assessment.answer, 'ACP Controller response');
    assert.equal(state.attempts.length, 1);
  }));

test('ACP bounds streamed text and rejects an unknown terminal', linux, () =>
  withOwnedRun('C08-output', async cwd => {
    for (const scenario of ['oversize', 'malformed']) {
      await using call = await invoke(provider(cwd, scenario));
      const result = await call.completion;
      assert.equal(result.outcome.diagnostics[0].code, 'PROTOCOL_ERROR');
      assert.equal(result.output, undefined);
      assert.ok(call.observations.some(item => item.kind === 'model' && item.completeness === 'truncated'));
    }
  }));

test('ACP retains late observations without accepting a decision after cancellation', linux, () =>
  withOwnedRun('C08-late', async cwd => {
    const endpoint = provider(cwd, 'late-terminal');
    await using call = await invoke(endpoint, { objective: 'hold' });
    await ready(cwd, 'attempt-test.ready');
    await endpoint.cancel(call.handle, 'attempt-test');
    const result = await call.completion;
    assert.equal(result.outcome.terminal, 'unknown');
    assert.equal(result.output, undefined);
    assert.ok(call.observations.some(item => item.value === 'late result'));
    assert.ok(call.observations.some(item => item.value?.stopReason === 'end_turn' && item.value.cancelRequested));
  }));

test('ACP cleans up its process when cancellation receives no terminal response', linux, () =>
  withOwnedRun('C08-unresponsive', async cwd => {
    const endpoint = provider(cwd, 'ignore-cancel');
    await using call = await invoke(endpoint, { objective: 'hold' });
    await ready(cwd, 'attempt-test.ready');
    await endpoint.cancel(call.handle, 'attempt-test');
    const result = await call.completion;
    assert.equal(result.outcome.diagnostics[0].code, 'CANCELLED');
    assert.equal(result.dispatchCertainty, 'unknown');
    assert.ok(call.observations.some(item => item.value === 'progress attempt-test'));
    assert.ok(call.observations.some(item => item.value?.signal === 'SIGKILL'));
  }));

test('ACP records cancellation initiated by the agent', linux, () =>
  withOwnedRun('C08-agent-cancel', async cwd => {
    await using call = await invoke(provider(cwd, 'provider-cancel'));
    assert.equal((await call.completion).outcome.terminal, 'cancelled');
    assert.ok(call.observations.some(item => item.value?.stopReason === 'cancelled' && item.value.cancelRequested === false));
  }));

test('ACP forwards cancellation to an outstanding client tool', linux, () =>
  withOwnedRun('C08-tool-cancel', async cwd => {
    const entered = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    const endpoint = provider(cwd, 'bridge-cancel', { bridge: {
      async 'fs/read_text_file'(_params, { signal }) {
        entered.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        stopped.resolve();
        return { content: 'late response' };
      },
    } });
    await using call = await invoke(endpoint);
    await Promise.race([entered.promise, call.completion.then(() => assert.fail('Tool was not requested'))]);
    await endpoint.cancel(call.handle, 'attempt-test');
    await stopped.promise;
    assert.equal((await call.completion).outcome.terminal, 'cancelled');
  }));

test('ACP detaches from a pending permission decision when the transport exits', linux, () =>
  withOwnedRun('C08-permission-disconnect', async cwd => {
    const pending = Promise.withResolvers();
    let count = 0;
    await using call = await invoke(provider(cwd, 'permission-disconnect'), { permissions: {
      request() {
        if (++count === 3) void writeFile(join(cwd, 'permissions-ready'), '');
        return pending.promise;
      },
    } });
    const result = await call.completion;
    assert.equal(result.dispatchCertainty, 'unknown');
    assert.equal(result.outcome.diagnostics[0].code, 'PROVIDER_DISCONNECTED');
    assert.equal(count, 3);
    pending.resolve({ kind: 'selected', option: 'allow' });
  }));

test('ACP applies the trusted native mode and refuses a mode absent from negotiation', linux, () =>
  withOwnedRun('C08-mode', async cwd => {
    const settings = { nativeSettings: { mode: 'review' } };
    await using configured = await invoke(provider(cwd, 'mode', settings));
    assert.equal((await configured.completion).output, 'review');
    await using unsupported = await invoke(provider(cwd, 'basic', settings));
    assert.equal((await unsupported.completion).outcome.diagnostics[0].code, 'CAPABILITY_UNAVAILABLE');
  }));

test('ACP delivers resource links and negotiated embedded resources', linux, () =>
  withOwnedRun('C08-resources', async cwd => {
    const options = { resolveAttachment: async ({ ref }) => ref === 'link' ?
      { type: 'resource_link', uri: 'file:///fixture', name: 'link' } :
      { type: 'resource', resource: { uri: 'file:///fixture', text: 'resource' } } };
    const input = { attachments: [{ ref: 'link', mediaType: 'text/plain' }, { ref: 'embed', mediaType: 'text/plain' }] };
    await using rejected = await invoke(provider(cwd, 'basic', options), input);
    assert.equal((await rejected.completion).outcome.diagnostics[0].code, 'CAPABILITY_UNAVAILABLE');
    await using supported = await invoke(provider(cwd, 'resource', options), input);
    assert.equal((await supported.completion).output, 'resource_link,resource');
  }));
