import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readDescriptor, openControl, callControl } from '../../src/hosts/local-control.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
import { createLocalStateStore, probeLocalStore } from '../../src/adapters/state/local-store.js';

const entry = fileURLToPath(new URL('../../src/main/cli.js', import.meta.url));
const plugin = fileURLToPath(new URL('../fixtures/host-plugin.js', import.meta.url));
const base = () => ({
  schemaVersion: 1, controllerProfile: 'primary',
  profiles: { primary: { provider: 'test', model: 'fixture' } },
  providers: { test: { adapter: 'host-fixture' } },
  plugins: [{ id: 'host-fixture', module: plugin }],
});
const environment = cwd => ({ ...process.env, XDG_CONFIG_HOME: join(cwd, 'config-home'), XDG_STATE_HOME: join(cwd, 'state-home') });
function invoke(cwd, sync, args, env = {}) {
  const result = sync(process.execPath, [entry, ...args, '--format', 'json'], { cwd, env: { ...environment(cwd), ...env } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function configuration(path, value = base()) {
  await writeFile(path, JSON.stringify(value));
}

test('C23 A126 logical config selection, default compatibility, explicit precedence and symlink retarget', () =>
  withOwnedRun('C23-paths', async (cwd, sync) => {
    const env = environment(cwd);
    const standard = join(env.XDG_CONFIG_HOME, 'role-orchestrator', 'config.json');
    await mkdir(join(env.XDG_CONFIG_HOME, 'role-orchestrator'), { recursive: true });
    await mkdir(join(cwd, 'other'));
    const a = join(cwd, 'config.json'), b = join(cwd, 'other', 'config.json');
    await configuration(standard); await configuration(a); await configuration(b);
    const diagnose = (...args) => invoke(cwd, sync, ['diagnose', ...args]);
    const defaultState = join(env.XDG_STATE_HOME, 'role-orchestrator');
    assert.equal(diagnose().stateDirectory, defaultState);
    assert.equal(diagnose('--config', standard).stateDirectory, defaultState);
    const first = diagnose('--config', a);
    const second = diagnose('--config', b);
    assert.notEqual(first.stateDirectory, second.stateDirectory);
    assert.notEqual(first.stateDirectory, defaultState);
    assert.equal(first.state, 'not_created');
    assert.equal(diagnose('--config', './other/../config.json').stateDirectory, first.stateDirectory);
    await writeFile(a, JSON.stringify(base(), null, 2));
    assert.equal(diagnose('--config', a).stateDirectory, first.stateDirectory);
    const alias = join(cwd, 'alias.json');
    await symlink(a, alias);
    const aliased = diagnose('--config', alias).stateDirectory;
    assert.notEqual(aliased, first.stateDirectory);
    await rm(alias); await symlink(b, alias);
    assert.equal(diagnose('--config', alias).stateDirectory, aliased);
    await configuration(b, { ...base(), storage: { directory: 'custom' } });
    assert.equal(diagnose('--config', b).stateDirectory, join(cwd, 'other', 'custom'));
    assert.equal(diagnose('--config', b, '--state-dir', 'explicit').stateDirectory, join(cwd, 'explicit'));
    await assert.rejects(readdir(defaultState), { code: 'ENOENT' });
  }));

test('C23 A129 offline management does not load plugins and explicit Store needs no config', () =>
  withOwnedRun('C23-offline', async (cwd, sync) => {
    const config = join(cwd, 'custom.json'), directory = join(cwd, 'state');
    const marker = join(cwd, 'factory-loaded');
    const module = join(cwd, 'plugin.mjs');
    await writeFile(module, "import { writeFileSync } from 'node:fs'; import { createProvider as make, manifest } from "
      + JSON.stringify(new URL('../fixtures/host-plugin.js', import.meta.url).href)
      + "; export { manifest }; export function createProvider(options) { writeFileSync("
      + JSON.stringify(marker) + ", 'loaded'); return make(options); }");
    await configuration(config, { ...base(), storage: { directory }, plugins: [{ id: 'host-fixture', module }] });
    const run = invoke(cwd, sync, ['run', 'offline', '--config', config]);
    assert.equal(run.status, 'finished');
    assert.equal(await readFile(marker, 'utf8'), 'loaded');
    await rm(marker);
    const id = run.operationId;
    const temp = '.state-12345678-1234-4123-8123-123456789abc.tmp';
    await writeFile(join(directory, temp), 'unrelated temporary file');
    const before = (await readdir(directory)).sort();
    const inspect = invoke(cwd, sync, ['inspect', id, '--config', config]);
    assert.equal(inspect.operationId, id);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.deepEqual((await readdir(directory)).sort(), before);
    await rm(config);
    const options = ['--config', config, '--state-dir', directory];
    assert.equal(invoke(cwd, sync, ['inspect', id, ...options]).status, 'finished');
    const trace = invoke(cwd, sync, ['trace', id, ...options]);
    assert.equal(trace.redacted, true);
    const output = join(cwd, 'export.json');
    invoke(cwd, sync, ['export-diagnostics', id, '--output', output, ...options]);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), trace);
    assert.deepEqual(invoke(cwd, sync, ['cancel', id, ...options]), { operationId: id, status: 'no_live_execution' });
    assert.deepEqual((await readdir(directory)).sort(), before);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }));

test('C23 A128 administrative requests are configuration-independent but execution and request identity remain bound',
  { skip: process.env.C10_SOCKET_UNAVAILABLE === '1' }, () =>
    withOwnedRun('C23-control', async directory => {
      const calls = [];
      const server = await openControl(directory, 'owner-config', async command => {
        calls.push(command.action);
        return { action: command.action };
      });
      try {
        const descriptor = await readDescriptor(directory);
        for (const action of ['inspect', 'cancel', 'trace', 'export-diagnostics']) {
          const command = { action, requestId: action, operationId: 'operation' };
          assert.deepEqual(await callControl(descriptor, 'other-config', command), { action });
          assert.deepEqual(await callControl(descriptor, 'owner-config', command), { action });
          await assert.rejects(callControl(descriptor, 'owner-config', { ...command, operationId: 'other' }), { code: 'IDENTITY_CONFLICT' });
        }
        await assert.rejects(callControl(descriptor, 'other-config', { action: 'run', requestId: 'run', text: 'task' }), { code: 'CONTROL_CONFIGURATION_MISMATCH' });
        assert.deepEqual(calls, ['inspect', 'cancel', 'trace', 'export-diagnostics']);
      } finally { await server.close(); }
    }));

test('C23 A127 two CLI processes on identical configurations have overlapping Operations in separate Stores',
  { timeout: 20_000, skip: process.env.C10_SOCKET_UNAVAILABLE === '1' }, () =>
    withOwnedRun('C23-concurrent', async (cwd, sync) => {
      const a = join(cwd, 'a.json'), b = join(cwd, 'b.json');
      await configuration(a); await configuration(b);
      const stores = [a,b].map(config => invoke(cwd, sync, ['diagnose', '--config', config]).stateDirectory);
      const children = [a,b].map((config,index) => {
        const child = spawn(process.execPath, [entry, 'run', 'hold', '--config', config,
          '--request-id', 'held-' + index, '--format', 'json'], { cwd, env: environment(cwd), stdio: ['ignore','pipe','pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', bytes => { stdout += bytes; });
        child.stderr.on('data', bytes => { stderr += bytes; });
        const closed = once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
        return { child, closed };
      });
      try {
        let observed = [];
        for (let poll = 0; poll < 160; poll++) {
          observed = await Promise.all(stores.map(async (directory,index) => {
            const files = await readdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
            const operations = await Promise.all(files.filter(name => /^[a-f0-9]{64}.*\.json$/u.test(name))
              .map(name => readFile(join(directory,name),'utf8').then(JSON.parse)));
            return operations.find(item => item.request.requestId === 'held-' + index &&
              item.attempts.some(attempt => attempt.status === 'dispatched'));
          }));
          if (observed.every(Boolean)) break;
          await delay(25);
        }
        assert.ok(observed.every(Boolean), 'both Operations must have dispatched attempts');
        assert.notEqual(stores[0], stores[1]);
        assert.equal((await readDescriptor(stores[0])).pid, children[0].child.pid);
        assert.equal((await readDescriptor(stores[1])).pid, children[1].child.pid);
        for (let i=0;i<2;i++) {
          const cancelled = invoke(cwd, sync, ['cancel', observed[i].operationId, '--state-dir', stores[i]]);
          assert.equal(cancelled.status, 'cancelled');
        }
        for (const {closed} of children) {
          const result = await closed;
          assert.equal(result.code, 0, result.stderr);
          assert.equal(JSON.parse(result.stdout).status, 'cancelled');
        }
      } finally {
        for (const {child} of children) child.kill('SIGKILL');
        await Promise.all(children.map(item => item.closed));
      }
    }));


function start(cwd, args, env = {}) {
  const child = spawn(process.execPath, [entry, ...args, '--format', 'json'],
    { cwd, env: { ...environment(cwd), ...env }, stdio: ['ignore','pipe','pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, closed };
}
async function dispatched(directory, requestId) {
  for (let poll = 0; poll < 200; poll++) {
    const files = await readdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    for (const name of files.filter(name => /^[a-f0-9]{64}.*\.json$/u.test(name))) {
      const operation = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (operation.request.requestId === requestId &&
          operation.attempts.some(attempt => attempt.status === 'dispatched')) return operation;
    }
    await delay(25);
  }
  assert.fail('Operation was not dispatched: ' + requestId);
}
function failed(cwd, sync, args, code, env = {}) {
  const result = sync(process.execPath, [entry, ...args, '--format', 'json'], { cwd, env: { ...environment(cwd), ...env } });
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(code));
  return result;
}

test('C23 A126 explicit override uses launch cwd, Unicode components are bounded and relative XDG is consistent', () =>
  withOwnedRun('C23-path-boundaries', async (cwd, sync) => {
    const config = join(cwd, '多'.repeat(60) + ' space.json');
    await configuration(config);
    const auto = invoke(cwd, sync, ['diagnose','--config',config]);
    assert.match(basename(auto.stateDirectory), /^[A-Za-z0-9._-]{1,48}-[a-f0-9]{64}$/u);
    assert.equal(auto.stateDirectorySource, 'configuration_path');
    await mkdir(join(cwd,'workspace'));
    const run = invoke(cwd,sync,['run','cwd','--config',config,'--cwd','workspace','--state-dir','explicit']);
    assert.equal(run.assessment.answer,join(cwd,'workspace'));
    assert.equal(invoke(cwd,sync,['inspect',run.operationId,'--state-dir','explicit']).status,'finished');
    assert.equal(invoke(cwd,sync,['diagnose','--config',config,'--state-dir','explicit']).stateDirectorySource,'cli_override');
    failed(cwd,sync,['diagnose','--config',config,'--state-dir='],'INVALID_ARGUMENT');
    failed(cwd,sync,['run','task','--config','missing.json','--state-dir','explicit'],'CONFIGURATION_UNAVAILABLE');
    failed(cwd,sync,['inspect',run.operationId,'--config','missing.json'],'specify --state-dir');
    const standard = join(cwd,'.config','role-orchestrator');
    await mkdir(standard,{recursive:true}); await configuration(join(standard,'config.json'));
    const env = { HOME: cwd, XDG_CONFIG_HOME: '', XDG_STATE_HOME: '' };
    const defaultPath = invoke(cwd,sync,['diagnose'],env);
    assert.equal(defaultPath.stateDirectory,join(cwd,'.local','state','role-orchestrator'));
    assert.equal(defaultPath.stateDirectorySource,'default_configuration');
    const relative = join(cwd,'relative-config','role-orchestrator');
    await mkdir(relative,{recursive:true}); await configuration(join(relative,'config.json'));
    const relativePath = invoke(cwd,sync,['diagnose'],{XDG_CONFIG_HOME:'relative-config',XDG_STATE_HOME:'relative-state'});
    assert.equal(relativePath.configuration,join(relative,'config.json'));
    assert.equal(relativePath.stateDirectory,join(cwd,'relative-state','role-orchestrator'));
    assert.equal(relativePath.state,'not_created');
  }));

test('C23 A128 compatible execution attaches, equal JSON with different relative context does not; live redaction belongs to owner',
  { timeout: 20_000, skip: process.env.C10_SOCKET_UNAVAILABLE === '1' }, () =>
  withOwnedRun('C23-attach-context', async (cwd,sync) => {
    const directory=join(cwd,'shared');
    const secret='C23-FIXTURE-KNOWN-VALUE';
    const profileId='primary-'+secret;
    const value={...base(),controllerProfile:profileId,profiles:{[profileId]:{provider:'test',model:'fixture'}},
      providers:{test:{adapter:'host-fixture',launch:{command:'/unused/executable',env:{TOKEN:{fromEnv:'C23_VALUE'}}}}},
      plugins:[{id:'host-fixture',module:'./fixture.mjs'}]};
    const a=join(cwd,'a'), b=join(cwd,'b');
    for (const path of [a,b]) {
      await mkdir(path);
      await writeFile(join(path,'fixture.mjs'),'export { manifest, createProvider } from '+JSON.stringify(new URL('../fixtures/host-plugin.js',import.meta.url).href)+';');
      await configuration(join(path,'config.json'),value);
    }
    const ownerConfig=join(a,'config.json'), alias=join(a,'another.json'), other=join(b,'config.json');
    await configuration(alias,value);
    const held=start(cwd,['run','hold','--config',ownerConfig,'--state-dir',directory,'--request-id','owner'],{C23_VALUE:secret});
    try {
      const operation=await dispatched(directory,'owner');
      const descriptor=await readDescriptor(directory);
      assert.equal(descriptor.pid,held.child.pid);
      const attached=invoke(cwd,sync,['run','compatible','--config',alias,'--state-dir',directory]);
      assert.equal(attached.assessment.answer,'Ответ: compatible');
      failed(cwd,sync,['run','incompatible','--config',other,'--state-dir',directory],'CONTROL_CONFIGURATION_MISMATCH');
      failed(cwd,sync,['resume',operation.operationId,'--config',other,'--state-dir',directory],'CONTROL_CONFIGURATION_MISMATCH');
      await writeFile(ownerConfig,JSON.stringify(value,null,2));
      failed(cwd,sync,['run','incompatible','--config',ownerConfig,'--state-dir',directory],'CONTROL_CONFIGURATION_MISMATCH');
      assert.equal(invoke(cwd,sync,['inspect',operation.operationId,'--config',other,'--state-dir',directory]).operationId,operation.operationId);
      await rm(ownerConfig);
      const admin=['--config',ownerConfig,'--state-dir',directory];
      const trace=invoke(cwd,sync,['trace',operation.operationId,...admin],{C23_VALUE:undefined});
      assert.equal(trace.manifest.knownValueMasking,'available_current_values');
      assert.equal(trace.attempts[0].profileId,'primary-[REDACTED]');
      assert.ok(!JSON.stringify(trace).includes(secret));
      const output=join(cwd,'live-trace.json');
      invoke(cwd,sync,['export-diagnostics',operation.operationId,'--output',output,...admin],{C23_VALUE:undefined});
      assert.deepEqual(JSON.parse(await readFile(output,'utf8')),trace);
      assert.equal(invoke(cwd,sync,['cancel',operation.operationId,...admin]).status,'cancelled');
      const result=await held.closed;
      assert.equal(result.code,0,result.stderr);
      assert.equal(JSON.parse(result.stdout).cancellation,'user');
    } finally { held.child.kill('SIGKILL'); await held.closed; }
  }));

test('C23 A129 offline known-value masking is optional, explicit about missing/historical values, and does not recreate Store', () =>
  withOwnedRun('C23-redaction', async (cwd,sync) => {
    const directory=join(cwd,'state'), config=join(cwd,'secrets.json');
    const secret='C23-FIXTURE-SECRET';
    const profileId='primary-'+secret;
    const value={...base(),controllerProfile:profileId,profiles:{[profileId]:{provider:'test',model:'fixture'}},
      providers:{test:{adapter:'host-fixture',launch:{command:'/unused/executable',env:{
        TOKEN:{fromEnv:'C23_CURRENT'}, MISSING:{fromEnv:'C23_MISSING'},
      }}}},storage:{directory}};
    await configuration(config,value);
    const env={C23_CURRENT:secret,C23_MISSING:undefined};
    const operation=invoke(cwd,sync,['run','private fixture body','--config',config],env);
    const args=['trace',operation.operationId,'--state-dir',directory,'--config',config];
    const trace=invoke(cwd,sync,args,env);
    assert.equal(trace.manifest.knownValueMasking,'partial_current_values');
    assert.equal(trace.attempts[0].profileId,'primary-[REDACTED]');
    assert.ok(!JSON.stringify(trace).includes(secret));
    assert.ok(!JSON.stringify(trace).includes('private fixture body'));
    const output=join(cwd,'trace.json');
    invoke(cwd,sync,['export-diagnostics',operation.operationId,'--config',config,'--state-dir',directory,'--output',output],env);
    assert.deepEqual(JSON.parse(await readFile(output,'utf8')),trace);
    const rotated=invoke(cwd,sync,args,{C23_CURRENT:'new-value',C23_MISSING:undefined});
    assert.equal(rotated.manifest.knownValueMasking,'partial_current_values');
    assert.ok(JSON.stringify(rotated).includes(secret),'historical secret is not known after rotation');
    for (const content of ['{broken','{}']) {
      await writeFile(config,content);
      const baseOnly=invoke(cwd,sync,args,env);
      assert.equal(baseOnly.manifest.knownValueMasking,'unavailable');
      assert.equal(baseOnly.redacted,true);
      assert.ok(JSON.stringify(baseOnly).includes(secret),'base projection cannot discover arbitrary unknown values');
      assert.ok(!JSON.stringify(baseOnly).includes('private fixture body'));
    }
    const absent=join(cwd,'absent');
    failed(cwd,sync,['inspect',operation.operationId,'--state-dir',absent],'STORE_UNAVAILABLE');
    assert.deepEqual(invoke(cwd,sync,['cancel',operation.operationId,'--state-dir',absent]),{operationId:operation.operationId,status:'no_live_execution'});
    await assert.rejects(readdir(absent),{code:'ENOENT'});
  }));

test('C23 A129/A130 writer probe cannot mistake busy/unreachable or corrupt storage for no live execution',
  { timeout: 15_000 }, () =>
  withOwnedRun('C23-ownership-probe', async (cwd,sync) => {
    const absent=join(cwd,'absent');
    assert.equal(await probeLocalStore(absent),'absent');
    await assert.rejects(readdir(absent),{code:'ENOENT'});
    const directory=join(cwd,'store'), alias=join(cwd,'alias');
    await mkdir(directory); await symlink(directory,alias);
    assert.equal(await probeLocalStore(directory),'idle');
    assert.deepEqual(await readdir(directory),[]);
    const store=createLocalStateStore(directory);
    await store.open();
    try {
      await assert.rejects(probeLocalStore(alias),{code:'STATE_STORE_IN_USE'});
      const stale=join(directory,'.control-v1.json');
      await writeFile(stale,JSON.stringify({path:join(cwd,'missing-socket'),token:'stale',pid:1}));
      const failure=failed(cwd,sync,['cancel','unknown','--state-dir',alias],'STATE_STORE_IN_USE');
      assert.ok(failure.stderr.includes(alias));
      assert.equal(JSON.parse(await readFile(stale,'utf8')).token,'stale');
    } finally { await store.close(); }
    const before=await readFile(join(directory,'.writer.sqlite'));
    assert.equal(await probeLocalStore(alias),'idle');
    assert.deepEqual(await readFile(join(directory,'.writer.sqlite')),before);
    assert.deepEqual(invoke(cwd,sync,['cancel','unknown','--state-dir',alias]),{operationId:'unknown',status:'no_live_execution'});
    const corrupt=join(cwd,'corrupt');
    await mkdir(corrupt); await writeFile(join(corrupt,'.writer.sqlite'),'not a sqlite database');
    await assert.rejects(probeLocalStore(corrupt),{code:'STORE_UNAVAILABLE'});
    failed(cwd,sync,['cancel','unknown','--state-dir',corrupt],'STORE_UNAVAILABLE');
    const file=join(cwd,'file');
    await writeFile(file,'not directory');
    failed(cwd,sync,['cancel','unknown','--state-dir',file],'STORE_UNAVAILABLE');
  }));

test('C23 A127 default retention and crashed sibling do not affect an active nested Store',
  { timeout: 20_000, skip: process.env.C10_SOCKET_UNAVAILABLE === '1' }, () =>
  withOwnedRun('C23-nested', async (cwd,sync) => {
    const env=environment(cwd), root=join(env.XDG_STATE_HOME,'role-orchestrator');
    const standard=join(env.XDG_CONFIG_HOME,'role-orchestrator','config.json');
    await mkdir(join(env.XDG_CONFIG_HOME,'role-orchestrator'),{recursive:true});
    await configuration(standard,{...base(),storage:{directory:root,artifactRetention:{maxAgeMs:0}}});
    const nestedConfig=join(cwd,'nested.json');
    await configuration(nestedConfig);
    const nested=invoke(cwd,sync,['diagnose','--config',nestedConfig]).stateDirectory;
    const sibling=start(cwd,['run','hold','--config',nestedConfig,'--request-id','shared-request']);
    const defaultOwner=start(cwd,['run','hold','--config',standard,'--request-id','shared-request']);
    try {
      const [a,b]=await Promise.all([dispatched(root,'shared-request'),dispatched(nested,'shared-request')]);
      assert.notEqual(a.operationId,b.operationId);
      assert.equal((await readDescriptor(root)).pid,defaultOwner.child.pid);
      assert.equal((await readDescriptor(nested)).pid,sibling.child.pid);
      const nestedDescriptor=await readFile(join(nested,'.control-v1.json'),'utf8');
      defaultOwner.child.kill('SIGKILL'); await defaultOwner.closed;
      assert.equal(invoke(cwd,sync,['cancel',a.operationId,'--state-dir',root]).status,'no_live_execution');
      const old=invoke(cwd,sync,['inspect',a.operationId,'--state-dir',root]);
      assert.ok(old.attempts.some(attempt=>attempt.effect==='unknown'));
      const fresh=invoke(cwd,sync,['run','after crash','--config',standard]);
      assert.equal(fresh.status,'finished');
      assert.equal(await readFile(join(nested,'.control-v1.json'),'utf8'),nestedDescriptor);
      assert.equal((await dispatched(nested,'shared-request')).operationId,b.operationId);
      assert.equal(invoke(cwd,sync,['cancel',b.operationId,'--state-dir',nested]).status,'cancelled');
      assert.equal((await sibling.closed).code,0);
    } finally {
      defaultOwner.child.kill('SIGKILL'); sibling.child.kill('SIGKILL');
      await Promise.all([defaultOwner.closed,sibling.closed]);
    }
  }));
