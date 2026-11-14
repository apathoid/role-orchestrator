import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createCliInput } from '../../src/hosts/cli-input.js';
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
