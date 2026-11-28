import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners, once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readDescriptor } from '../../src/hosts/local-control.js';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createOperation, applyEvent } from '../../src/core/operation.js';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { request as coreRequest, outcome as coreOutcome } from '../fixtures/core.js';
import { createAcpRelay } from '../../src/hosts/acp-relay.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const entry = fileURLToPath(new URL('../../src/main/cli.js', import.meta.url));
const a = methods.agent;
const c = methods.client;

async function fixture(cwd, overrides = {}) {
  const config = join(cwd, 'config.json');
  await writeFile(config, JSON.stringify({
    schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
    providers: { test: { adapter: 'host-fixture' } }, storage: { directory: 'state' },
    plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../fixtures/host-plugin.js', import.meta.url)) }],
    ...overrides,
  }));
  return config;
}

function launch(cwd, config, setup = app => app, flags = [], env = process.env) {
  const child = spawn(process.execPath, [entry, 'acp', '--config', config, ...flags], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  const progress = Promise.withResolvers();
  let wire = '';
  let stderr = '';
  child.stdout.on('data', bytes => { wire += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = once(child, 'close');
  const app = setup(client().onNotification(c.session.update, ({ params }) => {
    messages.push(params);
    if (params.update.sessionUpdate === 'agent_thought_chunk') progress.resolve(params);
  }));
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout),{maxMessageBytes:24*1024*1024}));
  return {
    agent: connection.agent, messages, progress: progress.promise, child,
    async close() {
      child.stdin.end();
      const [code] = await closed;
      assert.equal(code, 0, stderr);
      for (const line of wire.trim().split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    },
  };
}

const initialize = agent => agent.request(a.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
const prompt = (agent, sessionId, text, _meta) => agent.request(a.session.prompt, {
  sessionId, prompt: [{ type: 'text', text }], ...(_meta && { _meta }),
});

test('external ACP v1 serves separate non-Git sessions, progress, cancellation and reload', { timeout: 12_000 }, () =>
  withOwnedRun('C10-acp', async cwd => {
    const config = await fixture(cwd);
    const first = launch(cwd, config);
    let sessionId;
    try {
      await assert.rejects(first.agent.request(a.initialize, { protocolVersion: 99 }), /Unsupported ACP/);
      const initialized=await initialize(first.agent);
      assert.equal(initialized.agentCapabilities.loadSession, true);
      assert.deepEqual(initialized.agentCapabilities.promptCapabilities,{image:false,audio:false,embeddedContext:false});
      ({ sessionId } = await first.agent.request(a.session.new, { cwd, mcpServers: [] }));
      const second = await first.agent.request(a.session.new, { cwd, mcpServers: [] });
      assert.notEqual(sessionId, second.sessionId);
      const unsupported=await first.agent.request(a.session.new,{cwd,mcpServers:[]});
      assert.equal((await first.agent.request(a.session.prompt,{
        sessionId:unsupported.sessionId,prompt:[{type:'image',data:'AA==',mimeType:'image/png'}],
      })).stopReason,'refusal');
      assert.ok(first.messages.some(message=>message.sessionId===unsupported.sessionId&&message.update.content?.text?.includes('CAPABILITY_UNAVAILABLE')));
      assert.equal((await prompt(first.agent, sessionId, 'Привет')).stopReason, 'end_turn');
      assert.ok(first.messages.some(message => message.sessionId === sessionId && message.update.content?.text === 'Ответ: Привет'));
      assert.ok(!first.messages.some(message=>message.sessionId===sessionId&&message.update.sessionUpdate==='agent_thought_chunk'));
      const held = prompt(first.agent, second.sessionId, 'hold');
      await first.agent.notify(a.session.cancel, { sessionId: second.sessionId });
      assert.equal((await held).stopReason, 'cancelled');
    } finally { await first.close(); }
    const reopened = launch(cwd, config);
    try {
      await initialize(reopened.agent);
      await reopened.agent.request(a.session.load, { sessionId, cwd, mcpServers: [] });
      assert.deepEqual(reopened.messages.filter(message=>!message.update._meta?.roleOrchestratorSource).map(message => message.update.content?.text), ['Привет', 'Ответ: Привет']);
    } finally { await reopened.close(); }
  }));

test('external ACP correlates parallel permission replies and relays only advertised client tools', { timeout: 12_000 }, () =>
  withOwnedRun('C10-acp-relay', async cwd => {
    const config = await fixture(cwd, {
      providers: { test: { adapter: 'acp', launch: { command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/acp-contract-agent.js', import.meta.url)), 'host-relay'] } } },
      plugins: [],
    });
    const both = Promise.withResolvers();
    const seen = [];
    const reads = [];
    const host = launch(cwd, config, app => app
      .onRequest(c.session.requestPermission, async ({ params }) => {
        seen.push(params);
        if (seen.length === 2) both.resolve();
        await both.promise;
        return { outcome: { outcome: 'selected', optionId: params.sessionId === one ? 'allow' : 'deny' } };
      })
      .onRequest(c.fs.readTextFile, ({ params }) => {
        reads.push(params);
        return { content: 'client bytes' };
      }), ['--relay-client-tools']);
    let one;
    try {
      await host.agent.request(a.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true } } });
      ({ sessionId: one } = await host.agent.request(a.session.new, { cwd, mcpServers: [] }));
      const { sessionId: two } = await host.agent.request(a.session.new, { cwd, mcpServers: [] });
      await Promise.all([prompt(host.agent, one, 'one'), prompt(host.agent, two, 'two')]);
      assert.deepEqual(new Set(seen.map(request => request.sessionId)), new Set([one, two]));
      assert.notEqual(seen[0].toolCall.toolCallId, seen[1].toolCall.toolCallId);
      assert.deepEqual(reads.map(request => [request.sessionId, request.path]), [[one, '/example']]);
      const final = id => host.messages.filter(item => item.sessionId === id && item.update.sessionUpdate === 'agent_message_chunk').at(-1).update.content.text;
      assert.equal(final(one), 'allow:client bytes');
      assert.equal(final(two), 'deny');
    } finally { await host.close(); }
  }));

test('ACP disconnect drops delivery, preserves completion and deduplicates a lost acknowledgement', { timeout: 12_000 }, () =>
  withOwnedRun('C10-acp-disconnect', async cwd => {
    const config = await fixture(cwd, {
      providers: { test: { adapter: 'acp', launch: { command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/acp-contract-agent.js', import.meta.url)), 'host-relay'] } } },
      plugins: [],
    });
    const permission = Promise.withResolvers();
    const first = launch(cwd, config, app => app.onRequest(c.session.requestPermission, ({ params, signal }) => {
      permission.resolve(params);
      return new Promise(resolve => signal.addEventListener('abort', () =>
        resolve({ outcome: { outcome: 'cancelled' } }), { once: true }));
    }));
    await initialize(first.agent);
    const { sessionId } = await first.agent.request(a.session.new, { cwd, mcpServers: [] });
    const meta = { roleOrchestrator: { requestId: 'retry' } };
    const lost = prompt(first.agent, sessionId, 'disconnect test', meta);
    void lost.catch(() => {});
    assert.equal((await permission.promise).sessionId, sessionId);
    await first.close();

    let repeatedPermission = 0;
    const second = launch(cwd, config, app => app.onRequest(c.session.requestPermission, () => {
      repeatedPermission++;
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    }));
    try {
      await initialize(second.agent);
      await second.agent.request(a.session.load, { sessionId, cwd, mcpServers: [] });
      assert.equal((await prompt(second.agent, sessionId, 'disconnect test', meta)).stopReason, 'end_turn');
      assert.equal(repeatedPermission, 0);
      assert.equal(second.messages.filter(message => message.update.sessionUpdate === 'agent_message_chunk').at(-1).update.content.text, 'cancelled');
      await assert.rejects(prompt(second.agent, sessionId, 'different prompt', meta), /Request id reused/);
    } finally { await second.close(); }
  }));

test('ACP continues in changed cwd and supersedes only the named operation', { timeout: 12_000 }, () =>
  withOwnedRun('C10-acp-supersede', async cwd => {
    const config = await fixture(cwd);
    const next = join(cwd, 'new-directory');
    await mkdir(next);
    const first = launch(cwd, config);
    await initialize(first.agent);
    const { sessionId } = await first.agent.request(a.session.new, { cwd, mcpServers: [] });
    await prompt(first.agent, sessionId, 'initial');
    await first.close();
    const second = launch(cwd, config);
    try {
      await initialize(second.agent);
      await second.agent.request(a.session.load, { sessionId, cwd: next, mcpServers: [] });
      await prompt(second.agent, sessionId, 'cwd');
      assert.equal(second.messages.at(-1).update.content.text, next);
      const hold = prompt(second.agent, sessionId, 'hold', { roleOrchestrator: { newOperation: true } });
      void hold.catch(() => {});
      const path = join(cwd, 'state', 'client-session-' + sessionId + '.json');
      let current;
      for (let attempt = 0; attempt < 100; attempt++) {
        const saved = JSON.parse(await readFile(path, 'utf8'));
        if (saved.operations.length === 2) { current = saved.operations[1]; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(current, (await readdir(join(cwd, 'state'))).join(','));
      await assert.rejects(prompt(second.agent, sessionId, 'no', {
        roleOrchestrator: { supersedeOperationId: 'wrong' },
      }), /active prompt/);
      const replacement = prompt(second.agent, sessionId, 'replacement', {
        roleOrchestrator: { supersedeOperationId: current },
      });
      assert.equal((await hold).stopReason, 'cancelled');
      assert.equal((await replacement).stopReason, 'end_turn');
      assert.equal(second.messages.at(-1).update.content.text, 'Ответ: replacement');
    } finally { await second.close(); }
  }));

test('API, CLI and ACP share direct, delegated, partial, permission and continuation behavior', { timeout: 20_000 }, () =>
  withOwnedRun('C10-surfaces', async (cwd, spawnSync) => {
    const { openOrchestrator } = await import('../../src/main/index.js');
    const config = await fixture(cwd);
    const api = await openOrchestrator({
      configuration: await readFile(config, 'utf8'), stateDirectory: join(cwd, 'api-state'),
      permissions: { handleRequest: async () => ({ kind: 'selected', option: 'deny' }) },
    });
    const create = (requestId, text) => ({
      schemaVersion: 1, configurationRef: api.configurationRef, requestId, text,
      workspaceContext: { cwd }, attachments: [], userConstraints: [],
    });
    const cli = (...args) => {
      const result = spawnSync(process.execPath, [entry, ...args, '--config', config, '--format', 'json'], { cwd, input: '' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const cases = [['direct', 'Ответ: direct'], ['delegate', 'Delegated result'], ['partial', 'Ответ: partial']];
    try {
      for (const [input, answer] of cases) {
        const result = await (await api.submit(create(input, input))).completion;
        assert.equal(result.assessment.answer, answer);
        assert.equal(result.assessment.overall, input === 'partial' ? 'partial' : 'complete');
        if (input === 'delegate') assert.ok(result.attempts.some(attempt => attempt.actionId === 'delegated'));
        const fromCli = cli('run', input);
        assert.deepEqual(fromCli.assessment, result.assessment);
      }
      const waiting = await (await api.submit(create('clarify', 'clarify'))).completion;
      assert.equal(waiting.waiting.question, 'What scope?');
      const continued = await (await api.resume(waiting.operationId, { requestId: 'answer', text: 'scope',
        questionId: waiting.waiting.questionId })).completion;
      assert.equal(continued.assessment.answer, 'Ответ: scope');
      assert.equal(continued.attempts.length, 2);
      assert.equal((await (await api.resume(waiting.operationId)).completion).revision, continued.revision);
      const cliWaiting = cli('run', 'clarify');
      assert.equal(cliWaiting.waiting.question, waiting.waiting.question);
      const cliContinued = cli('resume', cliWaiting.operationId, '--question', cliWaiting.waiting.questionId, 'scope');
      assert.deepEqual(cliContinued.assessment, continued.assessment);
      assert.equal(cli('resume', cliWaiting.operationId).revision, cliContinued.revision);
      assert.equal(cli('run', 'permission').assessment.answer, 'unavailable');
      assert.equal((await (await api.submit(create('permission', 'permission'))).completion).assessment.answer, 'deny');
      const requested = Promise.withResolvers();
      const unsubscribe = api.subscribe(event => {
        if (event.eventName === 'controller.requested') requested.resolve();
      });
      const held = await api.submit(create('held', 'hold'));
      await requested.promise;
      await api.cancel(held.operation.operationId);
      assert.equal((await held.completion).status, 'cancelled');
      unsubscribe();
    } finally { await api.close(); }

    const host = launch(cwd, config, app => app.onRequest(c.session.requestPermission, () =>
      ({ outcome: { outcome: 'selected', optionId: 'deny' } })));
    try {
      await initialize(host.agent);
      const { sessionId } = await host.agent.request(a.session.new, { cwd, mcpServers: [] });
      for (const [input, answer] of [...cases, ['permission', 'deny'], ['clarify', 'What scope?']]) {
        await prompt(host.agent, sessionId, input, { roleOrchestrator: { newOperation: true } });
        assert.equal(host.messages.at(-1).update.content.text, answer);
      }
      await prompt(host.agent, sessionId, 'scope');
      assert.equal(host.messages.at(-1).update.content.text, 'Ответ: scope');
    } finally { await host.close(); }
  }));

test('external ACP keeps a background worker permission and client read after clarification', { timeout: 12_000 }, () =>
  withOwnedRun('C10-acp-background-relay', async cwd => {
    const config = await fixture(cwd, {
      profiles: { primary: { provider: 'test', model: 'fixture' }, relay: { provider: 'nested', model: 'fixture' } },
      providers: {
        test: { adapter: 'host-fixture' },
        nested: { adapter: 'acp', launch: { command: process.execPath,
          args: [fileURLToPath(new URL('../fixtures/acp-contract-agent.js', import.meta.url)), 'host-relay'] } },
      },
      resources: { invocationTimeoutMs: 4000 },
    });
    const permissions = [];
    const reads = [];
    const host = launch(cwd, config, app => app
      .onRequest(c.session.requestPermission, ({ params }) => {
        permissions.push(params.sessionId);
        return { outcome: { outcome: 'selected', optionId: 'allow' } };
      })
      .onRequest(c.fs.readTextFile, ({ params }) => {
        reads.push(params.sessionId);
        return { content: 'late client bytes' };
      }), ['--relay-client-tools']);
    try {
      await host.agent.request(a.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true } } });
      const { sessionId } = await host.agent.request(a.session.new, { cwd, mcpServers: [] });
      assert.equal((await prompt(host.agent, sessionId, 'relay-clarify')).stopReason, 'end_turn');
      assert.equal(host.messages.at(-1).update.content.text, 'While the worker runs?');
      assert.deepEqual(permissions, []);
      await writeFile(join(cwd, 'relay-go'), '');
      let result;
      for (let i = 0; i < 200 && result === undefined; i++) {
        result = await readFile(join(cwd, 'relay-result'), 'utf8').catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        // The fixture publishes via writeFile; existence may precede the first
        // bytes under full-suite load. An empty in-flight read is not completion.
        if(result==='')result=undefined;
        if (result === undefined) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(result, 'allow:late client bytes');
      assert.deepEqual(permissions, [sessionId]);
      assert.deepEqual(reads, [sessionId]);
    } finally { await host.close(); }
  }));

test('external ACP resolves project profile and resources in the session cwd on each operation', { timeout: 12_000 }, () =>
  withOwnedRun('C10-acp-project', async cwd => {
    const config = await fixture(cwd, {
      profiles: Object.fromEntries(['primary', 'a', 'b'].map(id => [id, { provider: 'test', model: 'fixture' }])),
    });
    const workspaces = await Promise.all(['a', 'b'].map(async (id, index) => {
      const project = join(cwd, id);
      await mkdir(project);
      await writeFile(join(project, '.role-orchestrator.json'), JSON.stringify({
        schemaVersion: 1, controllerProfile: id, resources: { invocationTimeoutMs: 3000 + index, maxInvocationsPerOperation: 3 - index },
      }));
      return project;
    }));
    const host = launch(cwd, config);
    try {
      await initialize(host.agent);
      const sessions = [];
      for (const [index, project] of workspaces.entries()) {
        const { sessionId } = await host.agent.request(a.session.new, { cwd: project, mcpServers: [] });
        sessions.push(sessionId);
        await prompt(host.agent, sessionId, 'settings');
        assert.deepEqual(JSON.parse(host.messages.at(-1).update.content.text), [index === 0 ? 'a' : 'b', 3000 + index]);
      }
      const directory = join(cwd, 'state');
      const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}.*\.json$/u.test(name));
      const limits = await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), 'utf8')).limits.maxInvocations));
      assert.deepEqual(limits.sort(), [2, 3]);
      await host.agent.request(a.session.load, { sessionId: sessions[0], cwd: workspaces[1], mcpServers: [] });
      await prompt(host.agent, sessions[0], 'settings');
      assert.deepEqual(JSON.parse(host.messages.at(-1).update.content.text), ['b', 3001]);
    } finally { await host.close(); }
  }));

test('CLI can inspect and cancel live ACP work while new prompts stay with ACP',
  { timeout: 12_000, skip: process.env.C10_SOCKET_UNAVAILABLE === '1' }, () =>
    withOwnedRun('C10-acp-local-control', async (cwd, spawnSync) => {
      const config = await fixture(cwd);
      const host = launch(cwd, config);
      try {
        await initialize(host.agent);
        const { sessionId } = await host.agent.request(a.session.new, { cwd, mcpServers: [] });
        const held = prompt(host.agent, sessionId, 'hold');
        void held.catch(() => {});
        assert.equal((await host.progress).update.content.text,'Fixture native hold');
        const state = join(cwd, 'state');
        const file = (await readdir(state)).find(name => /^[a-f0-9]{64}.*\.json$/u.test(name));
        const { operationId } = JSON.parse(await readFile(join(state, file), 'utf8'));
        const cli = (...args) => spawnSync(process.execPath, [entry, ...args, '--config', config, '--format', 'json'], { cwd });
        const inspected = cli('inspect', operationId);
        assert.equal(inspected.status, 0, inspected.stderr);
        assert.equal(JSON.parse(inspected.stdout).status, 'active');
        assert.match(cli('run', 'new').stderr, /CONTROL_ACP_SESSION_REQUIRED/);
        const cancelled = cli('cancel', operationId);
        assert.equal(cancelled.status, 0, cancelled.stderr);
        assert.equal(JSON.parse(cancelled.stdout).status, 'cancelled');
        assert.equal((await held).stopReason, 'cancelled');
      } finally { await host.close(); }
    }));

test('explicit ACP terminal release detaches ownership and its abort listener', async () => {
  const stop = new AbortController();
  const lifecycle = new AbortController();
  const calls = [];
  const relay = createAcpRelay(() => ({
    sessionId: 'external', signal: stop.signal, capabilities: { terminal: true },
    client: { async request(method, params) {
      calls.push([method, params.sessionId]);
      return method === c.terminal.create ? { terminalId: 'terminal' } : {};
    } },
  }));
  const scope = { operationId: 'operation', attemptId: 'attempt', signal: stop.signal, lifecycleSignal: lifecycle.signal };
  await relay.bridge[c.terminal.create]({ sessionId: 'inner', command: 'fixture' }, scope);
  assert.equal(getEventListeners(lifecycle.signal, 'abort').length, 1);
  await relay.bridge[c.terminal.release]({ sessionId: 'inner', terminalId: 'terminal' }, scope);
  assert.equal(getEventListeners(lifecycle.signal, 'abort').length, 0);
  lifecycle.abort();
  assert.deepEqual(calls, [[c.terminal.create, 'external'], [c.terminal.release, 'external']]);
  await assert.rejects(relay.bridge[c.terminal.output]({ sessionId: 'inner', terminalId: 'terminal' }, scope), /Unknown terminal/);
});


test('C13 ACP extension routing is explicitly enabled, session scoped and preserves opaque payload', { timeout: 12_000 }, () =>
  withOwnedRun('C13-acp-extension', async cwd => {
    const config = await fixture(cwd, {
      providers: { test: { adapter: 'acp', launch: { command: process.execPath,
        args: [fileURLToPath(new URL('../fixtures/acp-contract-agent.js', import.meta.url)), 'host-extension'] } } }, plugins: [],
    });
    const capabilities = { fs: { readTextFile: true }, terminal: true, _meta: {
      roleOrchestratorExtensions: { requests: ['_ro/echo', '_ro/unknown', 'session/new'], notifications: ['_ro/notice'] },
      unrelated: { opaque: [1, false] },
    } };
    for (const enabled of [false, true]) {
      const notices = [], requests = [];
      const host = launch(cwd, config, app => app.onRequest('*', ({ method, params }) => {
        assert.equal(method, '_ro/echo');
        requests.push(params);
        return { answer: params.objective };
      }).onNotification('*', ({ method, params }) => {
        if (method === '_ro/notice') notices.push(params);
      }), enabled ? ['--relay-client-extension', '_ro/echo', '--relay-client-extension', '_ro/notice'] : []);
      try {
        await host.agent.request(a.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities });
        const { sessionId: one } = await host.agent.request(a.session.new, { cwd, mcpServers: [] });
        const { sessionId: two } = await host.agent.request(a.session.new, { cwd, mcpServers: [] });
        await Promise.all([prompt(host.agent, one, 'one'), prompt(host.agent, two, 'two')]);
        const answer = id => host.messages.filter(x => x.sessionId === id && x.update.sessionUpdate === 'agent_message_chunk').at(-1).update.content.text;
        assert.equal(answer(one), enabled ? 'one' : 'unavailable');
        assert.equal(answer(two), enabled ? 'two' : 'unavailable');
        assert.equal(requests.length, enabled ? 2 : 0);
        assert.equal(notices.length, enabled ? 2 : 0);
        if (enabled) {
          assert.deepEqual(new Set(requests.map(x => x.sessionId)), new Set([one, two]));
          for (const request of requests) {
            assert.deepEqual(request.nested, { sessionId: 'opaque', arbitrary: [1, null] });
            assert.deepEqual(notices.find(x => x.sessionId === request.sessionId), request);
          }
        }
      } finally { await host.close(); }
    }
  }));


