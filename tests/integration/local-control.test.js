import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cliOwner } from '../../src/hosts/cli-owner.js';
import { createCliInput } from '../../src/hosts/cli-input.js';
import { PassThrough, Writable } from 'node:stream';
import { cliPresentation } from '../../src/hosts/cli-presentation.js';
import { pollAttachedInputs } from '../../src/hosts/attached-input.js';
import { callControl, openControl, readDescriptor } from '../../src/hosts/local-control.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const entry = fileURLToPath(new URL('../../src/main/cli.js', import.meta.url));
const localSocketCheck = process.env.C10_SOCKET_UNAVAILABLE === '1' ? 'UNVERIFIED: host denies Unix-domain sockets' : false;

test('control validates token/version and shares an in-flight result after lost response', { skip: localSocketCheck }, () =>
  withOwnedRun('C10-control-wire', async directory => {
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    let executions = 0;
    const server = await openControl(directory, 'config', async (_command, accepted) => {
      executions++;
      accepted('operation');
      started.resolve();
      await gate.promise;
      return { value: 42 };
    });
    try {
      const descriptor = await readDescriptor(directory);
      const send = (fields = {}) => {
        const socket = createConnection(descriptor.path);
        socket.once('connect', () => socket.write(JSON.stringify({
          version: 1, token: descriptor.token, requestId: 'same', action: 'run',
          payload: { configurationRef: 'config', text: 'task' }, ...fields,
        }) + '\n'));
        return socket;
      };
      const wrong = send({ version: 2 });
      assert.equal(JSON.parse((await once(wrong, 'data'))[0]).error.code, 'CONTROL_INVALID');
      const forged = send({ token: 'wrong' });
      assert.equal(JSON.parse((await once(forged, 'data'))[0]).error.code, 'CONTROL_UNAUTHORIZED');
      const disconnected = send();
      await started.promise;
      disconnected.destroy();
      const retry = callControl(descriptor, 'config', { action: 'run', requestId: 'same', text: 'task' });
      gate.resolve();
      assert.deepEqual(await retry, { value: 42 });
      assert.equal(executions, 1);
    } finally {
      gate.resolve();
      await server.close();
    }
    assert.equal(await readDescriptor(directory), undefined);
  }));

test('separate CLI processes share one owner and cancel only the foreground operation', { timeout: 15_000, skip: localSocketCheck }, () =>
  withOwnedRun('C10-control-cli', async cwd => {
    const config = join(cwd, 'config.json');
    const directory = join(cwd, 'state');
    await mkdir(directory);
    await writeFile(join(directory, '.control-v1.json'), JSON.stringify({ path: join(cwd, 'gone'), token: 'stale', pid: 1 }));
    await writeFile(config, JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture' } }, storage: { directory },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../fixtures/host-plugin.js', import.meta.url)) }],
    }));
    function call(...args) {
      const process = spawn(globalThis.process.execPath, [entry, ...args, '--config', config, '--format', 'json'], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      process.stdout.on('data', bytes => { stdout += bytes; });
      process.stderr.on('data', bytes => { stderr += bytes; });
      const completed = once(process, 'close').then(([code]) => {
        assert.equal(code, 0, stderr);
        return JSON.parse(stdout);
      });
      completed.catch(() => {});
      return { process, completed };
    }
    const first = call('run', 'hold', '--request-id', 'held');
    const second = call('run', 'hold second', '--request-id', 'second');
    try {
      let operations = [];
      for (let attempt = 0; attempt < 120; attempt++) {
        const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}.*\.json$/u.test(name));
        operations = (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8').then(JSON.parse)
          .catch(error => { if (error.code !== 'ENOENT') throw error; })))).filter(Boolean);
        if (operations.filter(item => item.attempts.some(attempt => attempt.status === 'dispatched')).length === 2) break;
        await delay(25);
      }
      assert.equal(operations.length, 2);
      const secondId = operations.find(item => item.request.requestId === 'second').operationId;
      const descriptor = await readDescriptor(directory);
      assert.ok([first.process.pid, second.process.pid].includes(descriptor?.pid));
      first.process.kill('SIGINT');
      assert.equal((await call('cancel', secondId).completed).status, 'cancelled');
      const [cancelled, unrelated] = await Promise.all([first.completed, second.completed]);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.cancellation, 'client');
      assert.equal(unrelated.cancellation, 'user');
      assert.equal(await readDescriptor(directory), undefined);
      assert.equal((await call('cancel', cancelled.operationId).completed).status, 'no_live_execution');
    } finally { first.process.kill('SIGKILL'); second.process.kill('SIGKILL'); }
  }));

