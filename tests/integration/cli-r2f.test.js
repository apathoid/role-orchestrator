import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { createCliInput } from '../../src/hosts/cli-input.js';

/** Native display receipt fixture. A write is not delivered until release().
 * No sleeps, model calls, or fake permission broker. */
class ControlledWritable extends Writable {
  constructor(){
    super();
    /** @type {{text:string,done:(error?:Error)=>void}[]} */
    this.held=[];
  }
  _write(chunk,_encoding,done){this.held.push({text:String(chunk),done});}
  release(){
    const item=this.held.shift();
    assert.ok(item,'expected a pending Writable callback');
    item.done();
    return item.text;
  }
}
const permission=(id='r')=>({kind:'permission',request:{
  requestId:id,operationId:'op',attemptId:id,profileId:'p',providerRequestId:'native',
  resource:'target',options:[{id:'deny',kind:'deny',label:'Deny'},{id:'allow',kind:'allow',label:'Allow',scope:'always'}],
}});
const form=(id='f',required=true)=>({kind:'input',request:{
  requestId:id,operationId:'op',attemptId:id,profileId:'p',providerRequestId:'native-form',
  payload:{mode:'form',message:'Select',requestedSchema:{
    type:'object',properties:{
      first:{type:'string',title:'First choice',oneOf:[{const:'a',title:'First A'}]},
      second:{type:'string',title:'Second choice',oneOf:[{const:'b',title:'Second B'}]},
    },required:required?['first','second']:['second']}},
}});
async function setup(t){
  const input=new PassThrough(),output=new ControlledWritable(),cli=createCliInput(input,output,true,()=>{});
  t.after(()=>{cli.close();input.destroy();output.destroy();});
  return {input,output,cli};
}

test('R2F RED initial permission numeric choice is rejected until successful Writable callback',async(t)=>{
  const {input,output,cli}=await setup(t);
  let done=false;
  const answer=cli.ask(permission(),new AbortController().signal).then(x=>{done=true;return x;});
  assert.match(output.held[0]?.text??'',/1\. Deny/);
  input.write('1\n');await tick();
  assert.equal(done,false,'initial options have not crossed the Writable boundary');
  output.release();await tick();
  input.write('1\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{optionId:'deny'}});
  cli.close();
});

test('R2F RED initial form numeric choice is rejected before successful Writable callback',async(t)=>{
  const {input,output,cli}=await setup(t);
  let done=false;
  const answer=cli.ask(form(),new AbortController().signal).then(x=>{done=true;return x;});
  input.write('1\n1\n');await tick();
  assert.equal(done,false,'second field must not be reached from an undisplayed first field');
  // An early choice cannot be silently replayed as approval after delivery.
  cli.close();
  assert.deepEqual(await answer,{kind:'unavailable'});
  output.destroy();
});

test('R2F RED nextForm: second-field number waits for its own Writable receipt',async(t)=>{
  const {input,output,cli}=await setup(t);
  let done=false;
  const answer=cli.ask(form(),new AbortController().signal).then(x=>{done=true;return x;});
  output.release();await tick(); // First choice has crossed Writable boundary.
  input.write('1\n');await tick();
  assert.match(output.held[0]?.text??'',/Second choice/);
  input.write('1\n');await tick();
  assert.equal(done,false,'unacknowledged second field must not complete the form');
  output.release();await tick();
  input.write('1\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{action:'accept',content:{first:'a',second:'b'}}});
  cli.close();
});

test('R2F RED :back: a stale initial callback for the same field index cannot authorize a newer display',async(t)=>{
  const {input,output,cli}=await setup(t);
  let done=false;
  const answer=cli.ask(form('back',false),new AbortController().signal).then(x=>{done=true;return x;});
  input.write(':skip\n:back\n');await tick(); // Back to field 0 while old write is held.
  assert.match(output.held[0]?.text??'',/First choice/);
  output.release();await tick(); // Stale original field-0 callback, not latest :back.
  input.write('1\n1\n');await tick();
  assert.equal(done,false,'stale callback must not authorize the latest field-0 display');
  input.write(':cancel\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{action:'cancel'}});
  cli.close();output.destroy();
});

test('R2F RED fast :choices 30 + 30 after initial receipt remains rejected until second page write resolves',async(t)=>{
  const {input,output,cli}=await setup(t);
  let done=false;
  const paged=permission();
  paged.request.options=Array.from({length:30},(_,i)=>({
    id:'native-'+(i+1),kind:i===29?'allow':'deny',label:'Option '+(i+1),scope:i===29?'always':'once',
  }));
  const answer=cli.ask(paged,new AbortController().signal).then(x=>{done=true;return x;});
  output.release();await tick();
  input.write(':choices 30\n30\n');await tick();
  assert.equal(done,false,'a queued :choices page is not yet shown');
  // Do not auto-replay 30 from the previous line.
  output.release();await tick();
  assert.equal(done,false);
  input.write('30\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{optionId:'native-30'}});
  cli.close();
});

test('R2F RED cancel/abort and failed Writable never record a page or allow a late native reply',async(t)=>{
  {
    const {input,output,cli}=await setup(),stop=new AbortController();
    const answer=cli.ask(permission(),stop.signal);
    stop.abort();
    assert.deepEqual(await answer,{kind:'cancelled'});
    output.release();await tick();
    input.write('#1 2\n');await tick();
    cli.close();output.destroy();
  }
  {
    const {input,output,cli}=await setup(t);
    const answer=cli.ask(permission(),new AbortController().signal);
    output.destroy(new Error('terminal unavailable'));
    assert.deepEqual(await answer,{kind:'unavailable'});
    input.write('2\n');await tick();
    cli.close();
  }
});

test('R2F RED concurrent pending questions do not share initial display receipts',async(t)=>{
  const {input,output,cli}=await setup(t);
  let secondSettled=false;
  const first=cli.ask(permission('one'),new AbortController().signal);
  const second=cli.ask(permission('two'),new AbortController().signal).then(x=>{secondSettled=true;return x;});
  output.release();await tick();
  input.write('#2 2\n');await tick();
  assert.equal(secondSettled,false,'first question receipt cannot authorize the second one');
  input.write('#1 id:deny\n');
  assert.deepEqual(await first,{kind:'answered',payload:{optionId:'deny'}});
  // The independently queued second question may now be delivered.
  output.release();await tick();
  input.write('#2 2\n');
  assert.deepEqual(await second,{kind:'answered',payload:{optionId:'allow'}});
  cli.close();
});