test('C13 ACP native form interaction negotiates actual client capability and keeps replies session scoped', { timeout: 12_000 }, () =>
  withOwnedRun('C13-acp-form', async cwd => {
    const config = await fixture(cwd, { providers: { test: { adapter: 'acp', launch: { command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/acp-contract-agent.js', import.meta.url)), 'host-elicitation'] } } }, plugins: [] });
    for (const enabled of [false, true]) {
      const seen = [];
      const host = launch(cwd, config, app => app.onRequest(c.elicitation.create, ({ params }) => {
        seen.push(params);
        assert.equal(params.message, 'Which value?');
        assert.deepEqual(params.requestedSchema.required, ['value']);
        return { action: 'accept', content: { value: params.sessionId } };
      }));
      try {
        await host.agent.request(a.initialize, { protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: enabled ? { elicitation: { form: {}, url: {} } } : {} });
        const { sessionId: one } = await host.agent.request(a.session.new, { cwd, mcpServers: [] });
        const { sessionId: two } = await host.agent.request(a.session.new, { cwd, mcpServers: [] });
        await Promise.all([prompt(host.agent, one, 'one'), prompt(host.agent, two, 'two')]);
        const answer = id => host.messages.filter(x => x.sessionId === id && x.update.sessionUpdate === 'agent_message_chunk').at(-1).update.content.text;
        assert.equal(answer(one), enabled ? one : 'unavailable');
        assert.equal(answer(two), enabled ? two : 'unavailable');
        assert.equal(seen.length, enabled ? 2 : 0);
      } finally { await host.close(); }
    }
  }));

test('C14 standard ACP maps only actual native thinking, tools, Controller plan and final once', {timeout:20000}, () =>
  withOwnedRun('C14-acp-ux', async cwd => {
    const config = await fixture(cwd,{providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[
      fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url)), 'host-native-ux']}}},plugins:[]});
    const host=launch(cwd,config,app=>app,['--presentation','detailed']);
    try {
      await initialize(host.agent);
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      assert.equal((await prompt(host.agent,sessionId,'native UX')).stopReason,'end_turn');
      const updates=host.messages.filter(item=>item.sessionId===sessionId).map(item=>item.update);
      const thoughts=updates.filter(x=>x.sessionUpdate==='agent_thought_chunk');
      assert.ok(thoughts.length>=3);
      assert.ok(thoughts.every(x=>x.content.text.startsWith('Native thought ')));
      assert.ok(thoughts.every(x=>x.messageId==null&&x._meta.roleOrchestratorSource.operationId));
      assert.ok(new Set(thoughts.map(x=>x._meta.roleOrchestratorSource.attemptId)).size>=3);
      const calls=updates.filter(x=>x.sessionUpdate==='tool_call');
      const changed=updates.filter(x=>x.sessionUpdate==='tool_call_update');
      assert.ok(calls.length>=3);
      assert.equal(new Set(calls.map(x=>x.toolCallId)).size,calls.length);
      assert.deepEqual(new Set(changed.map(x=>x.toolCallId)),new Set(calls.map(x=>x.toolCallId)));
      const plans=updates.filter(x=>x.sessionUpdate==='plan');
      assert.ok(plans.length>=1);
      assert.ok(plans.every(x=>x.entries.every(e=>!e.content.includes('worker-'))));
      assert.deepEqual(updates.filter(x=>x.sessionUpdate==='agent_message_chunk'&&!x._meta?.roleOrchestratorSource).map(x=>x.content.text),['Native final once']);
    } finally {await host.close();}
  }));