test('shutdown rejects new work while inspect, cancel and redelivery can drain accepted work',
  { timeout: 10_000, skip: localSocketCheck }, () => withOwnedRun('C10-control-drain', async directory => {
    const started = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const calls = [];
    const server = await openControl(directory, 'config', async (command, accepted) => {
      calls.push(command.action);
      if (command.action === 'run') {
        accepted('operation');
        started.resolve();
        await cancelled.promise;
      }
      if (command.action === 'cancel') cancelled.resolve();
      return { action: command.action };
    });
    try {
      const descriptor = await readDescriptor(directory);
      const run = { action: 'run', requestId: 'accepted', text: 'task' };
      const inFlight = callControl(descriptor, 'config', run);
      await started.promise;
      const closing = server.close();
      const attached = Promise.withResolvers();
      const retry = callControl(descriptor, 'config', run, attached.resolve);
      await attached.promise;
      await assert.rejects(callControl(descriptor, 'config', { ...run, requestId: 'new' }), { code: 'CONTROL_CLOSING' });
      await assert.rejects(callControl(descriptor, 'config', { action: 'resume', requestId: 'resume', operationId: 'operation' }),
        { code: 'CONTROL_CLOSING' });
      assert.deepEqual(await callControl(descriptor, 'config', { action: 'inspect', requestId: 'read', operationId: 'operation' }),
        { action: 'inspect' });
      assert.deepEqual(await callControl(descriptor, 'config', { action: 'cancel', requestId: 'cancel', operationId: 'operation' }),
        { action: 'cancel' });
      assert.deepEqual(await Promise.all([inFlight, retry]), [{ action: 'run' }, { action: 'run' }]);
      await closing;
      assert.deepEqual(calls, ['run', 'inspect', 'cancel']);
      assert.equal(await readDescriptor(directory), undefined);
    } finally {
      cancelled.resolve();
      await server.close();
    }
  }));

test('a peer waits for slow CLI initialization and uses its own workspace configuration',
  { timeout: 15_000, skip: localSocketCheck }, () => withOwnedRun('C10-control-startup', async cwd => {
    const config = join(cwd, 'config.json');
    const directory = join(cwd, 'state');
    const module = join(cwd, 'slow-provider.mjs');
    const started = join(cwd, 'factory-started');
    const release = join(cwd, 'factory-release');
    const fixture = new URL('../fixtures/host-plugin.js', import.meta.url).href;
    await writeFile(module, `
      import { access, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      import { createProvider as fixture } from ${JSON.stringify(fixture)};
      export { manifest } from ${JSON.stringify(fixture)};
      export async function createProvider(options) {
        await writeFile(${JSON.stringify(started)}, '');
        while (true) {
          try { await access(${JSON.stringify(release)}); break; }
          catch (error) { if (error.code !== 'ENOENT') throw error; await delay(10); }
        }
        return fixture(options);
      }
    `);
    await writeFile(config, JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary',
      profiles: Object.fromEntries(['primary', 'a', 'b'].map(id => [id, { provider: 'test', model: 'fixture' }])),
      providers: { test: { adapter: 'host-fixture' } }, storage: { directory },
      plugins: [{ id: 'host-fixture', module }],
    }));
    for (const [index, id] of ['a', 'b'].entries()) {
      await mkdir(join(cwd, id));
      await writeFile(join(cwd, id, '.role-orchestrator.json'), JSON.stringify({
        schemaVersion: 1, controllerProfile: id, resources: { invocationTimeoutMs: 3000 + index, maxInvocationsPerOperation: 3 - index },
      }));
    }
    const children = [];
    function launch(...args) {
      const child = spawn(process.execPath, [entry, ...args, '--config', config, '--format', 'json'], { cwd });
      children.push(child);
      let output = '';
      let stderr = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const done = once(child, 'close').then(([code]) => ({ code, output, stderr }));
      return { child, done };
    }
    const owner = launch('run', '--cwd', join(cwd, 'a'), 'hold');
    try {
      for (let i = 0; ; i++) {
        if (await readFile(started, 'utf8').then(() => true, error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        })) break;
        assert.ok(i < 200, 'provider factory did not start');
        await delay(10);
      }
      const peer = launch('run', '--cwd', join(cwd, 'b'), 'settings');
      // The startup hold exceeds the previous retry window.
      await delay(1700);
      assert.equal(peer.child.exitCode, null);
      assert.equal((await readDescriptor(directory)).pid, owner.child.pid);
      await writeFile(release, '');
      const result = await peer.done;
      assert.equal(result.code, 0, result.stderr);
      const operation = JSON.parse(result.output);
      assert.deepEqual(JSON.parse(operation.assessment.answer), ['b', 3001]);
      assert.equal(operation.resources.remaining, 1);
      owner.child.kill('SIGINT');
      const stopped = await owner.done;
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.equal(JSON.parse(stopped.output).cancellation, 'client');
    } finally { for (const child of children) child.kill('SIGKILL'); }
  }));

