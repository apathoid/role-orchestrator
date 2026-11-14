import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';

test('C13 baseline: pinned ACP SDK subprocess supports raw extensions and typed updates outside a prompt', { timeout: 8_000 }, async () => {
  const { agent: a, client: c } = methods;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/acp-extension-probe.js', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  const payload = { sessionId: 'probe-session', nested: { sessionId: 'opaque', arbitrary: [1, false, null] } };
  const meta = { '_ro/probe': { declared: true, opaque: ['x'] } };
  const notices = [];
  const updates = [];
  const connection = client()
    .onRequest('*', ({ method, params }) => {
      if (method !== '_ro/echo') throw RequestError.methodNotFound(method);
      return { echo: params };
    })
    .onNotification('*', ({ method, params }) => notices.push({ method, params }))
    .onNotification(c.session.update, ({ params }) => updates.push(params))
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const options = { cancellationSignal: AbortSignal.timeout(4_000), stopWaitingOnCancel: true };
  try {
    await connection.agent.request(a.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { terminal: false, _meta: meta },
    }, options);
    const { sessionId } = await connection.agent.request(a.session.new, { cwd: process.cwd(), mcpServers: [] }, options);
    await connection.agent.request(a.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'probe' }] }, options);
    const reply = await connection.agent.request('_ro/probe', payload, options);
    assert.deepEqual(reply.result, { echo: payload });
    assert.deepEqual(reply.advertised._meta, meta);
    assert.equal(reply.advertised.terminal, false);
    assert.deepEqual(notices, [{ method: '_ro/notice', params: payload }]);
    assert.deepEqual(updates.map(x => x.update.sessionUpdate), ['agent_thought_chunk', 'plan']);
    assert.ok(updates.every(x => x.sessionId === sessionId));
    assert.equal(updates[0].update.messageId ?? undefined, undefined);
    await assert.rejects(connection.agent.request('_ro/unsupported', {}, options), error => error.code === -32601);
  } finally {
    connection.close();
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
    await exited;
  }
});
