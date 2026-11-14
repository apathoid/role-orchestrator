import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { prepareCodexLaunch } from '../../src/adapters/cli/codex-launch.js';
import { startCliProcess } from '../../src/adapters/cli/owned-process.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 10_000 };

function invoke(source, { cwd, stdin = '', timeoutMs = 3_000, controller = new AbortController(), onOutput } = {}) {
  const launch = prepareCodexLaunch({
    adapter: 'codex-cli',
    launch: { command: process.execPath, args: ['--input-type=module', '-e', source, '--'] },
  }, { model: 'configured-model', cwd, prompt: stdin }, process.env);
  const output = { stdout: [], stderr: [] };
  const processHandle = startCliProcess(launch, {
    timeoutMs,
    signal: controller.signal,
    onOutput(stream, chunk) {
      output[stream].push(chunk);
      onOutput?.(stream, chunk);
    },
  });
  return { ...processHandle, output };
}

const text = chunks => Buffer.concat(chunks).toString('utf8');

test('CLI process preserves both streams and exposes the child exit separately', linux, async () => {
  const prompt = 'one 🧪\nsecond line\n';
  const run = invoke(`
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(Buffer.concat(chunks));
    process.stderr.write('native stderr');
    process.exitCode = 7;
  `, { stdin: prompt, timeoutMs: 2_147_483_647 });
  assert.deepEqual(await run.finished, { started: true, reason: 'exited', exitCode: 7, signal: null, errors: {} });
  assert.equal(text(run.output.stdout), prompt);
  assert.equal(text(run.output.stderr), 'native stderr');
  assert.equal(await run.close(), await run.finished);
});

test('CLI process distinguishes startup ENOENT from a child exiting before output', linux, async () => {
  await withOwnedRun('C07-process-start', async directory => {
    const missing = startCliProcess({
      command: join(directory, 'missing'), args: [], stdin: '', options: { shell: false, env: process.env },
    }, { timeoutMs: 1_000, signal: new AbortController().signal, onOutput: assert.fail });
    const failed = await missing.finished;
    assert.equal(failed.started, false);
    assert.equal(failed.reason, 'start_failed');
    assert.deepEqual(failed.errors, { start: 'ENOENT' });

    const early = invoke('process.exit(0)');
    assert.deepEqual(await early.finished, { started: true, reason: 'exited', exitCode: 0, signal: null, errors: {} });
    assert.equal(early.output.stdout.length, 0);
  });
});

test('CLI process records stdin EPIPE and still drains output', linux, async () => {
  const run = invoke(`
    import { closeSync } from 'node:fs';
    closeSync(0);
    process.stdout.write('available output');
    setTimeout(() => { process.exitCode = 6; }, 100);
  `, { stdin: 'x'.repeat(4 * 1024 * 1024) });
  const result = await run.finished;
  assert.equal(result.reason, 'exited');
  assert.equal(result.exitCode, 6);
  assert.equal(result.errors.stdin, 'EPIPE');
  assert.equal(text(run.output.stdout), 'available output');
});