test('live control delivers scoped notices and requires the work answer binding', { skip: localSocketCheck }, () =>
  withOwnedRun('C13-control-stream', async directory => {
    const gate = Promise.withResolvers(), started = Promise.withResolvers(), seen = Promise.withResolvers();
    const listeners = new Map();
    let executions = 0, answers = 0, ownerKey;
    const server = await openControl(directory, 'config', async (_command, accepted) => {
      executions++; accepted('op'); started.resolve(); await gate.promise; return { done: true };
    }, undefined, {
      subscribe(operationId, listener) { listeners.set(operationId, listener); return () => listeners.delete(operationId); },
      pending: operationId => [{ operationId, requestId: 'question' }],
      respond: reply => { answers++; return { kind: 'accepted', reply }; },
    });
    try {
      const descriptor = await readDescriptor(directory);
      const run = callControl(descriptor, 'config', { action: 'run', requestId: 'work', text: 'task' },
        (_id, key) => { ownerKey = key; }, undefined, { notice: seen.resolve, interactive:true });
      await started.promise;
      await listeners.get('op')({ channel: 'activity', event: { kind: 'reasoning', operationId: 'op', attemptId: 'a', sequence: 1, payload: 'native' } });
      assert.equal((await seen.promise).event.payload, 'native');
      assert.deepEqual(await callControl(descriptor, 'config', { action: 'pending', requestId: 'p', operationId: 'op' }), [{ operationId: 'op', requestId: 'question' }]);
      const answer = { action: 'answer', requestId: 'answer', operationId: 'op', ownerRequestId: 'work', answerKey: 'wrong',
        reply: { requestId: 'question', operationId: 'op', attemptId: 'a', providerRequestId: 'native', payload: { action: 'accept' } } };
      await assert.rejects(callControl(descriptor, 'config', answer), { code: 'CONTROL_INTERACTION_OWNER_REQUIRED' });
      const correct = { ...answer, requestId: 'correct', answerKey: ownerKey };
      assert.equal((await callControl(descriptor, 'config', correct)).kind, 'accepted');
      assert.equal((await callControl(descriptor, 'config', correct)).kind, 'accepted');
      assert.equal(answers, 1);
      gate.resolve();
      assert.deepEqual(await run, { done: true });
      assert.equal(executions, 1);
    } finally { gate.resolve(); await server.close(); }
  }));

