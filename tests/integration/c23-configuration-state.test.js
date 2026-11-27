import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readDescriptor, openControl, callControl } from '../../src/hosts/local-control.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const entry = fileURLToPath(new URL('../../src/main/cli.js', import.meta.url));
const plugin = fileURLToPath(new URL('../fixtures/host-plugin.js', import.meta.url));
const base = () => ({
  schemaVersion: 1, controllerProfile: 'primary',
  profiles: { primary: { provider: 'test', model: 'fixture' } },
  providers: { test: { adapter: 'host-fixture' } },
  plugins: [{ id: 'host-fixture', module: plugin }],
});
const environment = cwd => ({ ...process.env, XDG_CONFIG_HOME: join(cwd, 'config-home'), XDG_STATE_HOME: join(cwd, 'state-home') });
function invoke(cwd, sync, args) {
  const result = sync(process.execPath, [entry, ...args, '--format', 'json'], { cwd, env: environment(cwd) });
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