test('C14R.2 background old operation requests during new prompt stay correlated and return to A', {timeout:15000},()=>withOwnedRun('C14R-old-new',async cwd=>{
  const config=await fixture(cwd,{profiles:{primary:{provider:'test',model:'fixture'},relay:{provider:'nested',model:'fixture'}},
    providers:{test:{adapter:'host-fixture'},nested:{adapter:'acp',launch:{command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url)),'host-relay-concurrent']}}},
    resources:{invocationTimeoutMs:8000}});
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),permissions=[],forms=[],extensions=[],notices=[],reads=[];
  const host=launch(cwd,config,app=>app.onRequest(c.session.requestPermission,async({params})=>{
    permissions.push(params);
    if(params.toolCall.title==='fixture:read'){entered.resolve();await release.promise;return {outcome:{outcome:'selected',optionId:'deny'}};}
    assert.equal(params.toolCall.title,'slow-relay');return {outcome:{outcome:'selected',optionId:'allow'}};
  }).onRequest(c.elicitation.create,({params})=>{forms.push(params);return {action:'accept',content:{value:'old-form'}};})
  .onRequest(c.fs.readTextFile,({params})=>{reads.push(params);return {content:'old-file'};})
  .onRequest('*',({method,params})=>{assert.equal(method,'_ro/echo');extensions.push(params);return {answer:'old-extension'};})
  .onNotification('*',({method,params})=>{if(method==='_ro/notice')notices.push(params);}),
  ['--relay-client-tools','--relay-client-extension','_ro/echo','--relay-client-extension','_ro/notice']);
  try{
    await host.agent.request(a.initialize,{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{fs:{readTextFile:true},elicitation:{form:{}},
      _meta:{roleOrchestratorExtensions:{requests:['_ro/echo'],notifications:['_ro/notice']}}}});
    const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
    await prompt(host.agent,sessionId,'relay-clarify');assert.equal(host.messages.at(-1).update.content.text,'While the worker runs?');
    const b=prompt(host.agent,sessionId,'permission',{roleOrchestrator:{newOperation:true}});
    await entered.promise;await writeFile(join(cwd,'relay-go'),'');
    let result;
    for(let i=0;i<400&&result===undefined;i++){
      result=await readFile(join(cwd,'relay-result'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;});
      if(result===undefined)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(result,'allow:old-file:old-form:old-extension');
    assert.equal(permissions.length,2);const [newer,older]=permissions.map(x=>x._meta.roleOrchestratorSource);
    assert.notEqual(newer.operationId,older.operationId);
    assert.equal(forms[0]._meta.roleOrchestratorSource.operationId,older.operationId);
    assert.equal(forms[0]._meta.roleOrchestratorSource.attemptId,older.attemptId);
    assert.equal(forms[0].toolCallId,permissions[1].toolCall.toolCallId);
    assert.deepEqual(extensions,notices);assert.equal(extensions[0].sessionId,sessionId);assert.equal(reads[0].sessionId,sessionId);
    assert.deepEqual(extensions[0].nested,{sessionId:'opaque'});
    release.resolve();await b;assert.equal(host.messages.at(-1).update.content.text,'deny');
    await prompt(host.agent,sessionId,'resume A',{roleOrchestrator:{continueOperationId:older.operationId}});
    assert.equal(host.messages.at(-1).update.content.text,'Ответ: resume A');
  }finally{release.resolve();await host.close();}
}));

