import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
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
  assert.match(text,/\[p\/a\] Thinking: first second\n\[p\/b\] Thinking: other fragment\n/);
  assert.match(text,/Permission requested/);assert.match(text,/\[p\/a\] Thinking: again\n/);
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
