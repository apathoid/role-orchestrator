import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { startCliProcess } from '../../src/adapters/cli/owned-process.js';
import { createAcpProvider, createAuthorityGrant, createPermissionBroker } from '../../src/main/index.js';
import { setup, final } from '../fixtures/application.js';
import { createCatalog } from '../../src/application/configuration/catalog.js';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { request } from '../fixtures/core.js';
import { decodeDecision } from '../../src/core/contracts.js';
import { providerContract } from '../fixtures/provider-contract.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 12_000 };
const profile = { providerId: 'acp', profileId: 'primary', model: 'fixture' };
const script = fileURLToPath(new URL('../fixtures/acp-contract-agent.js', import.meta.url));

function provider(cwd, scenario, { nativeSettings, mcpBridge, controllerIntent, ...options } = {}) {
  return createAcpProvider({ providerId: 'acp', defaultCwd: cwd,
    configuration: { adapter: 'acp', launch: { command: process.execPath, args: [script, scenario ?? 'basic'] }, nativeSettings, mcpBridge, controllerIntent },
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


test('ACP SDK intentional close preserves the exact reason through the subprocess stdout boundary', linux, () =>
  withOwnedRun('C12R10R-F0-close-identity', async cwd => {
    const owner = startCliProcess({
      command: process.execPath, args: [script, 'basic'], options: { cwd, env: process.env, shell: false },
    }, { timeoutMs: 5_000, signal: new AbortController().signal, onOutput() {} });
    const pipes = owner.pipes;
    assert.ok(pipes);
    const connection = client().connect(ndJsonStream(Writable.toWeb(pipes.stdin), Readable.toWeb(pipes.stdout)));
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const reason = new Error('ACP connection closed');
      const observed = Promise.withResolvers();
      pipes.stdout.once('error', observed.resolve);
      connection.close(reason);
      const result = await owner.finished;
      assert.equal(await Promise.race([observed.promise, Promise.resolve(undefined)]), reason);
      // No close reason is registered with this generic process owner: it must
      // still classify this error as I/O failure, even with the SDK's usual text.
      assert.equal(result.errors.stdout, 'IO_ERROR');
      assert.equal(result.reason, 'io_failed');
    } finally {
      connection.close();
      await owner.close();
    }
  }));

async function invoke(endpoint, overrides = {}, activity) {
  const signal = new AbortController().signal;
  const input = { attemptId: 'attempt-test', operationId: 'operation', actionId: 'action', kind: 'delegate',
    profile, objective: 'success', instructions: [], context: [], userConstraints: [], authorityRef: 'grant',
    timeoutMs: 5_000, signal, ...overrides };
  const handle = await endpoint.open(input.profile, signal);
  const observations = [];
  const completion = endpoint.invoke(handle, input, item => { observations.push(item); return item.ref; }, activity);
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
    if (scenario === 'disconnect') {
      assert.ok(call.observations.some(item => item.value === 'progress attempt-test'));
      const process = call.observations.find(item => item.ref === 'acp-process');
      assert.equal(process.value.teardown, undefined);
      assert.equal(process.value.exitCode, 3);
      assert.equal(process.kind, 'agent_exit');
    }
  }));
}

test('ACP selects the exact model and closes the negotiated native session', linux, () =>
  withOwnedRun('C08-model', async cwd => {
    const endpoint = provider(cwd, 'selected-model');
    await using rejected = await invoke(endpoint, { profile: { ...profile, model: 'missing' } });
    assert.equal((await rejected.completion).outcome.diagnostics[0].code, 'CAPABILITY_UNAVAILABLE');
    await using call = await invoke(endpoint, { profile: { ...profile, model: 'other' } });
    assert.equal((await call.completion).output, 'other');
    const fact = call.observations.find(item => item.ref === 'acp-process').value;
    assert.equal(fact.teardown, 'after_exchange');
    assert.equal(fact.errors.stdout, undefined);
    assert.equal(fact.reason, 'cancelled');
    assert.equal(fact.exitCode, null);
    assert.equal(fact.signal, 'SIGKILL');
    assert.equal(fact.cancelRequested, false);
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
      assert.equal(result.outcome.diagnostics[0].code, scenario==='oversize'?'RESOURCE_LIMIT':'PROTOCOL_ERROR');
      assert.equal(result.output, undefined);
      assert.ok(call.observations.some(item => item.kind === 'model' && item.completeness === 'truncated'));
      if(scenario==='oversize'){
        const history=call.observations.find(item=>item.value?.reason==='accumulated_output_limit');
        const fact=call.observations.find(item=>item.value?.reason==='current_result_limit');
        assert.equal(history.kind,'host_transport');
        assert.equal(fact.kind,'host_transport');
        assert.equal(result.outcome.diagnostics[0].ref,fact.ref);
        assert.equal(call.observations.find(o=>o.ref==='acp-stop').value.resultTruncated,true);
      }
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
    const fact = call.observations.find(item => item.ref === 'acp-process').value;
    assert.equal(fact.teardown, 'after_exchange');
    assert.equal(fact.errors.stdout, undefined);
    assert.equal(fact.cancelRequested, true);
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
    const fact = call.observations.find(item => item.ref === 'acp-process').value;
    assert.equal(fact.signal, 'SIGKILL');
    assert.equal(fact.exitCode, null);
    assert.equal(fact.teardown, 'cancellation_deadline');
    assert.equal(fact.reason, 'cancelled');
    assert.equal(fact.cancelRequested, true);
    assert.equal(fact.errors.stdout, undefined);
  }));

