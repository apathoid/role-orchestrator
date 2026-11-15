import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { withOwnedRun } from '../../scripts/owned-run.mjs';
import { readDescriptor } from '../../src/hosts/local-control.js';

const entry=fileURLToPath(new URL('../../src/main/cli.js',import.meta.url));
const fixture=fileURLToPath(new URL('../fixtures/host-plugin.js',import.meta.url));
const agent=fileURLToPath(new URL('../fixtures/acp-contract-agent.js',import.meta.url));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function config(cwd,acp=false,scenario='host-elicitation') {
  const path=join(cwd,'config.json');
  await writeFile(path,JSON.stringify({schemaVersion:1,controllerProfile:'primary',
    profiles:{primary:{provider:'test',model:'fixture'}},
    providers:{test:acp?{adapter:'acp',launch:{command:process.execPath,args:[agent,scenario]}}:{adapter:'host-fixture'}},
    storage:{directory:'state'},plugins:acp?[]:[{id:'host-fixture',module:fixture}]}));
  return path;
}
async function tty(cwd,args,reply,expected) {
  // util-linux script allocates an actual PTY; this is a transport fixture,
  // not a real model or graphical client acceptance.
  const child=spawn('script',['-qefc',[process.execPath,entry,...args].map(quote).join(' '),'/dev/null'],
    {cwd,stdio:['pipe','pipe','pipe'],signal:AbortSignal.timeout(12000)});
  let output='',errors='',sent=false;
  child.stdout.on('data',chunk=>{
    output+=chunk;
    if(reply!==undefined&&!sent&&output.includes('Reply (')){
      sent=true;
      assert.match(output,/Permission requested|Native form/);
      child.stdin.write(reply+'\n');
    }
  });
  child.stderr.on('data',chunk=>{errors+=chunk});
  try {
    const [code]=await once(child,'close');
    assert.equal(code,0,output+errors);
    assert.equal(sent,reply!==undefined,output);
    assert.match(output,expected);
    return output;
  } finally { if(child.exitCode===null) child.kill('SIGKILL');child.stdin.destroy(); }
}
test('actual PTY direct CLI permission and native ACP form', {timeout:30000},()=>withOwnedRun('C14-pty-direct',async cwd=>{
  const path=await config(cwd);
  await tty(cwd,['run','permission','--config',path,'--presentation','detailed'],'deny',/(?:\r?\n)deny\r?\n/);
  const acp=await config(cwd,true);
  await tty(cwd,['run','form','--config',acp,'--presentation','compact'],'{"value":"chosen"}',/(?:\r?\n)chosen\r?\n/);
}));
test('actual PTY attached CLI answers its own permission, not the writer stdin', {timeout:25000},()=>withOwnedRun('C14-pty-attached',async cwd=>{
  const path=await config(cwd);
  const owner=spawn(process.execPath,[entry,'run','hold','--config',path,'--format','json'],{cwd,stdio:['ignore','pipe','pipe']});
  owner.stdout.resume();owner.stderr.resume();
  const closed=once(owner,'close');
  try {
    for(let i=0;!await readDescriptor(join(cwd,'state'));i++){
      assert.ok(i<500,'writer did not start');await delay(10);
    }
    await tty(cwd,['run','permission','--config',path,'--presentation','debug'],'deny',/(?:\r?\n)deny\r?\n/);
    await tty(cwd,['run','permission','--config',path,'--format','json'],'deny',/"answer":"deny"/);
    assert.equal(owner.exitCode,null,'peer answer must not cancel the independent writer operation');
  } finally { owner.kill('SIGINT');await closed; }
}));

test('C14R.3 actual PTY preserves native fragments across workers and permission', {timeout:25000},()=>withOwnedRun('C14R-pty-chunks',async cwd=>{
  const path=await config(cwd,true,'host-chunks');
  const output=await tty(cwd,['run','chunks','--config',path,'--presentation','compact'],'deny',/Native final once/);
  assert.match(output,/Native thought worker-a/);assert.match(output,/Native thought worker-b/);
  assert.match(output,/continued/);assert.match(output,/Permission requested/);
  assert.match(output,/Native thought [^\r\n]+ continued/);
}));

test('C14R.5 actual PTY final answer and clarification strip terminal controls only', {timeout:25000},()=>withOwnedRun('C14R-pty-final',async cwd=>{
  const path=await config(cwd);
  for(const task of ['tty-control','tty-question']){
    const output=await tty(cwd,['run',task,'--config',path],undefined,/Привет 🌍\r?\nLine!/);
    assert.doesNotMatch(output,/\x1b\[2J|SECRET|\x9b/);
  }
}));
