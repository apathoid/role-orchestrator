import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, withOwnedRun } from './owned-run.mjs';

// Real CLI input module on the exact review baseline, not a mock parser.
const baseline='0bd01ccca8eb1740805af5d04aed6cbced5b3d60';
function checked(command,args,options={}){
  const result=spawnSync(command,args,{cwd:root,maxBuffer:32*1024*1024,timeout:30000,...options});
  assert.equal(result.status,0,String(result.stderr??result.error));
  return result.stdout;
}
async function observed(source,command,lowLevel=false){
  const {createCliInput}=await import(pathToFileURL(join(source,'src/hosts/cli-input.js')).href);
  const input=new PassThrough(),output=new PassThrough();
  let display='';output.on('data',part=>display+=part);
  const terminal=createCliInput(input,output,true,()=>{});
  const cancel=new AbortController();
  const form={kind:'input',request:{
    requestId:'validation',operationId:'op',attemptId:'a',profileId:'fixture',
    providerRequestId:'p',nativeKind:'elicitation/create',deadlineAt:Date.now()+30000,
    payload:{mode:'form',message:'Native validation',requestedSchema:{
      type:'object',properties:{value:{type:'string',pattern:'(a+)+$'}},required:['value']
    }}
  }};
  /** @type {unknown} */
  let reply;
  const pending=terminal.ask(form,cancel.signal).then(value=>{reply=value;});
  const sample='a'.repeat(40)+'!';
  input.write((lowLevel?':json '+JSON.stringify({value:sample}):sample)+'\n'+command+'\n');
  await new Promise(resolve=>setImmediate(resolve));
  const replyBeforeTimeout=reply??null;
  // Always unwind the expected baseline failure; never leave a native task alive.
  cancel.abort();await pending;
  terminal.close();input.end();
  return {replyBeforeTimeout,display:display.slice(-350)};
}
await withOwnedRun('C15R6R-Final-cancel',async cwd=>{
  const old=join(cwd,'baseline');await mkdir(old);
  checked('tar',['-x','-C',old],{input:checked('git',['archive',baseline])});
  await symlink(join(root,'node_modules'),join(old,'node_modules'),'dir');
  for(const command of [':cancel',':decline'])for(const lowLevel of [false,true]){
    const red=await observed(old,command,lowLevel);
    assert.equal(red.replyBeforeTimeout,null,'baseline unexpectedly settled during validation');
    console.log('C15R6R_FINAL_RED '+JSON.stringify({command,lowLevel,reply:red.replyBeforeTimeout}));
    const green=await observed(root,command,lowLevel);
    assert.deepEqual(green.replyBeforeTimeout,{kind:'answered',payload:{action:command.slice(1)}});
    console.log('C15R6R_FINAL_GREEN '+JSON.stringify({command,lowLevel,reply:green.replyBeforeTimeout}));
  }
});
