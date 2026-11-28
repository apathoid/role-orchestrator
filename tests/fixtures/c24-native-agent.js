
import { agent, methods, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import { Readable,Writable } from 'node:stream';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readInvocationPrompt } from './read-invocation-prompt.js';
const {agent:a,client:c}=methods;
const variant=process.argv[2];
const sessionId='c24-native';
const recordRpc=async method=>{if(variant==='benchmark')await appendFile('c24-rpc.jsonl',JSON.stringify({method})+'\n');};
let mode='native';
const option=(id,category,values,currentValue)=>({id,name:id,category,type:'select',currentValue,options:values.map(value=>({value,name:value}))});
let options=[
  option('model','model',['fixture','other'],'fixture'),
  option('arbitrary-thought-id','thought_level',['native-low','native-high'],'native-low'),
  option('opaque-collaboration','mode',['native-default','native-plan'],'native-default'),
  option('opaque-approval',undefined,['native-review','native-open'],'native-review'),
];
const summarize=block=>{
  if(block.type==='image'||block.type==='audio'){
    const bytes=Buffer.from(block.data,'base64');
    return {type:block.type,mediaType:block.mimeType,size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')};
  }
  if(block.type==='resource')return {type:block.type,uri:block.resource.uri,text:block.resource.text};
  return block;
};
agent()
  .onRequest(a.initialize,async()=>{await recordRpc('initialize');return {protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true,audio:true,embeddedContext:true},sessionCapabilities:{close:{}}}};})
  .onRequest(a.session.new,async()=>{await recordRpc('session/new');return {sessionId,configOptions:options,modes:{currentModeId:mode,availableModes:['native','worker-review','worker-open'].map(id=>({id,name:id}))}};})
  .onRequest(a.session.setMode,async({params})=>{await recordRpc('session/set_mode');mode=params.modeId;return {};})
  .onRequest(a.session.setConfigOption,async({params})=>{
    await recordRpc('session/set_config_option');
    const selected=options.find(item=>item.id===params.configId);
    if(!selected||!selected.options.some(item=>item.value===params.value))throw new RequestError(-32602,'Unexpected native selector/value');
    selected.currentValue=params.value;return {configOptions:options};
  })
  .onRequest(a.session.prompt,async ({params,client})=>{
    await recordRpc('session/prompt');
    const {kind,operationId,attemptId,profileId,context}=readInvocationPrompt(params.prompt[0].text);
    const blocks=params.prompt.slice(1).map(summarize);
    const userSelectedSkills=context.find(item=>item.ref==='host:invocation-context')?.value?.userSelectedSkills;
    const userText=context.findLast(item=>item.provenance?.kind==='user')?.value;
    await appendFile('c24-wire.jsonl',JSON.stringify({kind,variant,profileId,blocks,mode,userSelectedSkills,userText,promptBytes:Buffer.byteLength(JSON.stringify(params.prompt)),settings:Object.fromEntries(options.map(item=>[item.id,item.currentValue]))})+'\n');
    const send=text=>client.notify(c.session.update,{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}});
    if(kind==='delegate'){await send('C24 worker result');return {stopReason:'end_turn'};}
    const host=context.find(item=>item.ref==='host:invocation-context').value;
    const latest=context.findLast(item=>item.provenance?.kind==='user')?.value;
    const delegate=latest==='delegate selected image'&&!context.some(item=>item.value==='C24 worker result');
    const decision={schemaVersion:1,operationId,decisionId:attemptId+'-decision',contextCursor:host.contextCursor,additions:[],cancellations:[]};
    if(variant==='history-request'&&latest==='retrieve first image'&&!blocks.some(item=>item.type==='image'&&item.hash===createHash('sha256').update(Buffer.alloc(700*1024,7)).digest('hex'))){
      const ref=host.attachments.find(item=>item.mediaType==='image/png').ref;
      decision.nextController={continue:true,contextRequest:{refs:[ref]}};
    }else if(delegate){
      const ref=host.attachments.filter(item=>item.mediaType==='image/png').at(-1).ref;
      decision.additions=[{kind:'delegate',actionId:'c24-selected-worker',profileId:'worker',objective:'Inspect selected content',expectedResult:'Result',contextRefs:[ref],dependsOn:[]}];
      decision.waitPolicy={kind:'all_requested',targets:[{kind:'action',id:'c24-selected-worker'}]};
    }else decision.finalAssessment={author:profileId,overall:'complete',answer:'C24 complete',requirements:[],observationRefs:[],findingRefs:[],unresolvedQuestions:[]};
    await send(JSON.stringify(decision));return {stopReason:'end_turn'};
  })
  .onRequest(a.session.close,()=>({}))
  .onNotification(a.session.cancel,()=>{})
  .connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin),{maxMessageBytes:24*1024*1024}));
