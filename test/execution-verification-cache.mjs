import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {runVerification} from '../src/repo.mjs';
import { configuredVerificationInputClosures, witnessVerificationInputs } from '../src/verification-inputs.mjs';
const dir=await mkdtemp(path.join(tmpdir(),'ro-verify-cache-'));
const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:'pipe'}).trim();
const oldCmd=process.env.AGENT_VERIFY_COMMANDS,oldInputs=process.env.AGENT_VERIFY_INPUT_CLOSURES;
try {
  await writeFile(path.join(dir,'source.txt'),'baseline');
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@invalid');
  git('add','.');git('commit','-qm','initial');
  const command=[process.execPath,'-e','process.exit(0)'];
  const name=command.join(' ');
  process.env.AGENT_VERIFY_COMMANDS=JSON.stringify([command,command]);
  process.env.AGENT_VERIFY_INPUT_CLOSURES=JSON.stringify({[name]:{complete:true,cacheable:true,paths:['source.txt']}});
  let results=await runVerification(dir);
  assert.equal(results.length,3);
  assert.equal(results[0].status,'PASS');
  assert.equal(results[1].cache?.hit,true,'same input in one attempt avoids redundant verification');
  assert.equal(results[2].cache?.hit,undefined,'mandatory final diff is never cached');
  let runs=0;
  results=await runVerification(dir,{onCommandComplete:async row=>{
    runs++;
    if (runs===1) await writeFile(path.join(dir,'source.txt'),'changed');
  }});
  assert.equal(results[1].cache?.hit,false,'changed source invalidates previous result');
  await writeFile(path.join(dir,'source.txt'),'baseline');
  process.env.AGENT_VERIFY_INPUT_CLOSURES=JSON.stringify({[name]:{complete:true,paths:['source.txt']}});
  results=await runVerification(dir);
  assert.equal(results[1].cache?.hit,false,'opt-out forbids reuse');
  // Input closure names are security-relevant cache identities, not hints.
  for (const unsafe of ['./source.txt','a//b','a/./b','a/../b',
    '.GIT/config','C:relative','C:/absolute','a\\\\b','a/']) {
    assert.throws(() => configuredVerificationInputClosures(JSON.stringify({
      [name]:{complete:true,cacheable:true,paths:[unsafe]},
    })),/Invalid verification input closure/,unsafe);
    assert.equal((await witnessVerificationInputs(dir,{complete:true,paths:[unsafe]})).kind,'unknown');
  }
  if (process.platform === 'linux') {
    const outside=await mkdtemp(path.join(tmpdir(),'ro-verify-outside-'));
    try {
      await writeFile(path.join(outside,'secret'),'DO_NOT_USE_OUTSIDE');
      await symlink(outside,path.join(dir,'linked'));
      assert.equal((await witnessVerificationInputs(dir,{complete:true,paths:['linked/secret']})).kind,'unknown',
        'symlink parent must not escape a pinned workspace path');
      await symlink(path.join(outside,'secret'),path.join(dir,'linked-file'));
      assert.equal((await witnessVerificationInputs(dir,{complete:true,paths:['linked-file']})).kind,'unknown',
        'final symlink must never be followed');
      await link(path.join(dir,'source.txt'),path.join(dir,'hardlink'));
      assert.equal((await witnessVerificationInputs(dir,{complete:true,paths:['hardlink']})).kind,'unknown',
        'hardlinked files can be mutated by another name outside declared inputs');
      await rm(path.join(dir,'hardlink'));
      const verified=await witnessVerificationInputs(dir,{complete:true,paths:['source.txt']});
      assert.equal(verified.kind,'paths');
      assert.equal(verified.completeness,'complete');
      assert.equal(verified.entries[0].path,'source.txt');
    } finally { await rm(outside,{recursive:true,force:true}); }
  }
  console.log('execution-verification-cache: PASS');
} finally {
  if(oldCmd===undefined) delete process.env.AGENT_VERIFY_COMMANDS;else process.env.AGENT_VERIFY_COMMANDS=oldCmd;
  if(oldInputs===undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES;else process.env.AGENT_VERIFY_INPUT_CLOSURES=oldInputs;
  await rm(dir,{recursive:true,force:true});
}
