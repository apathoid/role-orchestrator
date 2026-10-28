import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
for (const [name, version] of Object.entries(packageInfo.dependencies)) {
  assert.ok(readme.includes(`${name}@${version}`), `${name} version not documented consistently`);
}
assert.doesNotMatch(readme, /codex-acp@1\.12\.0|codex-acp@2\.2\.2|sdk@1\.8\.0/);
console.log('documented-dependencies: passed');
