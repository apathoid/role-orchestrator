import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../src/main/runtime.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

test('startup failure unwinds acquired plugin and store; startup never opens a model session', () =>
  withOwnedRun('C10-runtime', async directory => {
    const marker = join(directory, 'lifecycle');
    const module = join(directory, 'fixture.mjs');
    await writeFile(module, `
      import { appendFile } from 'node:fs/promises';
      const mark = text => appendFile(${JSON.stringify(marker)}, text);
      export const manifest = { id: 'test', version: '1', apiVersion: 1, exports: ['createProvider'] };
      export async function createProvider({providerId, onClose}) {
        await mark('create\\n');
        onClose(() => mark('close\\n'));
        return {
          describe: async () => ({ providerId, maxConcurrency: null, capabilities: {} }),
          open: () => mark('open\\n'), invoke() {}, cancel() {}, close() {},
        };
      }
    `);
    const configuration = JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'test' } }, plugins: [{ id: 'test', module }],
      storage: { directory: join(directory, 'state') },
    });
    await assert.rejects(openRuntime({ configuration, launch: { controllerProfile: 'missing' } }),
      { code: 'INVALID_CONFIGURATION', path: '$.controllerProfile' });
    assert.equal(await readFile(marker, 'utf8'), 'create\nclose\n');
    const runtime = await openRuntime({ configuration });
    assert.equal(await readFile(marker, 'utf8'), 'create\nclose\ncreate\n');
    await runtime.close();
    await runtime.close();
    assert.equal(await readFile(marker, 'utf8'), 'create\nclose\ncreate\nclose\n');
  }));

test('public API isolates stores, deduplicates requests and unsubscribes', () =>
  withOwnedRun('C10-api', async directory => {
    const { openOrchestrator, OrchestrationError } = await import('../../src/main/index.js');
    const { request } = await import('../fixtures/core.js');
    const configuration = JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture' } },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../fixtures/host-plugin.js', import.meta.url)) }],
    });
    const [first, second] = await Promise.all(['first', 'second'].map(name =>
      openOrchestrator({ configuration, stateDirectory: join(directory, name) })));
    try {
      const input = request({ configurationRef: first.configurationRef });
      const events = [];
      const unsubscribe = first.subscribe(event => events.push(event));
      const [submission, duplicate, independent] = await Promise.all([
        first.submit(input), first.submit(input), second.submit(input),
      ]);
      assert.equal(submission.operation.operationId, duplicate.operation.operationId);
      assert.notEqual(submission.operation.operationId, independent.operation.operationId);
      assert.equal((await submission.completion).assessment.answer, 'Ответ: Literal task');
      assert.equal((await independent.completion).status, 'finished');
      assert.ok(events.length > 1);
      assert.ok(events.every(event => event.schemaVersion === 1 && event.operationId === submission.operation.operationId));
      unsubscribe();
      const count = events.length;
      await (await first.submit({ ...input, requestId: 'next' })).completion;
      assert.equal(events.length, count);
      await assert.rejects(first.submit({ ...input, text: 'Conflict' }), error =>
        error instanceof OrchestrationError && error.code === 'IDENTITY_CONFLICT');
      await assert.rejects(second.inspect(submission.operation.operationId), { code: 'INVALID_PROPOSAL', path: '$.operationId' });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }));

test('closing a running API instance persists shutdown and refuses new submissions', () =>
  withOwnedRun('C10-shutdown', async directory => {
    const { openOrchestrator } = await import('../../src/main/index.js');
    const { request } = await import('../fixtures/core.js');
    const configuration = JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture' } },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../fixtures/host-plugin.js', import.meta.url)) }],
    });
    const first = await openOrchestrator({ configuration, stateDirectory: directory });
    const started = Promise.withResolvers();
    first.subscribe(event => { if (event.eventName === 'controller.requested') started.resolve(); });
    const input = request({ text: 'hold', configurationRef: first.configurationRef });
    const pending = await first.submit(input);
    await started.promise;
    const closed = first.close();
    await assert.rejects(first.submit({ ...input, requestId: 'new' }), { code: 'CANCELLED' });
    await closed;
    assert.equal((await pending.completion).cancellation, 'shutdown');
    const reopened = await openOrchestrator({ configuration, stateDirectory: directory });
    try {
      const saved = await reopened.inspect(pending.operation.operationId);
      assert.equal(saved.status, 'cancelled');
      assert.equal(saved.cancellation, 'shutdown');
      assert.ok(saved.attempts.every(attempt => attempt.status === 'terminal'));
    } finally { await reopened.close(); }
  }));

