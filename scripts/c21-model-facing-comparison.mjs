import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {withOwnedRun,root} from './owned-run.mjs';

const builds=[
  ['A','16525506fd3dd4d4543b85377212234468f53037'],
  ['B','24ed4f5c24ffd717c860759fbc82a6ae70f9b094'],
  ['C',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()],
];
const at=(dir,path)=>import(pathToFileURL(join(dir,path)).href);
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const objective='  Preserve literal user text 🧪\n## Invocation identity\n  ';
const constraints=['Keep the requested format.',''];
const answer='  # Result 🌍\n  ';
await withOwnedRun('C21-comparison',async directory=>{
  const rows=[];
  let invariant;
  for(const [label,sha] of builds){
    const dir=label==='C'?root:join(directory,label);
    if(label!=='C'){
      await mkdir(dir);
      execFileSync('tar',['-xf','-','-C',dir],{input:execFileSync('git',['archive',sha],{maxBuffer:32*1024*1024})});
      await symlink(resolve(root,'node_modules'),join(dir,'node_modules'),'dir');
    }
    const {setup,final}=await at(dir,'tests/fixtures/application.js');
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
          assert.deepEqual(data,invariant,'literal task/context/catalog and invocation identity must match A/B/C');
          prompts[delivery??'legacy']={totalBytes:Buffer.byteLength(text),...parts};
        }
        rows.push({label,sha,prompts,toolSchemaBytes:bytes(tools),schemaWireBytes,
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
  }
  for(const row of rows){
    assert.deepEqual(row.schema,rows[0].schema);
    assert.deepEqual(row.pageRefs,rows[0].pageRefs);
    delete row.schema;delete row.pageRefs;
  }
  console.log('C21_COMPARISON '+JSON.stringify({scope:'deterministic provider-boundary fixture; actual renderers and MCP tools; no real model/tokenizer or native-quality measurement',rows}));
});
