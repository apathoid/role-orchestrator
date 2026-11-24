import { readInvocationPrompt } from './read-invocation-prompt.js';
import assert from 'node:assert/strict';
import { retrieveContext } from './mcp-client.js';
import { decisionContract } from '../../src/application/decision-instructions.js';
import { controllerInstructions } from '../../src/application/controller-context.js';
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
    if (scenario === 'c20-silent-initialize') {
      await writeFile('c20-setup.ready','');
      return new Promise(()=>{});
    }
    if (scenario === 'init-stderr') {
      await new Promise(resolve => process.stderr.write('Missing ACP fixture configuration\n' + 'x'.repeat(70_000), resolve));
      process.exit(9);
    }
    if (scenario === 'init-rpc-error') throw new RequestError(-32000, 'ACP fixture initialization rejected');
    if (scenario === 'init-exit') process.exit(1);
    return { protocolVersion: scenario === 'bad-version' ? 2 : 1,
      agentCapabilities: { promptCapabilities: { image: scenario === 'image', embeddedContext: scenario === 'resource' }, sessionCapabilities: { close: {} }, mcpCapabilities: { http: scenario === 'mcp' || scenario === 'c18-mcp' || scenario === 'c18-large' || scenario === 'c18n-live' || scenario.startsWith('c18-overflow-') && scenario !== 'c18-overflow-text' } } };
  })
  .onRequest(a.session.new, async ({ params }) => {
    if (scenario === 'c20-silent-session-new') {
      await writeFile('c20-setup.ready','');
      return new Promise(()=>{});
    }
    if (params.cwd !== process.cwd()) throw Error('cwd mismatch');
    if (scenario === 'mcp' || scenario === 'c18-mcp' || scenario === 'c18-large' || scenario === 'c18n-live' || scenario.startsWith('c18-overflow-') && scenario !== 'c18-overflow-text') {
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
    const { objective, attemptId, actionId, kind, profileId, operationId, context, skillInstructions, instructions } = readInvocationPrompt(prompt);
    if (scenario === 'controller-contract' && kind === 'controller') {
      assert.deepEqual(instructions, controllerInstructions);
      assert.equal(instructions.filter(x => x === decisionContract).length, 1);
    }
    const message = (messageId, text) => client.notify(c.session.update, { sessionId, update: {
      sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text },
    } });
    if (scenario === 'c15r-transcript') {
      if(objective==='hold'){await writeFile('c15r-hold-ready','');await stop.promise;return {stopReason:'cancelled'};}
      const host=context.find(item=>item.ref==='host:invocation-context').value;
      const notify=update=>client.notify(c.session.update,{sessionId,update});
      const thought=text=>notify({sessionUpdate:'agent_thought_chunk',content:{type:'text',text}});
      await thought('Inspect');await thought(' the commit.\nRead the diff.');
      await notify({sessionUpdate:'tool_call',toolCallId:'shell',title:'shell',kind:'execute',status:'pending'});
      await notify({sessionUpdate:'tool_call_update',toolCallId:'shell',title:'git show HEAD',status:'in_progress'});
      await notify({sessionUpdate:'tool_call_update',toolCallId:'shell',title:'git show HEAD',status:'in_progress'});
      await notify({sessionUpdate:'tool_call_update',toolCallId:'shell',status:'completed'});
      await notify({sessionUpdate:'tool_call',toolCallId:'read',title:'Read package.json',kind:'read',status:'in_progress'});
      await notify({sessionUpdate:'tool_call_update',toolCallId:'read',status:'failed'});
      await thought('Version only.');
      await message('final',JSON.stringify({schemaVersion:1,operationId,decisionId:attemptId+'-final',contextCursor:host.contextCursor,
        additions:[],cancellations:[],finalAssessment:{author:profileId,overall:'complete',requirements:[],observationRefs:[],findingRefs:[],unresolvedQuestions:[],answer:'Version updated.'}}));
      return {stopReason:'end_turn'};
    }
    if (scenario === 'host-native-ux' || scenario === 'host-chunks') {
      const host = context.find(item => item.ref === 'host:invocation-context')?.value;
      const notify = update => client.notify(c.session.update,{sessionId,update});
      await notify({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Native thought '+actionId}});
      if(scenario==='host-chunks') await notify({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:' continued'}});
      await notify({sessionUpdate:'plan',entries:[{content:'Native plan '+actionId,priority:'medium',status:'pending'}]});
      await notify({sessionUpdate:'tool_call',toolCallId:'shared',title:'Native read',kind:'read',status:'in_progress'});
      await message('progress','Ambiguous progress must not reach client');
      await notify({sessionUpdate:'tool_call_update',toolCallId:'shared',status:'completed'});
      if (kind === 'delegate') {
        if(scenario==='host-chunks'&&actionId==='worker-a'){
          const reply=await client.request(c.session.requestPermission,{sessionId,toolCall:{toolCallId:'shared',title:'Native read'},options:[{optionId:'deny',name:'Deny',kind:'reject_once'}]});
          assert.equal(reply.outcome.optionId,'deny');
        }
        await message('final','Worker result '+actionId);
        return {stopReason:'end_turn'};
      }
      const decision = {schemaVersion:1,operationId,decisionId:attemptId+'-final',contextCursor:host.contextCursor,additions:[],cancellations:[]};
      if (!host.outcomes.length) {
        decision.additions = ['worker-a','worker-b'].map(actionId=>({kind:'delegate',actionId,profileId,objective:actionId,contextRefs:[],dependsOn:[],expectedResult:'Worker result'}));
        decision.waitPolicy = {kind:'all_requested',targets:decision.additions.map(({actionId})=>({kind:'action',id:actionId}))};
      } else decision.finalAssessment = {author:profileId,overall:'complete',requirements:[],observationRefs:[],findingRefs:[],unresolvedQuestions:[],answer:'Native final once'};
      await message('final',JSON.stringify(decision));
      return {stopReason:'end_turn'};
    }
    if (scenario === 'native-subagent-report') {
      assert.equal(kind, 'controller');
      const host = context.find(item => item.ref === 'host:invocation-context').value;
      await client.notify(c.session.update, { sessionId, update: {
        sessionUpdate: 'tool_call', toolCallId: 'native-subagent', title: 'Native subagent',
        kind: 'other', status: 'in_progress',
      } });
      await client.notify(c.session.update, { sessionId, update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'native-subagent', status: 'completed',
        content: [{type:'content',content:{type:'text',text:'Native subagent reported a result'}}],
      } });
      await message('final', JSON.stringify({schemaVersion:1,decisionId:attemptId+'-final',
        operationId,contextCursor:host.contextCursor,additions:[],cancellations:[],
        finalAssessment:{author:profileId,overall:'complete',requirements:[],observationRefs:[],
          findingRefs:[],unresolvedQuestions:[],answer:'Native subagent reported a result'}}));
      return {stopReason:'end_turn'};
    }
    if (scenario.startsWith('decision-tool-')) {
      const host = context.find(item => item.ref === 'host:invocation-context')?.value;
      if (kind === 'delegate') {
        assert.ok(!instructions.includes(decisionContract));
        assert.ok(!prompt.slice(0, prompt.indexOf(marker)).includes('final Controller message'));
        await message('worker-result', 'Native Worker ' + actionId);
        return { stopReason: 'end_turn' };
      }

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
        if (['decision-tool-invalid', 'decision-tool-only', 'decision-tool-prior-anonymous', 'decision-tool-prior-empty'].includes(scenario)) {
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
      if (['decision-tool-progress-b', 'decision-tool-prior-id', 'decision-tool-prior-empty'].includes(scenario)) await message('progress', a);
      else if (scenario === 'decision-tool-prior-anonymous') await message(undefined, a);
      else if (scenario !== 'decision-tool-only') await message('progress', 'Native inspection before Controller result');
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
      if (scenario === 'decision-tool-prior-empty') await message('final', '');
      if (['decision-tool-only', 'decision-tool-prior-id', 'decision-tool-prior-anonymous', 'decision-tool-prior-empty'].includes(scenario)) return { stopReason: 'end_turn' };
      const output = scenario === 'decision-tool-a' ? a :
        ['decision-tool-b', 'decision-tool-progress-b'].includes(scenario) ? JSON.stringify(proposal('b')) : 'not JSON';
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
    if (scenario === 'c15r6-interaction') {
      if(objective==='hold'){await writeFile('c15r6-hold-ready','');await stop.promise;return {stopReason:'cancelled'};}
      const source={sessionId};
      const permission=await client.request(c.session.requestPermission,{...source,
        toolCall:{toolCallId:'native-interaction',title:'Native read permission',status:'pending'},
        options:[{optionId:'deny',name:'Deny',kind:'reject_once'},
          {optionId:'option 1',name:'Allow',kind:'allow_always'}]});
      const selected=permission.outcome.outcome==='selected'?permission.outcome.optionId:'cancelled';
      const ask=client.request(c.elicitation.create,{...source,mode:'form',message:'What should happen next?',
        requestedSchema:{type:'object',title:'Next action',properties:{
          choice:{type:'string',title:'Choose an action',pattern:'^(continue|stop)$',oneOf:[{const:'continue',title:'Continue work'},
            {const:'stop',title:'Stop work'}]},
          note:{type:'string',title:'Optional context',description:'Add details if needed'}
        },required:['choice']}});
      for(let i=0;i<30;i++){
        await client.notify(c.session.update,{sessionId,update:{sessionUpdate:'agent_thought_chunk',
          content:{type:'text',text:'('+i+')'}}});
        if(i%3===0)await sleep(2);
      }
      await client.notify(c.session.update,{sessionId,update:{sessionUpdate:'tool_call',
        toolCallId:'tool-a',title:'Read config',kind:'read',status:'in_progress'}});
      await client.notify(c.session.update,{sessionId,update:{sessionUpdate:'tool_call',
        toolCallId:'tool-b',title:'Read config',kind:'read',status:'in_progress'}});
      await client.notify(c.session.update,{sessionId,update:{sessionUpdate:'tool_call_update',
        toolCallId:'tool-a',status:'completed'}});
      await client.notify(c.session.update,{sessionId,update:{sessionUpdate:'tool_call_update',
        toolCallId:'tool-b',status:'failed'}});
      const form=await ask;
      const answer='### Native answer\nPermission: '+selected+'\nChoice: '+(form.action==='accept'?form.content.choice:form.action);
      await message('final',JSON.stringify({schemaVersion:1,operationId,decisionId:attemptId+'-native',
        contextCursor:context.find(x=>x.ref==='host:invocation-context').value.contextCursor,
        additions:[],cancellations:[],finalAssessment:{author:profileId,overall:'complete',requirements:[],
          observationRefs:[],findingRefs:[],unresolvedQuestions:[],answer}}));
      return {stopReason:'end_turn'};
    }
    if (scenario === 'host-elicitation') {
      assert.equal(clientCapabilities?.elicitation?.url, undefined);
      let text = 'unavailable';
      const form = { mode: 'form', sessionId, message: 'Which value?', requestedSchema: {
        type: 'object', properties: { value: { type: 'string' } }, required: ['value'],
      } };
      if (clientCapabilities?.elicitation?.form) {
        assert.equal((await client.request(c.elicitation.create, { ...form, sessionId: 'wrong' })).action, 'cancel');
        const reply = await client.request(c.elicitation.create, form);
        text = reply.action === 'accept' ? reply.content.value : reply.action;
      } else await assert.rejects(client.request(c.elicitation.create, form), error => error.code === -32601);
      await message('result', JSON.stringify({ schemaVersion: 1, operationId, decisionId: 'elicitation-decision', contextCursor: 0,
        additions: [], cancellations: [], finalAssessment: { author: profileId, overall: 'complete', requirements: [],
          observationRefs: [], findingRefs: [], unresolvedQuestions: [], answer: text } }));
      return { stopReason: 'end_turn' };
    }
    if (scenario === 'native-activity') {
      await message('progress', 'ambiguous progress');
      await client.notify(c.session.update, { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning chunk' } } });
      await client.notify(c.session.update, { sessionId: 'wrong', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'foreign' } } });
      await client.notify(c.session.update, { sessionId, update: { sessionUpdate: 'plan', entries: [{ content: 'inspect', priority: 'medium', status: 'pending' }] } });
      await client.notify(c.session.update, { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'shared', title: 'Read', kind: 'read', status: 'in_progress' } });
      await client.notify(c.session.update, { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'shared', status: 'completed' } });
      for (;;) {
        try { await access(attemptId + '.release'); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(10); }
      }
      await message('final', 'native result');
      return { stopReason: 'end_turn' };
    }
    if (scenario === 'host-extension') {
      const advertised = clientCapabilities?._meta?.roleOrchestratorExtensions;
      assert.equal(clientCapabilities?.fs?.readTextFile ?? false, false);
      assert.equal(clientCapabilities?.terminal ?? false, false);
      assert.equal(clientCapabilities?._meta?.unrelated, undefined);
      let text = 'unavailable';
      if (advertised?.requests.includes('_ro/echo')) {
        assert.deepEqual(advertised, { requests: ['_ro/echo'], notifications: ['_ro/notice'] });
        await assert.rejects(client.request('_ro/unknown', { sessionId }), error => error.code === -32601);
        await assert.rejects(client.request('_ro/echo', { sessionId: 'wrong' }), error => error.code === -32800);
        const payload = { sessionId, nested: { sessionId: 'opaque', arbitrary: [1, null] }, objective };
        await client.notify('_ro/notice', payload);
        const reply = await client.request('_ro/echo', payload);
        text = reply.answer;
      } else {
        await assert.rejects(client.request('_ro/echo', { sessionId }), error => error.code === -32601);
      }
      await message('result', JSON.stringify({ schemaVersion: 1, operationId, decisionId: 'extension-decision', contextCursor: 0,
        additions: [], cancellations: [], finalAssessment: { author: profileId, overall: 'complete', requirements: [],
          observationRefs: [], findingRefs: [], unresolvedQuestions: [], answer: text } }));
      return { stopReason: 'end_turn' };
    }
    if (scenario === 'host-relay' || scenario === 'host-relay-concurrent') {
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
      if(scenario==='host-relay-concurrent'){
        const form=await client.request(c.elicitation.create,{sessionId,mode:'form',toolCallId:'shared-native-id',
          message:'Old worker form',requestedSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}});
        assert.equal(form.action,'accept');text+=':'+form.content.value;
        const payload={sessionId,objective,nested:{sessionId:'opaque'}};
        await client.notify('_ro/notice',payload);
        const ext=await client.request('_ro/echo',payload);text+=':'+ext.answer;
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
    if (scenario === 'c18n-live') {
      assert.equal(kind,'controller');
      assert.match(prompt,/ControllerIntent reference/);
      assert.match(prompt,/evidence_list/);
      const call=async(id,name,args)=>{
        const response=await fetch(mcpUrl,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});
        assert.equal(response.status,200);
        const payload=await response.json();
        return JSON.parse(payload.result.content[0].text);
      };
      const nativeName='c18n-native-inspection';
      await client.notify(c.session.update,{sessionId,update:{
        sessionUpdate:'tool_call',toolCallId:nativeName,title:'Native inspection',kind:'read',status:'in_progress',
      }});
      await client.notify(c.session.update,{sessionId,update:{
        sessionUpdate:'tool_call_update',toolCallId:nativeName,title:'Native inspection',status:'completed',
        content:[{type:'content',content:{type:'text',text:'native source receipt'}}],
      }});
      await client.notify(c.session.update,{sessionId,update:{
        sessionUpdate:'tool_call_update',toolCallId:nativeName,
        content:[{type:'content',content:{type:'text',text:'status-less update'}}],
      }});
      const directory=await call(1,'evidence_list',{});
      assert.equal(directory.kind,'available');
      const records=directory.items.filter(item=>item.provenance?.sourceId===nativeName);
      assert.equal(records.length,3);
      assert.deepEqual(records[0].native,{eventKind:'tool_call',nativeToolCallId:nativeName,
        title:'Native inspection',kind:'read',status:'in_progress'});
      assert.deepEqual(records[1].native,{eventKind:'tool_call_update',nativeToolCallId:nativeName,
        title:'Native inspection',status:'completed'});
      assert.deepEqual(records[2].native,{eventKind:'tool_call_update',nativeToolCallId:nativeName});
      const native=records.find(item=>item.native?.status==='completed');
      assert.ok(native,JSON.stringify(directory));
      assert.match(native.ref,/^evidence:[a-f0-9]{64}$/);
      assert.equal(native.source,'provider_reported');
      assert.equal(native.provenance.kind,'provider_tool');
      const bytes=await call(2,'evidence_fetch',{ref:native.ref});
      assert.equal(bytes.kind,'chunk');
      assert.equal(bytes.item.ref,native.ref);
      assert.deepEqual(bytes.item.native,native.native);
      assert.match(Buffer.from(bytes.base64,'base64').toString('utf8'),/Native inspection/);
      const original=await call(3,'submit_decision',{intent:{finalAssessment:{
        overall:'complete',answer:'before',requirements:[{
          requirementId:'native',status:'fulfilled',observationRefs:['evidence:does-not-exist'],
        }],
      }}});
      assert.equal(original.kind,'proposal_pending');
      assert.equal(original.preflight.kind,'checked');
      assert.match(original.preflight.issues[0].path,/requirements\[0\]\.observationRefs\[0\]/);
      await client.notify(c.session.update,{sessionId,update:{
        sessionUpdate:'tool_call',toolCallId:'after-warning',title:'Native tool after warning',
        kind:'read',status:'completed',
      }});
      const answer='# Нативный результат\n\nПроверено: 🌍 `code`';
      const corrected=await call(4,'submit_decision',{intent:{finalAssessment:{
        overall:'complete',answer,requirements:[{
          requirementId:'native',status:'fulfilled',observationRefs:[native.ref],
        }],
      }},replaces:original.proposalRef});
      assert.equal(corrected.kind,'proposal_pending');
      assert.deepEqual(corrected.preflight.issues,[]);
      await message('post-submission','Native final text is not ControllerIntent');
      return {stopReason:'end_turn'};
    }
    if (scenario === 'c18-large') {
      assert.match(prompt,/ControllerIntent reference/);
      const answer='界'.repeat(650_000);
      const body=JSON.stringify({jsonrpc:'2.0',id:42,method:'tools/call',
        params:{name:'submit_decision',arguments:{intent:{finalAssessment:{overall:'complete',answer}}}}});
      assert.ok(Buffer.byteLength(body,'utf8')>1_900_000&&Buffer.byteLength(body,'utf8')<2*1024*1024);
      const result=await fetch(mcpUrl,{method:'POST',headers:{'content-type':'application/json'},body});
      assert.equal(result.status,200);
      const packet=await result.json();
      assert.equal(JSON.parse(packet.result.content[0].text).kind,'proposal_pending');
      await message('native-last','Native final text is not the decision');
      return {stopReason:'end_turn'};
    }
    if (scenario.startsWith('c18-overflow-')) {
      assert.equal(kind,'controller');
      if (scenario !== 'c18-overflow-text' && scenario !== 'c18-overflow-missing') {
        const response=await fetch(mcpUrl,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:77,method:'tools/call',params:{
            name:'submit_decision',arguments:{intent:{finalAssessment:{overall:'complete',answer:'capture independent'}}}}})});
        const packet=await response.json();
        assert.equal(JSON.parse(packet.result.content[0].text).kind,'proposal_pending');
      }
      if (scenario === 'c18-overflow-text') {
        await message('partial-final','{"finalAssessment":{"overall":"complete",');
      }
      // Many ordinary tool updates, each under the ACP per-frame limit.
      // Their aggregate exceeds the adapter's 1MiB observation capture budget.
      for (let i=0;i<170;i++) await client.notify(c.session.update,{sessionId,update:{
        sessionUpdate:'tool_call_update',toolCallId:'large-native',
        title:'native '+i+' '+'.'.repeat(8000),status:'in_progress',
      }});
      if (scenario === 'c18-overflow-refusal') return {stopReason:'refusal'};
      if (scenario === 'c18-overflow-cancelled') return {stopReason:'cancelled'};
      if (scenario !== 'c18-overflow-text') await message('after-large-native','ordinary native final message');
      return {stopReason:'end_turn'};
    }
    if (scenario === 'c18-text' || scenario === 'c18-mcp') {
      assert.match(prompt, /ControllerIntent reference/);
      if (scenario === 'c18-text') {
        await message('intent-final',JSON.stringify({finalAssessment:{overall:'complete',
          answer:'C18 text fallback'}}));
        return {stopReason:'end_turn'};
      }
      /** @param {number} id @param {string} name @param {unknown} args */
      const call = async (id,name,args) => {
        const response=await fetch(mcpUrl,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})});
        assert.equal(response.status,200);
        const envelope=await response.json();
        return {envelope,value:JSON.parse(envelope.result.content[0].text)};
      };
      const first=await call(1,'submit_decision',{intent:{finalAssessment:{
        overall:'unrecognized',answer:'invalid first'}}});
      assert.equal(first.envelope.result.isError,true);
      assert.equal(first.value.kind,'rejected');
      // Native tool and model activity remains available after invalid submission.
      const nativeTool=await call(2,'context_list',{});
      assert.equal(nativeTool.value.kind,'available');
      await client.notify(c.session.update,{sessionId,update:{
        sessionUpdate:'tool_call',toolCallId:'after-invalid',title:'Native activity after invalid',
        kind:'read',status:'completed',
      }});
      // An intermediate valid Action must NOT be admitted, reserved or
      // dispatched while the agent continues its native tool loop.
      const initial=await call(3,'submit_decision',{intent:{
        additions:[{actionId:'must-not-run',kind:'delegate',profileId,objective:'Should not dispatch',
          expectedResult:'Not applicable'}],
        waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:'must-not-run'}]},
      }});
      assert.equal(initial.value.kind,'proposal_pending');
      assert.equal((await call(4,'context_list',{})).value.kind,'available');
      // Unrelated proposals conflict, but the native session is still live.
      const conflicting=await call(5,'submit_decision',{intent:{finalAssessment:{
        overall:'complete',answer:'unrelated'}}});
      assert.equal(conflicting.value.kind,'rejected');
      assert.equal((await call(6,'context_list',{})).value.kind,'available');
      const replacement=await call(7,'submit_decision',{intent:{finalAssessment:{
        overall:'complete',answer:'new candidate'}},replaces:initial.value.proposalRef});
      assert.equal(replacement.value.kind,'proposal_pending');
      assert.equal((await call(8,'context_list',{})).value.kind,'available');
      await message('not-decision','Ordinary native final text is not a JSON Decision');
      return {stopReason:'end_turn'};
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
