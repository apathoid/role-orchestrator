import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createCodexProvider } from '../../../../src/main/index.js';
import { outcome } from '../../fixtures/core.js';
import { providerContract } from '../../fixtures/provider-contract.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

providerContract('controlled ProviderPort', async run => {
  const profile = { profileId: 'contract', providerId: 'controlled', model: 'fixture' };
  const sessions = new Map();
  const calls = new Map();
  let sequence = 0;

  const provider = {
    async describe() { return { providerId: profile.providerId, maxConcurrency: null, capabilities: {} }; },
    async open(selected, signal) {
      signal.throwIfAborted();
      assert.deepEqual(selected, profile);
      const session = { sessionId: 'session-' + ++sequence };
      sessions.set(session, {});
      return session;
    },
    invoke(session, request, observe) {
      const state = sessions.get(session);
      const { attemptId, objective, signal } = request;
      const { promise, resolve } = Promise.withResolvers();
      const stop = () => resolve('cancelled');
      const refs = [];
      function message(kind) {
        const ref = observe({ ref: kind, kind: 'model', sourceId: attemptId, completeness: 'complete',
          value: kind + ' ' + attemptId });
        if (ref !== undefined) refs.push({ ref, kind: 'output', source: 'model_claim' });
      }
      message('progress');
      state.stop = stop;
      state.attemptId = attemptId;
      state.finished = promise.then(terminal => {
        if (terminal === 'completed') message('result');
        const diagnostics = terminal === 'completed' ? [] : [
          { code: terminal === 'cancelled' ? 'CANCELLED' : 'PROVIDER_DISCONNECTED' },
        ];
        return {
          dispatchCertainty: 'sent',
          outcome: outcome(attemptId, {
            terminal, effect: 'unknown', diagnostics, outputRefs: refs,
            ...(objective === 'known-usage' && { usage: { inputTokens: 0, outputTokens: 4, cost: null } }),
          }),
          output: terminal === 'completed' ? 'result ' + attemptId : undefined,
        };
      }).finally(() => signal.removeEventListener('abort', stop));
      calls.set(attemptId, { release: () => resolve('completed') });
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      else if (objective !== 'hold') resolve(objective === 'failure' ? 'failed' : 'completed');
      return state.finished;
    },
    async cancel(session, attemptId) {
      const state = sessions.get(session);
      if (state?.attemptId === attemptId) state.stop();
    },
    async close(session) {
      const state = sessions.get(session);
      state?.stop?.();
      await state?.finished;
      sessions.delete(session);
    },
  };

  await run({
    provider, profile,
    ready(id) { assert.ok(calls.has(id), 'invocation has not started'); },
    release(id) { calls.get(id).release(); },
  });
});

providerContract('Codex CLI ProviderPort', run => withOwnedRun('C07-provider-contract', async cwd => {
  const profile = { profileId: 'contract', providerId: 'codex', model: 'fixture' };
  const child = fileURLToPath(new URL('../../fixtures/codex-contract-child.js', import.meta.url));
  const provider = createCodexProvider({
    providerId: profile.providerId,
    configuration: { adapter: 'codex-cli', launch: { command: process.execPath, args: [child] } },
  });
  await run({
    provider, profile, workspaceContext: { cwd },
    async ready(id) {
      const path = join(cwd, id + '.ready');
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        try {
          await access(path);
          return;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await sleep(10);
        }
      }
      assert.fail('child did not signal readiness for ' + id);
    },
    release(id) { return writeFile(join(cwd, id + '.release'), ''); },
  });
}), { skip: process.platform !== 'linux' });
