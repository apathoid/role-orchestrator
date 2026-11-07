import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '../../..');
const runs = resolve(root, 'development/runs');
const tmp = resolve(runs, 'tmp');

export async function withOwnedRun(checkId, run) {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(resolve(tmp, checkId + '-'));
  const startedAt = new Date().toISOString();
  const commands = [];
  let status = 'failed';
  try {
    await run(directory, (command, args, options = {}) => {
      const result = spawnSync(command, args, {
        encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', ...options,
      });
      commands.push({ command, args, exit: result.status, signal: result.signal, error: result.error?.code });
      return result;
    });
    status = 'passed';
  } finally {
    try {
      await writeFile(resolve(runs, directory.split(/[\\/]/).at(-1) + '.json'), JSON.stringify({
        checkId, startedAt, endedAt: new Date().toISOString(), status, commands,
        limitations: 'Synthetic fixtures only. No native provider acceptance.',
      }, null, 2));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
