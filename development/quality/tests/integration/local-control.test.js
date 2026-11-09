import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
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
    let second;
    try {
      let descriptor;
      for (let attempt = 0; attempt < 100; attempt++) {
        descriptor = await readDescriptor(directory);
        if (descriptor?.pid === first.process.pid) break;
        await delay(25);
      }
      assert.equal(descriptor?.pid, first.process.pid);
      second = call('run', 'parallel', '--request-id', 'parallel');
      const unrelated = await second.completed;
      assert.equal(unrelated.status, 'finished');
      first.process.kill('SIGINT');
      const cancelled = await first.completed;
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.cancellation, 'client');
      assert.equal(await readDescriptor(directory), undefined);
      assert.equal((await call('cancel', cancelled.operationId).completed).status, 'no_live_execution');
    } finally { first.process.kill('SIGKILL'); second?.process.kill('SIGKILL'); }
  }));
