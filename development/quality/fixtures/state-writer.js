import { createLocalStateStore } from '../../../src/adapters/state/local-store.js';

const store = createLocalStateStore(process.argv[2]);
try {
  await store.open();
  process.on('message', async message => {
    if (message !== 'close') return;
    await store.close();
    process.disconnect();
  });
  process.send({ kind: 'opened' });
} catch (error) {
  process.send({ kind: 'error', code: error.code });
  process.disconnect();
}
