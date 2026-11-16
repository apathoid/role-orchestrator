import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, access } from 'node:fs/promises';
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
async function tty(cwd,args,reply,expected,env=process.env,columns) {
  // util-linux script allocates an actual PTY; this is a transport fixture,
  // not a real model or graphical client acceptance.
  const command=(columns?'stty cols '+columns+'; exec ':'')+[process.execPath,entry,...args].map(quote).join(' ');
  const child=spawn('script',['-qefc',command,'/dev/null'],
    {cwd,env,stdio:['pipe','pipe','pipe'],signal:AbortSignal.timeout(12000)});
  let output='',errors='',sent=false;
  child.stdout.on('data',chunk=>{
    output+=chunk;
    if(reply!==undefined&&!sent&&output.includes('Reply (')){
      sent=true;
      assert.match(output,/Permission requested|Native question/);
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
  await tty(cwd,['run','permission','--config',path,'--presentation','detailed'],'id:deny',/(?:\r?\n)deny\r?\n/);
  const acp=await config(cwd,true);
  await tty(cwd,['run','form','--config',acp,'--presentation','compact'],'chosen',/(?:\r?\n)chosen\r?\n/);
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
    await tty(cwd,['run','permission','--config',path,'--presentation','debug'],'id:deny',/(?:\r?\n)deny\r?\n/);
    await tty(cwd,['run','permission','--config',path,'--format','json'],'id:deny',/"answer":"deny"/);
    assert.equal(owner.exitCode,null,'peer answer must not cancel the independent writer operation');
  } finally { owner.kill('SIGINT');await closed; }
}));

