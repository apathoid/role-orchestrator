import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { root, withOwnedRun } from './owned-run.mjs';

const removal = process.argv.includes('--removal');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await withOwnedRun(removal ? 'C00-removal' : 'C00-package', async (directory, run) => {
  const product = join(directory, 'product');
  await mkdir(product);
  for (const file of ['package.json', 'package-lock.json', '.npmrc', ...pkg.files]) {
    await cp(join(root, file), join(product, file), { recursive: true });
  }
  await assert.rejects(access(join(product, 'development')), { code: 'ENOENT' });
  await assert.rejects(access(join(product, '.git')), { code: 'ENOENT' });

  function checked(command, args, cwd, env) {
    const result = run(command, args, { cwd, env });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }

  if (removal) {
    checked('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict'], product);
    assert.deepEqual(await readFile(join(product, 'package-lock.json')), await readFile(join(root, 'package-lock.json')));
  }
  const [packed] = JSON.parse(checked('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], product));
  assert.ok(packed.files.some(({ path }) => path === pkg.exports.slice(2)));
  const allowed = new Set(await readdir(product));
  for (const { path } of packed.files) {
    assert.ok(allowed.has(path.split('/')[0]) && !path.startsWith('node_modules/'), path);
  }
  assert.ok(!packed.files.some(({ path }) => /(^|\/)(development|fixtures|runs|tests)(\/|$)/.test(path)));

  // Extract the actual package and import it by name from a consumer with no runtime dependencies.
  const consumer = join(directory, 'consumer');
  const installed = join(consumer, 'node_modules', pkg.name);
  await mkdir(installed, { recursive: true });
  checked('tar', ['-xf', join(directory, packed.filename), '--strip-components=1', '-C', installed], consumer);
  checked(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const expectedSource = new URL('./node_modules/' + ${JSON.stringify(pkg.name)} + '/src/', import.meta.url).href;
    // The application uses Node's built-in SHA-256 for stable evidence identities.
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      assert.ok(result.url === 'node:crypto' || result.url.startsWith(expectedSource), result.url);
      return result;
    } });
    globalThis.fetch = () => { throw new Error('Network access during import'); };
    const api = await import(${JSON.stringify(pkg.name)});
    assert.equal(typeof api.emitDiagnostic, 'function');
  `], consumer, { ...process.env, PATH: '' });
  if (removal) {
    // Resolve the pinned validator from the clean install while exercising the
    // actual schema shipped in the tarball.
    await symlink(join(product, 'node_modules', 'ajv'), join(consumer, 'node_modules', 'ajv'), 'dir');
    checked(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { decodeConfiguration } = await import(${JSON.stringify(pkg.name)});
      assert.equal((await decodeConfiguration('{}')).kind, 'rejected');
    `], consumer, { ...process.env, PATH: '' });
  }
  console.log('PASS ' + (removal ? 'clean install without development or Git' : 'package contents and side-effect-free public import'));
});
