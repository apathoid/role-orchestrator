import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';

const { agent: a, client: c } = methods;
let advertised;
const sessionId = 'probe-session';

agent()
  .onRequest(a.initialize, ({ params }) => {
    advertised = params.clientCapabilities;
    return { protocolVersion: PROTOCOL_VERSION };
  })
  .onRequest(a.session.new, () => ({ sessionId }))
  .onRequest(a.session.prompt, () => ({ stopReason: 'end_turn' }))
  .onRequest('*', async ({ method, params, client }) => {
    if (method !== '_ro/probe') throw RequestError.methodNotFound(method);
    const result = await client.request('_ro/echo', params);
    await client.notify('_ro/notice', params);
    await client.notify(c.session.update, { sessionId, update: {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'native thought' },
    } });
    await client.notify(c.session.update, { sessionId, update: {
      sessionUpdate: 'plan', entries: [{ content: 'native plan', priority: 'medium', status: 'pending' }],
    } });
    return { result, advertised };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