test('C11 review P2-2: runtime trace uses trusted launch env secrets for direct and Host dispatch', () =>
  withOwnedRun('C11-trace-secret', async directory => {
    const { dispatchCommand } = await import('../../src/hosts/commands.js');
    const { request } = await import('../fixtures/core.js');
    const secret = 'C11-SECRET-VALUE-' + Date.now();
    const old = process.env.C11_REVIEW_TRACE;
    process.env.C11_REVIEW_TRACE = secret;
    const profileId = 'primary-' + secret;
    const configuration = JSON.stringify({
      schemaVersion: 1, controllerProfile: profileId,
      profiles: { [profileId]: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture',
        launch: { command: '/unused/executable', env: { TOKEN: { fromEnv: 'C11_REVIEW_TRACE' } } } } },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../fixtures/host-plugin.js', import.meta.url)) }],
    });
    try {
      const runtime = await openRuntime({ configuration, stateDirectory: join(directory, 'state') });
      try {
        const input = request({ configurationRef: runtime.api.configurationRef });
        const state = await (await runtime.api.submit(input)).completion;
        const trace = await runtime.api.trace(state.operationId);
        assert.ok(!JSON.stringify(trace).includes(secret));
        assert.equal(trace.attempts[0].profileId, 'primary-[REDACTED]');
        const exported = await dispatchCommand(runtime.api, {
          action: 'export-diagnostics', requestId: 'export', operationId: state.operationId,
        });
        assert.deepEqual(exported, trace);
      } finally { await runtime.close(); }
    } finally {
      if (old === undefined) delete process.env.C11_REVIEW_TRACE;
      else process.env.C11_REVIEW_TRACE = old;
    }
  }));

test('C20 runtime resume preserves persisted authority under new defaults/project preferences and honors explicit trusted override',()=>withOwnedRun('C20-runtime-defaults',async directory=>{
  const {request}=await import('../fixtures/core.js');
  const configuration={
    schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},
    providers:{test:{adapter:'host-fixture'}},
    plugins:[{id:'host-fixture',module:fileURLToPath(new URL('../fixtures/host-plugin.js',import.meta.url))}],
  };
  const stateDirectory=join(directory,'state');
  const first=await openRuntime({configuration:JSON.stringify({...configuration,resources:{
    maxConcurrentInvocations:2,maxInvocationsPerOperation:7,invocationTimeoutMs:10000}}),stateDirectory});
  const previous=[];
  try{
    for(let i=0;i<3;i++){
      const state=await(await first.api.submit(request({requestId:'old-'+i,text:'clarify',configurationRef:first.configurationRef}))).completion;
      assert.equal(state.waiting.kind,'question');
      assert.deepEqual(state.limits,{maxInvocations:7,maxConcurrentInvocations:2});
      previous.push(state);
    }
  }finally{await first.close();}
  const second=await openRuntime({configuration:JSON.stringify(configuration),stateDirectory});
  try{
    const resumed=await(await second.api.resume(previous[0].operationId,{requestId:'answer-0',questionId:previous[0].waiting.questionId,text:'answer'})).completion;
    assert.equal(resumed.status,'finished');
    assert.deepEqual(resumed.limits,{maxInvocations:7,maxConcurrentInvocations:2});
    const fresh=await(await second.api.submit(request({requestId:'new-defaults',configurationRef:second.configurationRef,text:'settings'}))).completion;
    assert.deepEqual(fresh.limits,{maxInvocations:null,maxConcurrentInvocations:5});
    assert.deepEqual(JSON.parse(fresh.assessment.answer),['primary',null]);
  }finally{await second.close();}
  const project=join(directory,'.role-orchestrator.json');
  await writeFile(project,JSON.stringify({schemaVersion:1,resources:{maxConcurrentInvocations:4,maxInvocationsPerOperation:10}}));
  const third=await openRuntime({configuration:JSON.stringify(configuration),stateDirectory,project:{path:project}});
  try{
    const resumed=await(await third.api.resume(previous[1].operationId,{requestId:'answer-1',questionId:previous[1].waiting.questionId,text:'answer'})).completion;
    assert.equal(resumed.status,'finished');
    assert.deepEqual(resumed.limits,{maxInvocations:7,maxConcurrentInvocations:2});
    const fresh=await(await third.api.submit(request({requestId:'new-project',configurationRef:third.configurationRef}))).completion;
    assert.deepEqual(fresh.limits,{maxInvocations:10,maxConcurrentInvocations:4});
  }finally{await third.close();}
  const fourth=await openRuntime({configuration:JSON.stringify(configuration),stateDirectory,
    launch:{resources:{maxConcurrentInvocations:5,maxInvocationsPerOperation:null}}});
  try{
    const resumed=await(await fourth.api.resume(previous[2].operationId,{requestId:'answer-2',questionId:previous[2].waiting.questionId,text:'answer'})).completion;
    assert.equal(resumed.status,'finished');
    assert.deepEqual(resumed.limits,{maxInvocations:null,maxConcurrentInvocations:5});
  }finally{await fourth.close();}
}));


