import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

const entry = fileURLToPath(new URL('../../src/main/cli.js', import.meta.url));

test('CLI validates arguments, accepts Unicode stdin outside Git and isolates JSON stdout', () =>
  withOwnedRun('C10-cli', async (cwd, spawn) => {
    const config = join(cwd, 'config.json');
    await writeFile(config, JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'host-fixture' } }, storage: { directory: 'state' },
      plugins: [{ id: 'host-fixture', module: fileURLToPath(new URL('../fixtures/host-plugin.js', import.meta.url)) }],
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

test('C11.5 diagnose reports unknown capabilities without opening providers or state', () =>
  withOwnedRun('C11-diagnose', async (cwd, spawn) => {
    const stateDirectory = join(cwd, 'uncreated-state');
    const marker = join(cwd, 'provider-opened');
    const module = join(cwd, 'must-not-load.mjs');
    await writeFile(module, 'import { writeFile } from "node:fs/promises"; await writeFile(' +
      JSON.stringify(marker) + ', "loaded");');
    const config = join(cwd, 'config.json');
    await writeFile(config, JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary',
      profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'fixture', launch: { command: '/definitely/missing/executable' } } },
      plugins: [{ id: 'fixture', module }],
      storage: { directory: stateDirectory },
    }));
    const result = spawn(process.execPath, [entry, 'diagnose', '--config', config, '--format', 'json'], { cwd });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.state, 'not_created');
    assert.equal(data.capabilities.status, 'unknown');
    assert.equal(data.sideEffects, 'none');
    assert.equal(data.providers[0].launch, 'unavailable');
    await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(join(stateDirectory, 'diagnostics', 'diagnostics.ndjson'), 'utf8'), { code: 'ENOENT' });
  }));

test('C11 review P3: diagnose distinguishes directories from files and cwd-dependent commands', () =>
  withOwnedRun('C11-diagnose-types', async (cwd, spawn) => {
    const stateFile = join(cwd, 'state-is-file');
    const directoryCommand = join(cwd, 'command-is-dir');
    const commandFile = join(cwd, 'command-is-file');
    const config = join(cwd, 'config.json');
    await writeFile(stateFile, 'not a directory');
    await mkdir(directoryCommand);
    await chmod(directoryCommand, 0o755);
    await writeFile(commandFile, '#!/bin/sh\\nexit 0\\n');
    await chmod(commandFile, 0o755);
    /** @param {string} command @param {string} storage */
    function diagnose(command, storage = stateFile) {
      const definition = {
        schemaVersion: 1, controllerProfile: 'primary',
        profiles: { primary: { provider: 'test', model: 'fixture' } },
        providers: { test: { adapter: 'host-fixture', launch: { command } } },
        storage: { directory: storage },
      };
      // Tests are subprocess based: no provider is loaded or run by diagnose.
      return writeFile(config, JSON.stringify(definition)).then(() => {
        const reply = spawn(process.execPath, [entry, 'diagnose', '--config', config, '--format', 'json'], { cwd });
        assert.equal(reply.status, 0, reply.stderr);
        return JSON.parse(reply.stdout);
      });
    }
    const bad = await diagnose(directoryCommand);
    assert.equal(bad.state, 'not_directory');
    assert.equal(bad.providers[0].launch, 'unavailable');
    assert.equal((await diagnose(commandFile)).providers[0].launch, 'executable');
    assert.equal((await diagnose('./command-is-file')).providers[0].launch, 'cwd_dependent');
    assert.equal((await diagnose(commandFile, cwd)).state, 'accessible');
  }));
