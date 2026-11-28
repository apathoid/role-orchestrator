import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { root, withOwnedRun } from './owned-run.mjs';

const corrective=process.argv.includes('--c15r');
const baseline=corrective?'6d3da730b49dfec77bcb12cce3bbbfe007fc16fd':'c5c4fca422b895b1962d7c2521cb168ac50ec655';
const a=methods.agent,c=methods.client;
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
const round=n=>Math.round(n*100)/100;
function checked(command,args,options={}){
  const result=spawnSync(command,args,{cwd:root,maxBuffer:64*1024*1024,timeout:30000,...options});
  assert.equal(result.status,0,String(result.stderr??result.error));
  return result.stdout;
}
function normalize(view){
  return {status:view.status,revision:view.revision,overall:view.assessment?.overall,answer:view.assessment?.answer,
    requirements:view.assessment?.requirements,unresolvedQuestions:view.assessment?.unresolvedQuestions,
    resources:view.resources,attempts:view.attempts.map(attempt=>({
      kind:attempt.actionId===attempt.attemptId?'controller':attempt.actionId,status:attempt.status,
      profile:attempt.route?.profileId,provider:attempt.route?.providerId,model:attempt.route?.model,reasoning:attempt.route?.reasoning,
      terminal:attempt.terminal,effect:attempt.effect,dispatchCertainty:attempt.dispatchCertainty,cancellation:attempt.cancellation,
    }))};
}
async function cli(entry,cwd,config,mode){
  const started=performance.now();let first=null,out='',err='',bytes=0;
  const child=spawn(process.execPath,[entry,'run','notice-delegate','--config',config,'--format','json',...(mode?['--presentation',mode]:[])],{cwd,stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close');const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  child.stdout.on('data',chunk=>{first??=performance.now()-started;out+=chunk;});
  child.stderr.on('data',chunk=>{first??=performance.now()-started;bytes+=chunk.length;err+=chunk;});
  try{const [code]=await closed;assert.equal(code,0,err);const result=JSON.parse(out);assert.equal(result.assessment.answer,'Notice final');
    return {firstMs:first,totalMs:performance.now()-started,presentationBytes:bytes,semantic:normalize(result)};
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
}
async function acp(entry,cwd,config,display,current,capable){
  const child=spawn(process.execPath,[entry,'acp','--config',config,'--presentation','detailed',...(current?['--progress-display',display]:[])],{cwd,stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  let stderr='',start=0,first=null,updates=[],bytes=0;
  child.stderr.on('data',chunk=>stderr+=chunk);
  const connection=client().onNotification(c.session.update,({params})=>{
    first??=performance.now()-start;
    updates.push(params.update);bytes+=Buffer.byteLength(JSON.stringify(params.update));
  }).connect(ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
  const agent=connection.agent;
  try{
    await agent.request(a.initialize,{protocolVersion:PROTOCOL_VERSION,clientCapabilities:capable?{session:{notices:{}}}:{}});
    const {sessionId}=await agent.request(a.session.new,{cwd,mcpServers:[]});
    const prompt=()=>agent.request(a.session.prompt,{sessionId,prompt:[{type:'text',text:'native UX'}],_meta:{roleOrchestrator:{newOperation:true}}});
    start=performance.now();const reply=await prompt();const totalMs=performance.now()-start;
    assert.equal(reply.stopReason,'end_turn');
    const finals=updates.filter(u=>u.sessionUpdate==='agent_message_chunk'&&!u._meta?.roleOrchestratorSource).map(u=>u.content.text);
    assert.deepEqual(finals,['Native final once']);
    const native=updates.filter(u=>['agent_thought_chunk','tool_call','tool_call_update','plan'].includes(u.sessionUpdate));
    assert.ok(native.length>=9);
    const semantic={finals,stopReason:reply.stopReason,counts:Object.fromEntries(['agent_thought_chunk','tool_call','tool_call_update','plan'].map(kind=>[kind,native.filter(u=>u.sessionUpdate===kind).length]))};
    const result={firstMs:first,totalMs,presentationBytes:bytes,updates:updates.length,semantic};
    // Identical three accepted turns; repeated history load measures durable view only.
    await prompt();await prompt();updates=[];bytes=0;
    const loadTimes=[];
    for(let i=0;i<3;i++){
      const before=performance.now();await agent.request(a.session.load,{sessionId,cwd,mcpServers:[]});loadTimes.push(performance.now()-before);
    }
    assert.equal(updates.filter(u=>u.sessionUpdate==='user_message_chunk').length,9);
    assert.equal(updates.filter(u=>u.sessionUpdate==='agent_message_chunk'&&!u._meta?.roleOrchestratorSource&&u.content.text==='Native final once').length,9);
    return {...result,historyMedianMs:median(loadTimes),historyUpdates:updates.length,historyBytes:bytes};
  }finally{child.stdin.end();const [code]=await closed;clearTimeout(timer);assert.equal(code,0,stderr);}
}
function summarize(samples){
  const keys=Object.keys(samples[0]).filter(k=>typeof samples[0][k]==='number');
  return Object.fromEntries(keys.map(k=>[k,round(median(samples.map(s=>s[k])))]));
}
await withOwnedRun('C15-benchmark',async cwd=>{
  const old=join(cwd,'baseline');await mkdir(old);
  const archive=checked('git',['archive',baseline]);
  checked('tar',['-x','-C',old],{input:archive});
  // Historical code shares the installed dependency tree. Every dependency it
  // actually locked must remain byte-identical in resolution and metadata.
  // C24 adds YAML; additional current-only packages do not change that baseline.
  const baselineLock=JSON.parse(await readFile(join(old,'package-lock.json'),'utf8'));
  const currentLock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
  for(const [key,value] of Object.entries(baselineLock.packages)){
    if(key==='')continue;
    assert.deepEqual(currentLock.packages[key],value,'Historical dependency changed: '+key);
  }
  await symlink(join(root,'node_modules'),join(old,'node_modules'),'dir');
  const work=join(cwd,'work');await mkdir(work);
  const config=join(work,'config.json');
  const configure=async native=>writeFile(config,JSON.stringify({
    schemaVersion:1,controllerProfile:'primary',profiles:{primary:{provider:'test',model:'fixture'}},
    providers:{test:native?{adapter:'acp',launch:{command:process.execPath,args:[join(root,'tests/fixtures/acp-contract-agent.js'),'host-native-ux']}}:{adapter:'host-fixture'}},
    // Compare presentation under the same historical finite policy, not changed C20 defaults.
    resources:{maxConcurrentInvocations:2,maxInvocationsPerOperation:40,invocationTimeoutMs:180000},
    storage:{directory:'state'},plugins:native?[]:[{id:'host-fixture',module:join(root,'tests/fixtures/host-plugin.js')}],
  }));
  const cases=[
    ['baseline-cli-headless',old,'cli',undefined],['current-cli-headless',root,'cli',undefined],
    ['baseline-cli-compact',old,'cli','compact'],['current-cli-compact',root,'cli','compact'],
    ['current-cli-detailed',root,'cli','detailed'],['current-cli-debug',root,'cli','debug'],
    [corrective?'baseline-acp-inline':'baseline-acp-no-notices',old,'acp',corrective?'inline':'notices',false],['baseline-acp-notices',old,'acp','notices',true],
    ['current-acp-inline',root,'acp','inline',false],['current-acp-notices',root,'acp','notices',true],
  ];
  const results=new Map(cases.map(([name])=>[name,[]]));
  const references=new Map();
  // Interleave all modes in each round. Fresh state; same configuration/workspace and fixture.
  for(let round=0;round<3;round++)for(const [name,source,kind,mode,capable] of cases){
    await rm(join(work,'state'),{recursive:true,force:true});await configure(kind==='acp');
    const entry=join(source,'src/main/cli.js');
    const sample=kind==='cli'?await cli(entry,work,config,mode):await acp(entry,work,config,mode,source===root||corrective,capable);
    if(references.has(kind))assert.deepEqual(sample.semantic,references.get(kind),name);
    else references.set(kind,sample.semantic);
    results.get(name).push(sample);
  }
  const report=Object.fromEntries([...results].map(([name,samples])=>[name,summarize(samples)]));
  console.log((corrective?'C15R_HISTORY_BENCHMARK ':'C15_BENCHMARK ')+JSON.stringify({baseline,current:String(checked('git',['rev-parse','HEAD'])).trim(),node:process.version,rounds:3,units:'ms and bytes; median',report}));
});
