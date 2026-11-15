import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { createBoundedDelivery } from '../../src/application/delivery.js';
import { setup, final } from '../fixtures/application.js';
import { request } from '../fixtures/core.js';
import { runCli } from '../../src/hosts/cli.js';
import { createCliInput } from '../../src/hosts/cli-input.js';
import { cliPresentation } from '../../src/hosts/cli-presentation.js';
import { cliOwner } from '../../src/hosts/cli-owner.js';
import { parseCli } from '../../src/hosts/cli.js';

const permission = {kind:'permission',request:{requestId:'p',operationId:'op',attemptId:'a',profileId:'worker',providerRequestId:'native',resource:'resource',options:[{id:'deny',kind:'deny'},{id:'allow',kind:'allow'}]}};
const form = {kind:'input',request:{requestId:'f',operationId:'op',attemptId:'b',profileId:'worker',providerRequestId:'form',nativeKind:'elicitation/create',kind:'input',deadlineAt:Date.now()+3000,payload:{mode:'form',message:'Which value?',requestedSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}}};
test('C14 CLI selects simultaneous real requests by label and preserves explicit replies', async()=>{
  const input=new PassThrough(), output=new PassThrough(); output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const signal=new AbortController().signal;
  const p=terminal.ask(permission,signal), f=terminal.ask(form,signal);
  input.write('#f {"value":"chosen"}\n#p deny\n');
  assert.deepEqual(await f,{kind:'answered',payload:{action:'accept',content:{value:'chosen'}}});
  assert.deepEqual(await p,{kind:'answered',payload:{optionId:'deny'}});
  terminal.close();
});
test('C14 CLI owner uses correlated remote handler replies and detach is unavailable',async()=>{
  const terminal=createCliInput(new PassThrough(),new PassThrough(),false,()=>{});
  const owner=cliOwner(terminal);
  assert.equal(owner.accept('op','work',true,true),true);
  assert.equal(owner.accept('op','observer',true,true),false);
  const signal=new AbortController().signal;
  const p=owner.handlePermission(permission.request,signal);
  assert.equal(owner.pending('op').length,1);
  const reply={requestId:'p',operationId:'op',attemptId:'a',providerRequestId:'native',payload:{kind:'answered',payload:{optionId:'deny'}}};
  assert.equal(owner.respond({...reply,attemptId:'other'}).kind,'rejected');
  assert.equal(owner.respond(reply).kind,'accepted');
  assert.deepEqual(await p,{kind:'selected',option:'deny'});
  const f=owner.handleInteraction(form.request,signal);
  owner.detach('op','work');
  assert.deepEqual(await f,{kind:'unavailable'});
  assert.equal(owner.pending('op').length,0);
});
test('C14 CLI opt-in modes and non-TTY default preserve machine grammar',()=>{
  assert.equal(parseCli(['run','hello','--presentation','debug'],'/tmp').presentation,'debug');
  assert.equal(parseCli(['run','hello','--format','json'],'/tmp').presentation,undefined);
  assert.throws(()=>parseCli(['run','hello','--presentation','invalid'],'/tmp'),/presentation/);
});

test('C14 input EOF, abort, unsupported form and non-interactive input settle explicitly', async()=>{
  const input=new PassThrough(), output=new PassThrough();output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const stop=new AbortController();
  const first=terminal.ask(permission,stop.signal);
  stop.abort();
  assert.deepEqual(await first,{kind:'cancelled'});
  const unsupported=structuredClone(form);
  unsupported.request.payload.requestedSchema.properties.value={type:'object'};
  assert.deepEqual(await terminal.ask(unsupported,new AbortController().signal),{kind:'unavailable'});
  const next=terminal.ask(form,new AbortController().signal);
  input.end();
  assert.deepEqual(await next,{kind:'unavailable'});
  terminal.close();
  const noTTY=createCliInput(new PassThrough(),output,false,()=>{});
  assert.deepEqual(await noTTY.ask(permission,new AbortController().signal),{kind:'unavailable'});
  noTTY.close();
});

test('C14R.3 native adjacent chunks use one source heading, switch and permission break the line',async()=>{
  const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',b=>text+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk);
  const event=(attemptId,text)=>({channel:'activity',event:{kind:'reasoning',nativeKind:'agent_thought_chunk',operationId:'op',attemptId,profileId:'p',providerId:'x',sequence:1,payload:{content:{type:'text',text}}}});
  await renderer.notice(event('a','first'));await renderer.notice(event('a',' second'));
  await renderer.notice(event('b','other'));await renderer.notice(event('b',' fragment'));
  const reply=terminal.ask(permission,new AbortController().signal);
  input.write('deny\n');await reply;
  await renderer.notice(event('a','again'));terminal.close();
  assert.match(text,/Thinking · p\/a\n  first second\n[\s\S]*Thinking · p\/b\n  other fragment\n/);
  assert.match(text,/Permission requested/);assert.match(text,/Thinking · p\/a\n  again\n/);
});

