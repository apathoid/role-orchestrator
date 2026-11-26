import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,symlink,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {withOwnedRun,root} from './owned-run.mjs';

const builds=[
  ['A','16525506fd3dd4d4543b85377212234468f53037'],
  ['B','24ed4f5c24ffd717c860759fbc82a6ae70f9b094'],
  ['C','71d6b2d64de96c43076021878e82387adc79a049'],
  ['C22A','f6d89a354724b9d11893c730d4f0871b1dfe067e'],
  ['D',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()],
];
const at=(dir,path)=>import(pathToFileURL(join(dir,path)).href);
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const objective='  Preserve literal user text 🧪\n## Invocation identity\n  ';
const constraints=['Keep the requested format.',''];
const answer='  # Result 🌍\n  ';
await withOwnedRun('C21-comparison',async directory=>{
  const rows=[];
  let invariant, nativeInvariant, c22Invariant, c22CorrectionInvariant;
  for(const [label,sha] of builds){
    const dir=label==='D'?root:join(directory,label);
    if(label!=='D'){
      await mkdir(dir);
      execFileSync('tar',['-xf','-','-C',dir],{input:execFileSync('git',['archive',sha],{maxBuffer:32*1024*1024})});
      await symlink(resolve(root,'node_modules'),join(dir,'node_modules'),'dir');
    }
    const {setup,final}=await at(dir,'tests/fixtures/application.js');
    const {createAcpProvider}=await at(dir,'src/main/index.js');
    const {request}=await at(dir,'tests/fixtures/core.js');
    const {readInvocationPrompt}=await at(dir,'tests/fixtures/read-invocation-prompt.js');
    const {renderInvocationPrompt}=await at(dir,'src/adapters/invocation-prompt.js');
    const {startMcpBridge,retrievalDetail}=await at(dir,'src/adapters/mcp-bridge.js');
    const {bindLiveEvidenceAccess}=await at(dir,'src/application/live-evidence.js');
    const {observation}=await at(dir,'src/core/observation.js');
    const records=Array.from({length:17},(_,i)=>observation({ref:'evidence:fixture:'+i,completeness:'complete',value:'Данные 🌍 '+i},
      {kind:'provider_tool',sourceId:'fixture',receivedAt:123}));
    const evidenceAccess=bindLiveEvidenceAccess({observations:records,isActive:()=>true});
    const fixture=setup({respond:async invocation=>{
      const bridge=await startMcpBridge({...invocation,evidenceAccess,controllerDelivery:'intent_mcp'});
      try{
        let id=0;
        async function rpc(method,params){
          const response=await fetch(bridge.url,{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
          assert.equal(response.status,200);
          const raw=await response.text(), data=JSON.parse(raw);
          assert.ok(data.result,raw);
          return {result:data.result,wireBytes:Buffer.byteLength(raw)};
        }
        let cursor, schemaWireBytes=0;
        const tools=[];
        do{
          const {result,wireBytes}=await rpc('tools/list',cursor===undefined?{}:{cursor});
          tools.push(...result.tools);schemaWireBytes+=wireBytes;cursor=result.nextCursor;
        }while(cursor!==undefined);
        const first=await rpc('tools/call',{name:bridge.evidenceListToolName,arguments:{}});
        const page=JSON.parse(first.result.content[0].text);
        assert.equal(page.items.length,12);assert.equal(page.resumeCursor,12);
        const second=await rpc('tools/call',{name:bridge.evidenceListToolName,arguments:{cursor:page.resumeCursor}});
        const rest=JSON.parse(second.result.content[0].text);
        assert.equal(rest.items.length,5);assert.equal(rest.resumeCursor,17);
        const fetched=await rpc('tools/call',{name:bridge.evidenceFetchToolName,arguments:{ref:page.items[0].ref}});
        const payload=JSON.parse(fetched.result.content[0].text);
        assert.equal(Buffer.from(payload.base64,'base64').toString('utf8'),records[0].value);
        const prompts={};
        for(const delivery of [undefined,'intent_text','intent_mcp']){
          let parts;
          const text=renderInvocationPrompt({...invocation,controllerDelivery:delivery,controllerDecisionToolName:bridge.decisionToolName},
            delivery==='intent_mcp'?retrievalDetail(Boolean(bridge.contextListToolName),bridge):retrievalDetail(false),value=>{parts=value});
          const decoded=readInvocationPrompt(text);
          assert.equal(decoded.objective,objective);assert.deepEqual(decoded.userConstraints,constraints);
          assert.deepEqual(decoded.context,JSON.parse(JSON.stringify(invocation.context)));
          const {instructions,...data}=decoded;
          invariant??=data;
          assert.deepEqual(data,invariant,'literal task/context/catalog and invocation identity must match A/B/C/D');
          prompts[delivery??'legacy']={totalBytes:Buffer.byteLength(text),...parts};
        }
        let c22;
        if(label==='C22A'||label==='D'){
          const invalid=await rpc('tools/call',{name:bridge.evidenceListToolName,arguments:{unknown:true}});
          const invalidValue=JSON.parse(invalid.result.content[0].text);
          assert.equal(invalidValue.kind,'unavailable');assert.equal(invalidValue.reason,'invalid_input');
          const submit=async args=>{const reply=await rpc('tools/call',{name:bridge.decisionToolName,arguments:args});
            return {value:JSON.parse(reply.result.content[0].text),wireBytes:reply.wireBytes};};
          const accepted=await submit({intent:{finalAssessment:{overall:'complete',answer}}});
          const wrong=await submit({intent:{},replaces:'foreign'});
          const rejected=await submit({intent:{finalAssessment:{overall:'complete',answer,unknown:true}},replaces:accepted.value.proposalRef});
          const corrected=await submit({intent:{finalAssessment:{overall:'complete',answer}},replaces:rejected.value.proposalRef});
          const selected=await bridge.finalizeDecision();
          assert.equal(selected.kind,'intent');assert.equal(selected.value.finalAssessment.answer,answer);
          assert.equal(selected.proposalRef,corrected.value.proposalRef);
          const primary=({code,path,expected})=>({code,path,expected});
          const stable={invalidKind:invalidValue.kind,invalidReason:invalidValue.reason,
            accepted:accepted.value.kind,wrong:primary(wrong.value.reason),rejected:primary(rejected.value.reason),selected};
          c22Invariant??=stable;assert.deepEqual(stable,c22Invariant);
          c22={invalidInputWireBytes:invalid.wireBytes,firstReceiptWireBytes:accepted.wireBytes,
            unregisteredReceiptWireBytes:wrong.wireBytes,registeredRejectionWireBytes:rejected.wireBytes,
            correctedReceiptWireBytes:corrected.wireBytes};
        }
        rows.push({label,sha,prompts,toolSchemaBytes:bytes(tools),schemaWireBytes,c22,
          combinedMcpPromptAndToolsBytes:prompts.intent_mcp.totalBytes+bytes(tools),
          evidenceListWireBytes:first.wireBytes,evidenceNextWireBytes:second.wireBytes,evidenceFetchWireBytes:fetched.wireBytes,
          schema:tools.map(({name,inputSchema})=>({name,inputSchema})),pageRefs:[...page.items,...rest.items].map(x=>x.ref)});
        return final(invocation,{finalAssessment:{...final(invocation).output.finalAssessment,answer}});
      }finally{bridge.close()}
    }});
    try{
      const state=await (await fixture.api.submit(request({text:objective,userConstraints:constraints}))).completion;
      assert.equal(state.status,'finished',fixture.respondErrors.map(String).join('\n'));
      assert.equal(state.assessment.answer,answer);
    }finally{await fixture.api.close()}

    if(label==='C22A'||label==='D'){
      const {decodeControllerIntent}=await at(dir,'src/core/controller-intent.js');
      const {materializeControllerIntent}=await at(dir,'src/application/controller-intent.js');
      const primary=({code,path,expected})=>({code,path,expected});
      const stableResult=result=>result.kind==='rejected'?{kind:result.kind,reason:primary(result.reason)}:result;
      const binding={operationId:'operation',attemptId:'attempt',contextCursor:1,profileId:'primary'};
      const samples=[{finalAssessment:{overall:'complete',answer}}, {finalAssessment:{overall:'invalid',answer}},
        {finalAssessment:{overall:'partial',answer,requirements:[{requirementId:'r',status:'unverified',unknown:true}]}},
        {nextController:{continue:true,contextRequest:{refs:[{ref:{revision:1,index:0},offset:0}]}}},
        ...[{refs:['r']},{refs:[{revision:1,index:0}]},{refs:[false]},{refs:[{ref:null,offset:0}]},
          {refs:[{revision:1,index:-1}]},{refs:[{revision:1,index:0,unknown:true}]},
          {cursor:0},{cursor:17},{cursor:false},{cursor:null},{cursor:{revision:1,index:-1}},
          {workCursor:17},{workCursor:false}].map(contextRequest=>({nextController:{continue:true,contextRequest}})),
        {additions:[{actionId:'a',kind:'delegate',profileId:'primary',objective,expectedResult:'result'}]},
        {schemaVersion:1,finalAssessment:{overall:'complete',answer}}, {finalAssessment:{overall:'complete',answer,author:'spoof'}}];
      const stableDecodes=samples.map(input=>[stableResult(decodeControllerIntent(input)),stableResult(materializeControllerIntent(input,binding))]);
      const correctionFixture=setup({respond(invocation,count){
        if(count===1)return {...final(invocation),output:'ordinary native text',controllerDeclaration:{kind:'missing'}};
        if(count===2)return {...final(invocation),controllerDeclaration:{kind:'intent',value:samples[2]}};
        return final(invocation,{finalAssessment:{...final(invocation).output.finalAssessment,answer}});
      }});
      try{
        const state=await(await correctionFixture.api.submit(request({text:objective,userConstraints:constraints}))).completion;
        assert.equal(state.status,'finished');assert.equal(state.assessment.answer,answer);
        const rejected=state.events.filter(e=>e.kind==='controller.invalid_proposal');
        const stable={decodes:stableDecodes,attempts:state.attempts.map(a=>({attemptId:a.attemptId,status:a.status,outcome:a.outcome})),
          rejected:rejected.map(e=>({...e,reason:primary(e.reason)})),assessment:state.assessment};
        c22CorrectionInvariant??=stable;assert.deepEqual(stable,c22CorrectionInvariant);
        rows.at(-1).c22.correction=correctionFixture.invocations.slice(1).map((invocation,index)=>{
          let parts;const text=renderInvocationPrompt({...invocation,controllerDelivery:index?'intent_text':'intent_mcp'},'fixture',v=>{parts=v});
          const decoded=readInvocationPrompt(text);assert.equal(decoded.objective,objective);assert.deepEqual(decoded.userConstraints,constraints);
          return {totalBytes:Buffer.byteLength(text),correctionBytes:parts.correctionBytes,historyBytes:parts.historyBytes};
        });
      }finally{await correctionFixture.api.close();}
    }

    // Historical production adapters and Orchestrators, same current SDK
    // agent fixture, actual live MCP responses and committed observations.
    // Keep the original metadata-less comparison above unchanged.
    const cwd=join(directory,'native-'+label);
    await mkdir(cwd);
    const profile={providerId:'acp',profileId:'primary',model:'fixture'};
    const provider=createAcpProvider({providerId:'acp',defaultCwd:cwd,
      configuration:{adapter:'acp',mcpBridge:true,controllerIntent:'prefer_mcp',
        launch:{command:process.execPath,args:[join(root,'tests/fixtures/acp-contract-agent.js'),'c21r-compare-sparse']}}});
    const nativeFixture=setup({provider,profile,maxInvocations:1});
    try{
      const state=await(await nativeFixture.api.submit(request({text:objective,userConstraints:constraints,workspaceContext:{cwd}}))).completion;
      assert.equal(state.status,'finished',JSON.stringify(state.events.slice(-4)));
      assert.equal(state.assessment.answer,answer);
      assert.equal(state.attempts.length,1);
      const {events,directory:live,fetched}=JSON.parse(await readFile(join(cwd,'c21r-sparse-comparison.json'),'utf8'));
      const records=live.value.items.filter(item=>item.provenance?.sourceId==='call-123');
      assert.equal(records.length,2);
      const [start,completion]=records;
      assert.deepEqual(start.native,{eventKind:'tool_call',nativeToolCallId:'call-123',title:events[0].title,kind:events[0].kind,status:'in_progress'});
      const expected={eventKind:'tool_call_update',nativeToolCallId:'call-123',status:'completed',
        ...(label!=='A'&&{title:events[0].title,kind:events[0].kind,inheritedFields:['title','kind']})};
      assert.deepEqual(completion.native,expected);
      assert.deepEqual(fetched.value.item.native,expected);
      assert.equal(completion.completeness,'complete');
      assert.equal(completion.source,'provider_reported');
      assert.equal(completion.provenance.kind,'provider_tool');
      assert.match(completion.ref,/^evidence:[a-f0-9]{64}$/);
      const saved=state.events.flatMap(e=>e.kind==='attempt.outcome'?e.observations??[]:[])
        .find(item=>item.ref===completion.ref);
      assert.ok(saved);
      assert.deepEqual(saved.native,completion.native);
      assert.deepEqual(JSON.parse(JSON.stringify(saved.provenance)),completion.provenance);
      const original=JSON.parse(Buffer.from(fetched.value.base64,'base64').toString('utf8'));
      assert.deepEqual(saved.value,original);
      assert.deepEqual(JSON.parse(original.json),events[1]);
      assert.deepEqual(state.assessment.observationRefs,[completion.ref]);
      const stable={events,ref:completion.ref,source:completion.source,provenance:completion.provenance,
        completeness:completion.completeness,value:original};
      nativeInvariant??=stable;
      assert.deepEqual(stable,nativeInvariant,'same input, canonical ref, provenance and raw payload across A/B/C/D');
      rows.at(-1).nativeSparse={start:start.native,completion:completion.native,ref:completion.ref,
        directoryWireBytes:live.wireBytes,fetchWireBytes:fetched.wireBytes,rawPayloadBytes:bytes(original)};
    }finally{await nativeFixture.api.close()}
  }
  for(const row of rows){
    assert.deepEqual(row.schema,rows[0].schema);
    assert.deepEqual(row.pageRefs,rows[0].pageRefs);
  }
  for(const row of rows){delete row.schema;delete row.pageRefs;}
  console.log('C21_COMPARISON '+JSON.stringify({scope:'deterministic provider-boundary fixture and actual historical ACP SDK subprocess/Orchestrator/live MCP sparse-event fixture; no real model/tokenizer or native-quality measurement',rows}));
});