test('C23 A127 API owners overlap in one process; closing/failing one does not close another and physical aliases share writer exclusion',
  { timeout: 15_000 }, () => withOwnedRun('C23-api',async directory=>{
    const {openOrchestrator}=await import('../../src/main/index.js');
    const {request}=await import('../fixtures/core.js');
    const configuration=JSON.stringify({
      schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},
      providers:{test:{adapter:'host-fixture'}},
      plugins:[{id:'host-fixture',module:fileURLToPath(new URL('../fixtures/host-plugin.js',import.meta.url))}],
    });
    await assert.rejects(openOrchestrator({configuration}),{code:'INVALID_CONFIGURATION'});
    const stateA=join(directory,'a'),stateB=join(directory,'b');
    const [first,second]=await Promise.all([stateA,stateB].map(stateDirectory=>openOrchestrator({configuration,stateDirectory})));
    async function active(api,id) {
      for(let i=0;i<200;i++){
        const state=await api.inspect(id);
        if(state.attempts.some(attempt=>attempt.status==='dispatched'))return state;
        await delay(10);
      }
      assert.fail('No dispatched attempt '+id);
    }
    try{
      const alias=join(directory,'alias');await symlink(stateA,alias);
      await assert.rejects(openOrchestrator({configuration,stateDirectory:alias}),{code:'STATE_STORE_IN_USE'});
      const input=request({requestId:'same',text:'hold',configurationRef:first.configurationRef});
      const [a,b]=await Promise.all([first.submit(input),second.submit(input)]);
      await Promise.all([active(first,a.operation.operationId),active(second,b.operation.operationId)]);
      assert.notEqual(a.operation.operationId,b.operation.operationId);
      await first.close();
      assert.equal((await a.completion).cancellation,'shutdown');
      await assert.rejects(openRuntime({configuration,stateDirectory:join(directory,'failed'),launch:{controllerProfile:'missing'}}),{code:'INVALID_CONFIGURATION'});
      assert.equal((await active(second,b.operation.operationId)).status,'active');
      await second.cancel(b.operation.operationId);
      assert.equal((await b.completion).status,'cancelled');
      const final=await(await second.submit({...input,requestId:'next',text:'still active'})).completion;
      assert.equal(final.assessment.answer,'Ответ: still active');
    }finally{await Promise.all([first.close(),second.close()]);}
  }));

test('C24-R accepted generation records effective default Controller even without features',()=>withOwnedRun('C24R-settings',async directory=>{
  const {request}=await import('../fixtures/core.js');
  const configuration=JSON.stringify({schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},
    providers:{test:{adapter:'host-fixture'}},plugins:[{id:'host-fixture',module:fileURLToPath(new URL('../fixtures/host-plugin.js',import.meta.url))}]});
  const runtime=await openRuntime({configuration,stateDirectory:directory});
  try{
    const result=await runtime.api.submit(request({configurationRef:runtime.api.configurationRef}));
    assert.equal(result.operation.acceptedSettings?.profileId,'primary');
    assert.equal((await result.completion).acceptedSettings?.profileId,'primary');
  }finally{await runtime.close();}
}));