test('already aborted signal avoids launching the executable', linux, async () => {
  const controller = new AbortController();
  controller.abort();
  const run = invoke('throw new Error("unexpected launch")', { controller });
  assert.deepEqual(await run.finished, { started: false, reason: 'cancelled', exitCode: null, signal: null, errors: {} });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('CLI deadline terminates a long process and preserves partial output', linux, async () => {
  const controller = new AbortController();
  const run = invoke(`
    process.stdout.write('partial');
    process.stderr.write('still running');
    setTimeout(() => {}, 8_000);
  `, { controller, timeoutMs: 1_000 });
  assert.deepEqual(await run.finished, {
    started: true, reason: 'timed_out', exitCode: null, signal: 'SIGKILL', errors: {},
  });
  assert.equal(text(run.output.stdout), 'partial');
  assert.equal(text(run.output.stderr), 'still running');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('output consumer failure terminates the process and preserves the reported bytes', linux, async () => {
  const run = invoke(`
    process.stdout.write('raw frame');
    setTimeout(() => {}, 8_000);
  `, { onOutput() { throw new Error('consumer failed'); } });
  assert.deepEqual(await run.finished, {
    started: true, reason: 'io_failed', exitCode: null, signal: 'SIGKILL',
    errors: { stdout: 'OUTPUT_CONSUMER_FAILED' },
  });
  assert.equal(text(run.output.stdout), 'raw frame');
});

function processWithDescendant(marker, { exit = false, detached = false, stdio = 'ignore', controller } = {}) {
  const ready = Promise.withResolvers();
  const workerSource = `
    import { appendFileSync } from 'node:fs';
    const tick = () => appendFileSync(${JSON.stringify(marker)}, '.');
    tick();
    const timer = setInterval(tick, 15);
    setTimeout(() => clearInterval(timer), 8_000);
  `;
  let readyOutput = '';
  const run = invoke(`
    import { spawn } from 'node:child_process';
    import { existsSync } from 'node:fs';
    import { setTimeout as sleep } from 'node:timers/promises';
    const worker = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(workerSource)}], {
      detached: ${detached},
      stdio: ['ignore', ${JSON.stringify(stdio)}, 'ignore'],
    });
    worker.unref();
    while (!existsSync(${JSON.stringify(marker)})) await sleep(10);
    process.stderr.write(String(worker.pid) + '\\n');
    ${exit ? '' : 'setTimeout(() => {}, 8_000);'}
  `, { controller, onOutput(stream, chunk) {
    if (stream !== 'stderr') return;
    readyOutput += chunk.toString();
    if (readyOutput.includes('\n')) ready.resolve(Number(readyOutput.trim()));
  } });
  return { ...run, ready: Promise.race([
    ready.promise,
    run.finished.then(() => { throw new Error('CLI exited before reporting a descendant'); }),
  ]) };
}

async function assertHeartbeat(marker, running) {
  const before = (await readFile(marker)).length;
  if (running) {
    for (let retry = 0; retry < 20; retry++) {
      await sleep(25);
      if ((await readFile(marker)).length > before) return;
    }
    assert.fail('independent descendant stopped writing its heartbeat');
  }
  // Allow an in-flight write immediately following delivery of SIGKILL.
  await sleep(40);
  const settled = (await readFile(marker)).length;
  await sleep(150);
  assert.equal((await readFile(marker)).length, settled, 'owned descendant continued writing');
}

test('abort, cancel and close share one cleanup without terminating an independent invocation', linux, async () => {
  await withOwnedRun('C07-process-cancel', async directory => {
    const controller = new AbortController();
    controller.signal.addEventListener('abort', event => event.stopImmediatePropagation(), { once: true });
    const ownedMarker = join(directory, 'owned');
    const independentMarker = join(directory, 'independent');
    const owned = processWithDescendant(ownedMarker, { controller });
    const independent = processWithDescendant(independentMarker);
    try {
      await Promise.all([owned.ready, independent.ready]);
      controller.abort();
      const terminal = await owned.finished;
      owned.cancel();
      const [first, second] = await Promise.all([owned.close(), owned.close()]);
      assert.equal(first, terminal);
      assert.equal(first, second);
      assert.equal(first.reason, 'cancelled');
      assert.equal(first.signal, 'SIGKILL');
      await assertHeartbeat(ownedMarker, false);
      await assertHeartbeat(independentMarker, true);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

      assert.equal((await independent.close()).reason, 'cancelled');
      await assertHeartbeat(independentMarker, false);
    } finally {
      await Promise.all([owned.close(), independent.close()]);
    }
  });
});

test('normal CLI exit cleans up its remaining group, including a descendant with no attached streams', linux, async () => {
  await withOwnedRun('C07-process-exit', async directory => {
    const marker = join(directory, 'descendant');
    const run = processWithDescendant(marker, { exit: true });
    await run.ready;
    assert.equal((await run.finished).exitCode, 0);
    await assertHeartbeat(marker, false);
  });
});

test('a descriptor inherited outside the group has a bounded drain with a diagnostic', linux, async () => {
  await withOwnedRun('C07-process-drain', async directory => {
    const marker = join(directory, 'descendant');
    const run = processWithDescendant(marker, { exit: true, detached: true, stdio: 'inherit' });
    const pid = await run.ready;
    assert.ok(Number.isInteger(pid) && pid > 1);
    try {
      const result = await run.finished;
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.errors, { stdout: 'OUTPUT_DRAIN_TIMEOUT' });
      await assertHeartbeat(marker, true);
    } finally {
      process.kill(pid, 'SIGKILL');
      await assertHeartbeat(marker, false);
    }
  });
});

for (const [name, stream, sameReason, duringCleanup, expectedReason, expectedError] of [
  ['expected stdout', 'stdout', true, false, 'cancelled', undefined],
  ['distinct same-text stdout', 'stdout', false, false, 'io_failed', 'IO_ERROR'],
  ['same object on stderr', 'stderr', true, false, 'io_failed', 'IO_ERROR'],
  ['genuine stdout during cleanup', 'stdout', false, true, 'cancelled', 'IO_ERROR'],
  ['genuine stderr during cleanup', 'stderr', false, true, 'cancelled', 'IO_ERROR'],
]) {
  test('F2 owned process distinguishes ' + name, linux, async () => {
    const expected = new Error('ACP connection closed');
    const owner = startCliProcess({
      command: process.execPath, args: ['--input-type=module','-e',
        "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
      options: {shell:false,env:process.env},
    }, {timeoutMs:4_000, signal:new AbortController().signal, onOutput(){}, expectedStdoutCloseError:expected});
    const pipes = owner.pipes;
    assert.ok(pipes);
    try {
      await new Promise(resolve => pipes.stdout.once('data', resolve));
      if (duringCleanup) owner.cancel();
      const seen = Promise.withResolvers();
      pipes[stream].once('error', seen.resolve);
      const error = sameReason ? expected : new Error(expected.message);
      pipes[stream].destroy(error);
      assert.equal(await seen.promise, error);
      const result = await owner.close();
      assert.equal(result.reason, expectedReason);
      assert.equal(result.errors[stream], expectedError);
      assert.equal(result.exitCode, null);
      assert.equal(result.signal, 'SIGKILL');
      assert.equal(await owner.close(), result);
    } finally {
      await owner.close();
    }
  });
}

test('F2 expected stdout closure does not conceal process cleanup failure', linux, async t => {
  const expected = new Error('ACP connection closed');
  const owner = startCliProcess({
    command:process.execPath,args:['--input-type=module','-e',
      "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
    options:{shell:false,env:process.env},
  }, {timeoutMs:4_000,signal:new AbortController().signal,onOutput(){},expectedStdoutCloseError:expected});
  const pipes = owner.pipes;
  assert.ok(pipes);
  const kill = process.kill;
  try {
    await new Promise(resolve => pipes.stdout.once('data', resolve));
    const observed = Promise.withResolvers();
    pipes.stdout.once('error', observed.resolve);
    pipes.stdout.destroy(expected);
    assert.equal(await observed.promise, expected);
    const mock = t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === -pipes.pid && signal === 'SIGKILL') throw Object.assign(new Error('denied'), {code:'EPERM'});
      return kill(pid, signal);
    });
    try { owner.cancel(); } finally { mock.mock.restore(); }
    // The failure was observed; the fixture must still be explicitly disposed.
    kill(-pipes.pid, 'SIGKILL');
    await assert.rejects(owner.close(), /CLI process group cleanup failed: EPERM/);
    const result = await owner.finished;
    assert.equal(result.errors.cleanup, 'EPERM');
    assert.equal(result.errors.stdout, undefined);
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.signal, 'SIGKILL');
  } finally {
    await owner.finished;
  }
});
