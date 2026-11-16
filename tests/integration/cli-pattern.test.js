import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkPattern} from '../../src/hosts/cli-pattern.js';
import {projectForm,validateFormPatterns,validateFormContent} from '../../src/hosts/cli-form.js';

const formFor=pattern=>projectForm({payload:{mode:'form',message:'Regex',requestedSchema:{
  type:'object',properties:{value:{type:'string',pattern}},required:['value']
}}});
test('C15R.6R P1: normal pattern validation retains match/mismatch semantics',async()=>{
  const form=formFor('^[a-z]{2,8}$');
  assert.ok(form);
  assert.equal(validateFormContent(form,{value:'hello'}),undefined);
  assert.deepEqual(await validateFormPatterns(form,{value:'hello'}),{kind:'valid'});
  assert.deepEqual(await validateFormPatterns(form,{value:'123'}),{kind:'invalid',message:'value: text does not match required pattern'});
  const invalid=formFor('[');
  assert.equal((await validateFormPatterns(invalid,{value:'anything'})).kind,'unavailable');
});
test('C15R.6R P1: catastrophic backtracking is timed out without stopping unrelated event-loop work', {timeout:10000},async()=>{
  const form=formFor('(a+)+$');
  const start=performance.now();
  const pending=validateFormPatterns(form,{value:'a'.repeat(40)+'!'});
  let resumed=false;
  await new Promise(resolve=>setImmediate(()=>{resumed=true;resolve();}));
  assert.equal(resumed,true);
  assert.ok(performance.now()-start<500,'main event loop was blocked by provider regex');
  const result=await pending;
  assert.equal(result.kind,'unavailable');
  assert.match(result.message,/timed out/);
});
test('C15R.6R P1: aborted pattern validation does not return mismatch or acceptance', {timeout:10000},async()=>{
  const ctl=new AbortController();
  const result=checkPattern('(a+)+$','a'.repeat(40)+'!',ctl.signal);
  ctl.abort();
  assert.equal(await result,'cancelled');
});


test('C15R.6R bounded large native multi-select validation uses original offered values',()=>{
  const options=Array.from({length:4000},(_,i)=>({const:'v'+i,title:'Option '+i}));
  const form=projectForm({payload:{mode:'form',message:'Many options',requestedSchema:{type:'object',
    properties:{values:{type:'array',items:{anyOf:options},minItems:1}}}}});
  assert.ok(form);
  const content={values:options.slice(0,2000).map(option=>option.const)};
  const start=performance.now();
  assert.equal(validateFormContent(form,content),undefined);
  const ms=performance.now()-start;
  assert.ok(ms<1000,'large offered values incurred quadratic validation cost');
  assert.match(validateFormContent(form,{values:['Option 1']}),/value not offered/);
});
