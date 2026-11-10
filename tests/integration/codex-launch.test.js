import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexLaunch } from '../../src/adapters/cli/codex-launch.js';
import { decodeConfiguration } from '../../src/application/configuration/decode-config.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

test('Codex launch sends prompt bytes through stdin and keeps argv, cwd and environment separate', async () => {
  await withOwnedRun('C07-codex-launch', async (directory, run) => {
    const cwd = join(directory, 'workspace with spaces');
    await mkdir(cwd);
    const capture = `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      process.stdout.write(JSON.stringify({
        argv: process.argv.slice(1),
        cwd: process.cwd(),
        stdin: Buffer.concat(chunks).toString('utf8'),
        tokenMatches: process.env.CODEX_API_KEY === 'synthetic credential',
        tools: process.env.CONFIGURED_TOOLS,
        pathPresent: Boolean(process.env.PATH)
      }) + '\\n');
    `;
    const configuration = await decodeConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: {
        codex: {
          adapter: 'codex-cli',
          launch: {
            command: process.execPath,
            args: ['--input-type=module', '-e', capture, '--'],
            env: { CODEX_API_KEY: { fromEnv: 'TEST_CODEX_KEY' } },
          },
          nativeSettings: { profile: 'operator profile' },
        },
      },
      profiles: { primary: { provider: 'codex', model: 'configured-model' } },
      controllerProfile: 'primary',
    }));
    assert.equal(configuration.kind, 'accepted');
    const { providers, profiles } = configuration.value;
    const environment = { PATH: '/custom/bin', CONFIGURED_TOOLS: '/configured tools', TEST_CODEX_KEY: 'synthetic credential' };
    const prompt = '--help\n$(touch marker); \`echo hello\` "кавычки" 🧪\n';
    const launch = prepareCodexLaunch(providers.codex, { cwd, model: profiles.primary.model, prompt }, environment);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.stdoutFormat, 'jsonl');
    const result = run(launch.command, launch.args, { ...launch.options, input: launch.stdin });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: ['exec', '--json', '--skip-git-repo-check', '--model=configured-model', '--profile=operator profile', '-'],
      cwd,
      stdin: prompt,
      tokenMatches: true,
      tools: '/configured tools',
      pathPresent: true,
    });
    assert.equal(Object.hasOwn(environment, 'CODEX_API_KEY'), false);
  });
});

test('Codex launch leaves unspecified native options to Codex and reports invalid launch settings', () => {
  const provider = { adapter: 'codex-cli', launch: { command: 'codex' } };
  const invocation = { model: 'configured-model', prompt: 'example' };
  const environment = {};
  const launch = prepareCodexLaunch(provider, invocation, environment);
  assert.deepEqual(launch.args, ['exec', '--json', '--skip-git-repo-check', '--model=configured-model', '-']);
  assert.equal(launch.options.cwd, undefined);
  assert.throws(() => prepareCodexLaunch({ adapter: 'codex-cli' }, invocation, environment), /launch is required/);
  assert.throws(() => prepareCodexLaunch({ ...provider, nativeSettings: { profile: true } }, invocation, environment),
    /nativeSettings\.profile/);
  assert.throws(() => prepareCodexLaunch({ ...provider, nativeSettings: { unexpected: true } }, invocation, environment),
    /nativeSettings key: unexpected/);
  const secretRef = { CODEX_API_KEY: { fromEnv: 'TEST_CODEX_KEY' } };
  assert.throws(() => prepareCodexLaunch({ ...provider, launch: { ...provider.launch, env: secretRef } }, invocation, environment),
    /launch\.env\.CODEX_API_KEY/);
});

test('C11R.7 selectable effort is a process-local -c override; native has no forced flag', () => {
  const provider={adapter:'codex-cli',launch:{command:'codex'},nativeSettings:{profile:'operator'}};
  const base={model:'fixture',prompt:'one'};
  const environment={};
  const native=prepareCodexLaunch(provider,{...base,reasoning:{mode:'native'}},environment);
  assert.deepEqual(native.args,['exec','--json','--skip-git-repo-check','--model=fixture','--profile=operator','-']);
  const low=prepareCodexLaunch(provider,{...base,reasoning:{
    mode:'selectable',level:'low',nativeValue:'minimal',selectionSource:'model',
  }},environment);
  const high=prepareCodexLaunch(provider,{...base,reasoning:{
    mode:'selectable',level:'high',nativeValue:'xhigh',selectionSource:'model',
  }},environment);
  assert.deepEqual(low.args.slice(-3),['-c','model_reasoning_effort="minimal"','-']);
  assert.deepEqual(high.args.slice(-3),['-c','model_reasoning_effort="xhigh"','-']);
  assert.equal(low.options.shell,false);
  assert.equal(high.options.shell,false);
  assert.deepEqual(provider.nativeSettings,{profile:'operator'});
  assert.deepEqual(prepareCodexLaunch(provider,base,environment).args,native.args);
  const literal=prepareCodexLaunch(provider,{...base,reasoning:{
    mode:'selectable',level:'custom',nativeValue:'raw"\\token',selectionSource:'default',
  }},environment);
  assert.equal(literal.args.at(-2), 'model_reasoning_effort=' + JSON.stringify('raw"\\token'));
  assert.throws(()=>prepareCodexLaunch(provider,{...base,reasoning:{
    mode:'selectable',level:'invalid',nativeValue:'x' + String.fromCharCode(0) + 'broken',selectionSource:'model',
  }},environment),/reasoning.nativeValue/);
});
