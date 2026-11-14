import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(process.argv[2] ?? 'release-artifacts');
const scratch = await mkdtemp(resolve(tmpdir(), 'role-orchestrator-release-'));
await mkdir(destination, { recursive: true });

function pack(out) {
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out],
    { cwd: root, encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 1, 'Exactly one package archive required');
  return reports[0];
}
async function info(item, directory) {
  const bytes = await readFile(resolve(directory, basename(item.filename)));
  return { filename: basename(item.filename), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contents: item.files.map(file => file.path).sort() };
}
try {
  const primary = await info(pack(destination), destination);
  const repeat = await info(pack(scratch), scratch);
  assert.deepEqual({ filename: primary.filename, bytes: primary.bytes, sha256: primary.sha256,
    contents: primary.contents }, repeat, 'Package must be byte reproducible within this toolchain');
  for (const required of ['package.json', 'README.md', 'CHANGELOG.md', 'src/main/index.js',
    'src/main/cli.js', 'docs/PRODUCT.md']) {
    assert.ok(primary.contents.includes(required), 'Missing release file: ' + required);
  }
  assert.ok(!primary.contents.some(path => /(^|\/)(development|tests|scripts|\.agents|roadmap|node_modules)(\/|$)/.test(path)));
  assert.ok(!primary.contents.includes('AGENTS.md'));
  const packageData = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const manifest = {
    schemaVersion: 1, package: { name: packageData.name, version: packageData.version,
      file: primary.filename, bytes: primary.bytes, sha256: primary.sha256, files: primary.contents.length },
    provenance: { commit: process.env.GITHUB_SHA ?? null, node: process.version,
      tool: 'npm pack --ignore-scripts --json', repeatedPackMatches: true },
    scope: 'npm source/package archive integrity, NOT signed release or native LLM/Zed acceptance',
  };
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
