import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await access(resolve(root, 'development')).then(() => { throw new Error('Legacy development/ must not exist'); }, error => { if (error.code !== 'ENOENT') throw error; });
const read = async path => readFile(resolve(root, path), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
assert.equal(pkg.name, 'role-orchestrator');
assert.equal(pkg.type, 'module');
assert.equal(pkg.engines.node, '^24.0.0');
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
assert.ok(Object.values(pkg.bin).every(path => !path.startsWith('development/')));

async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'runs', 'fixtures', 'experiments'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) result.push(path);
  }
  return result;
}
const paths = [
  resolve(root, 'README.md'), resolve(root, 'AGENTS.md'),
  resolve(root, 'CHANGELOG.md'), resolve(root, 'CONTRIBUTING.md'),
  resolve(root, 'tests/ACCEPTANCE_MATRIX.md'),
  ...await markdownFiles(resolve(root, 'docs')),
  ...await markdownFiles(resolve(root, '.agents')),
];
let linkCount = 0;
for (const path of paths) {
  const body = await readFile(path, 'utf8');
  assert.equal((body.match(/^\x60\x60\x60/gm) ?? []).length % 2, 0, 'Unclosed fence: ' + path);
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const actual = resolve(dirname(path), target);
    await access(actual).catch(() => { throw new Error('Broken link: ' + relative(root,path) + ' -> ' + target); });
    linkCount++;
  }
  for (const match of body.matchAll(/\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60/g)) JSON.parse(match[1]);
}
const cluster = await read('docs/roadmap/C12_ACCEPTANCE_DELIVERY.md');
const subtasks = [...cluster.matchAll(/^### C12\.0\.(\d+) —/gm)].map(x => Number(x[1]));
const stages = [...cluster.matchAll(/^## C12\.(\d+) —/gm)].map(x => Number(x[1]));
assert.deepEqual(subtasks, [1,2,3,4,5,6,7,8], 'C12.0 substeps are contiguous');
assert.deepEqual(stages, [1,2,3,4,5,6,7,8,9], 'C12 stages are contiguous');
const matrix = await read('tests/ACCEPTANCE_MATRIX.md');
const product = await read('docs/PRODUCT.md');
const requirements = [...product.matchAll(/^\| (R\d+) \|/gm)].map(m => m[1]);
assert.equal(requirements.length, 33, 'R01-R33 source requirements');
for (const id of requirements) {
  assert.ok(new RegExp('\\b' + id + '\\b').test(matrix), 'Unmapped requirement: ' + id);
  assert.ok(new RegExp('^\\| ' + id + ' \\| A\\d+', 'm').test(matrix), 'Missing R->A traceability row: ' + id);
}
const scenarios = [...matrix.matchAll(/^\| (A\d+) \|/gm)].map(m => m[1]);
assert.equal(scenarios.length, 54, 'A01-A54 must be present');
assert.equal(scenarios.length, new Set(scenarios).size, 'Duplicate acceptance identifiers');
const migration = [...matrix.matchAll(/^\| (M\d+) \|/gm)].map(m => m[1]);
assert.deepEqual(migration, ['M01','M02','M03','M04']);
for (const suite of ['foundation','core','contracts','integration']) {
  const tests = (await readdir(resolve(root,'tests',suite))).filter(x=>/\.test\.(?:js|mjs)$/.test(x));
  assert.ok(tests.length > 0, 'Missing mandatory suite ' + suite);
}
console.log(JSON.stringify({markdownFiles:paths.length,localLinks:linkCount,
  requirements:requirements.length,acceptanceScenarios:scenarios.length,migrationCriteria:migration.length,
  runtimeTests:'NOT RUN: specification validation only'},null,2));
