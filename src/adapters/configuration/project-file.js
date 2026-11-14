import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Read a project preference file from the supplied path or the one designated
 * directory. When neither is supplied, there is no project configuration.
 * @param {{cwd?: string, path?: string}} location
 * @returns {Promise<{kind: 'available', text: string} | {kind: 'absent'} | {kind: 'unavailable', source: 'project', path: string}>}
 */
export async function loadProjectPreferences({ cwd, path }) {
  if (path === undefined && cwd === undefined) return { kind: 'absent' };
  const target = resolve(cwd ?? '.', path ?? '.role-orchestrator.json');
  try {
    return { kind: 'available', text: await readFile(target, 'utf8') };
  } catch (error) {
    if (path === undefined && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'unavailable', source: 'project', path: target };
  }
}
