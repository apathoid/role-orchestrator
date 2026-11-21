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
  input.write('#2 chosen\n#1 id:deny\n');
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
  input.write('id:deny\n');await reply;
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
  assert.match(text,/Which value\?/);assert.match(text,/value \(text, required\)/);
  await tick();
  input.write('#1 option 2\n#2 chosen\n');
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


test('C15R.2 full compact, detailed and debug transcripts preserve text and actual tool transitions',async()=>{
  for(const mode of ['compact','detailed','debug']){
    const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',b=>text+=b);
    const terminal=createCliInput(input,output,false,()=>{});
    const renderer=cliPresentation(mode,terminal.print,terminal.printChunk,terminal.resetPresentation);
    renderer.accepted('123456789');
    const fact={kind:'attempt.dispatched',operationId:'123456789',attemptId:'a',invocationKind:'controller',attemptOrdinal:1,profileId:'p',modelSelector:'m',reasoning:{mode:'native'}};
    await renderer.notice({channel:'execution',event:{eventName:'attempt.dispatched',eventId:'dispatch',level:'info',sequence:1,receivedAt:0,reasonCode:'DISPATCH_STARTED'},fact});
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
    const debug=mode==='debug',heading='  Thinking · Controller #1 · p'+(debug?' [x agent_thought_chunk]':'');
    const row=(text,kind,id,seq)=>'  '+text+(debug?' ['+kind+' '+id+' seq='+seq+']':'');
    assert.equal(text,[
      'Role Orchestrator · '+mode+' · '+(debug?'Operation 123456789':'12345678'),'','● Controller #1 · p','  Invocation dispatched · selector=m · native effort',
      ...(debug?['  attempt=a event=dispatch seq=1 at=0 reason=DISPATCH_STARTED']:[]),'',
      heading,'  Inspect the commit.','  Read the diff.',
      row('◇ [T1] shell · pending','tool_call','x',3),
      row('◇ [T1] git show HEAD · in_progress','tool_call_update','x',4),
      ...(debug?[row('◇ [T1] git show HEAD · in_progress','tool_call_update','x',5)]:[]),
      row(debug?'■ [T1] git show HEAD · completed':'■ [T1] · completed','tool_call_update','x',6),
      row('◇ [T2] Read package.json · in_progress','tool_call','y',7),
      row(debug?'✗ [T2] Read package.json · failed':'✗ [T2] · failed','tool_call_update','y',8),'',
      heading,'  Version only.','',
    ].join('\n'),mode);
  }
});


test('C15R.2 gap resets native text continuation without swallowing subsequent text',async()=>{
  const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',b=>text+=b);
  const terminal=createCliInput(input,output,false,()=>{});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk,terminal.resetPresentation);
  const event=body=>({channel:'activity',event:{kind:'reasoning',nativeKind:'agent_thought_chunk',operationId:'op',attemptId:'a',profileId:'p',providerId:'x',sequence:1,payload:{content:{type:'text',text:body}}}});
  await renderer.notice(event('before\x1b]52;c;'));
  await renderer.notice({channel:'activity',event:{kind:'gap',operationId:'op',attemptId:'a',droppedCount:1,reason:'overflow'}});
  await renderer.notice(event('after gap'));
  terminal.close();
  assert.match(text,/before[\s\S]*Activity gap[\s\S]*after gap/);
  assert.doesNotMatch(text,/\x1b/);
});


test('C15R.6.1 exact position is never shadowed by optionId; explicit ID is separate',async()=>{
  const input=new PassThrough(),output=new PassThrough();output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const request=structuredClone(permission);
  request.request.requestId='collision';
  request.request.options=[{id:'deny',kind:'deny',label:'Deny'},
    {id:'option 1',kind:'allow',label:'Allow'},{id:'2',kind:'allow',scope:'always'}];
  try{
    const first=terminal.ask(request,new AbortController().signal);
    await tick();
    input.write('option 1\n');
    assert.deepEqual(await first,{kind:'answered',payload:{optionId:'deny'}});
    const second=terminal.ask({...request,request:{...request.request,requestId:'second'}},new AbortController().signal);
    input.write('id:option 1\n');
    assert.deepEqual(await second,{kind:'answered',payload:{optionId:'option 1'}});
    const third=terminal.ask({...request,request:{...request.request,requestId:'third'}},new AbortController().signal);
    await tick();
    input.write('2\n');
    assert.deepEqual(await third,{kind:'answered',payload:{optionId:'option 1'}});
    const cancelled=terminal.ask({...request,request:{...request.request,requestId:'fourth'}},new AbortController().signal);
    input.write(':cancel\n');assert.deepEqual(await cancelled,{kind:'cancelled'});
  }finally{terminal.close();input.end();}
});

