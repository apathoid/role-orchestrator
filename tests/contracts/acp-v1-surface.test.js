import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agent, client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

test('pinned ACP v1 SDK exchanges session, tool, permission and cancel messages over NDJSON', {
  timeout: 5_000,
}, async () => {
  const { agent: a, client: c } = methods;
  const agentToClient = new TransformStream();
  const clientToAgent = new TransformStream();
  const waitingForCancel = Promise.withResolvers();
  const permissionReceived = Promise.withResolvers();
  const updates = [];
  const sessionId = 'acp-fixture';
  const toolCallId = 'tool-fixture';

  assert.equal(PROTOCOL_VERSION, 1);
  const server = agent()
    .onRequest(a.initialize, ({ params }) => {
      assert.equal(params.protocolVersion, 1);
      assert.equal(params.clientCapabilities.fs.readTextFile, false);
      assert.equal(params.clientCapabilities.fs.writeTextFile, false);
      assert.equal(params.clientCapabilities.terminal, false);
      return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } };
    })
    .onRequest(a.session.new, ({ params }) => {
      assert.equal(params.cwd, process.cwd());
      assert.deepEqual(params.mcpServers, []);
      return { sessionId };
    })
    .onRequest(a.session.prompt, async ({ client: remote, params }) => {
      assert.equal(params.sessionId, sessionId);
      assert.deepEqual(params.prompt, [{ type: 'text', text: 'probe' }]);
      await remote.notify(c.session.update, { sessionId, update: {
        sessionUpdate: 'tool_call', toolCallId, title: 'Fixture tool', status: 'pending',
      } });
      const result = await remote.request(c.session.requestPermission, {
        sessionId, toolCall: { toolCallId },
        options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject once' }],
      });
      assert.deepEqual(result, { outcome: { outcome: 'selected', optionId: 'reject' } });
      permissionReceived.resolve();
      await waitingForCancel.promise;
      return { stopReason: 'cancelled' };
    })
    .onNotification(a.session.cancel, ({ params }) => {
      assert.equal(params.sessionId, sessionId);
      waitingForCancel.resolve();
    })
    .onRequest(a.session.close, ({ params }) => {
      assert.equal(params.sessionId, sessionId);
      return {};
    })
    .connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

  const connection = client()
    .onNotification(c.session.update, ({ params }) => updates.push(params))
    .onRequest(c.session.requestPermission, ({ params, requestId }) => {
      assert.ok(typeof requestId === 'number' || typeof requestId === 'string');
      assert.equal(params.sessionId, sessionId);
      assert.equal(params.toolCall.toolCallId, toolCallId);
      return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
    })
    .connect(ndJsonStream(clientToAgent.writable, agentToClient.readable));

  const signal = AbortSignal.timeout(2_000);
  try {
    const initialized = await connection.agent.request(a.initialize, { protocolVersion: 1, clientCapabilities: {} }, { cancellationSignal: signal, stopWaitingOnCancel: true });
    assert.equal(initialized.protocolVersion, 1);
    assert.ok(initialized.agentCapabilities.sessionCapabilities.close);
    const opened = await connection.agent.request(a.session.new, { cwd: process.cwd(), mcpServers: [] }, { cancellationSignal: signal, stopWaitingOnCancel: true });
    assert.equal(opened.sessionId, sessionId);
    const prompt = connection.agent.request(a.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'probe' }] }, { cancellationSignal: signal, stopWaitingOnCancel: true });
    await Promise.race([
      permissionReceived.promise,
      prompt.then(() => assert.fail('Prompt finished before the cancellation notification')),
    ]);
    assert.equal(updates[0].sessionId, sessionId);
    assert.equal(updates[0].update.toolCallId, toolCallId);
    await connection.agent.notify(a.session.cancel, { sessionId });
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.deepEqual(await connection.agent.request(a.session.close, { sessionId }, { cancellationSignal: signal, stopWaitingOnCancel: true }), {});
  } finally {
    waitingForCancel.resolve();
    connection.close();
    server.close();
    await Promise.all([connection.closed, server.closed]);
  }
});
