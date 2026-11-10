import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { final, setup } from './application.js';
import { request } from './core.js';

const [, , directory, boundary, cwd] = process.argv;
const durable = createLocalStateStore(directory);
await durable.open();
const pause = (operationId, delivered = false) => {
  process.send({ operationId, delivered });
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
      if (event?.kind === 'attempt.outcome' && boundary === 'after_result_before_outcome_commit') return pause(id);
      const result = await durable.commit(id, revision, next);
      if (result.kind !== 'committed') throw new Error('Fixture commit failed');
      if (event?.kind === 'attempt.reserved' && boundary === 'after_reservation') return pause(id);
      if (event?.kind === 'attempt.dispatched' && boundary === 'after_dispatch_record') return pause(id);
      if (event?.kind === 'attempt.outcome' && boundary === 'after_outcome_commit') return pause(id);
      if (event?.kind === 'operation.finished' && boundary === 'after_terminal_commit') return pause(id);
      return result;
    },
  },
  async open() {
    if (boundary === 'before_dispatch_record') await pause(operationId);
  },
  async respond(invocation) {
    await appendFile(join(directory, 'external-effects'), 'effect\n', { flush: true });
    return boundary === 'after_provider_dispatch' ? pause(operationId) : final(invocation);
  },
});
const submitted = await api.submit(request(cwd ? { workspaceContext: { cwd } } : undefined));
// A live IPC channel keeps the child alive at the selected boundary.
process.on('message', () => {});
const completed = await submitted.completion;
if (boundary === 'after_delivery') await pause(completed.operationId, true);