test('C14R.6 negotiated standard notices show committed findings and lifecycle without history replay', {timeout:20000},()=>withOwnedRun('C14R-notices',async cwd=>{
  const config=await fixture(cwd);
  for(const enabled of [false,true]){
    const host=launch(cwd,config,app=>app,['--presentation','detailed','--progress-display','notices']);
    try{
      await host.agent.request(a.initialize,{protocolVersion:PROTOCOL_VERSION,clientCapabilities:enabled?{session:{notices:{}}}:{}});
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      await prompt(host.agent,sessionId,'notice-delegate');
      const updates=host.messages.map(x=>x.update);
      const notices=updates.filter(x=>x.sessionUpdate==='notice');
      assert.deepEqual(updates.filter(x=>x.sessionUpdate==='agent_message_chunk').map(x=>x.content.text),['Notice final']);
      if(enabled){
        assert.ok(notices.some(x=>x._meta.roleOrchestratorSource.eventName==='attempt.dispatched'));
        assert.ok(notices.some(x=>x._meta.roleOrchestratorSource.eventName==='attempt.outcome'));
        const finding=notices.find(x=>x._meta.roleOrchestratorSource.findingId==='notice-finding');
        assert.ok(finding);assert.match(finding.description,/Model-authored notice/);assert.match(finding.description,/fixture uncertainty/);
        assert.equal(finding._meta.roleOrchestratorSource.source,'recorded_finding');
        assert.ok(finding._meta.roleOrchestratorSource.operationId);
      }else assert.equal(notices.length,0);
      const before=host.messages.length;
      await host.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
      assert.ok(host.messages.slice(before).every(x=>x.update.sessionUpdate!=='notice'));
      const next=host.messages.length;
      await prompt(host.agent,sessionId,'another',{roleOrchestrator:{newOperation:true}});
      assert.ok(host.messages.slice(next).every(x=>x.update._meta?.roleOrchestratorSource?.findingId!=='notice-finding'));
      assert.equal(host.messages.at(-1).update.content.text,'Ответ: another');
    }finally{await host.close();}
  }
}));

test('C15.4 standard ACP inline default emits compact attributed facts, native final once and no notices', {timeout:20000},()=>withOwnedRun('C15-inline',async cwd=>{
  const config=await fixture(cwd);
  for(const enabled of [false,true]){
    const host=launch(cwd,config);
    try{
      await host.agent.request(a.initialize,{protocolVersion:PROTOCOL_VERSION,clientCapabilities:enabled?{session:{notices:{}}}:{}});
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      await prompt(host.agent,sessionId,'notice-delegate');
      const updates=host.messages.map(x=>x.update);
      const own=updates.filter(x=>x.sessionUpdate==='agent_message_chunk'&&x.messageId?.startsWith('ro:'));
      assert.ok(own.length>=2);
      assert.ok(own.every(x=>x.content.text.includes('RO ·')&&x._meta.roleOrchestratorSource.operationId));
      assert.equal(own.filter(x=>x._meta.roleOrchestratorSource.eventName==='operation.accepted').length,0);
      assert.ok(own.some(x=>x._meta.roleOrchestratorSource.eventName==='attempt.dispatched'));
      assert.ok(own.some(x=>x._meta.roleOrchestratorSource.findingId==='notice-finding'));
      assert.equal(new Set(own.map(x=>x.messageId)).size,own.length);
      assert.equal(updates.filter(x=>x.sessionUpdate==='notice').length,0);
      assert.equal(updates.at(-1).content.text,'Notice final');
      assert.equal(updates.filter(x=>x.content?.text==='Notice final').length,1);
    }finally{await host.close();}
  }
}));

test('C15.5 ACP history preserves A B A user order and exact historical retry after continuation', {timeout:20000},()=>withOwnedRun('C15-history',async cwd=>{
  const config=await fixture(cwd);
  const host=launch(cwd,config);
  let sessionId,operationA;
  try{
    await initialize(host.agent);
    ({sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]}));
    const first={roleOrchestrator:{requestId:'r1'}};
    await prompt(host.agent,sessionId,'clarify',first);
    operationA=host.messages.find(x=>x.update._meta?.roleOrchestratorSource?.eventName==='attempt.dispatched').update._meta.roleOrchestratorSource.operationId;
    assert.equal(host.messages.at(-1).update.content.text,'What scope?');
    await prompt(host.agent,sessionId,'B',{roleOrchestrator:{requestId:'b',newOperation:true}});
    await prompt(host.agent,sessionId,'scope',{roleOrchestrator:{requestId:'r2',continueOperationId:operationA}});
    assert.equal(host.messages.at(-1).update.content.text,'Ответ: scope');
    await prompt(host.agent,sessionId,'clarify',first);
    assert.equal(host.messages.at(-1).update.content.text,'What scope?');
  }finally{await host.close();}
  const reopened=launch(cwd,config);
  try{
    await initialize(reopened.agent);
    await reopened.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
    const plain=messages=>messages.filter(x=>!x.update._meta?.roleOrchestratorSource).map(x=>x.update.content?.text);
    assert.deepEqual(plain(reopened.messages),['clarify','What scope?','B','Ответ: B','scope','Ответ: scope']);
    const own=reopened.messages.filter(x=>x.update.messageId?.startsWith('ro:')).map(x=>x.update.messageId);
    assert.ok(own.length>3);
    const before=reopened.messages.length;
    await reopened.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
    assert.deepEqual(plain(reopened.messages.slice(before)),plain(reopened.messages.slice(0,before)));
    assert.deepEqual(reopened.messages.slice(before).filter(x=>x.update.messageId?.startsWith('ro:')).map(x=>x.update.messageId),own);
  }finally{await reopened.close();}
}));


test('C15R ACP native sparse updates remain unfiltered by CLI projection',{timeout:20000},()=>withOwnedRun('C15R-native-stream',async cwd=>{
  const config=await fixture(cwd,{providers:{test:{adapter:'acp',launch:{command:process.execPath,
    args:[fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url)),'c15r-transcript']}}},plugins:[]});
  const host=launch(cwd,config);
  try{
    await initialize(host.agent);const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
    await prompt(host.agent,sessionId,'transcript');
    const updates=host.messages.map(m=>m.update);
    const tools=updates.filter(u=>u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update');
    assert.equal(tools.length,6);
    assert.equal(tools[0].toolCallId,tools[3].toolCallId);
    assert.equal(tools[1].title,'git show HEAD');assert.equal(tools[2].title,'git show HEAD');
    assert.equal(tools[3].title??undefined,undefined);
    assert.equal(tools[3].status,'completed');assert.equal(tools[5].status,'failed');
    assert.deepEqual(updates.filter(u=>u.sessionUpdate==='agent_thought_chunk').map(u=>u.content.text),['Inspect',' the commit.\nRead the diff.','Version only.']);
    assert.equal(updates.filter(u=>u.content?.text==='Version updated.').length,1);
    assert.ok(updates.some(u=>u.messageId?.startsWith('ro:')));
    assert.equal(updates.filter(u=>u.sessionUpdate==='notice').length,0);
  }finally{await host.close();}
}));

test('C15R SDK session.load preserves actual reducer report classifications and stable IDs',{timeout:20000},()=>withOwnedRun('C15R-history-sdk',async cwd=>{
  const config=await fixture(cwd),directory=join(cwd,'state');
  const sessionId='12345678-1234-1234-1234-123456789abc',operationId='history-op';
  let state=createOperation(operationId,coreRequest({requestId:'acp:'+sessionId+':r'}),'authority',{maxInvocations:3,maxConcurrentInvocations:2},0);
  const store=createLocalStateStore(directory),diagnostics=[];
  await mkdir(directory);await store.open();
  try{
    assert.equal((await store.commit(operationId,null,state)).kind,'committed');
    async function commit(eventId,kind,fields){
      const transition=applyEvent(state,{eventId,kind,operationId,receivedAt:state.revision+1,...fields});
      assert.equal(transition.kind,'applied',eventId);
      assert.equal((await store.commit(operationId,state.revision,transition.state)).kind,'committed');
      state=transition.state;diagnostics.push(transition.diagnostic);
    }
    for(const attemptId of ['a','b']){
      await commit('reserve-'+attemptId,'attempt.reserved',{attemptId,actionId:attemptId});
      await commit('dispatch-'+attemptId,'attempt.dispatched',{attemptId,route:{profileId:'primary',providerId:'test',model:'fixture',configurationRef:'test-config'}});
    }
    await commit('ordinary','attempt.outcome',{outcome:coreOutcome('a'),dispatchCertainty:'sent'});
    await commit('cancel','operation.cancelled',{source:'client'});
    await commit('late','attempt.outcome',{outcome:coreOutcome('b',{terminal:'unknown',effect:'unknown'}),dispatchCertainty:'unknown'});
    await commit('enrich','attempt.outcome',{outcome:coreOutcome('b',{terminal:'completed',effect:'confirmed'}),dispatchCertainty:'sent',late:true});
    await commit('conflict','attempt.outcome',{outcome:coreOutcome('b',{terminal:'failed',effect:'none'}),dispatchCertainty:'sent',late:true});
  }finally{await store.close();}
  await writeFile(join(directory,'client-session-'+sessionId+'.json'),JSON.stringify({sessionId,cwd,operations:[operationId],
    requests:[{requestId:'r',fingerprint:'fixture',operationId,responseEventId:'cancel',progressDisplay:'inline'}]}));
  const host=launch(cwd,config,app=>app,['--presentation','detailed']);
  try{
    await initialize(host.agent);
    const load=()=>host.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
    await load();const first=host.messages.map(x=>x.update);
    for(const eventId of ['ordinary','late','enrich','conflict']){
      const actual=diagnostics.find(d=>d.eventId===eventId);
      const update=first.find(u=>u._meta?.roleOrchestratorSource?.eventId===eventId);
      assert.equal(update._meta.roleOrchestratorSource.eventName,actual.eventName);
      assert.equal(update._meta.roleOrchestratorSource.reasonCode,actual.reasonCode);
      assert.equal(update._meta.roleOrchestratorSource.recovered,true);
      assert.ok(update.messageId.startsWith('ro:'));
    }
    assert.match(first.find(u=>u._meta?.roleOrchestratorSource?.eventId==='conflict').content.text,/Outcome discrepancy/);
    const before=host.messages.length;await load();
    assert.deepEqual(host.messages.slice(before).map(x=>x.update),first);
  }finally{await host.close();}
}));


