import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {runVerification} from '../src/repo.mjs';
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
  console.log('execution-verification-cache: PASS');
} finally {
  if(oldCmd===undefined) delete process.env.AGENT_VERIFY_COMMANDS;else process.env.AGENT_VERIFY_COMMANDS=oldCmd;
  if(oldInputs===undefined) delete process.env.AGENT_VERIFY_INPUT_CLOSURES;else process.env.AGENT_VERIFY_INPUT_CLOSURES=oldInputs;
  await rm(dir,{recursive:true,force:true});
}
