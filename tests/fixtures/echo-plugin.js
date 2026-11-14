import assert from 'node:assert/strict';
import { outcome } from './core.js';

export const manifest = { id: 'fixture-echo', version: '1.0.0', apiVersion: 1, exports: ['createProvider'] };

export function createProvider({ providerId }) {
  const sessions = new Map();
  const calls = new Map();
  let sequence = 0;

  const provider = {
    async describe() { return { providerId, maxConcurrency: null, capabilities: {
      'fixture.echo': { support: 'supported', source: 'configured' },
    } }; },
    async open(selected, signal) {
      signal.throwIfAborted();
      assert.equal(selected.providerId, providerId);
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
    ready(id) { assert.ok(calls.has(id), 'invocation has not started'); },
    release(id) { calls.get(id).release(); },
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
  return provider;
}
