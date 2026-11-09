import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const entry = fileURLToPath(new URL('../../../../src/main/cli.js', import.meta.url));
const a = methods.agent;
const c = methods.client;

async function fixture(cwd, overrides = {}) {
  const config = join(cwd, 'config.json');
  await writeFile(config, JSON.stringify({
    schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
    providers: { test: { adapter: 'host-fixture' } }, storage: { directory: 'state' },
    plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../../fixtures/host-plugin.js', import.meta.url)) }],
    ...overrides,
  }));
  return config;
}

function launch(cwd, config, setup = app => app, flags = []) {
  const child = spawn(process.execPath, [entry, 'acp', '--config', config, ...flags], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
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
      assert.equal((await initialize(first.agent)).agentCapabilities.loadSession, true);
      ({ sessionId } = await first.agent.request(a.session.new, { cwd, mcpServers: [] }));
      const second = await first.agent.request(a.session.new, { cwd, mcpServers: [] });
      assert.notEqual(sessionId, second.sessionId);
      await assert.rejects(first.agent.request(a.session.prompt, {
        sessionId, prompt: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
      }), /text prompt blocks/);
      assert.equal((await prompt(first.agent, sessionId, 'Привет')).stopReason, 'end_turn');
      assert.ok(first.messages.some(message => message.sessionId === sessionId && message.update.content?.text === 'Ответ: Привет'));
      const held = prompt(first.agent, second.sessionId, 'hold');
      await first.agent.notify(a.session.cancel, { sessionId: second.sessionId });
      assert.equal((await held).stopReason, 'cancelled');
    } finally { await first.close(); }
    const reopened = launch(cwd, config);
    try {
      await initialize(reopened.agent);
      await reopened.agent.request(a.session.load, { sessionId, cwd, mcpServers: [] });
      assert.deepEqual(reopened.messages.map(message => message.update.content?.text), ['Привет', 'Ответ: Привет']);
    } finally { await reopened.close(); }
  }));

test('external ACP correlates parallel permission replies and relays only advertised client tools', { timeout: 12_000 }, () =>
  withOwnedRun('C10-acp-relay', async cwd => {
    const config = await fixture(cwd, {
      providers: { test: { adapter: 'acp', launch: { command: process.execPath,
        args: [fileURLToPath(new URL('../../fixtures/acp-contract-agent.js', import.meta.url)), 'host-relay'] } } },
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
        args: [fileURLToPath(new URL('../../fixtures/acp-contract-agent.js', import.meta.url)), 'host-relay'] } } },
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