test('C15R.6 external ACP SDK retains native form and permission schema without CLI rewriting',{timeout:20000},()=>
 withOwnedRun('C15R6-acp-native',async cwd=>{
  const config=await fixture(cwd,{providers:{test:{adapter:'acp',launch:{command:process.execPath,
    args:[fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url)),'c15r6-interaction']}}},plugins:[]});
  const forms=[],permissions=[];
  const host=launch(cwd,config,app=>app
    .onRequest(c.session.requestPermission,({params})=>{permissions.push(params);
      return {outcome:{outcome:'selected',optionId:'deny'}};})
    .onRequest(c.elicitation.create,({params})=>{forms.push(params);
      return {action:'accept',content:{choice:'stop'}};}));
  try{
    await host.agent.request(a.initialize,{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{elicitation:{form:{}}}});
    const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
    await prompt(host.agent,sessionId,'native');
    assert.equal(permissions.length,1);assert.equal(permissions[0].options[1].optionId,'option 1');
    assert.equal(forms.length,1);
    assert.equal(forms[0].requestedSchema.properties.choice.oneOf[1].const,'stop');
    assert.equal(forms[0].requestedSchema.properties.note.title,'Optional context');
    assert.deepEqual(forms[0].requestedSchema.required,['choice']);
    const updates=host.messages.map(x=>x.update);
    assert.ok(updates.filter(u=>u.sessionUpdate==='agent_thought_chunk').length>=30);
    assert.equal(updates.filter(u=>u.sessionUpdate==='tool_call_update').length,2);
    const final=updates.filter(u=>u.sessionUpdate==='agent_message_chunk'&&
      !u._meta?.roleOrchestratorSource&&u.content?.text?.startsWith('### Native answer'));
    assert.equal(final.length,1);assert.match(final[0].content.text,/Choice: stop/);
  }finally{await host.close();}
}));

test('A116/A120 standard ACP SDK delivers real Controller plan in every mode without Worker plans or history synthesis',
  {timeout:30000},()=>withOwnedRun('C15R-GUI-native-plan',async cwd=>{
  const config=await fixture(cwd,{providers:{test:{adapter:'acp',launch:{command:process.execPath,
    args:[fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url)),'host-native-ux']}}},plugins:[]});
  for(const mode of ['compact','detailed','debug']){
    const host=launch(cwd,config,app=>app,['--presentation',mode]);
    try{
      await initialize(host.agent);
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      assert.equal((await prompt(host.agent,sessionId,'native plan')).stopReason,'end_turn');
      const updates=host.messages.map(x=>x.update);
      const plans=updates.filter(x=>x.sessionUpdate==='plan');
      assert.ok(plans.length>=1,mode);
      assert.ok(plans.every(x=>x.entries.length===1&&x.entries[0].content.startsWith('Native plan ')),mode);
      assert.ok(plans.every(x=>x._meta.roleOrchestratorSource.invocationKind==='controller'),mode);
      assert.ok(plans.every(x=>!x.entries.some(row=>row.content.includes('worker-'))),mode);
      assert.equal(updates.filter(x=>x.sessionUpdate==='agent_message_chunk'&&!x._meta?.roleOrchestratorSource).map(x=>x.content.text).join(''),'Native final once');
      assert.ok(updates.filter(x=>x.sessionUpdate==='agent_thought_chunk').length>=3,mode);
      assert.ok(updates.filter(x=>x.sessionUpdate==='tool_call').length>=3,mode);
      const before=host.messages.length;
      await host.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
      const replay=host.messages.slice(before).map(x=>x.update);
      assert.equal(replay.filter(x=>x.sessionUpdate==='plan').length,0,mode);
      assert.equal(replay.filter(x=>x.sessionUpdate==='agent_thought_chunk').length,0,mode);
      assert.equal(replay.filter(x=>x.sessionUpdate==='tool_call').length,0,mode);
      assert.equal(replay.filter(x=>x.sessionUpdate==='agent_message_chunk'&&!x._meta?.roleOrchestratorSource).map(x=>x.content.text).join(''),'Native final once');
    }finally{await host.close();}
  }
}));

test('A118/A121 client SDK receives original Markdown answer after RO-owned progress and repeated load',
  {timeout:12000},()=>withOwnedRun('C15R-GUI-markdown',async cwd=>{
  const config=await fixture(cwd);
  const input='### markdown\\n**bold** \`code\` [link](https://example.test) 🌍';
  const expected='Ответ: '+input;
  const host=launch(cwd,config);
  let sessionId;
  try{
    await initialize(host.agent);
    ({sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]}));
    assert.equal((await prompt(host.agent,sessionId,input)).stopReason,'end_turn');
    const plain=host.messages.filter(x=>x.update.sessionUpdate==='agent_message_chunk'&&!x.update._meta?.roleOrchestratorSource);
    assert.deepEqual(plain.map(x=>x.update.content.text),[expected]);
    assert.ok(host.messages.some(x=>x.update.messageId?.startsWith('ro:')));
    const before=host.messages.length;
    await host.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
    const replay=host.messages.slice(before).map(x=>x.update);
    assert.deepEqual(replay.filter(x=>x.sessionUpdate==='agent_message_chunk'&&!x._meta?.roleOrchestratorSource).map(x=>x.content.text),[expected]);
    assert.deepEqual(replay.filter(x=>x.sessionUpdate==='user_message_chunk').map(x=>x.content.text),[input]);
  }finally{await host.close();}
}));

test('R2 real ACP SDK compact omits accepted/assessment decoration and keeps native Controller/Workers',
  {timeout:30000},()=>withOwnedRun('C15R-GUI-R2-native-compact',async cwd=>{
  const config=await fixture(cwd,{providers:{test:{adapter:'acp',launch:{command:process.execPath,
    args:[fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url)),'host-native-ux']}}},plugins:[]});
  for(const mode of ['compact','detailed','debug']){
    const host=launch(cwd,config,app=>app,['--presentation',mode]);
    try{
      await initialize(host.agent);
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      const reply=await prompt(host.agent,sessionId,'Check sources');
      assert.equal(reply.stopReason,'end_turn');
      const updates=host.messages.map(x=>x.update);
      const owned=updates.filter(x=>x._meta?.roleOrchestratorSource?.eventName);
      const names=owned.map(x=>x._meta.roleOrchestratorSource.eventName);
      assert.equal(names.includes('operation.accepted'),mode!=='compact',mode);
      assert.equal(names.includes('operation.finished'),mode!=='compact',mode);
      assert.ok(names.includes('attempt.dispatched'),mode);
      assert.equal(updates.filter(x=>x.sessionUpdate==='plan').length>=1,true,mode);
      assert.ok(updates.some(x=>x.sessionUpdate==='agent_thought_chunk'),mode);
      assert.ok(updates.some(x=>x.sessionUpdate==='tool_call_update'),mode);
      assert.deepEqual(updates.filter(x=>x.sessionUpdate==='agent_message_chunk'&&!x._meta?.roleOrchestratorSource)
        .map(x=>x.content.text),['Native final once']);
      if(mode==='compact'){
        const dispatch=owned.filter(x=>x._meta.roleOrchestratorSource.eventName==='attempt.dispatched');
        assert.ok(dispatch.length>=3);
        assert.ok(dispatch.some(x=>x.content.text.includes('Controller · primary — started')));
        assert.ok(dispatch.some(x=>x._meta.roleOrchestratorSource.invocationKind==='delegate'&&
          x._meta.roleOrchestratorSource.profileId==='primary'));
        assert.ok(dispatch.every(x=>!x.content.text.includes('Attempt outcome reported')));
        assert.ok(dispatch.every(x=>!x.content.text.includes('Dispatched ·')));
      }
      const before=host.messages.length;
      await host.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
      const replay=host.messages.slice(before).map(x=>x.update);
      const recovered=replay.filter(x=>x._meta?.roleOrchestratorSource?.eventName);
      assert.equal(recovered.some(x=>x._meta.roleOrchestratorSource.eventName==='operation.accepted'),
        mode!=='compact',mode);
      assert.equal(recovered.some(x=>x._meta.roleOrchestratorSource.eventName==='operation.finished'),
        mode!=='compact',mode);
      assert.equal(replay.filter(x=>x.sessionUpdate==='plan'||x.sessionUpdate==='agent_thought_chunk'||
        x.sessionUpdate==='tool_call').length,0,mode);
      assert.deepEqual(replay.filter(x=>x.sessionUpdate==='agent_message_chunk'&&!x._meta?.roleOrchestratorSource)
        .map(x=>x.content.text).filter(x=>x==='Native final once'),['Native final once'],mode);
    }finally{await host.close();}
  }
}));

test('R2 ACP notices use same compact visibility with negotiated capability and no Markdown transformations',
  {timeout:20000},()=>withOwnedRun('C15R-GUI-R2-notices',async cwd=>{
  const config=await fixture(cwd);
  for(const enabled of [true,false]){
    const host=launch(cwd,config,app=>app,['--presentation','compact','--progress-display','notices']);
    try{
      await host.agent.request(a.initialize,{protocolVersion:PROTOCOL_VERSION,
        clientCapabilities:enabled?{session:{notices:{}}}:{}});
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      await prompt(host.agent,sessionId,'notice-delegate');
      const notices=host.messages.map(x=>x.update).filter(x=>x.sessionUpdate==='notice');
      assert.equal(notices.length>0,enabled);
      assert.ok(notices.every(x=>x._meta?.roleOrchestratorSource?.eventName!=='operation.accepted'));
      assert.ok(notices.every(x=>x._meta?.roleOrchestratorSource?.eventName!=='operation.finished'));
      if(enabled){
        assert.ok(notices.some(x=>x._meta.roleOrchestratorSource.findingId==='notice-finding'));
        assert.ok(notices.some(x=>x._meta.roleOrchestratorSource.eventName==='attempt.dispatched'));
      }
      assert.equal(host.messages.filter(x=>x.update.content?.text==='Notice final').length,1);
    }finally{await host.close();}
  }
}));

