import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createCliInput } from '../../src/hosts/cli-input.js';
import { cliPresentation } from '../../src/hosts/cli-presentation.js';
import { createCliTools } from '../../src/hosts/cli-tools.js';

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
  assert.match(outputText,/\x1b\[[0-9;]*m.*Approach/);
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