test('observer disconnect and unread socket do not cancel work or prevent owner shutdown', {timeout: 5000, skip: localSocketCheck}, () =>
  withOwnedRun('C13-observer', async directory => {
    const gate = Promise.withResolvers(), started = Promise.withResolvers(), observerReady = Promise.withResolvers();
    const listeners = new Map();
    const server = await openControl(directory, 'config', async (_command, accepted) => {
      accepted('op'); started.resolve(); await gate.promise; return {done:true};
    }, undefined, {
      subscribe(operationId, listener) {
        listeners.set(operationId, listener); observerReady.resolve();
        return () => listeners.delete(operationId);
      },
      pending: () => [], respond: () => assert.fail('observer cannot answer'),
    });
    let socket;
    try {
      const descriptor = await readDescriptor(directory);
      const work = callControl(descriptor, 'config', {action:'run',requestId:'work',text:'task'});
      await started.promise;
      socket = createConnection(descriptor.path);
      await once(socket, 'connect');
      socket.write(JSON.stringify({version:1,token:descriptor.token,requestId:'obs',action:'subscribe',operationId:'op',
        payload:{configurationRef:'config'}})+'\n');
      await observerReady.promise;
      assert.ok(listeners.has('op'));
      socket.pause();
      const unconsumed = listeners.get('op')({channel:'activity',event:{kind:'reasoning',payload:'x'.repeat(1024*1024)}});
      gate.resolve();
      assert.deepEqual(await work, {done:true});
      await server.close();
      await unconsumed;
      assert.equal(listeners.size,0);
    } finally { socket?.destroy(); gate.resolve(); await server.close(); }
  }));

test('C14 view changes on a repeated work request do not change request identity or owner', {skip:localSocketCheck},()=>withOwnedRun('C14-control-view',async directory=>{
  const gate=Promise.withResolvers(), ready=Promise.withResolvers(), attached=Promise.withResolvers();
  let count=0, registrations=0;
  const server=await openControl(directory,'config',async(_command,accepted)=>{
    count++;accepted('op');ready.resolve();await gate.promise;return {done:true};
  },undefined,{
    subscribe:()=>()=>{},pending:()=>[],respond:()=>assert.fail('unexpected answer'),
    ownerAccepted:()=>{registrations++;return true;},
  });
  try {
    const descriptor=await readDescriptor(directory);
    const command={action:'run',requestId:'same',text:'task'};
    const firstAccepted=Promise.withResolvers();
    const first=callControl(descriptor,'config',command,(id,key)=>firstAccepted.resolve({id,key}),undefined,{notice:async()=>{}});
    await ready.promise;
    assert.deepEqual(await firstAccepted.promise,{id:'op',key:undefined});
    const second=callControl(descriptor,'config',command,(id,key)=>attached.resolve({id,key}),undefined,{notice:async()=>{},interactive:true});
    assert.deepEqual(await attached.promise,{id:'op',key:undefined});
    gate.resolve();
    assert.deepEqual(await Promise.all([first,second]),[{done:true},{done:true}]);
    assert.equal(count,1);assert.equal(registrations,1);
  }finally{gate.resolve();await server.close();}
}));

