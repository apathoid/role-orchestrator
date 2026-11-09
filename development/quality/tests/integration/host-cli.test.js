import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const entry = fileURLToPath(new URL('../../../../src/main/cli.js', import.meta.url));

test('CLI validates arguments, accepts Unicode stdin outside Git and isolates JSON stdout', () =>
  withOwnedRun('C10-cli', async (cwd, spawn) => {
    const config = join(cwd, 'config.json');
    await writeFile(config, JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture' } }, storage: { directory: 'state' },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../../fixtures/host-plugin.js', import.meta.url)) }],
    }));
    const call = (args, input) => spawn(process.execPath, [entry, ...args], { cwd, input });
    assert.match(call(['--help']).stdout, /export-diagnostics/);
    for (const [args, input] of [[['inspect'], undefined], [['run', '--invented'], undefined], [['run'], '  \n']]) {
      const result = call(args, input);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
    }
    const run = call(['run', '--config', config, '--format', 'json'], 'Привет, мир 🌍');
    assert.equal(run.status, 0, run.stderr);
    const { operationId, assessment } = JSON.parse(run.stdout);
    assert.equal(assessment.answer, 'Ответ: Привет, мир 🌍');
    const inspect = call(['inspect', operationId, '--config', config, '--format', 'json']);
    assert.equal(JSON.parse(inspect.stdout).status, 'finished');
    const trace = call(['trace', operationId, '--config', config, '--format', 'json']);
    assert.equal(JSON.parse(trace.stdout).redacted, true);
    assert.doesNotMatch(trace.stdout, /Привет/);
    const exported = call(['export-diagnostics', operationId, '--output', 'trace.json', '--config', config]);
    assert.equal(exported.status, 0, exported.stderr);
    const diagnose = call(['diagnose', '--config', config, '--format', 'json']);
    assert.equal(JSON.parse(diagnose.stdout).state, 'accessible');
    const trusted = JSON.parse(await readFile(config, 'utf8'));
    trusted.permissions = { standing: [{ profileId: 'primary', resource: 'fixture:read', optionId: 'deny', kind: 'deny' }] };
    await writeFile(config, JSON.stringify(trusted));
    const standing = call(['run', 'permission', '--config', config, '--format', 'json']);
    assert.equal(standing.status, 0, standing.stderr);
    assert.equal(JSON.parse(standing.stdout).assessment.answer, 'deny');
    assert.doesNotMatch(standing.stderr, /Permission requested|Permission unavailable/);

  }));
