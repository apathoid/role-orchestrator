import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, basename, join } from 'node:path';
import { tmpdir } from 'node:os';

export const root = resolve(import.meta.dirname, '..');
// Synthetic test artifacts belong to OS temporary space, never the project or runtime state.
const runs = resolve(tmpdir(), 'role-orchestrator-check-runs');
const tmp = resolve(runs, 'tmp');

export async function withOwnedRun(checkId, run) {
  await mkdir(tmp, { recursive: true });
  const directory = await mkdtemp(join(tmp, checkId + '-'));
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
      await writeFile(resolve(runs, basename(directory) + '.json'), JSON.stringify({
        checkId, startedAt, endedAt: new Date().toISOString(), status, commands,
        limitations: 'Synthetic fixtures only. No native provider acceptance.',
      }, null, 2));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
