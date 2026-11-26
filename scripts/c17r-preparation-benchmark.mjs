import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {withOwnedRun,root} from './owned-run.mjs';

const builds=[['B','d80638609d86da92e2a88d939fa09a90a1a3cfbf'],['C17','e7e8bf84b731b5db9d3a6f9cb9133a74a1da34ff'],
  ['C17R',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()]];
const volumes=[65536,262144,1048576], rounds=3;
const round=x=>Math.round(x*1000)/1000;
const summary=values=>({min:round(Math.min(...values)),median:round([...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]),max:round(Math.max(...values))});
const moduleAt=(directory,path)=>import(pathToFileURL(join(directory,path)).href);

await withOwnedRun('C17R-preparation',async directory=>{
  const results=[];
  for(const [label,sha] of builds){
    const source=label==='C17R'?root:join(directory,label);
    if(label!=='C17R'){
      await mkdir(source);
      const archive=execFileSync('git',['archive',sha],{maxBuffer:32*1024*1024});
      execFileSync('tar',['-xf','-','-C',source],{input:archive});
      await symlink(resolve(root,'node_modules'),join(source,'node_modules'),'dir');
    }
    const {setup,final}=await moduleAt(source,'tests/fixtures/application.js');
    const {request}=await moduleAt(source,'tests/fixtures/core.js');
    const {renderInvocationPrompt,parseDecisionText}=await moduleAt(source,'src/adapters/invocation-prompt.js');
    const {createEventStream}=await moduleAt(source,'src/application/events.js');
    const reporter=label==='B'?undefined:(await moduleAt(source,'src/adapters/prompt-diagnostics.js')).createPromptReporter;
    for(const bytes of volumes){
      const samples=[];
      for(let n=0;n<rounds;n++){
        let writes=0,calls=0,diagnosticBytes=0,diagnosticCount=0,dispatchAt,preparedAt;
        const memory=new Map(), prep=[], render=[], full=[], activityLatency=[], hostBytes=[], prompts=[], emittedAt=new Map();
        const store={async open(){},async close(){},async list(){return structuredClone([...memory.values()])},
          async load(id){return structuredClone(memory.get(id))},
          async commit(id,revision,state){
            if((memory.get(id)?.revision??null)!==revision)return {kind:'conflict'};
            writes++;memory.set(id,structuredClone(state));return {kind:'committed'};
          }};
        const sink={emit(event){diagnosticBytes+=Buffer.byteLength(JSON.stringify(event)+'\n');diagnosticCount++;},flush(){}};
        const stream=createEventStream(sink,{captureBodies:false});
        let diagId=0;
        const report=reporter?.({diagnostics:stream,clock:{now:()=>1,monotonicNow:()=>performance.now()},ids:{newId:()=>String(++diagId)}});
        const start=performance.now();
        const fixture=setup({store,maxInvocations:4,context:{controllerMaxBytes:bytes},
          emit(event){
            if(event.eventName==='attempt.dispatched')dispatchAt=performance.now();
            if(event.eventName==='context.host_prepared'){preparedAt=performance.now();hostBytes.push(event.details.serializedContextBytes);}
            stream.emit(event);
          },
          respond(invocation,count,observe,activity){
            const stamp=performance.now();
            if(dispatchAt!==undefined&&preparedAt!==undefined)prep.push(preparedAt-dispatchAt);
            calls++;
            let componentSizes={};
            const prompt=renderInvocationPrompt(invocation,'deterministic provider boundary',value=>{componentSizes=value;});
            report?.(invocation,'prepared',componentSizes,prompt);
            render.push(performance.now()-stamp);
            prompts.push(Buffer.byteLength(prompt));
            full.push(performance.now()-(dispatchAt??start));
            emittedAt.set(invocation.attemptId,performance.now());
            activity?.({kind:'reasoning',nativeKind:'agent_thought_chunk',payload:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'probe'}}});
            if(count===3)return final(invocation);
            const refs=[];
            // Many separate records rather than a single artificial 1 MiB message.
            for(let i=0;i<bytes/16384;i++){
              const ref=observe({kind:'model',sourceId:'history-'+count+'-'+i,ref:'history-'+i,
                completeness:'complete',value:'x'.repeat(16384)});
              refs.push({ref,kind:'output',source:'model_claim'});
            }
            const raw='# Draft '+ '🧪'.repeat(4096);
            const ref=observe({kind:'model',sourceId:'rejected',ref:'rejected',completeness:'complete',value:raw});
            const reply=final(invocation);
            return {...reply,...parseDecisionText(raw),outputObservationRef:ref,
              outcome:{...reply.outcome,outputRefs:[...refs,{ref,kind:'output',source:'model_claim'}]}};
          }});
        const submitted=await fixture.api.submit(request({text:'Prepare fixed synthetic task'}));
        const subscription=fixture.api.subscribeActivity({operationId:submitted.operation.operationId},event=>{
          if(event.kind!=='gap'&&emittedAt.has(event.attemptId))activityLatency.push(performance.now()-emittedAt.get(event.attemptId));
        });
        try{
          const state=await submitted.completion;
          await subscription.finish();
          assert.equal(state.status,'finished',fixture.respondErrors.map(String).join('\n'));
          assert.equal(state.assessment.answer,'Direct answer');
          assert.equal(calls,3);
          assert.equal(state.events.filter(e=>e.kind==='controller.invalid_proposal').length,2);
          assert.equal(hostBytes.length,3);
          samples.push({writes,calls,diagnosticBytes,diagnosticCount,hostBytes:hostBytes.at(-1),promptBytes:prompts.at(-1),
            preparationMs:prep.length?prep.at(-1):null,renderDiagnosticsMs:render.at(-1),preDispatchMs:full.at(-1),
            activityLatencyMs:activityLatency.length?activityLatency.at(-1):null,wallMs:performance.now()-start});
        }finally{subscription();await fixture.api.close();await stream.flush();stream.close();}
      }
      const metrics={};
      for(const key of Object.keys(samples[0])){
        const observed=samples.map(x=>x[key]).filter(Number.isFinite);
        metrics[key]=observed.length?summary(observed):null;
      }
      results.push({label,sha,historyBudget:bytes,rounds,metrics});
    }
  }
  for(const bytes of volumes){
    const rows=results.filter(x=>x.historyBudget===bytes);
    assert.equal(new Set(rows.map(x=>x.metrics.writes.median)).size,1,'diagnostics/recovery must not add state writes');
    assert.equal(new Set(rows.map(x=>x.metrics.calls.median)).size,1);
  }
  console.log('C17R_PREPARATION '+JSON.stringify({node:process.version,
    scope:'exact checkout, actual Application preparation and rendering at deterministic ProviderPort boundary; in-memory counted StateStore, capture off; no real model or OS transport timing',
    unavailable:['exact journal traversal counts','allocation/copy counts beyond existing C17 renderer probe'],
    results}));
});