test('ACP records cancellation initiated by the agent', linux, () =>
  withOwnedRun('C08-agent-cancel', async cwd => {
    await using call = await invoke(provider(cwd, 'provider-cancel'));
    assert.equal((await call.completion).outcome.terminal, 'cancelled');
    assert.ok(call.observations.some(item => item.value?.stopReason === 'cancelled' && item.value.cancelRequested === false));
    const fact = call.observations.find(item => item.ref === 'acp-process').value;
    assert.equal(fact.teardown, 'after_exchange');
    assert.equal(fact.cancelRequested, false);
    assert.equal(fact.errors.stdout, undefined);
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

test('ACP Controller accepts anonymous Decision chunks after a tool call in one attempt', linux, () =>
  withOwnedRun('C08-anonymous-controller', async cwd => {
    const { api } = setup({ provider: provider(cwd, 'anonymous-controller'), profile, maxInvocations: 2 });
    const state = await (await api.submit(request({ workspaceContext: { cwd } }))).completion;
    assert.equal(state.status, 'finished');
    assert.equal(state.assessment.answer, 'ACP Controller response');
    assert.equal(state.attempts.length, 1);
  }));

test('ACP confirms the requested model after a mode changes the model and selector', linux, () =>
  withOwnedRun('C08-mode-reroutes', async cwd => {
    const settings = { nativeSettings: { mode: 'review' } };
    const prompted = join(cwd, 'prompt-model');
    await using refused = await invoke(provider(cwd, 'mode-model-unavailable', settings));
    const failure = await refused.completion;
    assert.equal(failure.dispatchCertainty, 'not_sent');
    assert.equal(failure.outcome.diagnostics[0].code, 'CAPABILITY_UNAVAILABLE');
    await assert.rejects(access(prompted), { code: 'ENOENT' });

    await using restored = await invoke(provider(cwd, 'mode-reroutes', settings));
    assert.equal((await restored.completion).outcome.terminal, 'completed');
    assert.equal(await readFile(prompted, 'utf8'), profile.model);
  }));

test('ACP delivers the proposed action to the trusted permission consumer', linux, () =>
  withOwnedRun('C08-permission-description', async cwd => {
    const delivered = [];
    let sequence = 0;
    const authority = createAuthorityGrant({ reference: 'grant', origin: 'user', profileIds: [profile.profileId] });
    const broker = createPermissionBroker({ authority, ids: { newId: () => 'permission-' + ++sequence },
      onRequest(request) {
        delivered.push(request);
        broker.respond({ requestId: request.requestId, attemptId: request.attemptId,
          providerRequestId: request.providerRequestId, optionId: 'deny' });
      },
    });
    const signal = new AbortController().signal;
    const permissions = broker.bind({ attemptId: 'attempt-test', authorityRef: 'grant', profileId: profile.profileId, signal });
    try {
      await using call = await invoke(provider(cwd, 'permission-description'), { permissions });
      assert.equal((await call.completion).output, 'permissions answered');
      assert.equal(delivered.length, 2);
      for (const entry of delivered) {
        assert.equal(entry.attemptId, 'attempt-test');
        assert.equal(entry.action.source, 'provider_reported');
        assert.equal(entry.action.title, 'Write project configuration');
        assert.equal(entry.action.kind, 'edit');
        assert.deepEqual(entry.action.locations.map(location => location.path), ['/project/config.json']);
        assert.ok(Object.isFrozen(entry.action.locations[0]));
        assert.deepEqual(JSON.parse(entry.action.details), {
          rawInput: { text: 'enabled' },
          content: [{ type: 'diff', path: '/project/config.json', oldText: 'disabled', newText: 'enabled' }],
        });
        assert.ok(Object.isFrozen(entry.action));
      }
    } finally {
      permissions.close();
    }
  }));

test('ACP startup failure links to bounded stderr and retains the process exit code', linux, () =>
  withOwnedRun('C08-stderr', async cwd => {
    await using call = await invoke(provider(cwd, 'init-stderr'));
    const result = await call.completion;
    const diagnostic = result.outcome.diagnostics[0];
    assert.equal(diagnostic.code, 'PROVIDER_START_FAILED');
    assert.equal(result.dispatchCertainty, 'not_sent');
    const stderr = call.observations.find(item => item.ref === diagnostic.ref);
    assert.equal(stderr.kind, 'provider_report');
    assert.equal(stderr.completeness, 'truncated');
    assert.ok(stderr.value.text.startsWith('Missing ACP fixture configuration'));
    assert.equal(Buffer.byteLength(stderr.value.text), 64 * 1024);
    assert.ok(stderr.value.receivedBytes > 64 * 1024);
    assert.ok(result.outcome.outputRefs.some(item => item.ref === diagnostic.ref));
    assert.ok(call.observations.some(item => item.kind === 'agent_exit' && item.exitCode === 9));
  }));

test('ACP startup failure links to the protocol error when stderr is empty', linux, () =>
  withOwnedRun('C08-rpc-error', async cwd => {
    await using call = await invoke(provider(cwd, 'init-rpc-error'));
    const result = await call.completion;
    const error = call.observations.find(item => item.ref === result.outcome.diagnostics[0].ref);
    assert.equal(error.kind, 'provider_report');
    assert.deepEqual(error.value, { code: -32000, message: 'ACP fixture initialization rejected' });
  }));

test('ACP requires negotiated HTTP for retrieval and reports unavailable when optional', linux, () =>
  withOwnedRun('C09-acp-mcp-unavailable', async cwd => {
    const endpoint = provider(cwd, 'mcp-unsupported', { mcpBridge: true });
    assert.equal((await endpoint.describe()).capabilities['context.retrieval'].support, 'unknown');
    const contextAccess = { list() { assert.fail('unnegotiated retrieval'); } };
    await using blocked = await invoke(endpoint, { contextAccess, requiredCapabilities: ['context.retrieval'] });
    const refused = await blocked.completion;
    assert.equal(refused.dispatchCertainty, 'not_sent');
    assert.equal(refused.outcome.diagnostics[0].code, 'CAPABILITY_UNAVAILABLE');
    await using ordinary = await invoke(endpoint, { contextAccess });
    assert.equal((await ordinary.completion).outcome.terminal, 'completed');
  }));

test('C11R.8 ACP uses negotiated thought_level for an isolated session and confirms it', linux, () =>
  withOwnedRun('C11R-acp-reasoning', async cwd => {
    const endpoint=provider(cwd,'reasoning-supported');
    await using selected=await invoke(endpoint,{reasoning:{
      mode:'selectable',level:'high',nativeValue:'high-native',selectionSource:'model',
    }});
    const result=await selected.completion;
    assert.equal(result.outcome.terminal,'completed');
    assert.equal(result.output,'high-native');
    assert.ok(selected.observations.some(item => item.ref === 'acp-reasoning-ack' &&
      item.value.status === 'config_option_confirmed' && item.value.level === 'high'));
    assert.equal(await readFile(join(cwd,'prompt-effort'),'utf8'),'high-native');
    await using native=await invoke(endpoint,{reasoning:{mode:'native'}});
    assert.equal((await native.completion).output,'low-native');
  }));

for (const [scenario, reason] of [
  ['reasoning-no-option','high-native'],
  ['reasoning-supported','undisclosed-native'],
  ['reasoning-ignored','high-native'],
  ['reasoning-reroutes','high-native'],
]) {
  test('C11R.8 ACP refuses nonconfirmed effort for '+scenario, linux, () =>
    withOwnedRun('C11R-acp-'+scenario, async cwd => {
      await using call=await invoke(provider(cwd,scenario),{reasoning:{
        mode:'selectable',level:'high',nativeValue:reason,selectionSource:'model',
      }});
      const result=await call.completion;
      assert.equal(result.dispatchCertainty,'not_sent');
      assert.equal(result.outcome.effect,'none');
      assert.equal(result.outcome.diagnostics[0].code,'CAPABILITY_UNAVAILABLE');
      await assert.rejects(access(join(cwd,'prompt-effort')),{code:'ENOENT'});
    }));
}

test('C11R review P1: ACP refusal carries specific pre-prompt reasoning cause', linux, () =>
  withOwnedRun('C11R-review-acp-refusal', async cwd => {
    const endpoint=provider(cwd,'reasoning-no-option');
    await using call=await invoke(endpoint,{reasoning:{
      mode:'selectable',level:'high',nativeValue:'high-native',selectionSource:'model',
    }});
    const result=await call.completion;
    assert.equal(result.outcome.diagnostics[0].code,'CAPABILITY_UNAVAILABLE');
    assert.equal(result.reasoningUnavailable,'session_option_unavailable');
    assert.equal(result.dispatchCertainty,'not_sent');
    assert.equal(result.outcome.effect,'none');
    await assert.rejects(access(join(cwd,'prompt-effort')),{code:'ENOENT'});
  }));

test('C12R.6.0 selected structured skill material crosses the actual ACP prompt boundary', linux, () =>
  withOwnedRun('C12R-acp-skills', async cwd => {
    await using call = await invoke(provider(cwd,'skill-delivery'), {
      skillInstructions:[{id:'checks',version:'v1',status:'complete',instructions:'Selected ACP skill'},
        {id:'partial',version:'v2',status:'truncated',instructions:'Partial'},
        {id:'missing',status:'unavailable',reason:'loader_unavailable'}],
    });
    const result = await call.completion;
    assert.equal(result.outcome.terminal,'completed');
    assert.equal(result.output,'skills delivered');
  }));

test('C12R.9 review P1: ACP Worker final message reaches Controller once without losing original refs', linux, () =>
  withOwnedRun('C12R9-acp-result', async cwd => {
    const endpoint = provider(cwd, 'basic');
    let turns = 0;
    let delivered;
    const fakeController = {
      async open() { return { sessionId: 'synthetic-controller' }; },
      async close() {},
      async invoke(session, invocation) {
        turns++;
        if (turns === 1) return {
          dispatchCertainty: 'sent',
          outcome: { schemaVersion: 1, attemptId: invocation.attemptId, terminal: 'completed', effect: 'none',
            diagnostics: [], outputRefs: [], usage: {inputTokens:null,outputTokens:null,cost:null} },
          output: {schemaVersion:1,decisionId:'start',operationId:invocation.operationId,
            contextCursor:invocation.context[1].value.contextCursor,additions:[{
              actionId:'worker',kind:'delegate',profileId:'acp-worker',objective:'produce native output',
              expectedResult:'report',dependsOn:[],contextRefs:[],
            }],cancellations:[],waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:'worker'}]}}};
        delivered=invocation.context.filter(item => typeof item.value === 'string' &&
          item.value.startsWith('result '));
        return {
          dispatchCertainty:'sent',
          outcome:{schemaVersion:1,attemptId:invocation.attemptId,terminal:'completed',effect:'none',
            diagnostics:[],outputRefs:[],usage:{inputTokens:null,outputTokens:null,cost:null}},
          output:{schemaVersion:1,decisionId:'complete',operationId:invocation.operationId,
            contextCursor:invocation.context[1].value.contextCursor,additions:[],cancellations:[],
            finalAssessment:{author:invocation.profile.profileId,overall:'complete',requirements:[],
              observationRefs:[],findingRefs:[],unresolvedQuestions:[],answer:'Completed'}},
        };
      },
    };
    const controller = {profileId:'primary',providerId:'synthetic-controller',model:'fixture'};
    const worker = {profileId:'acp-worker',providerId:'acp',model:'fixture'};
    const {api} = setup({profile:controller,provider:fakeController,
      authority:createAuthorityGrant({reference:'fixture-authority',origin:'user',
        profileIds:['primary','acp-worker']}),
      extraCatalog:[{kind:'profile',value:worker}],maxInvocations:4,
      providerFor: profile => profile.profileId === 'acp-worker' ? endpoint : fakeController});
    const result=await (await api.submit(request())).completion;
    assert.equal(result.status,'finished');
    assert.equal(turns,2);
    const workerAttempt=result.attempts.find(attempt=>attempt.actionId==='worker');
    assert.ok(workerAttempt,JSON.stringify(result.events.filter(event=>event.kind==='action.rejected'||event.kind==='action.deferred')));
    assert.equal(workerAttempt.outcome?.terminal,'completed',JSON.stringify(workerAttempt));
    assert.equal(delivered.length,1,JSON.stringify({workerAttempt,modelObservations:result.events.flatMap(event=>
      event.kind==='attempt.outcome'&&event.outcome.attemptId===workerAttempt.attemptId
        ? (event.observations??[]).map(item=>({ref:item.ref,source:item.source,completeness:item.completeness,
          value:typeof item.value==='string'?item.value.slice(0,100):undefined})):[])}));
    const receipts=result.events.filter(event=>event.kind==='attempt.outcome' &&
      result.attempts.find(a=>a.attemptId===event.outcome.attemptId)?.actionId==='worker');
    assert.equal(receipts.length,1);
    assert.equal(receipts[0].observations.filter(item => item.value?.startsWith?.('result ')).length,1);
    assert.ok(!receipts[0].observations.some(item=>item.ref.startsWith('attempt-output:')));
    assert.ok(receipts[0].outcome.outputRefs.some(ref=>ref.ref===delivered[0].ref));
  }));