test('C15R.6.1 input started for expired request cannot transfer to newly pending one',async()=>{
  const input=new PassThrough(),output=new PassThrough();let printed='';
  output.on('data',b=>printed+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const oldStop=new AbortController(),newStop=new AbortController();
  const first=terminal.ask(permission,oldStop.signal);
  input.write('1');
  const second=terminal.ask({...permission,request:{...permission.request,requestId:'new'}},newStop.signal);
  oldStop.abort();
  assert.deepEqual(await first,{kind:'cancelled'});
  input.write('\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(printed,/does not belong to an active request/);
  input.write('#2 1\n');assert.deepEqual(await second,{kind:'answered',payload:{optionId:'deny'}});
  const third=terminal.ask({...permission,request:{...permission.request,requestId:'later'}},new AbortController().signal);
  input.write('#1 2\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(printed,/does not belong to an active request/);
  input.write('#3 2\n');
  assert.deepEqual(await third,{kind:'answered',payload:{optionId:'allow'}});
  terminal.close();input.end();
});


test('C15R.6.2 form displays offered oneOf and maps numeric choice to const, not title',async()=>{
  const input=new PassThrough(),output=new PassThrough();let display='';output.on('data',b=>display+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const f=structuredClone(form);
  f.request.payload={mode:'form',message:'What should happen?',requestedSchema:{type:'object',
    properties:{decision:{type:'string',title:'Next step',oneOf:[{const:'continue',title:'Continue work'},{const:'stop',title:'Stop work'}]}},required:['decision']}};
  const answer=terminal.ask(f,new AbortController().signal);
  assert.match(display,/What should happen/);assert.match(display,/Continue work/);assert.match(display,/Stop work/);
  await tick();
  input.write('2\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{action:'accept',content:{decision:'stop'}}});
  terminal.close();input.end();
});
test('C15R.6.2 text, optional/required, typed values, multi-select and exact string whitespace',async()=>{
  const input=new PassThrough(),output=new PassThrough();let display='';output.on('data',b=>display+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const f=structuredClone(form);
  f.request.payload={mode:'form',message:'Choose values',requestedSchema:{type:'object',
    properties:{answer:{type:'string',title:'Your answer',minLength:1},count:{type:'integer',minimum:0,maximum:10,default:4},
      agreed:{type:'boolean'},tags:{type:'array',items:{anyOf:[{const:'x',title:'Alpha'},{const:'y',title:'Beta'}]},minItems:1,maxItems:2}},
    required:['answer','count','agreed','tags']}};
  const done=terminal.ask(f,new AbortController().signal);
  input.write('  verbatim  \n');
  input.write('12\n');await new Promise(resolve=>setImmediate(resolve));assert.match(display,/number above maximum/);
  input.write('0\nfalse\n');
  await tick(); // The final multi-select page must be shown before numeric 1,2.
  input.write('1,2\n');
  assert.deepEqual(await done,{kind:'answered',payload:{action:'accept',
    content:{answer:'  verbatim  ',count:0,agreed:false,tags:['x','y']}}});
  terminal.close();input.end();
});
test('C17.6 choice followed by arbitrary optional and required text preserves omitted versus empty',async()=>{
  for(const omit of [true,false]){
    const input=new PassThrough(),output=new PassThrough();let display='';output.on('data',b=>display+=b);
    const terminal=createCliInput(input,output,true,()=>{});
    const f=structuredClone(form);
    f.request.payload={mode:'form',message:'Choose an action',requestedSchema:{type:'object',
      properties:{pick:{type:'string',oneOf:[{const:'A',title:'Continue'},{const:'B',title:'Stop'}]},
        arbitrary:{type:'string',title:'Original field title',description:'Original description',default:'not selected'},
        other:{type:'string',title:'A required field',minLength:1}},required:['pick','other']}};
    const done=terminal.ask(f,new AbortController().signal);
    await tick();input.write('2\n');await tick();
    assert.match(display,/Additional text \(optional\)/);
    assert.match(display,/Original field title/);assert.match(display,/Original description/);
    assert.match(display,/Enter text, or :skip to omit this field\./);
    input.write(omit?':skip\n':'\n');await tick();
    input.write(':skip\n');await tick();assert.match(display,/cannot skip/);
    input.write('literal\n');
    assert.deepEqual(await done,{kind:'answered',payload:{action:'accept',content:{pick:'B',...(omit?{}:{arbitrary:''}),other:'literal'}}});
    terminal.close();input.end();
  }
});

test('C15R.6.2 literal control words and optional omission are distinct',async()=>{
  const input=new PassThrough(),output=new PassThrough();output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const f=structuredClone(form);
  f.request.payload={mode:'form',message:'Say something',requestedSchema:{type:'object',
    properties:{answer:{type:'string',title:'Your answer'},comment:{type:'string',default:'untouched'}},required:['answer']}};
  const done=terminal.ask(f,new AbortController().signal);
  input.write('cancel\n:skip\n');
  assert.deepEqual(await done,{kind:'answered',payload:{action:'accept',content:{answer:'cancel'}}});
  const second=terminal.ask({...f,request:{...f.request,requestId:'another'}},new AbortController().signal);
  input.write('::cancel\n:skip\n');
  assert.deepEqual(await second,{kind:'answered',payload:{action:'accept',content:{answer:':cancel'}}});
  terminal.close();input.end();
});


test('C15R.6.3 active readline preserves one Thinking block across 80 short native fragments and typed permission input',async()=>{
  const input=new PassThrough(),output=new PassThrough();let display='';output.on('data',b=>display+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk,terminal.resetPresentation);
  const answer=terminal.ask(permission,new AbortController().signal);
  input.write('id:');
  for(let i=0;i<80;i++){
    await renderer.notice({channel:'activity',event:{kind:'reasoning',nativeKind:'agent_thought_chunk',operationId:'op',
      attemptId:'worker-a',profileId:'p',providerId:'x',sequence:i,payload:{content:{type:'text',text:'<'+i+'>'}}}});
  }
  input.write('deny\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{optionId:'deny'}});
  assert.equal((display.match(/Thinking · p\/worker-a/g)??[]).length,1);
  for(let i=0;i<80;i++)assert.ok(display.includes('<'+i+'>'),String(i));
  terminal.close();input.end();
});


test('C15R.6R.2 blank Enter accepts empty string for the sole live form, not an omitted field',async()=>{
  const input=new PassThrough(),output=new PassThrough();output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const f=structuredClone(form);
  f.request.requestId='blank';
  f.request.payload={mode:'form',message:'Optional text',requestedSchema:{type:'object',
    properties:{text:{type:'string'}},required:['text']}};
  const done=terminal.ask(f,new AbortController().signal);
  input.write('\n');
  assert.deepEqual(await done,{kind:'answered',payload:{action:'accept',content:{text:''}}});
  const old=new AbortController();
  const p=terminal.ask(permission,old.signal);
  const future=terminal.ask({...f,request:{...f.request,requestId:'blank2'}},new AbortController().signal);
  input.write('\n'); // Two active owners: ambiguous empty Enter cannot be routed.
  await new Promise(resolve=>setImmediate(resolve));
  old.abort();assert.deepEqual(await p,{kind:'cancelled'});
  input.write('\n'); // Now one displayed live owner can accept blank text.
  assert.deepEqual(await future,{kind:'answered',payload:{action:'accept',content:{text:''}}});
  terminal.close();input.end();
});
test('C15R.6R.2 original special field names and typed values survive form draft and :json',async()=>{
  const input=new PassThrough(),output=new PassThrough();output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const props=JSON.parse('{"__proto__":{"type":"array","items":{"type":"string","enum":["a","b"]}},"constructor":{"type":"string"},"prototype":{"type":"integer"}}');
  const f=structuredClone(form);f.request.requestId='special';
  f.request.payload={mode:'form',message:'Special keys',requestedSchema:{type:'object',
    properties:props,required:['__proto__','constructor','prototype']}};
  const result=terminal.ask(f,new AbortController().signal);
  await tick();
  input.write('1,2\nname\n0\n');
  const received=await result;
  assert.equal(received.kind,'answered');
  assert.deepEqual(received.payload?.content?.['__proto__'],['a','b']);
  assert.equal(Object.hasOwn(received.payload.content,'__proto__'),true);
  assert.equal(received.payload.content.constructor,'name');
  assert.equal(received.payload.content.prototype,0);
  const next=terminal.ask({...f,request:{...f.request,requestId:'special2'}},new AbortController().signal);
  input.write(':json {"__proto__":["b"],"constructor":"given","prototype":0}\n');
  const accepted=await next;
  assert.equal(Object.hasOwn(accepted.payload.content,'__proto__'),true);
  assert.deepEqual(accepted.payload.content['__proto__'],['b']);
  terminal.close();input.end();
});
test('C15R.6R.2 large valid form streams one field; choice lists are paged without losing actual value',async()=>{
  const input=new PassThrough(),output=new PassThrough();let shown='';output.on('data',chunk=>shown+=chunk);
  const terminal=createCliInput(input,output,true,()=>{});
  const keys=Object.fromEntries(Array.from({length:132},(_,i)=>['f'+i,{type:'string'}]));
  keys.f0={type:'string',oneOf:Array.from({length:51},(_,i)=>({const:'value-'+(i+1),title:'Choice '+(i+1)}))};
  const f=structuredClone(form);f.request.requestId='large';
  f.request.payload={mode:'form',message:'Large valid ACP form',requestedSchema:{type:'object',properties:keys}};
  const ctl=new AbortController();const done=terminal.ask(f,ctl.signal);
  assert.match(shown,/Large valid ACP form/);
  assert.match(shown,/Choice 20/);assert.doesNotMatch(shown,/Choice 51/);
  input.write(':choices 41\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(shown,/Choice 51/);
  input.write('51\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(shown,/2\/132/);
  ctl.abort();assert.deepEqual(await done,{kind:'cancelled'});
  terminal.close();input.end();
});


test('C15R.6R.3 question source is the actual known execution label, otherwise unknown role is explicit',async()=>{
  const input=new PassThrough(),output=new PassThrough();let rendered='';output.on('data',b=>rendered+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk,terminal.resetPresentation);
  terminal.setSourceResolver(renderer.sourceFor);
  await renderer.notice({channel:'execution',event:{eventName:'attempt.dispatched',eventId:'e1',
    level:'info',sequence:1,receivedAt:0,reasonCode:'DISPATCH_STARTED'},fact:{
    attemptId:'b',invocationKind:'worker',roleId:'Reviewer',attemptOrdinal:2,profileId:'worker'}});
  const first=terminal.ask(form,new AbortController().signal);
  assert.match(rendered,/\? Reviewer #2 · worker · #1 · Native question/);
  input.write('value\n');await first;
  const second=terminal.ask({...form,request:{...form.request,requestId:'unknown',attemptId:'unseen'}},new AbortController().signal);
  assert.match(rendered,/profile worker · role not recorded/);
  input.write('another\n');await second;
  terminal.close();renderer.close();input.end();
});


test('C15R.6R.1 pattern timeout does not block another pending permission or grant its own request', {timeout:10000},async()=>{
  const input=new PassThrough(),output=new PassThrough();let shown='';output.on('data',b=>shown+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const risky=structuredClone(form);risky.request.requestId='risky';
  risky.request.payload={mode:'form',message:'Pattern',requestedSchema:{type:'object',properties:{
    value:{type:'string',pattern:'(a+)+$'}},required:['value']}};
  const stop=new AbortController();
  const answer=terminal.ask(risky,stop.signal);
  input.write('a'.repeat(40)+'!\n');
  const start=performance.now();
  const approval=terminal.ask({...permission,request:{...permission.request,requestId:'parallel'}},new AbortController().signal);
  await tick();
  input.write('#2 1\n');
  assert.deepEqual(await approval,{kind:'answered',payload:{optionId:'deny'}});
  assert.ok(performance.now()-start<700,'permission owner was stalled by unrelated provider regex');
  await new Promise(resolve=>setTimeout(resolve,950));
  assert.match(shown,/pattern validation timed out/);
  input.write(':cancel\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{action:'cancel'}});
  terminal.close();input.end();
});
test('C15R.6R.1 :json fallback validates native pattern rather than accepting unverified content', {timeout:10000},async()=>{
  const input=new PassThrough(),output=new PassThrough();let shown='';output.on('data',b=>shown+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const f=structuredClone(form);f.request.requestId='json-pattern';
  f.request.payload={mode:'form',message:'Pattern value',requestedSchema:{type:'object',
    properties:{value:{type:'string',pattern:'^(abc|def)$'}},required:['value']}};
  const answer=terminal.ask(f,new AbortController().signal);
  input.write(':json {"value":"different"}\n');
  await new Promise(resolve=>setTimeout(resolve,160));
  assert.match(shown,/does not match required pattern/);
  input.write(':json {"value":"abc"}\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{action:'accept',content:{value:'abc'}}});
  terminal.close();input.end();
});


test('C15R.6R-Final cancellation commands preempt a pending provider regex and cannot send a late accept',
  {timeout:10000},async()=>{
  for(const [command,action] of [[':cancel','cancel'],[':decline','decline']]){
    const input=new PassThrough(),output=new PassThrough();let shown='';
    output.on('data',b=>shown+=b);
    const terminal=createCliInput(input,output,true,()=>{});
    const risky=structuredClone(form);risky.request.requestId='pending-'+action;
    risky.request.payload={mode:'form',message:'Untrusted regex',requestedSchema:{type:'object',
      properties:{value:{type:'string',pattern:'(a+)+$'}},required:['value']}};
    try{
      const pending=terminal.ask(risky,new AbortController().signal);
      input.write('a'.repeat(40)+'!\n');
      // The first input has started a background validator. Do not wait for
      // its timeout; the next line must terminate the live native request.
      input.write(command+'\n');
      assert.deepEqual(await pending,{kind:'answered',payload:{action}});
      const next=structuredClone(form);next.request.requestId='after-'+action;
      next.request.payload={mode:'form',message:'Following question',requestedSchema:{type:'object',
        properties:{value:{type:'string',pattern:'^ok$'}},required:['value']}};
      const answer=terminal.ask(next,new AbortController().signal);
      input.write('ok\n');
      assert.deepEqual(await answer,{kind:'answered',payload:{action:'accept',content:{value:'ok'}}});
      await new Promise(resolve=>setTimeout(resolve,800));
      assert.doesNotMatch(shown,/pattern validation timed out|Pattern validation unavailable/);
    }finally{terminal.close();input.end();}
  }
});

test('C15R.6R-Final cancel while validating does not block an independent permission or steal its answer',
  {timeout:10000},async()=>{
  const input=new PassThrough(),output=new PassThrough();output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const risky=structuredClone(form);risky.request.requestId='worker-a';
  risky.request.payload={mode:'form',message:'Pattern',requestedSchema:{type:'object',
    properties:{value:{type:'string',pattern:'(a+)+$'}},required:['value']}};
  try{
    const formAnswer=terminal.ask(risky,new AbortController().signal);
    input.write('a'.repeat(40)+'!\n');
    const permissionAnswer=terminal.ask({...permission,request:{...permission.request,requestId:'worker-b'}},
      new AbortController().signal);
    await tick(); // The independent permission's numeric choices reached Writable.
    input.write('#1 :cancel\n#2 1\n');
    assert.deepEqual(await formAnswer,{kind:'answered',payload:{action:'cancel'}});
    assert.deepEqual(await permissionAnswer,{kind:'answered',payload:{optionId:'deny'}});
  }finally{terminal.close();input.end();}
});

test('C15R.6R-Final external abort wins if already delivered; later typed cancel cannot reach a new request',
  {timeout:10000},async()=>{
  const input=new PassThrough(),output=new PassThrough();let outputText='';
  output.on('data',b=>outputText+=b);
  const terminal=createCliInput(input,output,true,()=>{});
  const stop=new AbortController(),risky=structuredClone(form);
  risky.request.requestId='cancel-race';
  risky.request.payload={mode:'form',message:'Pattern',requestedSchema:{type:'object',
    properties:{value:{type:'string',pattern:'(a+)+$'}},required:['value']}};
  try{
    const original=terminal.ask(risky,stop.signal);
    input.write('a'.repeat(40)+'!\n');
    stop.abort();
    assert.deepEqual(await original,{kind:'cancelled'});
    const future=terminal.ask({...form,request:{...form.request,requestId:'future'}},
      new AbortController().signal);
    // A delayed explicit answer for the already cancelled alias must never
    // be interpreted as a command for the newly displayed question.
    input.write('#1 :cancel\n');
    await tick();
    input.write('#2 chosen\n');
    assert.deepEqual(await future,{kind:'answered',payload:{action:'accept',content:{value:'chosen'}}});
    assert.match(outputText,/does not belong to an active request/);
  }finally{terminal.close();input.end();}
});
