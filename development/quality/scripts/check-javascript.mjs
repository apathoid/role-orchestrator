import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
for (const entry of readdirSync(resolve(root, 'src'), { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', resolve(entry.parentPath, entry.name)], { stdio: 'inherit' });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
  }
}
const check = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'jsconfig.json'],
  { cwd: resolve(root, 'development'), stdio: 'inherit' });
assert.ifError(check.error);
assert.equal(check.status, 0);