test('R2F live ACP SDK preserves non-complete assessments and original model answers across load',
  {timeout:30000},()=>withOwnedRun('C15R-GUI-R2F-partial-live',async cwd=>{
  const config=await fixture(cwd);
  for(const display of ['inline','notices']){
    const host=launch(cwd,config,app=>app,['--presentation','compact','--progress-display',display]);
    try{
      await host.agent.request(a.initialize,{protocolVersion:PROTOCOL_VERSION,
        clientCapabilities:display==='notices'?{session:{notices:{}}}:{}});
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      const cases=[
        {input:'ordinary',status:'complete',answer:'Ответ: ordinary'},
        {input:'partial-markdown',status:'partial',answer:'### Partial answer\n**original** [link](https://example.test) 🌍'},
        {input:'unresolved',status:'unresolved',answer:'Ответ: unresolved'},
      ];
      for(const item of cases){
        const before=host.messages.length;
        assert.equal((await prompt(host.agent,sessionId,item.input,{roleOrchestrator:{newOperation:true}})).stopReason,'end_turn');
        const updates=host.messages.slice(before).map(msg=>msg.update);
        const originals=updates.filter(update=>update.sessionUpdate==='agent_message_chunk'&&!update._meta?.roleOrchestratorSource);
        assert.deepEqual(originals.map(update=>update.content.text),[item.answer]);
        const progress=updates.filter(update=>update._meta?.roleOrchestratorSource?.eventName==='operation.finished');
        assert.equal(progress.length,item.status==='complete'?0:1,display+' '+item.status);
        if(progress.length){
          const text=progress[0].sessionUpdate==='notice'?progress[0].title:progress[0].content.text;
          assert.match(text,new RegExp('Model assessment recorded.*overall='+item.status));
          assert.equal(progress[0]._meta.roleOrchestratorSource.source,display==='notices'?'execution':'journal');
        }
      }
      const before=host.messages.length;
      await host.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
      const history=host.messages.slice(before).map(message=>message.update);
      assert.deepEqual(history.filter(update=>update.sessionUpdate==='agent_message_chunk'&&!update._meta?.roleOrchestratorSource)
        .map(update=>update.content.text),cases.map(item=>item.answer));
      if(display==='inline'){
        const status=history.filter(update=>update._meta?.roleOrchestratorSource?.eventName==='operation.finished');
        assert.deepEqual(status.map(update=>update.content.text.match(/overall=(partial|unresolved)/)?.[1]),
          ['partial','unresolved']);
        assert.ok(status.every(update=>update._meta.roleOrchestratorSource.recovered===true));
      }else assert.equal(history.some(update=>update.sessionUpdate==='notice'),false);
      const next=host.messages.length;
      await host.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
      assert.deepEqual(host.messages.slice(next).map(msg=>msg.update),history);
    }finally{await host.close();}
  }
}));

test('C17R external ACP never forwards private configured Controller capture',{timeout:12000},()=>withOwnedRun('C17R-acp-private',async cwd=>{
  const config=await fixture(cwd,{
    providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url)),'controller-contract']}}},
    plugins:[],diagnostics:{captureBodies:true,promptCaptureMaxBytes:262144}});
  const host=launch(cwd,config);
  try{
    await initialize(host.agent);
    const session=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
    assert.equal((await prompt(host.agent,session.sessionId,'fixture task')).stopReason,'end_turn');
    assert.ok(host.messages.some(m=>m.update.content?.text?.includes('Проверка')));
    assert.doesNotMatch(JSON.stringify(host.messages),/adapter\.prompt\.capture|Controller Invocation \(sectioned JSON\)/);
  }finally{await host.close();}
  const events=(await readFile(join(cwd,'state','diagnostics','diagnostics.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const capture=events.find(e=>e.eventName==='adapter.prompt.capture');
  assert.match(capture.details.prompt,/Controller Invocation \(sectioned JSON\)/);
  assert.equal(capture.details.captureLimitBytes,262144);
}));


