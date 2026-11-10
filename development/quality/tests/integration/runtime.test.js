import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openRuntime } from '../../../../src/main/runtime.js';
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
    const { openOrchestrator, OrchestrationError } = await import('../../../../src/main/index.js');
    const { request } = await import('../../fixtures/core.js');
    const configuration = JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture' } },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../../fixtures/host-plugin.js', import.meta.url)) }],
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
    const { openOrchestrator } = await import('../../../../src/main/index.js');
    const { request } = await import('../../fixtures/core.js');
    const configuration = JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture' } },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../../fixtures/host-plugin.js', import.meta.url)) }],
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
    const { dispatchCommand } = await import('../../../../src/hosts/commands.js');
    const { request } = await import('../../fixtures/core.js');
    const secret = 'C11-SECRET-VALUE-' + Date.now();
    const old = process.env.C11_REVIEW_TRACE;
    process.env.C11_REVIEW_TRACE = secret;
    const profileId = 'primary-' + secret;
    const configuration = JSON.stringify({
      schemaVersion: 1, controllerProfile: profileId,
      profiles: { [profileId]: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture',
        launch: { command: '/unused/executable', env: { TOKEN: { fromEnv: 'C11_REVIEW_TRACE' } } } } },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../../fixtures/host-plugin.js', import.meta.url)) }],
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