test('C12R.10 actual ACP prompt delivers the current Decision contract', linux, () =>
  withOwnedRun('C12R10-controller-contract', async cwd => {
    const { api } = setup({provider:provider(cwd,'controller-contract'),profile});
    const state = await (await api.submit(request({workspaceContext:{cwd}}))).completion;
    assert.equal(state.status,'finished');
    assert.equal(state.assessment.answer,'# Result\nПроверка 🧪\n{"value":1}');
    assert.equal(state.attempts.length,2);
    assert.equal(state.events.find(e=>e.kind==='controller.invalid_proposal').reason.expected,'valid JSON');
  }));

for (const mode of ['a', 'b', 'invalid', 'progress-b', 'only', 'prior-id', 'prior-anonymous', 'prior-empty']) {
  test('C12R.10R.5 ACP Decision-shaped tool output vs final ' + mode, linux, () =>
    withOwnedRun('C12R10R-acp-' + mode, async cwd => {
      const endpoint = provider(cwd, 'decision-tool-' + mode);
      const observed = Promise.withResolvers();
      const workerCalls = [];
      let firstAttempt;
      let firstReply;
      const wrapped = { ...endpoint, invoke(session, invocation, observe) {
        if (invocation.kind === 'delegate') workerCalls.push(invocation.actionId);
        else firstAttempt ??= invocation.attemptId;
        return endpoint.invoke(session, invocation, item => {
          const ref = observe(item);
          if (item.kind === 'provider_tool' && item.sourceId === 'decision-shaped-tool' &&
              item.value?.status === 'completed') observed.resolve({ item, ref });
          return ref;
        }).then(reply => {
          if (invocation.attemptId === firstAttempt) firstReply = reply;
          return reply;
        });
      } };
      const { api } = setup({ provider: wrapped, profile, maxInvocations: 3 });
      try {
        const handle = await api.submit(request({ workspaceContext: { cwd } }));
        const { item, ref } = await Promise.race([observed.promise, handle.completion.then(() =>
          assert.fail('Controller finished before the tool observation gate'))]);
        assert.ok(ref);
        const a = JSON.parse(JSON.parse(item.value.json).content[0].content.text);
        assert.equal(decodeDecision(a).kind, 'accepted');
        assert.equal(a.additions[0].actionId, 'worker-a');
        const before = await api.inspect(handle.operation.operationId);
        assert.equal(before.status, 'active');
        assert.equal(before.attempts.length, 1);
        assert.equal(before.attempts[0].attemptId, firstAttempt);
        assert.equal(before.attempts[0].status, 'dispatched');
        assert.equal(before.events.some(e => e.kind === 'controller.responded'), false);
        assert.deepEqual(workerCalls, []);
        await writeFile(join(cwd, firstAttempt + '.release'), '');
        const state = await handle.completion;
        assert.equal(state.status, 'finished');
        assert.equal(state.assessment.answer, 'Transport complete');
        const expected = ['invalid', 'only', 'prior-anonymous', 'prior-empty'].includes(mode) ? [] :
          [mode === 'a' || mode === 'prior-id' ? 'worker-a' : 'worker-b'];
        assert.deepEqual(workerCalls, expected);
        assert.deepEqual(state.events.flatMap(e => e.kind === 'controller.responded'
          ? e.admissions.filter(x => x.kind === 'accepted').map(x => x.action.actionId) : []), expected);
        assert.deepEqual(state.events.filter(e => e.kind === 'attempt.reserved' && e.actionId !== e.attemptId)
          .map(e => e.actionId), expected);
        const workers = state.attempts.filter(x => x.actionId !== x.attemptId);
        assert.deepEqual(workers.map(x => x.actionId), expected);
        assert.deepEqual(state.events.filter(e => e.kind === 'attempt.dispatched' &&
          workers.some(w => w.attemptId === e.attemptId)).map(e => e.attemptId), workers.map(w => w.attemptId));
        const receipt = state.events.find(e => e.kind === 'attempt.outcome' && e.outcome.attemptId === firstAttempt);
        assert.equal(receipt.outcome.terminal, 'completed');
        assert.equal(receipt.dispatchCertainty, 'sent');
        const processFact = receipt.observations.find(o => o.providerRef === 'acp-process').value;
        assert.equal(processFact.teardown, 'after_exchange');
        assert.equal(processFact.errors.stdout, undefined);
        assert.notEqual(processFact.reason, 'io_failed');
        const tool = receipt.observations.find(o => o.provenance?.kind === 'provider_tool' &&
          o.provenance.sourceId === 'decision-shaped-tool' && o.value.status === 'completed');
        assert.equal(tool.ref, ref);
        assert.equal(tool.source, 'provider_reported');
        assert.deepEqual(JSON.parse(JSON.parse(tool.value.json).content[0].content.text), a);
        assert.ok(receipt.outcome.outputRefs.some(x => x.ref === tool.ref));
        const prior = receipt.observations.find(o => o.provenance?.kind === 'model' && o.value === JSON.stringify(a) && o.provenance.sourceId !== 'final');
        if (['progress-b', 'prior-id', 'prior-anonymous', 'prior-empty'].includes(mode)) {
          assert.ok(prior);
          assert.equal(prior.source, 'model_claim');
          assert.notEqual(prior.ref, tool.ref);
          assert.ok(receipt.outcome.outputRefs.some(x => x.ref === prior.ref));
          if (mode !== 'prior-anonymous') assert.equal(prior.provenance.sourceId, 'progress');
        }
        const final = receipt.observations.find(o => o.provenance?.kind === 'model' && o.provenance.sourceId === 'final');
        const selected = mode === 'prior-id' ? prior : final;
        if (selected) {
          assert.equal(selected.source, 'model_claim');
          assert.notEqual(selected.ref, tool.ref);
          assert.ok(receipt.outcome.outputRefs.some(x => x.ref === selected.ref));
          assert.equal(firstReply.outputObservationRef, selected.ref);
          assert.equal(firstReply.outputObservationParsed,true);
        }
        const invalid = state.events.filter(e => e.kind === 'controller.invalid_proposal');
        assert.equal(invalid.length, expected.length ? 0 : 1);
        if (!expected.length) {
          assert.equal(firstReply.output, mode === 'invalid' ? 'not JSON' : '');
          assert.equal(firstReply.decisionTextError, 'invalid_json');
          if (mode === 'invalid') {
            assert.equal(final.value, 'not JSON');
            assert.deepEqual(invalid[0].result,{ref:final.ref,representation:'reported_text'});
          }
          else {
            assert.equal(final, undefined);
            assert.equal(firstReply.outputObservationRef, undefined);
            assert.equal(firstReply.outputObservationParsed,undefined);
          }
          assert.equal(invalid[0].reason.expected, 'valid JSON');
          assert.equal(invalid[0].attemptId, firstAttempt);
        } else {
          const submitted = JSON.parse(selected.value);
          const admitted = state.events.find(e => e.kind === 'controller.responded');
          assert.equal(admitted.attemptId, firstAttempt);
          assert.equal(admitted.decision.decisionId, submitted.decisionId);
          assert.equal(submitted.additions[0].actionId, expected[0]);
          assert.equal(mode === 'a' || mode === 'prior-id', submitted.decisionId === a.decisionId);
          if (mode === 'progress-b') assert.notEqual(prior.ref, selected.ref);
          assert.equal(workers[0].outcome.terminal, 'completed');
          const result = state.events.find(e => e.kind === 'attempt.outcome' && e.outcome.attemptId === workers[0].attemptId);
          assert.ok(result.observations.some(o => o.source === 'model_claim' && o.value === 'Native Worker ' + expected[0]));
        }
      } finally {
        if (firstAttempt) await writeFile(join(cwd, firstAttempt + '.release'), '');
        await api.close();
      }
    }));
}

