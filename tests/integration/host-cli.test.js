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
    for (const mode of ['compact','detailed','debug']) {
      const presented = call(['run','Привет, мир 🌍','--config',config,'--format','json','--presentation',mode]);
      assert.equal(presented.status,0,presented.stderr);
      assert.equal(JSON.parse(presented.stdout).assessment.answer,assessment.answer);
      assert.match(presented.stderr,/✓ Operation complete\n  1 Controller attempt · 0 Worker attempts · 0 recorded findings/);
    }
    const raw = '\x1b[2JПривет 🌍\nLine\x1b]52;c;SECRET\x07\x9b31m!';
    const redirected = call(['run','tty-control','--config',config]);
    assert.equal(redirected.stdout, raw + '\n');
    const json = call(['run','tty-control','--config',config,'--format','json']);
    assert.equal(JSON.parse(json.stdout).assessment.answer,raw);
    const question = call(['run','tty-question','--config',config]);
    assert.equal(question.stdout,raw+'\n');
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

test('C17R configured capture reaches local sink only and leaves CLI machine output unchanged',()=>withOwnedRun('C17R-cli-private',async(cwd,spawn)=>{
  const config=join(cwd,'config.json');
  const spec={schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},
    providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url)),'controller-contract']}}},
    storage:{directory:'state'},diagnostics:{captureBodies:true,promptCaptureMaxBytes:262144}};
  await writeFile(config,JSON.stringify(spec));
  const result=spawn(process.execPath,[entry,'run','fixture task','--config',config,'--format','json','--presentation','debug'],{cwd});
  assert.equal(result.status,0,result.stderr);
  const parsed=JSON.parse(result.stdout);
  assert.equal(parsed.status,'finished');
  assert.equal(parsed.assessment.answer,'# Result\nПроверка 🧪\n{"value":1}');
  assert.doesNotMatch(result.stdout,/adapter\.prompt\.capture|serializedPromptBytes|Controller Invocation \(sectioned JSON\)/);
  assert.doesNotMatch(result.stderr,/Controller Invocation \(sectioned JSON\)/);
  const events=(await readFile(join(cwd,'state','diagnostics','diagnostics.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const capture=events.find(e=>e.eventName==='adapter.prompt.capture');
  assert.equal(capture.operationId,parsed.operationId);
  assert.match(capture.details.prompt,/Controller Invocation \(sectioned JSON\)/);
  assert.equal(capture.details.captureCompleteness,'complete_before_redaction');
  assert.equal(capture.details.captureLimitBytes,262144);
}));

test('C24 CLI lists shared settings and skills without a Store, applies explicit flags and forwards file references',()=>withOwnedRun('C24-cli',async(cwd,spawn)=>{
  const native=fileURLToPath(new URL('../fixtures/c24-native-agent.js',import.meta.url));
  const config=join(cwd,'config.json');
  const skillDir=join(cwd,'.agents','skills','c24-cli');
  await mkdir(skillDir,{recursive:true});
  const skill=join(skillDir,'SKILL.md');
  await writeFile(skill,'---\nname: c24-cli\ndescription: CLI skill\n---\nInstructions\n');
  const spec={schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture',features:{reasoningEffort:'shared',approvalMode:'approval'}}},
    providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[native,'controller']},featureBindings:{reasoningEffort:{kind:'configOption',id:'arbitrary-thought-id'},approvalMode:{kind:'configOption',id:'opaque-approval'}}}},
    features:{reasoningEffort:{shared:{default:'low',options:[{id:'low',nativeValue:'native-low'},{id:'high',nativeValue:'native-high'}]}},approvalMode:{approval:{default:'review',options:[{id:'review',nativeValue:'native-review'},{id:'open',nativeValue:'native-open'}]}}},storage:{directory:'state'}};
  await writeFile(config,JSON.stringify(spec));
  const call=args=>spawn(process.execPath,[entry,...args,'--config',config,'--format','json'],{cwd});
  const settings=call(['settings']);
  assert.equal(settings.status,0,settings.stderr);
  const {readUserSettings}=await import('../../src/main/index.js');
  assert.deepEqual(JSON.parse(settings.stdout),JSON.parse(JSON.stringify(await readUserSettings(JSON.stringify(spec),cwd,cwd))));
  const skills=call(['skills']);
  assert.equal(skills.status,0,skills.stderr);
  assert.ok(JSON.parse(skills.stdout).commands.some(x=>x.path===skill));
  await assert.rejects(readFile(join(cwd,'c24-wire.jsonl')),{code:'ENOENT'});
  const {stat}=await import('node:fs/promises');
  await assert.rejects(stat(join(cwd,'state')),{code:'ENOENT'});
  const path=join(cwd,'not-created file.txt');
  const run=call(['run','task','--profile','primary','--reasoning-effort','high','--agent-skill','c24-cli','--attachment',path]);
  assert.equal(run.status,0,run.stderr);
  const result=JSON.parse(run.stdout);
  assert.equal(result.status,'finished');
  const read=async()=> (await readFile(join(cwd,'c24-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const first=(await read())[0];
  assert.equal(first.settings['arbitrary-thought-id'],'native-high');
  assert.equal(first.userSelectedSkills[0].path,skill);
  const {pathToFileURL}=await import('node:url');
  assert.equal(first.blocks.find(x=>x.type==='resource_link').uri,pathToFileURL(path).href);
  const resume=call(['resume',result.operationId,'follow-up','--approval-mode','open']);
  assert.equal(resume.status,0,resume.stderr);
  assert.equal((await read()).at(-1).settings['opaque-approval'],'native-open');
  assert.equal(call(['resume',result.operationId,'--reasoning-effort','low']).status,2);
}));
