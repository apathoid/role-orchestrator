import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = async path => readFile(resolve(root, path), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
assert.equal(pkg.name, 'role-orchestrator');
assert.equal(pkg.type, 'module');
assert.equal(pkg.engines.node, '^24.0.0');
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
assert.ok(!pkg.bin || Object.values(pkg.bin).every(path => !path.startsWith('development/')));

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

const paths = [resolve(root, 'README.md'), resolve(root, 'AGENTS.md'),
  ...await markdownFiles(resolve(root, 'docs')),
  ...await markdownFiles(resolve(root, 'development'))];
let linkCount = 0;
for (const path of paths) {
  const text = await readFile(path, 'utf8');
  assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, `Unclosed fence: ${path}`);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const actual = resolve(dirname(path), target);
    await access(actual).catch(() => { throw new Error(`Broken link: ${relative(root, path)} -> ${target}`); });
    if (!relative(root, path).startsWith('development/')) {
      assert.ok(!relative(root, actual).startsWith('development/'), `Product doc depends on removable file: ${path}`);
    }
    linkCount++;
  }
  for (const match of text.matchAll(/```json\n([\s\S]*?)\n```/g)) JSON.parse(match[1]);
}

const clusters = await markdownFiles(resolve(root, 'development/plan/clusters'));
const ids = [];
for (const path of clusters) {
  const text = await readFile(path, 'utf8');
  const steps = [...text.matchAll(/^## (C\d\d)\.(\d+) —/gm)];
  assert.ok(steps.length > 0, `No steps: ${path}`);
  for (const [index, match] of steps.entries()) {
    assert.equal(Number(match[2]), index + 1, `Non-contiguous steps: ${path}`);
    ids.push(`${match[1]}.${match[2]}`);
  }
}
assert.equal(ids.length, new Set(ids).size, 'Duplicate step identifiers');
const matrix = await read('development/quality/ACCEPTANCE_MATRIX.md');
const product = await read('docs/PRODUCT.md');
const requirements = [...product.matchAll(/^\| (R\d+) \|/gm)].map(match => match[1]);
for (const id of requirements) assert.ok(new RegExp(`\\b${id}\\b`).test(matrix), `Unmapped requirement: ${id}`);
const scenarios = [...matrix.matchAll(/^\| (A\d+) \|/gm)].map(match => match[1]);
assert.equal(scenarios.length, new Set(scenarios).size, 'Duplicate acceptance identifiers');
console.log(JSON.stringify({ markdownFiles: paths.length, localLinks: linkCount,
  clusters: clusters.length, implementationSteps: ids.length,
  requirements: requirements.length, acceptanceScenarios: scenarios.length,
  runtimeTests: 'NOT RUN: specification validation only' }, null, 2));
