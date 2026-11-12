import assert from 'node:assert/strict';
import { retrieveContext } from './mcp-client.js';
import { agent, RequestError, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const { agent: a, client: c } = methods;
const scenario = process.argv[2];
const stop = Promise.withResolvers();
const sessionId = 'native-fixture';
const configOptions = (currentValue, id = 'model') => [{
  id, name: 'Model', category: 'model', type: 'select', currentValue,
  options: [{ value: 'fixture', name: 'Fixture' }, { value: 'other', name: 'Other' }],
}];
let mcpUrl;
let effort = 'low-native';
const reasoningScenario = scenario.startsWith('reasoning-');
const configuredOptions = () => [...configOptions(model, modelSelector), ...(reasoningScenario ? [{
  id:'native-reasoning', name:'Thinking', category: scenario === 'reasoning-no-option' ? 'model_config' : 'thought_level',
  type:'select', currentValue:effort, options:[
    {value:'low-native',name:'Low'}, {value:'high-native',name:'High'},
  ],
}] : [])];
let model = 'fixture';
let mode = 'default';
let clientCapabilities;
let modelSelector = 'model';
const modeScenario = ['mode', 'mode-reroutes', 'mode-model-unavailable'].includes(scenario);
agent()
  .onRequest(a.initialize, async ({ params }) => {
    clientCapabilities = params.clientCapabilities;
    if (scenario === 'init-stderr') {
      await new Promise(resolve => process.stderr.write('Missing ACP fixture configuration\n' + 'x'.repeat(70_000), resolve));
      process.exit(9);
    }
    if (scenario === 'init-rpc-error') throw new RequestError(-32000, 'ACP fixture initialization rejected');
    if (scenario === 'init-exit') process.exit(1);
    return { protocolVersion: scenario === 'bad-version' ? 2 : 1,
      agentCapabilities: { promptCapabilities: { image: scenario === 'image', embeddedContext: scenario === 'resource' }, sessionCapabilities: { close: {} }, mcpCapabilities: { http: scenario === 'mcp' } } };
  })
  .onRequest(a.session.new, ({ params }) => {
    if (params.cwd !== process.cwd()) throw Error('cwd mismatch');
    if (scenario === 'mcp') {
      assert.equal(params.mcpServers[0]?.type, 'http');
      mcpUrl = params.mcpServers[0].url;
    }
    return { sessionId, configOptions: reasoningScenario ? configuredOptions() : configOptions(model), ...(modeScenario && {
      modes: { currentModeId: mode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'review', name: 'Review' }] },
    }) };
  })
  .onRequest(a.session.setConfigOption, ({ params }) => {
    if (params.sessionId !== sessionId) throw Error('unexpected session');
    if (params.configId === 'native-reasoning' && reasoningScenario) {
      if (scenario !== 'reasoning-ignored') effort = params.value;
      if (scenario === 'reasoning-reroutes') model = 'other';
      return {configOptions:configuredOptions()};
    }
    if (params.configId !== modelSelector) throw Error('unexpected model selector');
    if (!['ignore-model', 'mode-model-unavailable'].includes(scenario)) model = params.value;
    return { configOptions: reasoningScenario ? configuredOptions() : configOptions(model, modelSelector) };
  })
  .onRequest(a.session.setMode, async ({ params, client }) => {
    if (params.sessionId !== sessionId || params.modeId !== 'review') throw Error('unexpected mode');
    mode = params.modeId;
    if (scenario === 'mode-reroutes' || scenario === 'mode-model-unavailable') {
      model = 'other';
      modelSelector = 'model-in-review';
      await client.notify(c.session.update, { sessionId, update: {
        sessionUpdate: 'config_option_update', configOptions: configOptions(model, modelSelector),
      } });
    }
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
    const { objective, attemptId, actionId, kind, profileId, operationId, context, skillInstructions } = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
    if (scenario === 'controller-contract' && kind === 'controller') {
      assert.ok(prompt.includes('cursor?:0|{revision:number,index:number}'));
      assert.ok(prompt.includes('finalAssessment.answer'));
      assert.ok(!prompt.includes('cursor?: number'));
    }
    const message = (messageId, text) => client.notify(c.session.update, { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
    } });
    if (scenario.startsWith('decision-tool-')) {
      const host = context.find(item => item.ref === 'host:invocation-context')?.value;
      if (kind === 'delegate') {
        await message('worker-result', 'Native Worker ' + actionId);
        return { stopReason: 'end_turn' };
      }
      assert.ok(prompt.includes('Ordinary tool results, files and intermediate messages do not submit it'));
      assert.ok(prompt.includes('not an inventory of native tools'));
      const decision = fields => ({ schemaVersion: 1, decisionId: attemptId + '-final',
        operationId, contextCursor: host.contextCursor, additions: [], cancellations: [], ...fields });
      const proposal = suffix => decision({
        decisionId: attemptId + '-' + suffix,
        additions: [{ actionId: 'worker-' + suffix, kind: 'delegate', profileId, objective: 'Native fixture work',
          contextRefs: [], dependsOn: [], expectedResult: 'Report' }],
        waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: 'worker-' + suffix }] },
      });
      const error = context.find(item => item.ref === 'host:decision-error')?.value;
      if (host.outcomes.length || error) {
        if (scenario === 'decision-tool-invalid') {
          assert.equal(error.code, 'INVALID_PROPOSAL');
          assert.equal(error.expected, 'valid JSON');
        }
        await message('final', JSON.stringify(decision({ finalAssessment: {
          author: profileId, overall: 'complete', requirements: [], observationRefs: [], findingRefs: [],
          unresolvedQuestions: [], answer: 'Transport complete',
        } })));
        return { stopReason: 'end_turn' };
      }
      const a = JSON.stringify(proposal('a'));
      await message('progress', 'Native inspection before Controller result');
      await client.notify(c.session.update, { sessionId, update: {
        sessionUpdate: 'tool_call', toolCallId: 'decision-shaped-tool', title: 'Read native result',
        kind: 'read', status: 'in_progress',
      } });
      await client.notify(c.session.update, { sessionId, update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'decision-shaped-tool', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: a } }],
      } });
      // The test releases only after the real adapter's observe callback.
      for (;;) {
        try { await access(attemptId + '.release'); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(10); }
      }
      const output = scenario === 'decision-tool-a' ? a :
        scenario === 'decision-tool-b' ? JSON.stringify(proposal('b')) : 'not JSON';
      await message('final', output);
      return { stopReason: 'end_turn' };
    }
    if (scenario === 'skill-delivery') {
      assert.deepEqual(skillInstructions,[{id:'checks',version:'v1',status:'complete',instructions:'Selected ACP skill'},
        {id:'partial',version:'v2',status:'truncated',instructions:'Partial'},
        {id:'missing',status:'unavailable',reason:'loader_unavailable'}]);
      await message('result','skills delivered');
      return {stopReason:'end_turn'};
    }
    if (scenario === 'host-relay') {
      if (objective === 'slow-relay') {
        await writeFile('relay-ready', '');
        while (true) {
          try { await access('relay-go'); break; }
          catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(10); }
        }
      }
      const permission = await client.request(c.session.requestPermission, {
        sessionId, toolCall: { toolCallId: 'shared-native-id', title: objective, locations: [{ path: '/example' }] },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
      });
      let text = permission.outcome.outcome === 'selected' ? permission.outcome.optionId : 'cancelled';
      if (clientCapabilities?.fs?.readTextFile && text === 'allow') {
        const result = await client.request(c.fs.readTextFile, { sessionId, path: '/example' });
        text += ':' + result.content;
      }
      assert.equal(Boolean(clientCapabilities?.terminal), false);
      if (objective === 'slow-relay') await writeFile('relay-result', text);
      await message('result', JSON.stringify({
        schemaVersion: 1, operationId, decisionId: 'relay-decision', contextCursor: 0, additions: [], cancellations: [],
        finalAssessment: { author: profileId, overall: 'complete', requirements: [], observationRefs: [],
          findingRefs: [], unresolvedQuestions: [], answer: text },
      }));
      return { stopReason: 'end_turn' };
    }
    if (scenario === 'mcp') {
      assert.match(prompt, /Optional MCP context_list and context_fetch/);
      const decision = await retrieveContext(mcpUrl, { attemptId, profileId, operationId, context });
      await message('result', JSON.stringify(decision));
      return { stopReason: 'end_turn' };
    }
    if (scenario === 'mcp-unsupported') assert.match(prompt, /Context retrieval is unavailable/);
    if (reasoningScenario) {
      await writeFile('prompt-effort', effort);
      await client.notify(c.session.update, {sessionId,update: {
        sessionUpdate:'agent_message_chunk', messageId:'effort', content:{type:'text',text:effort},
      }});
      return {stopReason:'end_turn'};
    }
    const anonymous = scenario === 'anonymous-controller';
    const modelId = anonymous ? undefined : 'result';
    await message(anonymous ? undefined : 'progress', 'progress ' + attemptId);
    if (modeScenario) await writeFile('prompt-model', model);
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
    if (scenario === 'permission-description') {
      const toolCall = { toolCallId: 'edit-config', title: 'Write project configuration', kind: 'edit',
        locations: [{ path: '/project/config.json' }], rawInput: { text: 'enabled' },
        content: [{ type: 'diff', path: '/project/config.json', oldText: 'disabled', newText: 'enabled' }],
      };
      await client.notify(c.session.update, { sessionId, update: { sessionUpdate: 'tool_call', ...toolCall } });
      for (const tool of [{ toolCallId: toolCall.toolCallId }, { ...toolCall, toolCallId: 'edit-config-direct' }]) {
        await client.request(c.session.requestPermission, { sessionId, toolCall: tool,
          options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
      }
      await message('result', 'permissions answered');
    } else if (['permission', 'pending-permission', 'permission-disconnect'].includes(scenario)) {
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
      if (scenario === 'controller-contract') {
        const error=context.find(item=>item.ref==='host:decision-error')?.value;
        if (!error) {
          await message(modelId,'not JSON');
          return {stopReason:'end_turn'};
        }
        assert.equal(error.expected,'valid JSON');
      }
      const decision = JSON.stringify({ schemaVersion: 1, decisionId: attemptId + '-decision',
        operationId, contextCursor: cursor, additions: [], cancellations: [], finalAssessment: {
          author: profileId, overall: 'partial', requirements: [], observationRefs: [], findingRefs: [],
          unresolvedQuestions: [], answer: scenario === 'controller-contract' ? '# Result\nПроверка 🧪\n{"value":1}' : 'ACP Controller response',
        } });
      if (anonymous) await client.notify(c.session.update, { sessionId, update: {
        sessionUpdate: 'tool_call', toolCallId: 'inspect-config', title: 'Inspect configuration',
      } });
      await message(modelId, decision.slice(0, 30));
      if (anonymous) await client.notify(c.session.update, { sessionId, update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'inspect-config', status: 'completed',
      } });
      await message(modelId, decision.slice(30));
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
