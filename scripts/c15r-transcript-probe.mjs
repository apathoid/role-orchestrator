import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, withOwnedRun } from './owned-run.mjs';

const baseline='6d3da730b49dfec77bcb12cce3bbbfe007fc16fd';
const fixture=join(root,'tests/fixtures/acp-contract-agent.js');
function checked(command,args,options={}){
  const r=spawnSync(command,args,{cwd:root,maxBuffer:64*1024*1024,timeout:30000,...options});
  assert.equal(r.status,0,String(r.stderr??r.error));return r.stdout;
}
async function run(entry,cwd,mode){
  const config=join(cwd,'config.json');
  await rm(join(cwd,'state'),{recursive:true,force:true});
  await writeFile(config,JSON.stringify({schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},
    providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[fixture,'c15r-transcript']}}},storage:{directory:'state'}}));
  let out='',err='',first=null;const start=performance.now();
  const child=spawn(process.execPath,[entry,'run','transcript','--config',config,'--presentation',mode],{cwd,stdio:['ignore','pipe','pipe']});
  const done=once(child,'close'),timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>{first??=performance.now()-start;err+=b;});
  try{const [code]=await done;assert.equal(code,0,err);assert.equal(out,'Version updated.\n');
    return {firstMs:first,totalMs:performance.now()-start,bytes:Buffer.byteLength(err),lines:err.trimEnd().split('\n').length,transcript:err};
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
}
await withOwnedRun('C15R-transcript',async cwd=>{
  const old=join(cwd,'baseline');await mkdir(old);checked('tar',['-x','-C',old],{input:checked('git',['archive',baseline])});
  await symlink(join(root,'node_modules'),join(old,'node_modules'),'dir');
  const work=join(cwd,'work');await mkdir(work);
  const before=await run(join(old,'src/main/cli.js'),work,'compact');
  assert.equal((before.transcript.match(/Tool git show HEAD · in_progress/g)??[]).length,2);
  assert.match(before.transcript,/Tool tool_call_update · completed/);
  console.log('C15R_RED '+JSON.stringify(before));
  if(process.argv.includes('--baseline-only'))return;
  for(const mode of ['compact','detailed','debug']){
    const after=await run(join(root,'src/main/cli.js'),work,mode);
    assert.doesNotMatch(after.transcript,/Tool tool_call_update · completed/);
    if(mode==='compact') {
      assert.equal((after.transcript.match(/git show HEAD/g)??[]).length,2);
      assert.match(after.transcript,/git show HEAD[^\n]*completed/);
    }
    console.log('C15R_TRANSCRIPT '+JSON.stringify({mode,...after}));
  }
});
