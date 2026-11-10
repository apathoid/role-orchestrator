import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('CLI and ACP help run from an unrelated non-Git workspace without state creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'role-orchestrator-acceptance-'));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'),
      XDG_STATE_HOME: join(directory, 'state') };
    for (const args of [['--help'], ['acp', '--help']]) {
      const result = spawnSync(process.execPath, [join(root, 'src/main/cli.js'), ...args],
        { cwd: directory, env, encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage: role-orchestrator/);
    }
    await assert.rejects(access(join(directory, '.git')), { code: 'ENOENT' });
    await assert.rejects(access(join(directory, 'state')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public API is loadable without starting a provider or reading workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'role-orchestrator-api-'));
  try {
    const code = `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const api = await import(pathToFileURL(process.argv[1]).href);
assert.equal(typeof api.openOrchestrator, 'function');
assert.equal(typeof api.createCodexProvider, 'function');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code,
      join(root, 'src/main/index.js')],
    { cwd: directory, env: { ...process.env, XDG_STATE_HOME: join(directory, 'state') },
      encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    await assert.rejects(access(join(directory, 'state')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('handoff preserves permanent knowledge and all four executable regression suites', async () => {
  await assert.rejects(access(join(root, 'development')), { code: 'ENOENT' });
  const entry = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(entry, /docs\/roadmap\/STATUS\.md/);
  assert.match(entry, /\.agents\/REASONING\.md/);
  const state = await readFile(join(root, 'docs/roadmap/STATUS.md'), 'utf8');
  assert.match(state, /Следующий этап/);
  for (const name of ['foundation', 'core', 'contracts', 'integration']) {
    assert.ok((await readdir(join(root, 'tests', name))).some(path => path.endsWith('.test.js')), name);
  }
});