test('C24-R technical recovery keeps accepted Controller despite a new default and legacy global approval hash',()=>withOwnedRun('C24R-recover',async directory=>{
  const {request}=await import('../fixtures/core.js');
  const {createOperation}=await import('../../src/core/operation.js');
  const {createLocalStateStore}=await import('../../src/adapters/state/local-store.js');
  const {mkdir}=await import('node:fs/promises');
  const configuration={schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'},other:{provider:'test',model:'fixture'}},providers:{test:{adapter:'host-fixture'}},plugins:[{id:'host-fixture',module:fileURLToPath(new URL('../fixtures/host-plugin.js',import.meta.url))}]};
  const first=await openRuntime({configuration:JSON.stringify(configuration),stateDirectory:join(directory,'first')});
  let accepted;
  try{const submission=await first.api.submit(request({configurationRef:first.configurationRef,text:'settings'}));accepted=submission.operation;await submission.completion;}finally{await first.close();}
  const stateDirectory=join(directory,'recovery');await mkdir(stateDirectory);const store=createLocalStateStore(stateDirectory);await store.open();
  try{
    const restored=createOperation('recovery-op',accepted.request,accepted.authorityRef,accepted.limits,accepted.acceptedAt,{...accepted.acceptedSettings,approvalMappingsRef:'legacy-global-hash'});
    assert.equal((await store.commit(restored.operationId,null,restored)).kind,'committed');
  }finally{await store.close();}
  const second=await openRuntime({configuration:JSON.stringify({...configuration,controllerProfile:'other'}),stateDirectory});
  try{const result=await(await second.api.resume('recovery-op')).completion;assert.equal(result.status,'finished');assert.deepEqual(JSON.parse(result.assessment.answer),['primary',null]);assert.equal(result.attempts[0].route.profileId,'primary');}finally{await second.close();}
}));

test('C24-R settings inspection closes trusted plugin factory without opening execution or Store',()=>withOwnedRun('C24R-inspection',async directory=>{
  const {readUserSettings}=await import('../../src/main/runtime.js');
  const {access}=await import('node:fs/promises');
  const marker=join(directory,'lifecycle');const module=join(directory,'fixture.mjs');
  await writeFile(module,`import {appendFile} from 'node:fs/promises';const mark=text=>appendFile(${JSON.stringify(marker)},text+'\\n');export const manifest={id:'test',version:'1',apiVersion:1,exports:['createProvider']};export async function createProvider({providerId,onClose}){await mark('create');onClose(()=>mark('close'));return {describe:async()=>{await mark('describe');return {providerId,maxConcurrency:null,capabilities:{}}},open:()=>mark('open'),invoke:()=>mark('invoke'),cancel(){},close(){}};}`);
  const configuration=JSON.stringify({schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},providers:{test:{adapter:'test'}},plugins:[{id:'test',module}],storage:{directory:join(directory,'state')}});
  const view=await readUserSettings(configuration,directory,directory);assert.equal(view.controllerProfile.current,'primary');
  const calls=(await readFile(marker,'utf8')).trim().split('\n');assert.equal(calls[0],'create');assert.equal(calls.at(-1),'close');assert.ok(calls.includes('describe'));assert.ok(!calls.includes('open')&&!calls.includes('invoke'));await assert.rejects(access(join(directory,'state')),{code:'ENOENT'});
}));

