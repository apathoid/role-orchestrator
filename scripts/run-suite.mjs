import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const suite = process.argv[2];
if (!['core', 'contracts', 'integration', 'acceptance', 'native'].includes(suite)) {
  throw new Error('Unknown test suite: ' + suite);
}
const directory = resolve(import.meta.dirname, '../tests', suite);
const files = existsSync(directory) ? readdirSync(directory, { recursive: true })
  .filter(file => /\.test\.(?:js|mjs)$/.test(file)).map(file => resolve(directory, file)) : [];
if (files.length === 0) {
  console.error('NOT IMPLEMENTED: ' + suite + ' suite contains no tests');
  process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