test('C13R.3 terminal view never replays a dropped recorded finding',async()=>{
  const out=[];
  const renderer=cliPresentation('compact',async text=>{out.push(text);});
  await renderer.notice({channel:'gap',droppedCount:1,reason:'overflow'});
  renderer.finish({operationId:'op',status:'finished',assessment:{overall:'complete'},attempts:[],limits:{maxInvocations:4},events:[
    {kind:'attempt.outcome',findings:[{findingId:'f',author:'p',claim:'omitted claim',subject:'file',supports:[],uncertainties:[]}]}
  ]});
  assert.match(out.join('\n'),/Delivery gap/);assert.doesNotMatch(out.join('\n'),/omitted claim/);
});


const writeNotice={channel:'activity',event:{kind:'reasoning',nativeKind:'agent_thought_chunk',operationId:'op',attemptId:'a',profileId:'p',providerId:'x',sequence:1,payload:{content:{type:'text',text:'native'}}}};
function writerDelivery(output){
  const terminal=createCliInput(new PassThrough(),output,false,()=>{});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk);
  const delivery=createBoundedDelivery(notice=>renderer.notice(notice),()=>({channel:'gap',droppedCount:1,reason:'overflow'}));
  return {terminal,renderer,delivery};
}

test('C14R.5R actual Writable success and callback/throw/closed failures reach delivery',async()=>{
  for(const mode of ['success','callback','throw','destroyed','ended','broken']){
    let writes=0;
    const output=new Writable({write(_chunk,_encoding,cb){writes++;cb(mode==='callback'?Error('callback failed'):undefined);}});
    if(mode==='throw')output.write=()=>{writes++;throw Error('sync write failed');};
    const {terminal,delivery}=writerDelivery(output);
    if(mode==='destroyed'){const closed=once(output,'close');output.destroy();await closed;}
    if(mode==='ended'){const finished=once(output,'finish');output.end();await finished;}
    if(mode==='broken')output.emit('error',Error('already broken'));
    delivery.enqueue(writeNotice,100);
    assert.equal(await delivery.finish(),mode==='success'?0:1,mode);
    await terminal.report('local gap message'); // fire-and-forget path never rejects
    if(!['success','callback','throw'].includes(mode))assert.equal(writes,0);
    if(mode==='callback'||mode==='throw')assert.equal(writes,1,'do not write recursively to broken output');
    terminal.close();output.destroy();
  }
});

test('C14R.5R actual Writable close/error settle pending writes; timeout stays unconfirmed after late callback',async()=>{
  for(const mode of ['close','error','timeout']){
    const started=Promise.withResolvers();
    let writes=0,callback;
    const output=new Writable({write(_chunk,_encoding,cb){writes++;callback=cb;started.resolve();}});
    const {terminal,delivery}=writerDelivery(output);
    delivery.enqueue(writeNotice,100);await started.promise;
    delivery.enqueue(writeNotice,100);
    if(mode==='close')output.destroy();
    if(mode==='error')output.emit('error',Error('stream failed'));
    const finish=delivery.finish(25);
    assert.equal(await finish,2);
    assert.equal(writes,1);
    callback();await tick();
    assert.equal(await delivery.finish(),2);
    assert.equal(writes,1,'no automatic repeat or late queued delivery');
    terminal.close();output.destroy();
  }
});

test('C14R.5R broken prompt settles unavailable; local report and terminal summary do not reject',async()=>{
  const output=new Writable({write(_chunk,_encoding,cb){cb(Error('prompt failed'));}});
  const terminal=createCliInput(new PassThrough(),output,true,()=>{});
  assert.deepEqual(await terminal.ask(permission,new AbortController().signal),{kind:'unavailable'});
  assert.deepEqual(await terminal.ask(form,new AbortController().signal),{kind:'unavailable'});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk);
  renderer.finish({operationId:'op',status:'finished',assessment:{overall:'complete'},attempts:[],limits:{maxInvocations:4},events:[]});
  void terminal.report('uncertain reply');terminal.close();await tick();
  output.destroy();
});

