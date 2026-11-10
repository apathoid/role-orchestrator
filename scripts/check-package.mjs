import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { root, withOwnedRun } from './owned-run.mjs';

const removal = process.argv.includes('--removal');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await withOwnedRun(removal ? 'C00-removal' : 'C00-package', async (directory, run) => {
  const product = join(directory, 'product');
  await mkdir(product);
  for (const file of ['package.json', 'package-lock.json', '.npmrc', ...pkg.files]) {
    await mkdir(dirname(join(product, file)), { recursive: true });
    await cp(join(root, file), join(product, file), { recursive: true });
  }
  for (const directoryName of ['development', 'tests', 'scripts', '.agents', 'AGENTS.md', 'docs/roadmap', 'node_modules']) {
    await assert.rejects(access(join(product, directoryName)), { code: 'ENOENT' });
  }
  await assert.rejects(access(join(product, '.git')), { code: 'ENOENT' });

  function checked(command, args, cwd, env) {
    const result = run(command, args, { cwd, env });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }

  if (removal) {
    checked('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict'], product);
    assert.deepEqual(await readFile(join(product, 'package-lock.json')), await readFile(join(root, 'package-lock.json')));
    await assert.rejects(access(join(product,'node_modules','typescript')), {code:'ENOENT'});
    await assert.rejects(access(join(product,'node_modules','@types','node')), {code:'ENOENT'});
  }
  const [packed] = JSON.parse(checked('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], product));
  assert.ok(packed.files.some(({ path }) => path === pkg.exports.slice(2)));
  const executable = pkg.bin['role-orchestrator'].slice(2);
  assert.ok(packed.files.some(({ path, mode }) => path === executable && (mode & 0o111) !== 0));
  const allowed = new Set(await readdir(product));
  for (const { path } of packed.files) {
    assert.ok(allowed.has(path.split('/')[0]) && !path.startsWith('node_modules/'), path);
  }
  assert.ok(!packed.files.some(({ path }) => /(^|\/)(development|fixtures|runs|tests|scripts|\.agents)(\/|$)/.test(path)));

  // Extract the actual package and import it by name from a consumer with no runtime dependencies.
  const consumer = join(directory, 'consumer');
  const installed = join(consumer, 'node_modules', pkg.name);
  await mkdir(installed, { recursive: true });
  checked('tar', ['-xf', join(directory, packed.filename), '--strip-components=1', '-C', installed], consumer);
  checked(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const expectedSource = new URL('./node_modules/' + ${JSON.stringify(pkg.name)} + '/src/', import.meta.url).href;
    const builtins = new Set(['node:crypto', 'node:buffer', 'node:child_process', 'node:events', 'node:http', 'node:path', 'node:stream', 'node:url']);
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      assert.ok(builtins.has(result.url) || result.url.startsWith(expectedSource), result.url);
      return result;
    } });
    globalThis.fetch = () => { throw new Error('Network access during import'); };
    const api = await import(${JSON.stringify(pkg.name)});
    assert.equal(typeof api.emitDiagnostic, 'function');
    assert.equal(typeof api.createCodexProvider, 'function');
    assert.equal(typeof api.loadExtensions, 'function');
    assert.equal(typeof api.openOrchestrator, 'function');
  `], consumer, { ...process.env, PATH: '' });
  assert.match(checked(process.execPath, [join(installed, executable), '--help'], consumer), /Usage: role-orchestrator/);
  if (removal) {
    // Resolve the pinned validator from the clean install while exercising the
    // actual schema shipped in the tarball.
    await symlink(join(product, 'node_modules', 'ajv'), join(consumer, 'node_modules', 'ajv'), 'dir');
    await writeFile(join(consumer, 'local-extension.mjs'), `
      export const manifest = { id: 'local-extension', version: '1', apiVersion: 1, exports: ['loadSkill', 'tool'] };
      export async function loadSkill({ id, content }) {
        return content === 'metadata' ? { id, version: '1', description: 'A test skill' } :
          { version: '1', instructions: 'Use these explicitly selected instructions.' };
      }
      export const tool = {
        id: 'local_tool', resource: 'test:tool', description: 'A test tool', effect: 'read',
        inputSchema: { type: 'object', additionalProperties: false },
        async invoke() { return 'result'; },
      };
    `);
    checked(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { randomUUID } from 'node:crypto';
      import { access } from 'node:fs/promises';
      const { decodeConfiguration, loadExtensions } = await import(${JSON.stringify(pkg.name)});
      assert.equal((await decodeConfiguration('{}')).kind, 'rejected');
      await assert.rejects(access('development'), { code: 'ENOENT' });
      const result = await decodeConfiguration(JSON.stringify({
        schemaVersion: 1, controllerProfile: 'primary',
        providers: { cli: { adapter: 'codex-cli' } },
        profiles: { primary: { provider: 'cli', model: 'configured-model' } },
        plugins: [{ id: 'local-extension', module: './local-extension.mjs' }],
        skills: [{ id: 'example', source: 'local-extension' }], tools: [{ id: 'local_tool' }],
      }));
      assert.equal(result.kind, 'accepted');
      const registry = await loadExtensions(result.value, {
        directory: process.cwd(), clock: { now: Date.now }, ids: { newId: randomUUID },
      });
      try {
        assert.equal((await registry.selectController()).kind, 'available');
        const skill = await registry.catalog.loadSkill('example', 256, new AbortController().signal);
        assert.equal(skill.instructions, 'Use these explicitly selected instructions.');
        assert.equal((await registry.catalog.resolve('tool', 'local_tool')).value.resource, 'test:tool');
      } finally {
        await registry.close();
      }
    `], consumer, { ...process.env, PATH: '' });

    // Exercise the *extracted tarball* (not the checkout) through the public CLI.
    // The consumer only supplies its own fixture extension and externally held state.
    await writeFile(join(consumer, 'fixture-provider.mjs'), `
      export const manifest = { id: 'fixture', version: '1', apiVersion: 1, exports: ['createProvider'] };
      export function createProvider({ providerId }) {
        return {
          async describe() { return { providerId, maxConcurrency: null, capabilities: {} }; },
          async open() { return { sessionId: 'fixture-session' }; },
          async invoke(_session, invocation) {
            return {
              dispatchCertainty: 'sent',
              outcome: { schemaVersion: 1, attemptId: invocation.attemptId,
                terminal: 'completed', effect: 'none', diagnostics: [], outputRefs: [],
                usage: { inputTokens: null, outputTokens: null, cost: null } },
              output: { schemaVersion: 1, decisionId: 'fixture-final',
                operationId: invocation.operationId, contextCursor: 0,
                additions: [], cancellations: [], finalAssessment: {
                  author: invocation.profile.profileId, overall: 'complete',
                  answer: invocation.workspaceContext.cwd, requirements: [],
                  observationRefs: [], findingRefs: [], unresolvedQuestions: [],
                } },
            };
          },
          async cancel() {},
          async close() {},
        };
      }
    `);
    const fixtureConfig = join(consumer, 'fixture-config.json');
    await writeFile(fixtureConfig, JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary',
      profiles: { primary: { provider: 'fixture', model: 'fixture' } },
      providers: { fixture: { adapter: 'fixture', launch: { command: 'fixture-command' } } },
      plugins: [{ id: 'fixture', module: './fixture-provider.mjs' }],
      storage: { directory: join(consumer, 'external-state') },
    }));
    const fixtureEnv = { ...process.env, XDG_CONFIG_HOME: join(consumer, 'xdg-config'),
      XDG_STATE_HOME: join(consumer, 'xdg-state'), PATH: '' };
    const diagnosis = JSON.parse(checked(process.execPath, [join(installed, executable),
      'diagnose', '--config', fixtureConfig, '--format', 'json'], consumer, fixtureEnv));
    assert.equal(diagnosis.state, 'not_created');
    assert.equal(diagnosis.capabilities.status, 'unknown');
    assert.equal(diagnosis.sideEffects, 'none');
    await assert.rejects(access(join(consumer, 'external-state')), { code: 'ENOENT' });
    const completed = JSON.parse(checked(process.execPath, [join(installed, executable),
      'run', '--config', fixtureConfig, '--format', 'json', 'Answer from an external consumer'],
    consumer, fixtureEnv));
    assert.equal(completed.assessment.answer, consumer);
    await access(join(consumer, 'external-state'));
    for (const excluded of ['development', 'tests', 'scripts', '.agents', 'AGENTS.md', 'docs/roadmap']) {
      await assert.rejects(access(join(installed, excluded)), { code: 'ENOENT' });
    }
  }
  console.log('PASS ' + (removal ? 'clean install without development or Git' : 'package contents and side-effect-free public import'));
});