test('C12R.10R ACP native subagent observation does not need bridge support or a Host Worker', linux, () =>
  withOwnedRun('C12R10R-native-subagent', async cwd => {
    const endpoint = provider(cwd, 'native-subagent-report');
    assert.equal((await endpoint.describe()).capabilities['tools.bridge'].support, 'unsupported');
    const { api } = setup({ provider: endpoint, profile, maxInvocations: 1 });
    try {
      const state = await (await api.submit(request({workspaceContext:{cwd}}))).completion;
      assert.equal(state.status, 'finished');
      assert.equal(state.assessment.answer, 'Native subagent reported a result');
      assert.equal(state.attempts.length, 1);
      const receipt = state.events.find(e => e.kind === 'attempt.outcome');
      const tool = receipt.observations.find(o => o.provenance?.kind === 'provider_tool' &&
        o.provenance.sourceId === 'native-subagent' && o.value.status === 'completed');
      assert.equal(tool.source, 'provider_reported');
      assert.match(tool.value.json, /Native subagent reported a result/);
      assert.ok(receipt.outcome.outputRefs.some(ref => ref.ref === tool.ref));
      assert.ok(state.events.every(e => e.kind !== 'controller.responded' || e.admissions.length === 0));
    } finally { await api.close(); }
  }));