test('C24-R2 T05/T06 recovered accepted Worker checks only its admitted approval mapping before native dispatch',{timeout:60000},()=>withOwnedRun('C24R2-worker-approval',async directory=>{
  const {request}=await import('../fixtures/core.js');
  const {createOperation,applyEvent}=await import('../../src/core/operation.js');
  const {createLocalStateStore}=await import('../../src/adapters/state/local-store.js');
  const {mkdir}=await import('node:fs/promises');
  const native=fileURLToPath(new URL('../fixtures/c24-native-agent.js',import.meta.url));
  const configuration={schemaVersion:1,controllerProfile:'primary',
    profiles:{primary:{provider:'test',model:'fixture',features:{approvalMode:'controller'}},
      worker:{provider:'test',model:'fixture',features:{approvalMode:'worker'}},
      unused:{provider:'test',model:'fixture',features:{approvalMode:'unused'}}},
    providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[native,'approval-recovery']},featureBindings:{approvalMode:{kind:'configOption',id:'opaque-approval'}}}},
    features:{approvalMode:Object.fromEntries(['controller','worker','unused'].map(name=>[name,{default:'review',options:[{id:'review',nativeValue:'native-review'}]}]))}};
  const open=(config,stateDirectory)=>openRuntime({configuration:JSON.stringify(config),configurationDirectory:directory,stateDirectory});
  const first=await open(configuration,join(directory,'original'));
  let original;
  try{
    original=await(await first.api.submit(request({configurationRef:first.api.configurationRef,workspaceContext:{cwd:directory}}))).completion;
    assert.equal(original.status,'finished');
    const admitted=original.events.find(e=>e.kind==='controller.responded'&&e.admissions?.some(a=>a.kind==='accepted')).admissions[0];
    assert.equal(admitted.approval.setting.nativeValue,'native-review');
    assert.equal(original.attempts.find(a=>a.actionId==='c24-approval-worker').route.approvalMode.nativeValue,'native-review');
  }finally{await first.close();}
  const wire=async()=> (await readFile(join(directory,'c24-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  for(const [changed,reserved,expected] of [['worker',false,false],['worker',true,false],['unused',true,true]]){
    const config=structuredClone(configuration);
    config.features.approvalMode[changed].options[0].nativeValue='native-open';
    const stateDirectory=join(directory,changed+'-'+reserved);await mkdir(stateDirectory);
    let restored=createOperation(original.operationId,original.request,original.authorityRef,original.limits,original.acceptedAt,original.acceptedSettings);
    for(const event of original.events){
      const applied=applyEvent(restored,event);
      assert.equal(applied.kind,'applied');
      restored=applied.state;
      if(!reserved&&event.kind==='controller.responded'&&event.admissions?.some(a=>a.kind==='accepted'))break;
      if(reserved&&event.kind==='attempt.reserved'&&event.actionId==='c24-approval-worker')break;
    }
    const store=createLocalStateStore(stateDirectory);await store.open();
    try{assert.equal((await store.commit(restored.operationId,null,restored)).kind,'committed');}finally{await store.close();}
    const count=(await wire()).length;
    const second=await open(config,stateDirectory);
    try{
      const result=await(await second.api.resume(restored.operationId)).completion;
      assert.equal(result.status,'finished');
      const attempt=result.attempts.find(a=>a.actionId==='c24-approval-worker');
      assert.equal(attempt.status,'terminal');
      const delegated=(await wire()).slice(count).filter(item=>item.kind==='delegate');
      if(expected){
        assert.equal(delegated.length,1);
        assert.equal(delegated[0].settings['opaque-approval'],'native-review');
        assert.equal(attempt.route.approvalMode.nativeValue,'native-review');
      }else{
        assert.equal(delegated.length,0);
        assert.equal(attempt.dispatchCertainty,'not_sent');
        assert.equal(attempt.outcome.diagnostics[0].code,'CAPABILITY_UNAVAILABLE');
        assert.ok(result.events.some(e=>e.kind==='attempt.outcome'&&e.observations?.some(o=>o.value?.reason==='accepted_worker_setting_changed')));
      }
    }finally{await second.close();}
  }
}));
test('C24-R2 T13 ordered-capable plugin advertises unknown input only when it declares negotiation',()=>withOwnedRun('C24R2-input-capability',async directory=>{
  const {request}=await import('../fixtures/core.js');
  const module=join(directory,'fixture.mjs');
  await writeFile(module,`export const manifest={id:'capability-fixture',version:'1',apiVersion:1,exports:['createProvider']};
    export function createProvider({providerId}){
      return {supportsOrderedContent:true,describe:async()=>({providerId,maxConcurrency:null,capabilities:{'input.image':{support:'unknown',source:'configured'},'input.audio':{support:'supported',source:'configured'}}}),
        open:()=>{throw new Error('must not open')},invoke:()=>{throw new Error('must not invoke')},cancel(){},close(){}};
    }`);
  const configuration=JSON.stringify({schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},
    providers:{test:{adapter:'capability-fixture'}},plugins:[{id:'capability-fixture',module}]});
  const runtime=await openRuntime({configuration,stateDirectory:join(directory,'state')});
  try{
    const capabilities=await runtime.api.inputCapabilities();
    assert.equal(capabilities.image,false);assert.equal(capabilities.audio,true);
    const {text,...base}=request({configurationRef:runtime.api.configurationRef});
    const result=await(await runtime.api.submit({...base,content:[{kind:'image',mediaType:'image/png',data:'AQID',encoding:'binary'}]})).completion;
    assert.equal(result.status,'waiting');
    assert.equal(result.waiting.reason.code,'CAPABILITY_UNAVAILABLE');
    assert.match(result.waiting.reason.resource,/user_content:capability_unavailable:input.image/);
    assert.equal(result.attempts[0].dispatchCertainty,'not_sent');
  }finally{await runtime.close();}
}));
