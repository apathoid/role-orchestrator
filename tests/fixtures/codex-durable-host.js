import { fileURLToPath } from 'node:url';
import { createCodexProvider } from '../../src/main/index.js';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { setup } from './application.js';
import { request } from './core.js';

const ownPath = fileURLToPath(import.meta.url);
const childPath = fileURLToPath(new URL('./codex-durable-child.js', import.meta.url));

export const durableRequest = (cwd, text) => request({ text, workspaceContext: { cwd } });

export async function openDurableCodex(directory, { crash = false, idPrefix } = {}) {
  const durable = createLocalStateStore(directory);
  await durable.open();
  const profile = { profileId: 'primary', providerId: 'codex', model: 'fixture' };
  const provider = createCodexProvider({
    providerId: profile.providerId,
    configuration: { adapter: 'codex-cli', launch: { command: process.execPath, args: [childPath] } },
  });
  const store = crash ? {
    ...durable,
    async commit(id, revision, next) {
      const event = next.events.at(-1);
      if (event?.kind === 'attempt.outcome' &&
          next.attempts.some(attempt => attempt.attemptId === event.outcome.attemptId && attempt.actionId === 'worker')) {
        if (event.outcome.terminal !== 'completed') throw new Error('Worker transport did not complete');
        process.send({ operationId: id, workerAttemptId: event.outcome.attemptId });
        return new Promise(() => {});
      }
      return durable.commit(id, revision, next);
    },
  } : durable;
  const { api } = setup({ provider, profile, store, idPrefix, maxInvocations: 4 });
  return { api, durable };
}

if (process.argv[1] === ownPath) {
  const [, , state, cwd] = process.argv;
  process.on('message', () => {});
  const { api } = await openDurableCodex(state, { crash: true });
  const submission = await api.submit(durableRequest(cwd, 'recover-worker'));
  await submission.completion;
  throw new Error('Worker did not reach the selected crash boundary');
}
