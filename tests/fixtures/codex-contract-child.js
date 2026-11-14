import { access, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const separator = '\n\nInvocation (JSON):\n';
const boundary = prompt.indexOf(separator);
if (boundary < 0) throw new Error('Missing invocation JSON');
const { attemptId, objective } = JSON.parse(prompt.slice(boundary + separator.length));
if (!/^attempt-[a-z]+$/u.test(attemptId)) throw new Error('Invalid fixture attempt id');

const emit = event => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(event) + '\n', error => error ? reject(error) : resolve());
});
const message = (id, text) => emit({ type: 'item.completed', item: { id, type: 'agent_message', text } });
await emit({ type: 'thread.started', thread_id: 'synthetic-thread' });
await emit({ type: 'turn.started' });
await message('progress', 'progress ' + attemptId);

if (objective === 'hold') {
  await writeFile(attemptId + '.ready', '');
  for (;;) {
    try {
      await access(attemptId + '.release');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await sleep(10);
    }
  }
}

if (objective === 'failure') {
  await emit({ type: 'turn.failed', error: { message: 'Synthetic terminal failure' } });
  process.exitCode = 7;
} else {
  await message('result', 'result ' + attemptId);
  await emit({ type: 'turn.completed', usage: objective === 'known-usage'
    ? { input_tokens: 0, output_tokens: 4 } : {} });
}