test('C13R.1 attached replies reconcile rejected/lost responses via actual control sockets', {timeout:10000,skip:localSocketCheck},()=>withOwnedRun('C13R-reply',async directory=>{
  const gate=Promise.withResolvers(), ready=Promise.withResolvers(), stop=new AbortController();
  const requests=['reject','before','after','timeout'].map(id=>({kind:'input',request:{requestId:id,operationId:'op',attemptId:'a-'+id,providerRequestId:'native-'+id}}));
  const pending=new Map(requests.map(x=>[x.request.requestId,x]));
  const asks=new Map(), deliveries=new Map(), notices=[];
  let dispatches=0;
  const server=await openControl(directory,'config',async(_command,accepted)=>{dispatches++;accepted('op');await gate.promise;return {done:true};},undefined,{
    subscribe:()=>()=>{},pending:()=>[...pending.values()],
    respond(reply){const id=reply.requestId;const n=(deliveries.get(id)??0)+1;deliveries.set(id,n);
      if(id==='reject'&&n===1)return {kind:'rejected',code:'INVALID'};
      pending.delete(id);return {kind:'accepted'};
    }
  });
  try {
    const descriptor=await readDescriptor(directory);
    const work=callControl(descriptor,'config',{action:'run',requestId:'work',text:'task'},(id,key)=>ready.resolve({id,key}),undefined,{interactive:true});
    const {id,key}=await ready.promise;
    const watch=pollAttachedInputs({operationId:id,ownerRequestId:'work',answerKey:key,signal:stop.signal,intervalMs:5,
      ask:async entry=>{const id=entry.request.requestId;asks.set(id,(asks.get(id)??0)+1);return {kind:'answered',payload:{action:'accept'}};},
      print:async message=>{notices.push(message);},
      call:async(command,signal)=>{
        if(command.action==='answer'){
          const id=command.reply.requestId;
          if(id==='before'&&asks.get(id)===1)return callControl({...descriptor,path:descriptor.path+'-absent'},'config',command,undefined,undefined,{signal});
          if(id==='timeout'){pending.delete(id);throw Error('lost');}
          const result=await callControl(descriptor,'config',command,undefined,undefined,{signal});
          if(id==='after')throw Error('ack lost');
          return result;
        }
        return callControl(descriptor,'config',command,undefined,undefined,{signal});
      }
    });
    for(let i=0;pending.size||!notices.some(x=>x.includes('no longer pending'));i++){assert.ok(i<400);await delay(10);}
    stop.abort();await watch;gate.resolve();await work;
    assert.deepEqual(Object.fromEntries(asks),{reject:2,before:2,after:1,timeout:1});
    assert.equal(deliveries.get('after'),1);assert.equal(deliveries.get('before'),1);assert.equal(dispatches,1);
    assert.ok(notices.some(x=>x.includes('rejected (INVALID)')));
  }finally{stop.abort();gate.resolve();await server.close();}
}));
test('C13R.1 polling failure is explicit and detaches pending input',async()=>{
  const notices=[];
  await pollAttachedInputs({operationId:'op',ownerRequestId:'work',answerKey:'key',signal:new AbortController().signal,
    call:async()=>{throw Error('connection lost');},ask:async()=>assert.fail('no input'),print:async x=>notices.push(x)});
  assert.match(notices.join(' '),/polling stopped.*pending reply state unknown/);
});

test('C13R.2 original binding reconnects future input without granting a duplicate observer ownership', {timeout:10000,skip:localSocketCheck},()=>withOwnedRun('C13R-reconnect',async directory=>{
  const gate=Promise.withResolvers(), ready=Promise.withResolvers(), detached=Promise.withResolvers();
  const cli=cliOwner(createCliInput(new PassThrough(),new PassThrough(),false,()=>{}));
  let calls=0, registrations=0;
  const server=await openControl(directory,'config',async(_command,accepted)=>{calls++;accepted('op');await gate.promise;return {done:true};},undefined,{
    subscribe:()=>()=>{},pending:cli.pending,respond:cli.respond,
    ownerAccepted:(id,requestId,interactive)=>{registrations++;return cli.accept(id,requestId,true,interactive);},
    ownerDetached:(id,requestId)=>{cli.detach(id,requestId);detached.resolve();}
  });
  const firstStop=new AbortController();
  try {
    const descriptor=await readDescriptor(directory), command={action:'run',requestId:'work',text:'task'};
    const first=callControl(descriptor,'config',command,(id,key)=>ready.resolve({id,key}),undefined,{interactive:true,signal:firstStop.signal});
    const lost=assert.rejects(first,{code:'CONTROL_RESPONSE_LOST'});
    const {key}=await ready.promise;assert.ok(key);assert.equal(cli.available('op'),true);
    const old={kind:'input',nativeKind:'form',requestId:'old',providerRequestId:'old-native',operationId:'op',attemptId:'a',profileId:'p',deadlineAt:Date.now()+10000,payload:{mode:'form',requestedSchema:{type:'object',properties:{value:{type:'string'}}}}};
    const signal=new AbortController().signal;
    const oldReply=cli.handleInteraction(old,signal);
    const observerReady=Promise.withResolvers();
    const observer=callControl(descriptor,'config',command,(id,key)=>observerReady.resolve(key),undefined,{interactive:true});
    assert.equal(await observerReady.promise,undefined);
    firstStop.abort();await lost;await detached.promise;
    assert.equal((await oldReply).kind,'unavailable');assert.equal(cli.available('op'),false);
    const restored=Promise.withResolvers();
    const reconnect=callControl(descriptor,'config',command,(id,key)=>restored.resolve(key),undefined,{reconnectKey:key,interactive:false});
    assert.equal(await restored.promise,key);assert.equal(cli.available('op'),true);assert.equal(registrations,2);
    const next={...old,requestId:'next',providerRequestId:'next-native'};
    const reply=cli.handleInteraction(next,signal);
    const answer={action:'answer',operationId:'op',requestId:'answer',ownerRequestId:'work',answerKey:key,reply:{requestId:'next',operationId:'op',attemptId:'a',providerRequestId:'next-native',payload:{kind:'answered',payload:{action:'accept',content:{value:'yes'}}}}};
    assert.equal((await callControl(descriptor,'config',answer)).kind,'accepted');
    assert.equal((await reply).kind,'answered');
    assert.equal((await callControl(descriptor,'config',{...answer,requestId:'old-answer',reply:{...answer.reply,requestId:'old',providerRequestId:'old-native'}})).kind,'rejected');
    gate.resolve();await Promise.all([observer,reconnect]);assert.equal(calls,1);
  }finally{firstStop.abort();gate.resolve();await server.close();}
}));

