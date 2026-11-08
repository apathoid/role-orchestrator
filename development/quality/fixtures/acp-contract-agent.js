import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const { agent: a, client: c } = methods;
const scenario = process.argv[2];
const stop = Promise.withResolvers();
const sessionId = 'native-fixture';
const configOptions = currentValue => [{
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue,
  options: [{ value: 'fixture', name: 'Fixture' }, { value: 'other', name: 'Other' }],
}];
let model = 'fixture';
let mode = 'default';
agent()
  .onRequest(a.initialize, () => {
    if (scenario === 'init-exit') process.exit(1);
    return { protocolVersion: scenario === 'bad-version' ? 2 : 1,
      agentCapabilities: { promptCapabilities: { image: scenario === 'image', embeddedContext: scenario === 'resource' }, sessionCapabilities: { close: {} } } };
  })
  .onRequest(a.session.new, ({ params }) => {
    if (params.cwd !== process.cwd()) throw Error('cwd mismatch');
    return { sessionId, configOptions: configOptions(model), ...(scenario === 'mode' && {
      modes: { currentModeId: mode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'review', name: 'Review' }] },
    }) };
  })
  .onRequest(a.session.setConfigOption, ({ params }) => {
    if (params.sessionId !== sessionId) throw Error('session mismatch');
    if (scenario !== 'ignore-model') model = params.value;
    return { configOptions: configOptions(model) };
  })
  .onRequest(a.session.setMode, ({ params }) => {
    if (params.sessionId !== sessionId || params.modeId !== 'review') throw Error('unexpected mode');
    mode = params.modeId;
    return {};
  })
  .onNotification(a.session.cancel, ({ params }) => {
    if (params.sessionId === sessionId && scenario !== 'ignore-cancel') stop.resolve('cancelled');
  })
  .onRequest(a.session.close, async ({ params, client }) => {
    if (params.sessionId !== sessionId) throw Error('session mismatch');
    if (scenario === 'events') await client.notify(c.session.update, { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after terminal' },
    } });
    await writeFile('closed', '');
    return {};
  })
  .onRequest(a.session.prompt, async ({ params, client }) => {
    const prompt = params.prompt[0].text;
    const marker = '\n\nInvocation (JSON):\n';
    const { objective, attemptId, kind, profileId, operationId, context } = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
    const message = (messageId, text) => client.notify(c.session.update, { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
    } });
    await message('progress', 'progress ' + attemptId);
    if (objective === 'hold') {
      await writeFile(attemptId + '.ready', '');
      const untilReleased = async () => {
        while (true) {
          try { await access(attemptId + '.release'); return 'end_turn'; }
          catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(10); }
        }
      };
      if (await Promise.race([untilReleased(), stop.promise]) === 'cancelled') {
        if (scenario !== 'late-terminal') return { stopReason: 'cancelled' };
        await message('late', 'late result');
        return { stopReason: 'end_turn' };
      }
    }
    if (scenario === 'disconnect') process.exit(3);
    if (scenario === 'malformed') return {};
    if (scenario === 'oversize') {
      for (let i = 0; i < 3; i++) await message('progress', 'x'.repeat(400_000));
      return { stopReason: 'end_turn' };
    }
    if (scenario === 'provider-cancel') return { stopReason: 'cancelled' };
    if (objective === 'failure') return { stopReason: 'refusal' };
    if (['permission', 'pending-permission', 'permission-disconnect'].includes(scenario)) {
      const options = [{ optionId: 'allow', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'deny', name: 'Reject once', kind: 'reject_once' }];
      const ask = toolCallId => client.request(c.session.requestPermission, { sessionId, toolCall: { toolCallId }, options });
      const repliesPromise = Promise.all([ask('tool-one'), ask('tool-two'), ask('tool-three')]);
      if (scenario === 'permission-disconnect') {
        await access('permissions-ready').catch(async () => {
          while (true) {
            try { await access('permissions-ready'); break; }
            catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(10); }
          }
        });
        process.exit(3);
      }
      const replies = await repliesPromise;
      if (scenario === 'pending-permission') {
        if (replies.some(reply => reply.outcome.outcome !== 'cancelled')) throw Error('Permission survived cancellation');
        await stop.promise;
        await writeFile('permissions-cancelled', '');
        return { stopReason: 'cancelled' };
      }
      await message('result', JSON.stringify(replies.map(reply => reply.outcome)));
    } else if (scenario === 'bridge' || scenario === 'bridge-cancel') {
      let output;
      try { output = (await client.request(c.fs.readTextFile, { sessionId, path: '/test/file' })).content; }
      catch (error) { output = String(error.code); }
      if (scenario === 'bridge-cancel') {
        await stop.promise;
        return { stopReason: 'cancelled' };
      }
      await message('result', output);
    } else if (scenario === 'resource') {
      await message('result', params.prompt.slice(1).map(item => item.type).join(','));
    } else if (scenario === 'image') {
      await message('result', params.prompt[1]?.type === 'image' ? 'image delivered' : 'missing image');
    } else if (kind === 'controller') {
      const cursor = context.find(item => item.ref === 'host:invocation-context').value.contextCursor;
      const decision = JSON.stringify({ schemaVersion: 1, decisionId: attemptId + '-decision',
        operationId, contextCursor: cursor, additions: [], cancellations: [], finalAssessment: {
          author: profileId, overall: 'partial', requirements: [], observationRefs: [], findingRefs: [],
          unresolvedQuestions: [], answer: 'ACP Controller response',
        } });
      await message('result', decision.slice(0, 30));
      await message('result', decision.slice(30));
    } else if (scenario === 'mode') {
      await message('result', mode);
    } else if (scenario === 'selected-model') {
      await message('result', model);
    } else {
      if (scenario === 'events') {
        const update = { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'fixture tool', status: 'completed' };
        await client.notify(c.session.update, { sessionId: 'foreign', update });
        await client.notify(c.session.update, { sessionId, update });
        await client.notify(c.session.update, { sessionId, update });
      }
      await message('result', 'result ');
      await message('result', attemptId);
    }
    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
