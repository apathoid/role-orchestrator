import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createCliInput } from '../../src/hosts/cli-input.js';
import { cliPresentation } from '../../src/hosts/cli-presentation.js';
import { createCliTools } from '../../src/hosts/cli-tools.js';
import { formFieldView } from '../../src/hosts/cli-input-view.js';
import { projectForm } from '../../src/hosts/cli-form.js';
import { boundedNativePreview, nativeDetailsPage } from '../../src/hosts/cli-details.js';

const textOf=parts=>typeof parts==='string'?parts:parts.map(x=>x.text).join('');
const notice=(eventName,reasonCode,attemptId='attempt-a')=>({
  channel:'execution',
  event:{eventName,reasonCode,attemptId,actionId:'action-a',operationId:'op',
    eventId:eventName+reasonCode,sequence:1,level:'info',receivedAt:1},
  fact:{attemptId,invocationKind:'delegate',roleId:'any-native-role',profileId:'p'},
});
const tool=(payload,sequence=1)=>({kind:'tool',operationId:'op',attemptId:'a',nativeId:'t',
  sequence,nativeKind:'tool_call_update',payload});

test('R1.1 compact and detailed retain technical interaction/permission outcomes without a fabricated native ACK or question number',async()=>{
  for(const mode of ['compact','detailed']){
    const out=[],render=cliPresentation(mode,async value=>out.push(textOf(value)));
    await render.notice(notice('interaction.resolved','INTERACTION_ANSWERED'));
    await render.notice(notice('interaction.resolved','INTERACTION_TIMED_OUT'));
    await render.notice(notice('interaction.resolved','INTERACTION_UNAVAILABLE'));
    await render.notice(notice('permission.resolved','DENY'));
    await render.notice(notice('permission.resolved','UNAVAILABLE'));
    await render.notice(notice('permission.expired','CANCELLED'));
    render.close();
    const transcript=out.join('\n');
    assert.match(transcript,/Question response recorded|Question answer submitted/);
    assert.match(transcript,/Question timed out/);
    assert.match(transcript,/Question unavailable/);
    assert.match(transcript,/Permission selection.*deny|Permission denied/);
    assert.match(transcript,/Permission unavailable/);
    assert.doesNotMatch(transcript,/provider accepted|provider acknowledged|Question #\d+/i);
  }
});

test('R1.3 native completed does not masquerade as verified success',()=>{
  const p=createCliTools();
  p.accept(tool({title:'shell',status:'in_progress'},1),'compact');
  const completed=p.accept(tool({status:'completed'},2),'compact');
  assert.match(completed.text,/completed/);
  assert.notEqual(completed.tone,'success');
  assert.doesNotMatch(completed.text,/^✓/);
  const late=p.accept(tool({status:'failed'},3),'compact');
  assert.match(late.text,/conflicting status/);
});

test('R1.2 actual native field metadata and choice options are segmented without changing choice identity',async()=>{
  const input=new PassThrough(),output=new PassThrough();output.isTTY=true;
  let outputText='';output.on('data',chunk=>outputText+=chunk.toString());
  const terminal=createCliInput(input,output,true,()=>{});
  const pending=terminal.ask({kind:'input',request:{requestId:'r',operationId:'op',attemptId:'a',profileId:'p',
    providerRequestId:'f',payload:{mode:'form',message:'Choose next approach',requestedSchema:{
      type:'object',properties:{choice:{type:'string',title:'Approach',description:'What should happen',
        oneOf:[{const:'patch',title:'Minimal patch'},{const:'rewrite',title:'Full refactoring'}]}},
      required:['choice']}}}},new AbortController().signal);
  assert.match(outputText,/Approach/);
  assert.match(outputText,/Minimal patch/);
  const schema=projectForm({payload:{mode:'form',message:'Choose next approach',requestedSchema:{
    type:'object',properties:{choice:{type:'string',title:'Approach',
      oneOf:[{const:'patch',title:'Minimal patch'},{const:'rewrite',title:'Full refactoring'}]}},
    required:['choice']}}});
  const parts=formFieldView(schema,0);
  assert.ok(parts.some(x=>x.text==='Approach'&&x.tone==='bold'));
  assert.ok(parts.some(x=>x.text==='Minimal patch'&&x.tone==='neutral'));
  assert.ok(parts.some(x=>x.text.includes('required')&&x.tone==='muted'));
  input.write('2\n');
  assert.deepEqual(await pending,{kind:'answered',payload:{action:'accept',content:{choice:'rewrite'}}});
  terminal.close();
});

test('R1.4 :details identifies field projection rather than claiming an original complete request',async()=>{
  const input=new PassThrough(),output=new PassThrough();let text='';
  output.on('data',part=>text+=part.toString());
  const terminal=createCliInput(input,output,true,()=>{});
  const ask=terminal.ask({kind:'input',request:{requestId:'r',operationId:'op',attemptId:'a',profileId:'p',
    providerRequestId:'f',payload:{mode:'form',message:'Original question',requestedSchema:{
      type:'object',properties:{value:{type:'string',description:'😀'.repeat(6000)}}}}}},new AbortController().signal);
  input.write(':details 1\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(text,/Current native field|Bounded native details/);
  assert.doesNotMatch(text,/Original request details/);
  input.write(':cancel\n');
  assert.deepEqual(await ask,{kind:'answered',payload:{action:'cancel'}});
  terminal.close();
});

test('R1.1 all known broker reasons and unknown request IDs remain distinguishable',async()=>{
  const cases=[
    ['interaction.resolved','INTERACTION_ANSWERED','response recorded'],
    ['interaction.resolved','INTERACTION_CANCELLED','Question cancelled'],
    ['interaction.resolved','INTERACTION_TIMED_OUT','Question timed out'],
    ['interaction.resolved','INTERACTION_UNAVAILABLE','Question unavailable'],
    ['interaction.resolved','INTERACTION_INVALID','Question invalid'],
    ['interaction.resolved','INTERACTION_ERROR','Question error reported'],
    ['permission.resolved','ALLOW','allow option'],
    ['permission.resolved','DENY','deny option'],
    ['permission.resolved','STANDING_ALLOW','Standing permission selection'],
    ['permission.resolved','STANDING_DENY','Standing permission decision'],
    ['permission.resolved','DENIED','Permission denied'],
    ['permission.resolved','INVALID','Permission invalid'],
    ['permission.resolved','UNAVAILABLE','Permission unavailable'],
    ['permission.expired','CANCELLED','Permission request cancelled'],
  ];
  for(const mode of ['compact','detailed','debug']){
    const out=[],renderer=cliPresentation(mode,async value=>out.push(textOf(value)));
    for(const [eventName,reasonCode] of cases)await renderer.notice(notice(eventName,reasonCode));
    renderer.close();
    const text=out.join('\n');
    if(mode==='debug'){
      assert.match(text,/interaction.resolved/);assert.match(text,/INTERACTION_TIMED_OUT/);
    }else{
      for(const [,,message] of cases)assert.ok(text.includes(message),mode+' missing '+message);
      assert.doesNotMatch(text,/Question #\d+|Permission #\d+|provider acknowledged/i);
      if(mode==='detailed')assert.match(text,/request ID not in execution event/);
    }
  }
  const out=[],renderer=cliPresentation('compact',async value=>out.push(textOf(value)));
  await renderer.notice({channel:'execution',event:{eventName:'interaction.resolved',reasonCode:'INTERACTION_TIMED_OUT',
    eventId:'unknown',sequence:1,level:'warn',receivedAt:1,operationId:'op'}});
  renderer.close();assert.match(out.join('\n'),/Unattributed request/);
});

test('R1.4 bounded native previews avoid full serialization and preserve emoji at page boundaries',()=>{
  const huge={items:Array.from({length:120000},(_,i)=>({index:i,value:'😀'.repeat(8)}))};
  const before=performance.now(),result=boundedNativePreview(huge);
  assert.equal(result.omitted,true);assert.ok(result.text.length<=32000);
  assert.ok(performance.now()-before<1000,'preview should not traverse the entire native payload');
  assert.match(nativeDetailsPage(huge,1,'Native permission details'),/bounded preview/);
  assert.match(nativeDetailsPage(huge,999999,'Native permission details'),/outside bounded preview/);
  const cyclic={};cyclic.self=cyclic;assert.match(boundedNativePreview(cyclic).text,/repeated object/);
  const value={field:'a'.repeat(1985)+'😀'+'b'.repeat(4000)};
  for(const page of [1,2,3]){
    const text=nativeDetailsPage(value,page,'Current native field details');
    assert.doesNotMatch(text,/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  }
  assert.ok(value.field.includes('😀'));
});

test('R1.4 140-field form :details and independent permission remain responsive',async()=>{
  const properties=Object.fromEntries(Array.from({length:140},(_,i)=>['f'+i,{type:'string',description:'field'}]));
  const form={kind:'input',request:{requestId:'big',operationId:'op',attemptId:'a',profileId:'p',providerRequestId:'f',
    payload:{mode:'form',message:'Large form',requestedSchema:{type:'object',properties}}}};
  const permit={kind:'permission',request:{requestId:'p',operationId:'op',attemptId:'b',profileId:'p',
    resource:'r',options:[{id:'deny',kind:'deny'}]}};
  const input=new PassThrough(),output=new PassThrough();let seen='';
  output.on('data',chunk=>seen+=chunk.toString());
  const terminal=createCliInput(input,output,true,()=>{});
  const first=terminal.ask(form,new AbortController().signal),second=terminal.ask(permit,new AbortController().signal);
  input.write('#1 :details 1\n#2 1\n');
  assert.deepEqual(await second,{kind:'answered',payload:{optionId:'deny'}});
  assert.match(seen,/Current native field details/);
  input.write('#1 :cancel\n');
  assert.deepEqual(await first,{kind:'answered',payload:{action:'cancel'}});
  terminal.close();
});
test('R1.5 generic pending is immediate, identity-scoped and never fabricated as completed',()=>{
  const p=createCliTools(),event={kind:'tool',operationId:'op',attemptId:'a',
    nativeId:'x',sequence:1,nativeKind:'tool_call',payload:{title:'shell',status:'pending'}};
  assert.match(p.accept(event,'compact').text,/shell · pending/);
  assert.equal(p.accept({...event,sequence:2},'compact'),undefined);
  assert.match(p.accept({...event,nativeId:'y',sequence:3},'compact').text,/shell · pending/);
  assert.match(p.accept({...event,sequence:4,payload:{title:'Read',status:'in_progress'}},'compact').text,/Read/);
});

test('R1.1 unexpected diagnostic reason names cannot escape the neutral fallback',async()=>{
  const out=[],renderer=cliPresentation('compact',async value=>out.push(textOf(value)));
  await renderer.notice(notice('interaction.resolved','toString'));
  await renderer.notice(notice('permission.resolved','constructor'));
  renderer.close();
  assert.match(out.join('\n'),/Question outcome reported \(details in debug\)/);
  assert.match(out.join('\n'),/Permission outcome reported \(details in debug\)/);
});

test('R1.1 result uses only already delivered trusted attempt identity, never a guessed request alias',async()=>{
  const out=[],renderer=cliPresentation('compact',async value=>out.push(textOf(value)));
  await renderer.notice({channel:'execution',event:{eventName:'attempt.dispatched',reasonCode:'DISPATCH_STARTED',
    eventId:'dispatch',receivedAt:1,sequence:1,level:'info',operationId:'op',attemptId:'a'},
    fact:{attemptId:'a',invocationKind:'controller',attemptOrdinal:1,profileId:'native'}});
  await renderer.notice({channel:'execution',event:{eventName:'interaction.resolved',
    reasonCode:'INTERACTION_TIMED_OUT',eventId:'resolution',receivedAt:2,sequence:2,
    level:'warn',operationId:'op',attemptId:'a'}});
  renderer.close();
  const display=out.join('\n');
  assert.match(display,/Controller #1 · native · Question timed out/);
  assert.doesNotMatch(display,/Attempt a · Question timed out|Question #\d+.*timed out/);
});