test('C14R.4 measured representative full snapshot transport cost versus committed finding facts', {timeout:15000,skip:localSocketCheck},()=>withOwnedRun('C14R-snapshot-cost',async directory=>{
  const findings=Array.from({length:64},(_,i)=>({findingId:'f'+i,author:'p',claim:'claim '+i,subject:'file',supports:[],uncertainties:[]}));
  const snapshot={operationId:'op',events:Array.from({length:256},(_,i)=>({eventId:'e'+i,kind:'attempt.outcome',observations:[{value:'x'.repeat(4096)}],findings:[findings[i%64]]})),attempts:Array.from({length:64},(_,i)=>({attemptId:'a'+i}))};
  let reads=0,bytes=0;
  const server=await openControl(directory,'config',async()=>{reads++;const copy=structuredClone(snapshot);bytes+=Buffer.byteLength(JSON.stringify(copy));return copy;});
  const before=process.memoryUsage().heapUsed,started=performance.now();
  try{
    const descriptor=await readDescriptor(directory);
    for(let i=0;i<32;i++)await callControl(descriptor,'config',{action:'inspect',operationId:'op',requestId:'read-'+i});
    const factBytes=findings.slice(0,32).reduce((n,f)=>n+Buffer.byteLength(JSON.stringify([f])),0);
    assert.equal(reads,32);assert.ok(bytes>32*1024*1024);assert.ok(factBytes<bytes/100);
    // The old read-only cache retains these full snapshots; heap delta is
    // GC-dependent, serialized retained volume is the deterministic metric.
    console.log('C14R.4 snapshot metrics',JSON.stringify({reads,serializedSnapshotBytes:bytes,committedFactBytes:factBytes,heapDelta:process.memoryUsage().heapUsed-before,wallMs:performance.now()-started}));
  }finally{await server.close();}
}));

