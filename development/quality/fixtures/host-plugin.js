import { final } from './application.js';
import { assessment } from './core.js';

export const manifest = { id: 'host-fixture', version: '1', apiVersion: 1, exports: ['createProvider'] };

export function createProvider({ providerId }) {
  return {
    async describe() { return { providerId, maxConcurrency: null, capabilities: {} }; },
    async open() { return { sessionId: crypto.randomUUID() }; },
    async invoke(_session, invocation) {
      if (invocation.context[0].value === 'hold') {
        await new Promise(resolve => {
          if (invocation.signal.aborted) resolve();
          else invocation.signal.addEventListener('abort', resolve, { once: true });
        });
      }
      return final(invocation, { finalAssessment: assessment({
        author: invocation.profile.profileId, answer: 'Ответ: ' + invocation.context[0].value,
      }) });
    },
    async cancel() {},
    async close() {},
  };
}