test('F1 actual ACP reasoning and process facts keep Host source across journal, ContextPort and reopen', linux, () =>
  withOwnedRun('C12R10R-F1-acp-provenance', async cwd => {
    const endpoint = provider(cwd, 'reasoning-supported');
    const controller = {profileId:'primary', providerId:'synthetic-controller', model:'fixture'};
    const catalog = createCatalog({schemaVersion:1, providers:{'synthetic-controller':{adapter:'fixture'}, acp:{adapter:'acp'}},
      features:{reasoningEffort:{workerEffort:{default:'high',options:[{id:'high',nativeValue:'high-native'}]}}},
      profiles:{primary:{provider:'synthetic-controller',model:'fixture'}, worker:{provider:'acp',model:'fixture',
        features:{reasoningEffort:'workerEffort'}}},controllerProfile:'primary'});
    await mkdir(join(cwd, 'state'));
    const store = createLocalStateStore(join(cwd, 'state'));
    await store.open();
    let turns = 0;
    const contextRefs = [];
    const fakeController = {
      async open() { return { sessionId: 'synthetic-controller' }; },
      async close() {},
      async invoke(_session, invocation) {
        if (++turns === 1) return final(invocation, {
          contextCursor: invocation.context[1].value.contextCursor, finalAssessment: undefined,
          additions: [{kind:'delegate',actionId:'worker',profileId:'worker',reasoningLevel:'high',
            objective:'Produce evidence',expectedResult:'Report',dependsOn:[],contextRefs:[]}],
          waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:'worker'}]},
        });
        const page = invocation.contextAccess.list();
        assert.equal(page.kind, 'available');
        for (const name of ['acp-reasoning-ack', 'acp-process']) {
          const entry = page.items.find(item => item.providerRef === name);
          assert.ok(entry, name);
          assert.equal(entry.source, 'host_observed');
          const detail = await invocation.contextAccess.fetch(entry.ref);
          assert.equal(detail.kind, 'available');
          assert.equal(detail.item.source, 'host_observed');
          assert.equal(detail.item.provenance.kind, 'host_transport');
          assert.equal(detail.item.provenance.exit, undefined);
          contextRefs.push(entry.ref);
        }
        return final(invocation, { contextCursor: invocation.context[1].value.contextCursor });
      },
    };
    const {api} = setup({profile:controller, provider:fakeController, catalog, store, maxInvocations:4,
      authority:createAuthorityGrant({reference:'fixture-authority',origin:'user',profileIds:['primary','worker']}),
      providerFor: selected => selected.profileId === 'worker' ? endpoint : fakeController});
    try {
      const state = await (await api.submit(request({workspaceContext:{cwd}}))).completion;
      assert.equal(state.status, 'finished');
      assert.equal(turns, 2);
      const attempt = state.attempts.find(item => item.actionId === 'worker');
      assert.equal(attempt.outcome.terminal, 'completed');
      const receipt = state.events.find(event => event.kind === 'attempt.outcome' && event.outcome.attemptId === attempt.attemptId);
      for (const ref of contextRefs) {
        const fact = receipt.observations.find(item => item.ref === ref);
        assert.equal(fact.source, 'host_observed');
        assert.equal(receipt.outcome.outputRefs.find(item => item.ref === ref).source, fact.source);
        assert.equal(receipt.outcome.outputRefs.find(item => item.ref === ref).kind, 'output');
      }
      assert.equal(contextRefs.length, 2);
      const process = receipt.observations.find(item => item.providerRef === 'acp-process');
      assert.equal(process.value.signal, 'SIGKILL');
      await store.close();
      await store.open();
      const reopened = await store.load(state.operationId);
      const durable = reopened.events.find(event => event.kind === 'attempt.outcome' && event.outcome.attemptId === attempt.attemptId);
      // Snapshot decoding may materialize absent optional fields as undefined.
      assert.deepEqual(JSON.parse(JSON.stringify(durable)), JSON.parse(JSON.stringify(receipt)));
    } finally {
      await api.close();
      await store.close();
    }
  }));

test('F2/C20 ACP owner deadline retains classification and partial native evidence', linux, () =>
  withOwnedRun('C12R10R-F2-timeout', async cwd => {
    const stop=new AbortController();
    await using call = await invoke(provider(cwd, 'ignore-cancel'), {objective:'hold', timeoutMs:null,signal:stop.signal});
    await ready(cwd, 'attempt-test.ready');
    stop.abort('deadline');
    const result = await call.completion;
    assert.equal(result.outcome.diagnostics[0].code, 'DEADLINE_EXCEEDED');
    assert.equal(result.outcome.terminal, 'unknown');
    assert.equal(result.dispatchCertainty, 'unknown');
    assert.ok(call.observations.some(item => item.value === 'progress attempt-test'));
    const fact = call.observations.find(item => item.ref === 'acp-process').value;
    assert.equal(fact.reason, 'cancelled');
    assert.equal(fact.cancelRequested, true);
    assert.equal(fact.signal, 'SIGKILL');
    assert.equal(fact.exitCode, null);
  }));


