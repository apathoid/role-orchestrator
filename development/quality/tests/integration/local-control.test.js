import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { callControl, openControl, readDescriptor } from '../../../../src/hosts/local-control.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const entry = fileURLToPath(new URL('../../../../src/main/cli.js', import.meta.url));
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
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../../fixtures/host-plugin.js', import.meta.url)) }],
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
    const fixture = new URL('../../fixtures/host-plugin.js', import.meta.url).href;
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
