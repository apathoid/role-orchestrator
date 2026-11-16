import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdir, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, withOwnedRun } from './owned-run.mjs';
const baseline='320f24fa9e994c221b5f1ad05b937fa47b18b3cd';
function checked(cmd,args,opt={}){
  const r=spawnSync(cmd,args,{cwd:root,timeout:30000,maxBuffer:32*1024*1024,...opt});
  assert.equal(r.status,0,String(r.stderr??r.error));return r.stdout;
}
async function run(source){
  const {createCliInput}=await import(pathToFileURL(join(source,'src/hosts/cli-input.js')).href);
  const input=new PassThrough(),output=new PassThrough();let printed='';
  output.on('data',b=>printed+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const ctl=new AbortController();
  const permission={kind:'permission',request:{requestId:'collision',operationId:'op',attemptId:'a',
    profileId:'worker',providerRequestId:'native',resource:'fixture',options:[
      {id:'deny',kind:'deny',label:'Deny'},{id:'option 1',kind:'allow',label:'Allow'}]}};
  const answer=terminal.ask(permission,ctl.signal);
  input.write('option 1\n');const result=await answer;
  terminal.close();input.end();
  const formInput=new PassThrough(),formOutput=new PassThrough();let formText='';
  formOutput.on('data',b=>formText+=b);
  const formTerminal=createCliInput(formInput,formOutput,true,()=>{});
  const stop=new AbortController();
  const form={kind:'input',request:{requestId:'f',operationId:'op',attemptId:'a',profileId:'worker',
    providerRequestId:'form',nativeKind:'elicitation/create',deadlineAt:Date.now()+30000,payload:{
      mode:'form',message:'What should happen?',requestedSchema:{type:'object',properties:{
        answer:{type:'string',title:'Choose an action',oneOf:[{const:'no',title:'Decline'},{const:'yes',title:'Proceed'}]}
      },required:['answer']}}}};
  let settled=false;const requested=formTerminal.ask(form,stop.signal).then(v=>{settled=true;return v;});
  formInput.write('ordinary text\n');await new Promise(resolve=>setImmediate(resolve));
  const resultBeforeAbort=settled;stop.abort();await requested;
  formTerminal.close();formInput.end();
  return {permission:result,printed,formText,freeTextAccepted:resultBeforeAbort};
}
await withOwnedRun('C15R6-red',async cwd=>{
  const old=join(cwd,'baseline');await mkdir(old);
  checked('tar',['-x','-C',old],{input:checked('git',['archive',baseline])});
  await symlink(join(root,'node_modules'),join(old,'node_modules'),'dir');
  const red=await run(old);
  assert.deepEqual(red.permission,{kind:'answered',payload:{optionId:'option 1'}});
  assert.equal(red.freeTextAccepted,false);
  assert.doesNotMatch(red.formText,/Decline.*Proceed/s);
  console.log('C15R6_RED '+JSON.stringify(red));
  if(process.argv.includes('--baseline-only'))return;
  const green=await run(root);
  assert.deepEqual(green.permission,{kind:'answered',payload:{optionId:'deny'}});
  assert.match(green.formText,/Choose an action/);
  assert.match(green.formText,/Decline/);
  assert.match(green.formText,/Proceed/);
  console.log('C15R6_GREEN '+JSON.stringify(green));
});
