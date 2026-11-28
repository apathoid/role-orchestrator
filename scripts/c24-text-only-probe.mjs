import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { root, withOwnedRun } from './owned-run.mjs';

const baseline=process.argv[2]??'a8888fdaaf6990d16c259ae511f16edf607395ec';
assert.match(baseline,/^[a-f0-9]{40}$/);
const fixture=join(root,'tests/fixtures/c24-native-agent.js');
function checked(command,args,options={}){
  const r=spawnSync(command,args,{cwd:root,maxBuffer:64*1024*1024,timeout:30000,...options});
  assert.equal(r.status,0,String(r.stderr??r.error));return r.stdout;
}
await withOwnedRun('C24-text-only',async directory=>{
  const old=join(directory,'baseline');await mkdir(old);
  checked('tar',['-x','-C',old],{input:checked('git',['archive',baseline])});
  await symlink(join(root,'node_modules'),join(old,'node_modules'),'dir');
  const baselineLock=JSON.parse(await readFile(join(old,'package-lock.json'),'utf8'));
  const currentLock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
  for(const [key,value] of Object.entries(baselineLock.packages))if(key!=='')assert.deepEqual(currentLock.packages[key],value);
  const results={baseline:[],current:[]};
  for(let round=0;round<3;round++)for(const [name,entry] of [['baseline',join(old,'src/main/cli.js')],['current',join(root,'src/main/cli.js')]]){
    const cwd=join(directory,name+'-'+round);await mkdir(cwd);
    const config=join(cwd,'config.json');
    await writeFile(config,JSON.stringify({schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},
      providers:{test:{adapter:'acp',launch:{command:process.execPath,args:[fixture,'benchmark']}}},storage:{directory:'state'}}));
    const start=performance.now();
    const result=checked(process.execPath,[entry,'run','Ordinary text task','--config',config,'--format','json'],{cwd,encoding:'utf8'});
    const elapsedMs=performance.now()-start;
    const parsed=JSON.parse(result);assert.equal(parsed.status,'finished');
    assert.equal(parsed.assessment.answer,'C24 complete');
    const wire=(await readFile(join(cwd,'c24-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const rpcs=(await readFile(join(cwd,'c24-rpc.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).map(x=>x.method);
    assert.equal(wire.length,1);assert.equal(wire[0].blocks.length,0);
    assert.deepEqual(rpcs,['initialize','session/new','session/prompt']);
    results[name].push({elapsedMs:Math.round(elapsedMs),promptBytes:wire[0].promptBytes,rpcs});
  }
  console.log('C24_TEXT_ONLY '+JSON.stringify({baseline,current:String(checked('git',['rev-parse','HEAD'])).trim(),node:process.version,results,scope:'same ACP SDK subprocess fixture, no features, no real LLM or client quality inference'}));
});
