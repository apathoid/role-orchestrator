import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
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
  assert.deepEqual(await readFile(join(old,'package-lock.json')),await readFile(join(root,'package-lock.json')));
  const cases=[['baseline',join(old,'src/main/cli.js'),'compact'],
    ...(!process.argv.includes('--baseline-only')?['compact','detailed','debug'].map(mode=>[mode,join(root,'src/main/cli.js'),mode]):[])];
  const results=new Map(cases.map(([name])=>[name,[]]));
  for(let round=0;round<3;round++)for(const [name,entry,mode] of cases){
    const sample=await run(entry,work,mode);
    if(name==='baseline'){
      assert.equal((sample.transcript.match(/Tool git show HEAD · in_progress/g)??[]).length,2);
      assert.match(sample.transcript,/Tool tool_call_update · completed/);
    }else{
      assert.doesNotMatch(sample.transcript,/Tool tool_call_update · completed/);
      assert.match(sample.transcript,name==='debug'?/\[T1\] git show HEAD · completed/:/\[T1\] · completed/);
      assert.match(sample.transcript,/Inspect the commit\.\n  Read the diff\./);
      const expected=name==='debug'?3:1;
      assert.equal((sample.transcript.match(/git show HEAD/g)??[]).length,expected);
    }
    if(round===0)console.log((name==='baseline'?'C15R_RED ':'C15R_TRANSCRIPT ')+JSON.stringify({mode:name,...sample}));
    results.get(name).push(sample);
  }
  const median=values=>[...values].sort((a,b)=>a-b)[1];
  const report=Object.fromEntries([...results].map(([name,samples])=>[name,Object.fromEntries(['firstMs','totalMs','bytes','lines'].map(key=>[key,Math.round(median(samples.map(s=>s[key]))*100)/100]))]));
  console.log('C15R_BENCHMARK '+JSON.stringify({baseline,current:String(checked('git',['rev-parse','HEAD'])).trim(),node:process.version,rounds:3,report}));
});