test('C14R.5R failed actual presentation Writable leaves direct execution and final JSON unchanged',async()=>{
  async function run(fail){
    const {api}=setup({respond(invocation,_n,_observe,activity){activity({kind:'reasoning',nativeKind:'agent_thought_chunk',payload:{content:{type:'text',text:'native'}}});return final(invocation);}});
    const stdout=new PassThrough(),stderr=new Writable({write(_chunk,_encoding,cb){cb(fail?Error('presentation failed'):undefined);}});
    let text='';stdout.on('data',b=>text+=b);
    const terminal=createCliInput(new PassThrough(),stderr,false,()=>{});
    const renderer=cliPresentation('compact',terminal.print,terminal.printChunk);
    let state,omitted;
    try{
      const code=await runCli(['run','task','--format','json'],{cwd:'/tmp',stdin:new PassThrough(),stdout,stderr},async()=>{
        let sub;
        const submission=await api.submit(request(),id=>{sub=api.subscribeActivity({operationId:id},event=>renderer.notice({channel:'activity',event}));});
        state=await submission.completion;omitted=await sub.finish();renderer.finish(state);return state;
      });
      assert.equal(code,0);assert.equal(JSON.parse(text).assessment.answer,'Direct answer');
      assert.equal(omitted,fail?1:0);
      return {state,text};
    }finally{renderer.close();terminal.close();stderr.destroy();await api.close();}
  }
  assert.deepEqual(await run(true),await run(false));
});

test('C15.3 numbered choices preserve native option identity and render actual form fields',async()=>{
  const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',b=>text+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const signal=new AbortController().signal;
  const p=terminal.ask(permission,signal), f=terminal.ask(form,signal);
  assert.match(text,/1\. deny \[id=deny\]/);assert.match(text,/2\. allow \[id=allow\]/);
  assert.match(text,/Which value\?/);assert.match(text,/value · string \(required\)/);
  input.write('#p option 2\n#f {"value":"chosen"}\n');
  assert.deepEqual(await p,{kind:'answered',payload:{optionId:'allow'}});
  assert.deepEqual(await f,{kind:'answered',payload:{action:'accept',content:{value:'chosen'}}});
  terminal.close();
});


test('C15.6 interleaved native sources retain split escape state and visual boundaries',async()=>{
  const input=new PassThrough(),output=new PassThrough();let rendered='';
  output.on('data',chunk=>rendered+=chunk.toString());
  const terminal=createCliInput(input,output,false,()=>{});
  await terminal.printChunk({source:'a',header:'[A] ',text:'first\x1b]52;c;'});
  await terminal.printChunk({source:'b',header:'[B] ',text:'second'});
  await terminal.print('Lifecycle');
  await terminal.printChunk({source:'a',header:'[A] ',text:'SECRET\x07rest'});
  terminal.close();
  assert.match(rendered,/\[A\] first\n\[B\] second\nLifecycle\n\[A\] rest/);
  assert.doesNotMatch(rendered,/SECRET|\x1b/);
});


test('C15R.2 full compact transcript preserves source and text while hiding repeated tool updates',async()=>{
  const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',b=>text+=b);
  const terminal=createCliInput(input,output,false,()=>{});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk);
  renderer.accepted('123456789');
  const fact={kind:'attempt.dispatched',operationId:'123456789',attemptId:'a',invocationKind:'controller',attemptOrdinal:1,profileId:'p',modelSelector:'m',reasoning:{mode:'native'}};
  await renderer.notice({channel:'execution',event:{eventName:'attempt.dispatched',eventId:'dispatch',level:'info'},fact});
  let sequence=0;
  const send=(kind,payload,nativeId,nativeKind)=>renderer.notice({channel:'activity',event:{kind,operationId:'123456789',attemptId:'a',profileId:'p',providerId:'x',sequence:++sequence,payload,nativeId,nativeKind}});
  await send('reasoning',{content:{type:'text',text:'Inspect'}},undefined,'agent_thought_chunk');
  await send('reasoning',{content:{type:'text',text:' the commit.\nRead the diff.'}},undefined,'agent_thought_chunk');
  await send('tool',{title:'shell',kind:'execute',status:'pending'},'x','tool_call');
  await send('tool',{title:'git show HEAD',status:'in_progress'},'x','tool_call_update');
  await send('tool',{title:'git show HEAD',status:'in_progress'},'x','tool_call_update');
  await send('tool',{status:'completed'},'x','tool_call_update');
  await send('tool',{title:'Read package.json',status:'in_progress'},'y','tool_call');
  await send('tool',{status:'failed'},'y','tool_call_update');
  await send('reasoning',{content:{type:'text',text:'Version only.'}},undefined,'agent_thought_chunk');
  terminal.close();
  assert.equal(text,[
    'Role Orchestrator · compact · 12345678','','● Controller #1 · p','  Invocation dispatched · p · selector=m · native effort','',
    '  Thinking · Controller #1 · p','  Inspect the commit.','  Read the diff.',
    '  ◇ git show HEAD · in_progress','  ✓ git show HEAD · completed',
    '  ◇ Read package.json · in_progress','  ✗ Read package.json · failed','',
    '  Thinking · Controller #1 · p','  Version only.','',
  ].join('\n'));
});