test('C14R.3 actual PTY preserves native fragments across workers and permission', {timeout:25000},()=>withOwnedRun('C14R-pty-chunks',async cwd=>{
  const path=await config(cwd,true,'host-chunks');
  const output=await tty(cwd,['run','chunks','--config',path,'--presentation','compact'],'id:deny',/Native final once/);
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


test('C15 actual PTY trusted colors, native lifecycle and NO_COLOR plain fallback',{timeout:25000},()=>withOwnedRun('C15-pty-color',async cwd=>{
  const path=await config(cwd);
  const env={...process.env,TERM:'xterm-256color'};delete env.NO_COLOR;
  const args=['run','notice-delegate','--config',path,'--presentation','compact'];
  const colored=await tty(cwd,args,undefined,/Notice final/,env);
  assert.match(colored,/\x1b\[1;36mRole Orchestrator/);
  assert.match(colored,/Invocation dispatched/);
  assert.match(colored,/Recorded finding/);
  assert.match(colored,/\x1b\[32m\s*✓ Operation complete/);
  assert.ok(colored.indexOf('Notice final')<colored.indexOf('✓ Operation complete'));
  const plain=await tty(cwd,args,undefined,/Notice final/,{...env,NO_COLOR:'1'});
  assert.match(plain,/Role Orchestrator/);
  assert.match(plain,/Recorded finding/);
  assert.doesNotMatch(plain,/\x1b\[[0-9;]*m/);
}));


function assertTranscript(output,profile){
  assert.match(output,new RegExp('● Controller #1 · '+profile));
  assert.match(output,new RegExp('Thinking · Controller #1 · '+profile+'\\n  Inspect the commit\\.\\n  Read the diff\\.'));
  assert.equal((output.match(/git show HEAD/g)??[]).length,1);
  assert.match(output,/◇ \[T1\] git show HEAD · in_progress\n  ✓ \[T1\] · completed/);
  assert.match(output,/◇ \[T2\] Read package\.json · in_progress\n  ✗ \[T2\] · failed/);
  assert.match(output,new RegExp('Thinking · Controller #1 · '+profile+'\\n  Version only\\.'));
  assert.doesNotMatch(output,/tool_call_update · completed/);
  assert.equal((output.match(/Version updated\./g)??[]).length,1);
  assert.ok(output.indexOf('Version updated.')<output.indexOf('✓ Operation complete'));
  assert.match(output,/1 Controller attempt · 0 Worker attempts · 0 recorded findings/);
}

test('C15R actual PTY full transcript tool correlation and final before summary',{timeout:25000},()=>withOwnedRun('C15R-pty-transcript',async cwd=>{
  const path=await config(cwd,true,'c15r-transcript');
  const env={...process.env,TERM:'xterm-256color',NO_COLOR:'1'};
  const args=['run','transcript','--config',path,'--presentation','compact'];
  const output=(await tty(cwd,args,undefined,/Version updated\./,env,48)).replace(/\r\n/g,'\n');
  assertTranscript(output,'primary');
  console.log('C15R_PTY '+JSON.stringify(output));
  delete env.NO_COLOR;
  const colored=await tty(cwd,args,undefined,/Version updated\./,env,48);
  assert.match(colored,/\x1b\[2;3m/);assert.match(colored,/\x1b\[32m/);assert.match(colored,/\x1b\[1;31m/);
  assertTranscript(colored.replace(/\x1b\[[0-9;]*m/g,'').replace(/\r\n/g,'\n'),'primary');
  console.log('C15R_PTY_COLOR '+JSON.stringify(colored));
}));

test('C15R actual attached PTY uses same rich native transcript while owner remains independent',{timeout:25000},()=>withOwnedRun('C15R-pty-attached',async cwd=>{
  const path=await config(cwd,true,'c15r-transcript');
  const owner=spawn(process.execPath,[entry,'run','hold','--config',path,'--format','json'],{cwd,stdio:['ignore','pipe','pipe']});
  owner.stdout.resume();owner.stderr.resume();
  const closed=once(owner,'close');
  try{
    for(let i=0;!await readDescriptor(join(cwd,'state'));i++){assert.ok(i<500);await delay(10);}
    for(let i=0;;i++){try{await access(join(cwd,'c15r-hold-ready'));break;}catch{assert.ok(i<500);await delay(10);}}
    const output=(await tty(cwd,['run','transcript','--config',path,'--presentation','compact'],undefined,/Version updated\./,{...process.env,NO_COLOR:'1',TERM:'xterm-256color'},52)).replace(/\r\n/g,'\n');
    assertTranscript(output,'primary');assert.equal(owner.exitCode,null);
    console.log('C15R_PTY_ATTACHED '+JSON.stringify(output));
  }finally{owner.kill('SIGINT');await closed;}
}));


/** Actual Linux PTY dialogue; replies are tied to observed prompt identities, not a timer. */
async function ttyDialogue(cwd,args,replies){
  const cmd=[process.execPath,entry,...args].map(quote).join(' ');
  const child=spawn('script',['-qefc',cmd,'/dev/null'],{cwd,stdio:['pipe','pipe','pipe'],
    env:{...process.env,TERM:'xterm-256color',NO_COLOR:'1'},signal:AbortSignal.timeout(15000)});
  let output='',errors='',index=0;
  child.stdout.on('data',chunk=>{
    output+=chunk;
    while(index<replies.length&&output.includes(replies[index].when)){
      child.stdin.write(replies[index].value+'\n');
      index++;
    }
  });
  child.stderr.on('data',chunk=>errors+=chunk);
  try{
    const [code]=await once(child,'close');
    assert.equal(code,0,output+errors);
    assert.equal(index,replies.length,output);
    return output.replace(/\r\n/g,'\n');
  }finally{if(child.exitCode===null)child.kill('SIGKILL');child.stdin.destroy();}
}
const c15r6Replies=[
  {when:'Reply (#1):',value:'1'},
  {when:'Reply (#2) field 1:',value:'2'},
  {when:'Reply (#2) field 2:',value:':skip'},
];
test('C15R.6 actual SDK/PTY permission and titled form preserve identity and Markdown final',{timeout:30000},()=>withOwnedRun('C15R6-pty',async cwd=>{
  const configPath=await config(cwd,true,'c15r6-interaction');
  const output=await ttyDialogue(cwd,['run','native','--config',configPath,'--presentation','compact'],c15r6Replies);
  assert.match(output,/Permission requested/);
  assert.match(output,/What should happen next\?/);
  assert.match(output,/Continue work/);assert.match(output,/Stop work/);
  assert.match(output,/Optional context/);
  // Real interaction and lifecycle notices may legitimately interrupt Thinking.
  // They cannot produce one header per native fragment while readline redraws.
  assert.ok((output.match(/Thinking · Controller/g)??[]).length<=3,output);
  for(let i=0;i<30;i++)assert.ok(output.includes('('+i+')'),'missing native thought '+i);
  assert.match(output,/\[T1\] Read config/);assert.match(output,/\[T2\] Read config/);
  assert.match(output,/Permission: deny/);assert.match(output,/Choice: stop/);
  assert.ok(output.indexOf('### Native answer')<output.indexOf('Operation complete'));
  assert.equal((output.match(/### Native answer/g)??[]).length,1);
  console.log('C15R6_PTY '+JSON.stringify(output));
}));
test('C15R.6 attached SDK/PTY retains authoritative input route',{timeout:30000},()=>withOwnedRun('C15R6-pty-attached',async cwd=>{
  const configPath=await config(cwd,true,'c15r6-interaction');
  const owner=spawn(process.execPath,[entry,'run','hold','--config',configPath,'--format','json'],
    {cwd,stdio:['ignore','pipe','pipe']});
  owner.stdout.resume();owner.stderr.resume();
  const closed=once(owner,'close');
  try{
    for(let i=0;!await readDescriptor(join(cwd,'state'));i++){assert.ok(i<500);await delay(10);}
    for(let i=0;;i++){try{await access(join(cwd,'c15r6-hold-ready'));break;}
      catch{assert.ok(i<500);await delay(10);}}
    const output=await ttyDialogue(cwd,['run','native','--config',configPath,'--presentation','compact'],c15r6Replies);
    assert.match(output,/Permission: deny/);assert.match(output,/Choice: stop/);
    assert.equal(owner.exitCode,null);
    console.log('C15R6_PTY_ATTACHED '+JSON.stringify(output));
  }finally{owner.kill('SIGINT');await closed;}
}));