test('C13 ACP native activity is delivered before terminal without changing result or observations', linux, () =>
  withOwnedRun('C13-acp-activity', async cwd => {
    const endpoint = provider(cwd, 'native-activity');
    const observed = [], ready = Promise.withResolvers();
    await using live = await invoke(endpoint, {}, event => {
      observed.push(event);
      if (observed.length === 4) ready.resolve();
      if (event.kind === 'tool') { event.payload.status = 'corrupt'; throw Error('consumer'); }
    });
    await Promise.race([ready.promise, live.completion.then(() => assert.fail('activity was not live'))]);
    assert.deepEqual(observed.map(x => [x.kind, x.nativeKind, x.nativeId]), [
      ['reasoning', 'agent_thought_chunk', undefined], ['plan', 'plan', undefined],
      ['tool', 'tool_call', 'shared'], ['tool', 'tool_call_update', 'shared'],
    ]);
    await writeFile(join(cwd, 'attempt-test.release'), '');
    const result = await live.completion;
    assert.equal(result.output, 'native result');
    assert.equal(observed.length, 4);
    await using baseline = await invoke(endpoint);
    const baselineResult = await baseline.completion;
    assert.deepEqual(result, baselineResult);
    assert.deepEqual(live.observations, baseline.observations);
  }));


test('C18.3 ACP native text fallback works without HTTP MCP negotiation', linux, () =>
  withOwnedRun('C18-acp-intent-text', async cwd => {
    const endpoint=provider(cwd,'c18-text',{mcpBridge:true,controllerIntent:'prefer_mcp'});
    const {api}=setup({provider:endpoint,profile,maxInvocations:1});
    try{
      const state=await (await api.submit(request({workspaceContext:{cwd}}))).completion;
      assert.equal(state.status,'finished');
      assert.equal(state.assessment.answer,'C18 text fallback');
      assert.equal(state.events.filter(x=>x.kind==='controller.responded').length,1);
      assert.equal(state.events.filter(x=>x.kind==='controller.invalid_proposal').length,0);
    }finally{await api.close();}
  }));

test('C18.4 ACP MCP tool finality, correction and continuing native tools in one real SDK turn', linux, () =>
  withOwnedRun('C18-acp-intent-mcp', async cwd => {
    const endpoint=provider(cwd,'c18-mcp',{mcpBridge:true,controllerIntent:'prefer_mcp'});
    const {api}=setup({provider:endpoint,profile,maxInvocations:1});
    try{
      const state=await (await api.submit(request({workspaceContext:{cwd}}))).completion;
      assert.equal(state.status,'finished',JSON.stringify(state.events.slice(-4)));
      assert.equal(state.assessment.answer,'new candidate');
      const responded=state.events.filter(x=>x.kind==='controller.responded');
      assert.equal(responded.length,1);
      assert.equal(state.attempts.length,1,'pending proposals must not dispatch Workers');
      assert.ok(!state.events.some(x=>x.kind==='action.admitted'));
      assert.equal(state.events.filter(x=>x.kind==='controller.invalid_proposal').length,0);
      const observations=state.events.flatMap(x=>x.observations??[]);
      assert.ok(observations.some(x=>x.value==='Ordinary native final text is not a JSON Decision'));
      assert.ok(observations.some(x=>x.value?.finalAssessment?.answer==='new candidate'));
    }finally{await api.close();}
  }));

test('C18N.8 actual ACP SDK accepted native observation is discoverable in-turn and durable under same canonical ref',linux,()=>
  withOwnedRun('C18N-acp-live',async cwd=>{
    const endpoint=provider(cwd,'c18n-live',{mcpBridge:true,controllerIntent:'prefer_mcp'});
    const {api}=setup({provider:endpoint,profile,maxInvocations:1});
    try{
      const state=await (await api.submit(request({workspaceContext:{cwd}}))).completion;
      assert.equal(state.status,'finished',JSON.stringify(state.events.slice(-4)));
      const answer='# Нативный результат\n\nПроверено: 🌍 `code`';
      assert.equal(state.assessment.answer,answer);
      assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,1);
      assert.equal(state.events.filter(e=>e.kind==='controller.invalid_proposal').length,0);
      assert.equal(state.attempts.length,1);
      const native=state.events.flatMap(e=>e.kind==='attempt.outcome'?e.observations??[]:[])
        .find(o=>o.provenance?.sourceId==='c18n-native-inspection'&&o.native?.status==='completed');
      assert.ok(native);
      assert.match(native.ref,/^evidence:[a-f0-9]{64}$/);
      assert.equal(native.providerRef?.startsWith('acp-update-'),true);
      assert.equal(native.provenance.kind,'provider_tool');
      assert.equal(native.native.eventKind,'tool_call_update');
      assert.equal(native.native.kind,'read');
      assert.deepEqual(native.native.inheritedFields,['kind']);
      assert.equal(state.assessment.requirements[0].observationRefs[0],native.ref);
      assert.ok(state.events.flatMap(e=>e.kind==='attempt.outcome'?e.observations??[]:[])
        .some(o=>o.provenance?.sourceId==='after-warning'),
        'native tools remain available after preflight warning');
    }finally{await api.close();}
  }));

// C18R.0 RED: capture of ordinary ACP updates is not a proof of MCP
// submission incompleteness. Preserve the independent truncation evidence.
for(const [scenario,valid] of [
  ['c18-overflow-valid',true],['c18-overflow-missing',false],
  ['c18-overflow-refusal',false],['c18-overflow-cancelled',false],
  ['c18-overflow-text',false],
]){
  test('C18R.1 ACP capture overflow and decision finality: '+scenario, {...linux,timeout:15000},()=> 
    withOwnedRun('C18R-'+scenario, async cwd=>{
      const endpoint=provider(cwd,scenario,{mcpBridge:true,controllerIntent:'prefer_mcp'});
      const {api}=setup({provider:endpoint,profile,maxInvocations:1});
      try {
        const state=await (await api.submit(request({workspaceContext:{cwd}}))).completion;
        const receipts=state.events.filter(e=>e.kind==='controller.responded');
        assert.equal(receipts.length,valid?1:0);
        if(valid){
          assert.equal(state.assessment.answer,'capture independent');
          assert.equal(state.status,'finished');
        }
        const observed=state.events.flatMap(e=>e.kind==='attempt.outcome'?e.observations??[]:[]);
        assert.ok(observed.some(o=>o.providerRef==='acp-output-limit'));
        assert.ok(observed.some(o=>o.value?.truncated===true&&o.value?.stopReason));
        assert.equal(observed.some(o=>o.value==='ordinary native final message'&&o.completeness==='complete'),
          ['c18-overflow-valid','c18-overflow-missing'].includes(scenario));
      }finally{await api.close();}
    }));
}

