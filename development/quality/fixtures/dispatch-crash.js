import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalStateStore } from '../../../src/adapters/state/local-store.js';
import { setup } from './application.js';
import { request } from './core.js';

const [, , directory, boundary] = process.argv;
const durable = createLocalStateStore(directory);
await durable.open();
const pause = operationId => {
  process.send({ operationId });
  return new Promise(() => {});
};
let operationId;
const { api } = setup({
  store: {
    ...durable,
    async commit(id, revision, next) {
      operationId = id;
      const event = next.events.at(-1);
      if (event?.kind === 'attempt.reserved' && boundary === 'before_reservation') return pause(id);
      const result = await durable.commit(id, revision, next);
      if (result.kind !== 'committed') throw new Error('Fixture commit failed');
      if (event?.kind === 'attempt.reserved' && boundary === 'after_reservation') return pause(id);
      if (event?.kind === 'attempt.dispatched' && boundary === 'after_dispatch_record') return pause(id);
      return result;
    },
  },
  async respond() {
    await appendFile(join(directory, 'external-effects'), 'effect\n', { flush: true });
    return pause(operationId);
  },
});
const submitted = await api.submit(request());
// A live IPC channel keeps the child alive at the selected boundary.
process.on('message', () => {});
await submitted.completion;