test('C13R.1 unavailable input after uncertain reply does not send automatic new answer', {timeout:5000,skip:localSocketCheck},()=>withOwnedRun('C13R-eof',async directory=>{
  const gate=Promise.withResolvers(),ready=Promise.withResolvers(),stop=new AbortController();
  let asks=0,answers=0;
  const entry={kind:'input',request:{requestId:'q',operationId:'op',attemptId:'a',providerRequestId:'native'}};
  const server=await openControl(directory,'config',async(_cmd,accepted)=>{accepted('op');await gate.promise;return {done:true};},undefined,{
    subscribe:()=>()=>{},pending:()=>[entry],respond:()=>{answers++;return {kind:'rejected',code:'INVALID'};}
  });
  try{
    const descriptor=await readDescriptor(directory);
    const work=callControl(descriptor,'config',{action:'run',requestId:'w',text:'task'},(id,key)=>ready.resolve({id,key}),undefined,{interactive:true});
    const {id,key}=await ready.promise;
    const reported=Promise.withResolvers();
    const polling=pollAttachedInputs({operationId:id,ownerRequestId:'w',answerKey:key,signal:stop.signal,intervalMs:5,
      ask:async()=>++asks===1?{kind:'answered',payload:{action:'accept'}}:{kind:'unavailable'},
      print:async message=>{if(message.includes('no new explicit reply'))reported.resolve();},
      call:(command,signal)=>callControl(descriptor,'config',command,undefined,undefined,{signal})});
    await reported.promise;await delay(30);assert.equal(asks,2);assert.equal(answers,1);
    stop.abort();await polling;gate.resolve();await work;
  }finally{stop.abort();gate.resolve();await server.close();}
}));

test('C14R.5R attached actual socket final survives failed CLI Writable', {timeout:5000,skip:localSocketCheck},()=>withOwnedRun('C14R-write-failure',async directory=>{
  const ready=Promise.withResolvers(),gate=Promise.withResolvers(),failed=Promise.withResolvers();
  let listener,dispatches=0,omitted=0;
  const server=await openControl(directory,'config',async(_cmd,accepted)=>{dispatches++;accepted('op');ready.resolve();await gate.promise;return {done:true};},undefined,{
    subscribe(_id,fn){listener=fn;return ()=>{};},pending:()=>[],respond:()=>assert.fail('no synthetic reply')
  });
  const output=new Writable({write(_chunk,_encoding,cb){cb(Error('broken presentation'));failed.resolve();}});
  const terminal=createCliInput(new PassThrough(),output,false,()=>{});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk);
  try{
    const descriptor=await readDescriptor(directory);
    const result=callControl(descriptor,'config',{action:'run',requestId:'work',text:'task'},undefined,undefined,{notice:notice=>renderer.notice(notice),onGap:count=>{omitted+=count;}});
    await ready.promise;
    await listener({channel:'activity',event:{kind:'reasoning',nativeKind:'agent_thought_chunk',operationId:'op',attemptId:'a',profileId:'p',providerId:'x',sequence:1,payload:{content:{type:'text',text:'native'}}}});
    await failed.promise;gate.resolve();
    assert.deepEqual(await result,{done:true});assert.equal(omitted,1);assert.equal(dispatches,1);
  }finally{gate.resolve();renderer.close();terminal.close();output.destroy();await server.close();}
}));

test('C24 local control forwards explicit settings, skill and attachments and includes them in request identity',{skip:localSocketCheck},()=>withOwnedRun('C24-control',async directory=>{
  let executions=0;
  const server=await openControl(directory,'config',async(command,accepted)=>{
    executions++;accepted('operation');
    return {controllerProfile:command.controllerProfile,userSettings:command.userSettings,agentSkill:command.agentSkill,attachmentPaths:command.attachmentPaths};
  });
  try{
    const descriptor=await readDescriptor(directory);
    const fields={controllerProfile:'secondary',userSettings:{reasoningEffort:'high',collaborationMode:'plan',approvalMode:'review'},agentSkill:{name:'example',path:join(directory,'SKILL.md'),source:'project'},attachmentPaths:[join(directory,'external.txt')]};
    const command={action:'run',requestId:'c24-settings',text:'task',...fields};
    assert.deepEqual(await callControl(descriptor,'config',command),fields);
    assert.deepEqual(await callControl(descriptor,'config',command),fields);
    await assert.rejects(callControl(descriptor,'config',{...command,userSettings:{reasoningEffort:'low'}}),{code:'IDENTITY_CONFLICT'});
    await assert.rejects(callControl(descriptor,'config',{...command,attachmentPaths:[]}),{code:'IDENTITY_CONFLICT'});
    assert.equal(executions,1);
  }finally{await server.close();}
}));