test('C23 A127/A130 two ACP processes and one CLI overlap; restart changed config retains session and other owners',
  { timeout: 30_000, skip: process.env.C10_SOCKET_UNAVAILABLE === '1' }, () =>
  withOwnedRun('C23-acp-concurrent', async (cwd,sync) => {
    const config=await fixture(cwd,{storage:undefined});
    const other=join(cwd,'other.json'), cliConfig=join(cwd,'cli.json');
    const original=await readFile(config,'utf8');
    await writeFile(other,original); await writeFile(cliConfig,original);
    const env={...process.env,XDG_CONFIG_HOME:join(cwd,'config-home'),XDG_STATE_HOME:join(cwd,'state-home')};
    function call(args) {
      return sync(process.execPath,[entry,...args,'--format','json'],{cwd,env});
    }
    function result(args) {
      const response=call(args); assert.equal(response.status,0,response.stderr);
      return JSON.parse(response.stdout);
    }
    const storeA=result(['diagnose','--config',config]).stateDirectory;
    const storeB=result(['diagnose','--config',other]).stateDirectory;
    const storeC=join(cwd,'explicit-cli');
    assert.notEqual(storeA,storeB);
    async function active(directory,text) {
      for (let poll=0;poll<200;poll++) {
        const names=await readdir(directory).catch(error=>{if(error.code!=='ENOENT')throw error;return [];});
        for (const name of names.filter(name=>/^[a-f0-9]{64}.*\.json$/u.test(name))) {
          const operation=JSON.parse(await readFile(join(directory,name),'utf8'));
          if(operation.request.text===text && operation.attempts.some(attempt=>attempt.status==='dispatched'))return operation;
        }
        await delay(25);
      }
      assert.fail('No dispatched attempt for '+text);
    }
    const first=launch(cwd,config,undefined,[],env);
    const second=launch(cwd,other,undefined,[],env);
    let firstClosed=false, secondClosed=false, reopened, reopenedClosed=false, cli, cliClosed;
    const turns=[];
    try {
      await Promise.all([initialize(first.agent),initialize(second.agent)]);
      const {sessionId:history}=await first.agent.request(a.session.new,{cwd,mcpServers:[]});
      await prompt(first.agent,history,'settings');
      const {sessionId:one}=await first.agent.request(a.session.new,{cwd,mcpServers:[]});
      const {sessionId:two}=await second.agent.request(a.session.new,{cwd,mcpServers:[]});
      const heldA=prompt(first.agent,one,'hold ACP A');
      const heldB=prompt(second.agent,two,'hold ACP B');
      for (const turn of [heldA,heldB]) {turn.catch(()=>{});turns.push(turn);}
      cli=spawn(process.execPath,[entry,'run','hold CLI C','--config',cliConfig,'--state-dir',storeC,'--format','json'],
        {cwd,env,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';
      cli.stdout.on('data',bytes=>{stdout+=bytes;}); cli.stderr.on('data',bytes=>{stderr+=bytes;});
      cliClosed=once(cli,'close').then(([code])=>({code,stdout,stderr}));
      const [opA,opB,opC]=await Promise.all([active(storeA,'hold ACP A'),active(storeB,'hold ACP B'),active(storeC,'hold CLI C')]);
      assert.equal((await readDescriptor(storeA)).pid,first.child.pid);
      assert.equal((await readDescriptor(storeB)).pid,second.child.pid);
      assert.equal((await readDescriptor(storeC)).pid,cli.pid);
      const attached=call(['run','not a CLI owner','--config',config,'--state-dir',storeA]);
      assert.notEqual(attached.status,0); assert.match(attached.stderr,/CONTROL_ACP_SESSION_REQUIRED/);
      const duplicate=sync(process.execPath,[entry,'acp','--config',config,'--state-dir',storeA],{cwd,env,input:''});
      assert.notEqual(duplicate.status,0); assert.match(duplicate.stderr,/STATE_STORE_IN_USE/);
      assert.equal(result(['inspect',opB.operationId,'--state-dir',storeB]).operationId,opB.operationId);
      assert.equal(result(['cancel',opA.operationId,'--state-dir',storeA]).status,'cancelled');
      assert.equal((await heldA).stopReason,'cancelled');
      await first.close(); firstClosed=true;
      const updated=JSON.parse(original);
      updated.controllerProfile='secondary'; updated.profiles.secondary={provider:'test',model:'fixture'};
      await writeFile(config,JSON.stringify(updated));
      assert.equal(result(['diagnose','--config',config]).stateDirectory,storeA);
      reopened=launch(cwd,config,undefined,['--state-dir',storeA],env);
      await initialize(reopened.agent);
      await reopened.agent.request(a.session.load,{sessionId:history,cwd,mcpServers:[]});
      assert.ok(reopened.messages.some(message=>message.sessionId===history&&message.update.content?.text==='settings'));
      assert.equal((await prompt(reopened.agent,history,'settings')).stopReason,'end_turn');
      const answer=reopened.messages.filter(message=>message.sessionId===history&&message.update.sessionUpdate==='agent_message_chunk').at(-1);
      assert.equal(JSON.parse(answer.update.content.text)[0],'secondary');
      await reopened.close(); reopenedClosed=true;
      assert.equal((await active(storeB,'hold ACP B')).operationId,opB.operationId);
      assert.equal((await active(storeC,'hold CLI C')).operationId,opC.operationId);
      await second.agent.notify(a.session.cancel,{sessionId:two});
      assert.equal((await heldB).stopReason,'cancelled');
      await second.close(); secondClosed=true;
      assert.equal(result(['cancel',opC.operationId,'--state-dir',storeC]).status,'cancelled');
      const completed=await cliClosed;
      assert.equal(completed.code,0,completed.stderr);
      assert.equal(JSON.parse(completed.stdout).status,'cancelled');
    } finally {
      if(!firstClosed)first.child.kill('SIGKILL');
      if(!secondClosed)second.child.kill('SIGKILL');
      if(reopened&&!reopenedClosed)reopened.child.kill('SIGKILL');
      cli?.kill('SIGKILL');
      await Promise.allSettled([...turns,...(!firstClosed?[first.close()]:[]),...(!secondClosed?[second.close()]:[]),
        ...(reopened&&!reopenedClosed?[reopened.close()]:[]),...(cliClosed?[cliClosed]:[])]);
    }
  }));

test('C24 ACP exposes and persists Controller profile selection before prompting', { timeout: 12_000 }, () =>
  withOwnedRun('C24-acp-profile', async cwd => {
    const config = await fixture(cwd, {
      profiles: {
        primary: { provider: 'test', model: 'fixture' },
        secondary: { provider: 'test', model: 'fixture' },
      },
    });
    const first = launch(cwd, config);
    let sessionId;
    const profileOption = response => {
      const option = response.configOptions?.find(item => item.id === 'controllerProfile');
      assert.ok(option, 'session must expose the Controller profile selector before prompting');
      assert.equal(option.category, 'model');
      assert.equal(option.type, 'select');
      assert.deepEqual(new Set(option.options.flatMap(item => 'options' in item ? item.options : [item]).map(item => item.value)),
        new Set(['primary', 'secondary']));
      return option;
    };
    try {
      await initialize(first.agent);
      const created = await first.agent.request(a.session.new, { cwd, mcpServers: [] });
      sessionId = created.sessionId;
      assert.equal(profileOption(created).currentValue, 'primary');
      const changed = await first.agent.request(a.session.setConfigOption, {
        sessionId, configId: 'controllerProfile', value: 'secondary',
      });
      assert.equal(profileOption(changed).currentValue, 'secondary');
      await assert.rejects(first.agent.request(a.session.setConfigOption, {
        sessionId, configId: 'controllerProfile', value: 'missing',
      }));
      const meta = { roleOrchestrator: { requestId: 'c24-profile-selected' } };
      assert.equal((await prompt(first.agent, sessionId, 'settings', meta)).stopReason, 'end_turn');
      const answer = () => JSON.parse(first.messages.filter(item => item.sessionId === sessionId &&
        item.update.sessionUpdate === 'agent_message_chunk').at(-1).update.content.text)[0];
      assert.equal(answer(), 'secondary');
      await first.agent.request(a.session.setConfigOption, { sessionId, configId: 'controllerProfile', value: 'primary' });
      assert.equal((await prompt(first.agent, sessionId, 'settings', meta)).stopReason, 'end_turn');
      assert.equal(answer(), 'secondary', 'redelivery uses the accepted selection');
      assert.equal((await prompt(first.agent, sessionId, 'settings')).stopReason, 'end_turn');
      assert.equal(answer(), 'primary', 'new continuation uses the new selection');
      await first.agent.request(a.session.setConfigOption, { sessionId, configId: 'controllerProfile', value: 'secondary' });
    } finally { await first.close(); }

    const reopened = launch(cwd, config);
    try {
      await initialize(reopened.agent);
      const loaded = await reopened.agent.request(a.session.load, { sessionId, cwd, mcpServers: [] });
      assert.equal(profileOption(loaded).currentValue, 'secondary');
      const other = await reopened.agent.request(a.session.new, { cwd, mcpServers: [] });
      assert.equal(profileOption(other).currentValue, 'primary');
    } finally { await reopened.close(); }
  }));

test('C24 mixed ACP wire blocks survive acceptance, follow-up, selected Worker and session reload', {timeout:30_000}, ()=>
  withOwnedRun('C24-ordered-content',async cwd=>{
    const agentPath=fileURLToPath(new URL('../fixtures/c24-native-agent.js',import.meta.url));
    const config=await fixture(cwd,{
      providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[agentPath,'controller']}},
        worker:{adapter:'acp',launch:{command:process.execPath,args:[agentPath,'worker']}}},
      profiles:{primary:{provider:'test',model:'fixture'},worker:{provider:'worker',model:'fixture'}},plugins:[],
      storage:{directory:'state',artifactRetention:{maxAgeMs:0,maxBytes:0}},
    });
    const image={type:'image',mimeType:'image/png',data:Buffer.alloc(900*1024,7).toString('base64')};
    const secondImage={type:'image',mimeType:'image/png',data:'AQIDBA=='};
    const firstBlocks=[{type:'text',text:'before'},image,{type:'text',text:'after'},
      {type:'resource_link',uri:'file:///not-read-by-host.txt',name:'literal-link',mimeType:'text/plain'}];
    const secondBlocks=[secondImage,{type:'audio',data:'AQID',mimeType:'audio/wav'},
      {type:'resource',resource:{uri:'file:///embedded.txt',mimeType:'text/plain',text:'embedded text'}},{type:'text',text:'compare'}];
    const first=launch(cwd,config);
    let sessionId;
    const wire=async()=> (await readFile(join(cwd,'c24-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const send=(host,blocks,requestId)=>host.agent.request(a.session.prompt,{sessionId,prompt:blocks,_meta:{roleOrchestrator:{requestId}}});
    try{
      const init=await initialize(first.agent);
      assert.equal(init.agentCapabilities.promptCapabilities.image,true);
      assert.equal(init.agentCapabilities.promptCapabilities.audio,true);
      assert.equal(init.agentCapabilities.promptCapabilities.embeddedContext,true);
      ({sessionId}=await first.agent.request(a.session.new,{cwd,mcpServers:[]}));
      assert.equal((await send(first,firstBlocks,'ordered-a')).stopReason,'end_turn');
      const initial=(await wire()).at(-1);
      assert.deepEqual(initial.blocks.map(b=>b.type),['text','image','text','resource_link']);
      assert.deepEqual(initial.blocks.filter(b=>b.type==='text').map(b=>b.text),['before','after']);
      assert.equal(initial.blocks[1].size,900*1024);
      assert.equal(initial.blocks[3].uri,'file:///not-read-by-host.txt');
      assert.equal((await send(first,secondBlocks,'ordered-b')).stopReason,'end_turn');
      const comparison=(await wire()).at(-1);
      assert.deepEqual(comparison.blocks.map(b=>b.type),[...initial.blocks.map(b=>b.type),'image','audio','resource','text']);
      assert.equal(comparison.blocks[6].text,'embedded text');
      const count=(await wire()).length;
      assert.equal((await send(first,secondBlocks,'ordered-b')).stopReason,'end_turn');
      assert.equal((await wire()).length,count,'redelivery does not dispatch again');
      await assert.rejects(send(first,[{type:'text',text:'changed'}],'ordered-b'));
      assert.equal((await send(first,[{type:'text',text:'delegate selected image'}],'ordered-c')).stopReason,'end_turn');
      const worker=(await wire()).find(item=>item.kind==='delegate');
      assert.ok(worker);
      assert.deepEqual(worker.blocks.map(b=>b.type),['image']);
      assert.equal(worker.blocks[0].size,4);
      const files=await readdir(join(cwd,'state'));
      const journals=await Promise.all(files.filter(name=>name.endsWith('.json')).map(name=>readFile(join(cwd,'state',name),'utf8')));
      assert.ok(journals.every(body=>!body.includes(image.data)&&!body.includes(secondImage.data)));
      assert.ok(files.filter(name=>name.startsWith('artifact-')&&name.endsWith('.blob')).length>=3);
      const imageOnly=await first.agent.request(a.session.new,{cwd,mcpServers:[]});
      assert.equal((await first.agent.request(a.session.prompt,{sessionId:imageOnly.sessionId,prompt:[secondImage]})).stopReason,'end_turn');
    }finally{await first.close();}
    const reopened=launch(cwd,config);
    try{
      await initialize(reopened.agent);
      await reopened.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
      const replay=reopened.messages.filter(item=>item.update.sessionUpdate==='user_message_chunk').map(item=>item.update.content);
      assert.deepEqual(replay.map(b=>b.type),[...firstBlocks.map(b=>b.type),...secondBlocks.map(b=>b.type),'text']);
      assert.equal(replay[1].data,image.data);
      assert.equal(replay[4].data,secondImage.data);
      assert.equal(replay[6].resource.text,'embedded text');
    }finally{await reopened.close();}
  }));

test('C24 native settings selectors apply exact opaque IDs and scope Controller and Worker settings', {timeout:30_000}, ()=>
  withOwnedRun('C24-native-settings',async cwd=>{
    const native=fileURLToPath(new URL('../fixtures/c24-native-agent.js',import.meta.url));
    const config=await fixture(cwd,{
      providers:{
        test:{adapter:'acp',launch:{command:process.execPath,args:[native,'controller']},
          featureBindings:{reasoningEffort:{kind:'configOption',id:'arbitrary-thought-id'},
            collaborationMode:{kind:'configOption',id:'opaque-collaboration'},
            approvalMode:{kind:'configOption',id:'opaque-approval'}}},
        worker:{adapter:'acp',launch:{command:process.execPath,args:[native,'worker']},
          featureBindings:{approvalMode:{kind:'sessionMode'}}},
      },
      features:{
        reasoningEffort:{shared:{default:'low',options:[{id:'native'},{id:'low',nativeValue:'native-low'},{id:'high',nativeValue:'native-high'}]}},
        collaborationMode:{plans:{default:'default',options:[{id:'default',nativeValue:'native-default'},{id:'plan',nativeValue:'native-plan'}]}},
        approvalMode:{first:{default:'review',options:[{id:'native'},{id:'review',nativeValue:'native-review'},{id:'open',nativeValue:'native-open'}]},
          second:{default:'review',options:[{id:'review',nativeValue:'worker-review'},{id:'open',nativeValue:'worker-open'}]}},
      },
      profiles:{primary:{provider:'test',model:'fixture',features:{reasoningEffort:'shared',collaborationMode:'plans',approvalMode:'first'}},
        worker:{provider:'worker',model:'fixture',features:{reasoningEffort:'shared',approvalMode:'second'}},
        plain:{provider:'worker',model:'fixture'}},plugins:[],
    });
    const host=launch(cwd,config);
    try{
      await initialize(host.agent);
      const created=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      const sessionId=created.sessionId;
      const current=(result,id)=>result.configOptions?.find(item=>item.id===id)?.currentValue;
      const select=(configId,value)=>host.agent.request(a.session.setConfigOption,{sessionId,configId,value});
      assert.equal(current(created,'reasoningEffort'),'low');
      assert.equal(current(created,'collaborationMode'),'default');
      assert.equal(current(created,'approvalMode'),'review');
      await assert.rejects(readFile(join(cwd,'c24-wire.jsonl')), {code:'ENOENT'});
      await select('reasoningEffort','high');
      await select('collaborationMode','plan');
      await select('approvalMode','open');
      await assert.rejects(select('approvalMode','missing'));
      const worker=await select('controllerProfile','worker');
      assert.equal(current(worker,'reasoningEffort'),'high');
      assert.equal(current(worker,'approvalMode'),'open');
      assert.equal(current(worker,'collaborationMode'),undefined);
      const plain=await select('controllerProfile','plain');
      assert.equal(current(plain,'reasoningEffort'),undefined);
      const back=await select('controllerProfile','primary');
      assert.equal(current(back,'reasoningEffort'),'low');
      assert.equal(current(back,'approvalMode'),'review');
      await select('reasoningEffort','high');await select('collaborationMode','plan');await select('approvalMode','open');
      const input=[{type:'image',mimeType:'image/png',data:'AQID'},{type:'text',text:'delegate selected image'}];
      assert.equal((await host.agent.request(a.session.prompt,{sessionId,prompt:input})).stopReason,'end_turn');
      const records=(await readFile(join(cwd,'c24-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      const controller=records.find(x=>x.kind==='controller');
      const delegated=records.find(x=>x.kind==='delegate');
      assert.equal(controller.settings['arbitrary-thought-id'],'native-high');
      assert.equal(controller.settings['opaque-collaboration'],'native-plan');
      assert.equal(controller.settings['opaque-approval'],'native-open');
      assert.equal(delegated.settings['arbitrary-thought-id'],'native-low','Controller user default must not leak to Worker');
      assert.equal(delegated.settings['opaque-collaboration'],'native-default');
      assert.equal(delegated.mode,'worker-open','Worker receives its own mapping of the logical approval option');
      assert.equal(delegated.blocks.length,1);
    }finally{await host.close();}
  }));

test('C24 ordinary continuation remains usable after an earlier image on a different profile', {timeout:20_000},()=>
  withOwnedRun('C24-history-capability',async cwd=>{
    const native=fileURLToPath(new URL('../fixtures/c24-native-agent.js',import.meta.url));
    const config=await fixture(cwd,{
      providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[native,'controller']}},plain:{adapter:'host-fixture'}},
      profiles:{primary:{provider:'test',model:'fixture'},plain:{provider:'plain',model:'fixture'}}
    });
    const host=launch(cwd,config);
    try{
      await initialize(host.agent);
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      assert.equal((await host.agent.request(a.session.prompt,{sessionId,prompt:[{type:'image',mimeType:'image/png',data:'AQID'}]})).stopReason,'end_turn');
      await host.agent.request(a.session.setConfigOption,{sessionId,configId:'controllerProfile',value:'plain'});
      assert.equal((await prompt(host.agent,sessionId,'settings')).stopReason,'end_turn');
      const answer=host.messages.filter(item=>item.sessionId===sessionId&&item.update.sessionUpdate==='agent_message_chunk').at(-1).update.content.text;
      assert.equal(JSON.parse(answer)[0],'plain');
    }finally{await host.close();}
  }));

test('C24 ACP advertises project skills, preserves explicit selection and clears removed commands on reload',{timeout:20_000},()=>
  withOwnedRun('C24-acp-skills',async cwd=>{
    const native=fileURLToPath(new URL('../fixtures/c24-native-agent.js',import.meta.url));
    const config=await fixture(cwd,{providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[native,'controller']}}},plugins:[]});
    const directory=join(cwd,'.agents','skills','c24-project');
    await mkdir(directory,{recursive:true});
    const path=join(directory,'SKILL.md');
    await writeFile(path,'---\nname: c24-project\ndescription: Example project skill\n---\nPrivate body\n');
    const host=launch(cwd,config,undefined,[],{...process.env,HOME:cwd});
    try{
      await initialize(host.agent);
      const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
      const commands=()=>host.messages.filter(x=>x.update.sessionUpdate==='available_commands_update').at(-1)?.update.availableCommands;
      assert.ok(commands().some(x=>x.name==='c24-project'));
      await assert.rejects(readFile(join(cwd,'c24-wire.jsonl')), {code:'ENOENT'});
      assert.equal((await prompt(host.agent,sessionId,'/c24-project task')).stopReason,'end_turn');
      assert.equal((await prompt(host.agent,sessionId,'/unknown-c24 ordinary')).stopReason,'end_turn');
      const records=(await readFile(join(cwd,'c24-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(records[0].userSelectedSkills[0].path,path);
      assert.equal(records[0].userSelectedSkills[0].source,'project');
      assert.equal(records[1].userSelectedSkills.length,1);
      assert.equal(records[1].userText,'/unknown-c24 ordinary');
      await writeFile(path,'not a skill');
      await host.agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});
      assert.deepEqual(commands(),[]);
    }finally{await host.close();}
  }));

