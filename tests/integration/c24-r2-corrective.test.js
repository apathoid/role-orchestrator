import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { createOperation, acceptedSettingsFor } from '../../src/core/operation.js';
import { controllerContext, operationHistory, pendingControllerHistoryRequest } from '../../src/application/controller-context.js';
import { prepareUserContent } from '../../src/application/user-content.js';
import { attachmentBlocks, renderContentAttachment, renderOrderedTurn } from '../../src/adapters/acp/input.js';
import { runCli } from '../../src/hosts/cli.js';
import { request, assessment, outcome } from '../fixtures/core.js';

const signal=new AbortController().signal;
const operation=input=>createOperation('op',input,'authority',{maxInvocations:100,maxConcurrentInvocations:1},0);
const nativeImage=ref=>({kind:'image',ref,mediaType:'image/png'});
test('C24-R2 T09 fallback text retains ordered boundaries while native slices and accepted identity stay intact',async()=>{
  const {text,...base}=request();
  const prepared=prepareUserContent({...base,content:[{kind:'text',text:'first'},{kind:'text',text:'second'}]});
  assert.equal(prepared.kind,'accepted');
  const turn=prepared.input;
  assert.equal(turn.text,'firstsecond');
  assert.equal(operationHistory(operation(turn))[0].value,'firstsecond');
  assert.equal(operationHistory(operation(turn),0,true)[0].value,'first\nsecond');
  const wire=await renderOrderedTurn(turn,undefined,{},signal);
  assert.deepEqual(wire.map(block=>block.text),['first','second']);
});
test('C24-R2 T11 partial native content has exact delivered reference and block index',async()=>{
  const omitted=[],delivered=[];
  const turn={requestId:'old',text:'',required:false,content:[nativeImage('B'),nativeImage('C')]};
  const blocks=await attachmentBlocks({orderedTurns:[turn],readUserPayload:async ref=>ref==='C'?Buffer.from('C'):undefined},
    {promptCapabilities:{image:true}},undefined,signal,(id,ref)=>omitted.push(ref),(...args)=>delivered.push(args));
  assert.deepEqual(omitted,['B']);
  assert.equal(blocks.length,1);
  assert.equal(blocks[0].data,Buffer.from('C').toString('base64'));
  assert.deepEqual(delivered[0].slice(1),[1,1,[{ref:'C',block:1}]]);
});
test('C24-R2 T18 canonical native content owns optional MIME and mutually exclusive resource bodies',async()=>{
  const item={kind:'resource',uri:'file:///canonical',ref:'r',mediaType:'application/octet-stream',mimeTypeOmitted:true,encoding:'utf8',
    metadata:{outer:{type:'image',_meta:{opaque:true}},resource:{uri:'bad',blob:'bad',mimeType:'bad',_meta:{inner:true}}}};
  const block=await renderContentAttachment(item,async()=>Buffer.from('body'),undefined,signal);
  assert.deepEqual(block,{type:'resource',_meta:{opaque:true},resource:{uri:'file:///canonical',text:'body',_meta:{inner:true}}});
  const binary=await renderContentAttachment({...item,encoding:'binary',metadata:{resource:{text:'bad',blob:'bad'}}},async()=>Buffer.from('body'),undefined,signal);
  assert.deepEqual(binary.resource,{uri:'file:///canonical',blob:Buffer.from('body').toString('base64')});
  const link=await renderContentAttachment({kind:'link',uri:'file:///canonical',mediaType:'application/octet-stream',mimeTypeOmitted:true,metadata:{mimeType:'bad',name:'file',_meta:{opaque:true}}},undefined,undefined,signal);
  assert.equal(Object.hasOwn(link,'mimeType'),false);
  assert.equal(link.uri,'file:///canonical');
});
test('C24-R2 T15 first legacy recovery settings remain accepted until explicit continuation',()=>{
  const state=operation(request());
  const settings={profileId:'a',providerId:'p',model:'m',configurationRef:'c'};
  state.events=[{kind:'operation.recovered',trusted:{settings}},{kind:'operation.recovered',trusted:{}}];
  assert.deepEqual(acceptedSettingsFor(state),settings);
  state.events.push({kind:'operation.continued',input:{requestId:'next'},trusted:{}});
  assert.equal(acceptedSettingsFor(state),undefined);
});
test('C24-R2 T12 only an undispatched pre-recovery Controller reservation preserves a context selection',()=>{
  const state=operation(request());
  const contextRequest={refs:['user-content:old']};
  const choice={kind:'controller.responded',decision:{nextController:{continue:true,contextRequest}}};
  const prior={kind:'attempt.reserved',attemptId:'old',actionId:'old'};
  const recovered={kind:'operation.recovered'};
  const next={kind:'attempt.reserved',attemptId:'new',actionId:'new'};
  state.events=[choice,prior,recovered,next];
  assert.deepEqual(pendingControllerHistoryRequest(state,'new'),contextRequest);
  state.events=[choice,prior,{kind:'attempt.dispatched',attemptId:'old'},recovered,next];
  assert.equal(pendingControllerHistoryRequest(state,'new'),undefined);
  state.events=[choice,prior,recovered,{kind:'operation.continued'},next];
  assert.equal(pendingControllerHistoryRequest(state,'new'),undefined);
});
test('C24-R2 T03/T04/T10 explicit work page and current skill survive large optional attachment previews',()=>{
  const {text,...base}=request({agentSkill:{name:'changed',path:'/workspace/changed/SKILL.md',source:'project'}});
  const prepared=prepareUserContent({...base,content:[{kind:'text',text},...Array.from({length:300},(_,i)=>({kind:'link',uri:'file:///a'+i}))]});
  assert.equal(prepared.kind,'accepted');
  const state=operation(prepared.input);
  for(let i=0;i<5;i++){
    const attemptId='controller-'+i;
    state.events.push({kind:'attempt.reserved',attemptId,actionId:attemptId});
    state.attempts.push({attemptId,actionId:attemptId,status:'terminal',dispatchCertainty:'sent',outcome:outcome(attemptId)});
  }
  state.revision=state.events.length;
  const context=controllerContext(state,[],undefined,undefined,3000,undefined,[],{revision:state.revision,index:0});
  const host=context.find(item=>item.ref==='host:invocation-context').value;
  assert.ok(host.workMap.entries.length>0);
  assert.equal(host.userSelectedSkills[0].name,'changed');
  if(host.workMap.nextCursor){
    const following=controllerContext(state,[],undefined,undefined,3000,undefined,[],host.workMap.nextCursor).find(item=>item.ref==='host:invocation-context').value.workMap;
    assert.ok(following.entries.length>0);
    assert.notEqual(following.entries[0].attemptId,host.workMap.entries[0].attemptId);
  }
});
test('C24-R2 T07/T08 CLI renders current technical failure/question instead of historical answer',async()=>{
  const state=operation(request());
  state.assessment=assessment({answer:'OLD SUCCESS'});
  state.status='waiting';
  for(const waiting of [{kind:'technical',reason:{code:'CAPABILITY_UNAVAILABLE',profileId:'p'}},{kind:'question',questionId:'q',question:'NEW QUESTION'}]){
    state.waiting=waiting;
    let stdout='',stderr='';
    const code=await runCli(['resume','op','next'],{cwd:'/tmp',stdin:new PassThrough(),stdout:{write:v=>{stdout+=v;}},stderr:{write:v=>{stderr+=v;}}},async()=>state);
    assert.equal(stderr,'');
    assert.doesNotMatch(stdout,/OLD SUCCESS/);
    assert.match(stdout,waiting.kind==='question'?/NEW QUESTION/:/CAPABILITY_UNAVAILABLE/);
    assert.equal(code,waiting.kind==='question'?0:1);
  }
});
