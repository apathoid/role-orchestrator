import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
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