test('C24 decoded input limit rejects oversized embedded data before native dispatch',{timeout:12_000},()=>withOwnedRun('C24-input-limit',async cwd=>{
  const native=fileURLToPath(new URL('../fixtures/c24-native-agent.js',import.meta.url));
  const config=await fixture(cwd,{input:{maxBytes:64},providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[native,'controller']}}},plugins:[]});
  const host=launch(cwd,config);
  try{
    await initialize(host.agent);
    const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
    await assert.rejects(host.agent.request(a.session.prompt,{sessionId,prompt:[{type:'image',mimeType:'image/png',data:Buffer.alloc(65).toString('base64')}]}));
    await assert.rejects(readFile(join(cwd,'c24-wire.jsonl')),{code:'ENOENT'});
    assert.equal((await prompt(host.agent,sessionId,'ordinary')).stopReason,'end_turn');
  }finally{await host.close();}
}));

test('C24-R unavailable default leaves available profile selectable without silent fallback', {timeout:12000},()=>withOwnedRun('C24R-profile',async cwd=>{
  const config=await fixture(cwd,{controllerProfile:'missing',providers:{test:{adapter:'host-fixture'},missing:{adapter:'not-installed'}},
    profiles:{primary:{provider:'test',model:'fixture'},missing:{provider:'missing',model:'fixture'}}});
  const host=launch(cwd,config);
  try{
    await initialize(host.agent);
    const created=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
    const selector=created.configOptions.find(item=>item.id==='controllerProfile');
    assert.ok(selector);
    assert.equal(selector.currentValue,'missing');
    assert.ok(selector.options.some(item=>item.value==='primary'));
    await assert.rejects(prompt(host.agent,created.sessionId,'settings'));
    await host.agent.request(a.session.setConfigOption,{sessionId:created.sessionId,configId:'controllerProfile',value:'primary'});
    assert.equal((await prompt(host.agent,created.sessionId,'settings')).stopReason,'end_turn');
  }finally{await host.close();}
}));

test('C24-R unsupported feature still permits explicit native no-override', {timeout:12000},()=>withOwnedRun('C24R-native',async cwd=>{
  const config=await fixture(cwd,{profiles:{primary:{provider:'test',model:'fixture',features:{approvalMode:'review'}}},
    features:{approvalMode:{review:{default:'review',options:[{id:'native'},{id:'review',nativeValue:'ask'}]}}}});
  const host=launch(cwd,config);
  try{
    await initialize(host.agent);
    const created=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
    assert.equal(created.configOptions.find(item=>item.id==='approvalMode').currentValue,'review');
    const result=await host.agent.request(a.session.setConfigOption,{sessionId:created.sessionId,configId:'approvalMode',value:'native'});
    assert.equal(result.configOptions.find(item=>item.id==='approvalMode').currentValue,'native');
    assert.equal((await prompt(host.agent,created.sessionId,'settings')).stopReason,'end_turn');
  }finally{await host.close();}
}));

test('C24-R Controller selects historical native image beyond automatic input budget', {timeout:30000},()=>withOwnedRun('C24R-history',async cwd=>{
  const native=fileURLToPath(new URL('../fixtures/c24-native-agent.js',import.meta.url));
  const config=await fixture(cwd,{input:{maxBytes:1024*1024},resources:{maxInvocationsPerOperation:4},
    providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[native,'history-request']}}},plugins:[]});
  const host=launch(cwd,config);
  const image=byte=>({type:'image',mimeType:'image/png',data:Buffer.alloc(700*1024,byte).toString('base64')});
  try{
    await initialize(host.agent);
    const {sessionId}=await host.agent.request(a.session.new,{cwd,mcpServers:[]});
    const send=blocks=>host.agent.request(a.session.prompt,{sessionId,prompt:blocks});
    assert.equal((await send([{type:'text',text:'first picture'},image(7)])).stopReason,'end_turn');
    assert.equal((await send([image(8),{type:'text',text:'retrieve first image'}])).stopReason,'end_turn');
    const records=(await readFile(join(cwd,'c24-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length,3);
    const first=records[0].blocks.find(item=>item.type==='image').hash;
    assert.notEqual(records[1].blocks.find(item=>item.type==='image').hash,first);
    assert.equal(records[2].blocks.find(item=>item.type==='image').hash,first);
    assert.equal(records[2].blocks.filter(item=>item.type==='image').length,1);
    assert.ok(records.every(item=>item.kind==='controller'));
  }finally{await host.close();}
}));