test('C18R.5 complete near-limit UTF-8 MCP Decision passes real ACP SDK and existing admission', {...linux,timeout:20000},() =>
  withOwnedRun('C18R-acp-large',async cwd=>{
    const endpoint=provider(cwd,'c18-large',{mcpBridge:true,controllerIntent:'prefer_mcp'});
    const {api}=setup({provider:endpoint,profile,maxInvocations:1});
    try{
      const state=await (await api.submit(request({workspaceContext:{cwd}}))).completion;
      assert.equal(state.status,'finished');
      assert.equal(state.assessment.answer,'界'.repeat(650_000));
      assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,1);
      const observations=state.events.flatMap(e=>e.kind==='attempt.outcome'?e.observations??[]:[]);
      assert.ok(observations.some(o=>o.value?.finalAssessment?.answer===state.assessment.answer));
    }finally{await api.close();}
  }));

for(const scenario of ['c20-silent-initialize','c20-silent-session-new']){
  test('C20 ACP cancellation during '+scenario+' with no execution timer', {...linux,timeout:5000},()=>
    withOwnedRun(scenario,async cwd=>{
      const stop=new AbortController();
      await using call=await invoke(provider(cwd,scenario),{timeoutMs:null,signal:stop.signal});
      await ready(cwd,'c20-setup.ready');
      stop.abort('user');
      const result=await call.completion;
      assert.equal(result.dispatchCertainty,'not_sent');
      assert.equal(result.outcome.diagnostics[0].code,'CANCELLED');
      assert.equal(result.outcome.effect,'none');
      const fact=call.observations.find(item=>item.ref==='acp-process').value;
      assert.equal(fact.cancelRequested,true);
      assert.equal(fact.signal,'SIGKILL');
    }));
}

for(const mode of ['intent-mcp','intent-text','legacy']){
  test('C20 no deadline: ACP late final after accumulated capture, '+mode,{...linux,timeout:15000},()=>
    withOwnedRun('C20-overflow-'+mode,async cwd=>{
      const endpoint=provider(cwd,'c20-overflow-'+mode,{mcpBridge:true,
        controllerIntent:mode==='legacy'?undefined:'prefer_mcp'});
      const {api}=setup({provider:endpoint,profile,maxInvocations:1,invocationTimeoutMs:null});
      try{
        const state=await(await api.submit(request({workspaceContext:{cwd}}))).completion;
        const observations=state.events.flatMap(e=>e.observations??[]);
        assert.ok(observations.some(o=>o.providerRef==='acp-output-limit'));
        assert.ok(observations.some(o=>o.value?.truncated===true&&o.value?.stopReason==='end_turn'));
        assert.equal(state.status,'finished');
        assert.equal(state.assessment.answer,'late final after capture');
        assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,1);
        const native=observations.find(o=>o.provenance?.sourceId==='native-last'&&o.completeness==='complete');
        assert.ok(native);
        assert.equal(native.source,'model_claim');
        assert.match(native.ref,/^evidence:[a-f0-9]{64}$/);
        assert.equal(mode==='intent-mcp'?native.value:JSON.parse(native.value).finalAssessment.answer,'late final after capture');
      }finally{await api.close();}
    }));
}
test('C20-R: ACP Worker late final survives history overflow',{...linux,timeout:15000},()=>
  withOwnedRun('C20-overflow-worker',async cwd=>{
    const endpoint=provider(cwd,'c20-overflow-worker');
    await using call=await invoke(endpoint,{timeoutMs:null});
    const result=await call.completion;
    assert.equal(result.outcome.terminal,'completed');
    assert.equal(result.output,'late final after capture');
    assert.ok(call.observations.some(o=>o.ref==='acp-output-limit'));
    const native=call.observations.find(o=>o.ref===result.outputObservationRef);
    assert.equal(native?.value,result.output);
    assert.equal(native?.completeness,'complete');
    assert.equal(native?.sourceId,'native-last');
  }));

const c20rAnswer='# Result\nПроверка 🧪\n{"value":"a\\b"}';
for(const mode of ['mid-message','new-id','anonymous','oversized','anonymous-too-large','anonymous-identity-limit']){
  test('C20-R native result identity and completeness: '+mode,{...linux,timeout:15000},()=>
    withOwnedRun('C20R-'+mode,async cwd=>{
      const endpoint=provider(cwd,'c20r-'+mode,{controllerIntent:'text'});
      const {api}=setup({provider:endpoint,profile,maxInvocations:1,invocationTimeoutMs:null});
      try{
        const state=await(await api.submit(request({workspaceContext:{cwd}}))).completion;
        const obs=state.events.flatMap(e=>e.observations??[]);
        const stop=obs.find(o=>o.providerRef==='acp-stop')?.value;
        assert.equal(stop?.historyTruncated,true);
        const valid=['mid-message','new-id','anonymous'].includes(mode);
        assert.equal(stop?.resultTruncated,!valid);
        assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,valid?1:0);
        if(valid){
          assert.equal(state.status,'finished');
          assert.equal(state.assessment.answer,c20rAnswer);
          const native=obs.find(o=>o.providerRef==='acp-current-result');
          assert.equal(native.completeness,'complete');
          assert.equal(native.source,'model_claim');
          assert.equal(JSON.parse(native.value).finalAssessment.answer,c20rAnswer);
          assert.equal(obs.filter(o=>o.providerRef==='acp-current-result').length,1);
        }else{
          assert.equal(state.attempts[0].outcome.diagnostics[0].code,'RESOURCE_LIMIT');
          assert.ok(obs.some(o=>o.providerRef===(mode==='anonymous-identity-limit'?'acp-result-boundary-limit':'acp-result-limit')));
          assert.ok(!obs.some(o=>o.providerRef==='acp-current-result'&&o.completeness==='complete'));
        }
      }finally{await api.close();}
    }));
}
for(const [mode,expected] of [['worker-anonymous','first second 🧪'],['split-surrogate','x'.repeat(100)+'🧪']]){
  test('C20-R Worker preserves native chunks: '+mode,linux,()=>withOwnedRun('C20R-'+mode,async cwd=>{
    await using call=await invoke(provider(cwd,'c20r-'+mode),{timeoutMs:null});
    const result=await call.completion;
    assert.equal(result.outcome.terminal,'completed');
    assert.equal(result.output,expected);
    const native=call.observations.find(o=>o.ref===result.outputObservationRef);
    assert.equal(native?.value,expected);
    assert.equal(native?.completeness,'complete');
    assert.equal(call.observations.find(o=>o.ref==='acp-stop').value.resultBytes,Buffer.byteLength(expected));
  }));
}
for(const mode of ['cancel','deadline','disconnect','refusal']){
  test('C20-R no admission after '+mode+' following history overflow',linux,()=>withOwnedRun('C20R-'+mode,async cwd=>{
    const stop=new AbortController();
    await using call=await invoke(provider(cwd,'c20r-'+mode,{controllerIntent:'text'}),{kind:'controller',timeoutMs:null,signal:stop.signal});
    if(mode==='cancel'||mode==='deadline'){
      await ready(cwd,'c20r-ready');
      stop.abort(mode==='deadline'?'deadline':'client');
    }
    const result=await call.completion;
    assert.notEqual(result.outcome.terminal,'completed');
    assert.equal(result.controllerDeclaration,undefined);
    assert.equal(result.outputObservationRef,undefined);
    assert.ok(call.observations.some(o=>o.ref==='acp-output-limit'));
    assert.ok(!call.observations.some(o=>o.ref==='acp-current-result'&&o.completeness==='complete'));
    assert.equal(result.outcome.diagnostics[0].code,({cancel:'CANCELLED',deadline:'DEADLINE_EXCEEDED',disconnect:'PROVIDER_DISCONNECTED',refusal:'PROVIDER_REFUSED'})[mode]);
  }));
}

test('C20-R rejected text after overflow references exact current native message and supports correction',linux,()=>
  withOwnedRun('C20R-correction',async cwd=>{
    const {api}=setup({provider:provider(cwd,'c20r-correction',{controllerIntent:'text'}),profile,maxInvocations:2,invocationTimeoutMs:null});
    try{
      const state=await(await api.submit(request({workspaceContext:{cwd}}))).completion;
      assert.equal(state.status,'finished');
      assert.equal(state.assessment.answer,c20rAnswer);
      const rejected=state.events.find(e=>e.kind==='controller.invalid_proposal');
      assert.ok(rejected);
      const receipt=state.events.find(e=>e.kind==='attempt.outcome'&&e.outcome.attemptId===rejected.attemptId);
      const original=receipt.observations.find(o=>o.providerRef==='acp-current-result');
      assert.equal(original.value,'not JSON after history overflow');
      assert.equal(original.completeness,'complete');
      assert.deepEqual(rejected.result,{ref:original.ref,representation:'reported_text'});
      assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,1);
    }finally{await api.close();}
  }));

test('C20-R actual Worker result survives Controller retrieval and durable reopen',linux,()=>
  withOwnedRun('C20R-worker-durable',async cwd=>{
    const endpoint=provider(cwd,'c20-overflow-worker');
    const controller={profileId:'primary',providerId:'synthetic-controller',model:'fixture'};
    const catalog=createCatalog({schemaVersion:1,providers:{'synthetic-controller':{adapter:'fixture'},acp:{adapter:'acp'}},
      profiles:{primary:{provider:'synthetic-controller',model:'fixture'},worker:{provider:'acp',model:'fixture'}},controllerProfile:'primary'});
    const store=createLocalStateStore(join(cwd,'state'));
    await mkdir(join(cwd,'state'));
    await store.open();
    let turns=0,selectedRef;
    const fakeController={
      async open(){return {sessionId:'controller'};},async close(){},
      async invoke(_session,invocation){
        const contextCursor=invocation.context[1].value.contextCursor;
        if(++turns===1)return final(invocation,{contextCursor,finalAssessment:undefined,
          additions:[{kind:'delegate',actionId:'worker',profileId:'worker',objective:'Produce evidence',
            expectedResult:'Report',dependsOn:[],contextRefs:[]}],
          waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:'worker'}]}});
        let cursor=0;
        do{
          const page=invocation.contextAccess.list(cursor);
          assert.equal(page.kind,'available');
          const entry=page.items.find(item=>item.providerRef==='acp-current-result');
          if(entry){
            const detail=await invocation.contextAccess.fetch(entry.ref);
            assert.equal(detail.kind,'available');
            assert.equal(detail.item.value,'late final after capture');
            assert.equal(detail.item.source,'model_claim');
            assert.equal(detail.item.completeness,'complete');
            selectedRef=entry.ref;
            break;
          }
          cursor=page.nextCursor;
        }while(cursor!==undefined);
        assert.ok(selectedRef);
        return final(invocation,{contextCursor});
      },
    };
    const {api}=setup({profile:controller,provider:fakeController,catalog,store,maxInvocations:4,
      invocationTimeoutMs:null,authority:createAuthorityGrant({reference:'fixture-authority',origin:'user',profileIds:['primary','worker']}),
      providerFor:selected=>selected.profileId==='worker'?endpoint:fakeController});
    let state;
    try{
      state=await(await api.submit(request({workspaceContext:{cwd}}))).completion;
      assert.equal(state.status,'finished');
      assert.equal(turns,2);
      const worker=state.attempts.find(a=>a.actionId==='worker');
      assert.equal(worker.outcome.terminal,'completed');
      const receipt=state.events.find(e=>e.kind==='attempt.outcome'&&e.outcome.attemptId===worker.attemptId);
      const original=receipt.observations.find(o=>o.ref===selectedRef);
      assert.equal(original.value,'late final after capture');
      assert.equal(original.provenance.sourceId,'native-last');
      assert.equal(receipt.observations.filter(o=>o.value===original.value).length,1);
      assert.ok(receipt.outcome.outputRefs.some(r=>r.ref===selectedRef&&r.source==='model_claim'));
    }finally{try{await api.close();}finally{await store.close();}}
    const reopened=createLocalStateStore(join(cwd,'state'));
    await reopened.open();
    try{
      const restored=await reopened.load(state.operationId);
      const find=operation=>operation.events.flatMap(e=>e.observations??[]).find(o=>o.ref===selectedRef);
      assert.deepEqual(JSON.parse(JSON.stringify(find(restored))),JSON.parse(JSON.stringify(find(state))));
    }finally{await reopened.close();}
  }));
