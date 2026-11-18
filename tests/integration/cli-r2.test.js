import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { createCliInput } from '../../src/hosts/cli-input.js';
import { cliPresentation } from '../../src/hosts/cli-presentation.js';
import { formFieldView, permissionChoicesView } from '../../src/hosts/cli-input-view.js';
import { boundedNativePreview } from '../../src/hosts/cli-details.js';

const permission=options=>({kind:'permission',request:{requestId:'r1',operationId:'op',attemptId:'a',profileId:'p',
  providerRequestId:'native',resource:'tool',options}});
const choices=Array.from({length:30},(_,i)=>({id:'option-'+(i+1),kind:i===29?'allow':'deny',
  label:i===29?'Allow all paths':'Deny '+(i+1),scope:i===29?'always':'once'}));
const event=reason=>({channel:'execution',event:{eventName:'permission.resolved',
  reasonCode:reason,operationId:'op',attemptId:'a',eventId:reason,level:'info',sequence:1,receivedAt:1}});
const textOf=parts=>typeof parts==='string'?parts:parts.map(p=>p.text).join('');

test('R2-F1: numeric permission choice must have appeared in current request output before approval',async()=>{
  const input=new PassThrough(),output=new PassThrough();let shown='';
  output.on('data',b=>shown+=b.toString());
  const cli=createCliInput(input,output,true,()=>{});
  let resolved=false;
  const pending=cli.ask(permission(choices),new AbortController().signal).then(x=>{resolved=true;return x;});
  assert.match(shown,/1\. Deny 1/);
  assert.doesNotMatch(shown,/30\. Allow all paths/);
  input.write('30\n');
  await tick();
  assert.equal(resolved,false,'a hidden broad-scope permission cannot be granted numerically');
  assert.match(shown,/Option 30 has not been displayed|Use :choices 30/);
  input.write(':choices 30\n');
  await tick();
  assert.match(shown,/30\. Allow all paths.*always/);
  input.write('30\n');
  assert.deepEqual(await pending,{kind:'answered',payload:{optionId:'option-30'}});
  cli.close();
});

test('R2-F1: paginated form choice also requires a previously displayed position',async()=>{
  const options=Array.from({length:30},(_,i)=>({const:'value'+(i+1),title:'Choice '+(i+1)}));
  const entry={kind:'input',request:{requestId:'q',operationId:'op',attemptId:'a',profileId:'p',
    providerRequestId:'form',payload:{mode:'form',message:'Choose',requestedSchema:{
      type:'object',properties:{choice:{type:'string',oneOf:options}},required:['choice']}}}};
  const input=new PassThrough(),output=new PassThrough();let rendered='';
  output.on('data',b=>rendered+=b.toString());
  const cli=createCliInput(input,output,true,()=>{});
  let resolved=false;
  const pending=cli.ask(entry,new AbortController().signal).then(x=>{resolved=true;return x;});
  input.write('30\n');
  await tick();
  assert.equal(resolved,false);
  assert.match(rendered,/:choices 30|not.*displayed/i);
  input.write(':choices 30\n');
  await tick();
  input.write('30\n');
  assert.deepEqual(await pending,{kind:'answered',payload:{action:'accept',content:{choice:'value30'}}});
  cli.close();
});

test('R2-F2: actual broker PERMISSION_UNAVAILABLE is rendered explicitly with raw debug reason',async()=>{
  for(const mode of ['compact','detailed','debug']){
    const chunks=[],renderer=cliPresentation(mode,async part=>chunks.push(textOf(part)));
    await renderer.notice(event('PERMISSION_UNAVAILABLE'));
    renderer.close();
    const output=chunks.join('');
    if(mode==='debug')assert.match(output,/PERMISSION_UNAVAILABLE/);
    else {
      assert.match(output,/Permission unavailable/);
      assert.doesNotMatch(output,/Permission outcome reported \(details in debug\)/);
    }
  }
});

test('R2-F4: all native view clips preserve surrogate pairs and one truncation marker',()=>{
  const option={id:'allow',kind:'allow',scope:'always',label:'a'.repeat(239)+'😀'+'b'.repeat(300)};
  const fields={message:'b'.repeat(1999)+'😀',title:'c'.repeat(239)+'😀',
    fields:[{key:'x',shape:{type:'string',title:'d'.repeat(999)+'😀',
      description:'e'.repeat(999)+'😀',oneOf:[]},required:false,
      options:[{label:option.label,value:'original',description:'f'.repeat(479)+'😀'}]}]};
  const text=[
    ...permissionChoicesView(permission([option]).request),
    ...formFieldView(fields,0),
  ].map(p=>p.text).join('');
  assert.doesNotMatch(text,/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  assert.match(text,/\[display truncated\]/);
  assert.doesNotMatch(text,/…\s*…/);
  assert.equal(option.label.at(239),'\ud83d','native original remains unchanged');
});

test('R2-F3: record Node 24 wide-property preview baseline latency and memory before choosing a fix',()=>{
  const samples=[];
  for(const count of [10000,100000,300000]){
    const wide={};
    for(let i=0;i<count;i++)wide['p'+i]=i;
    const heapStart=process.memoryUsage().heapUsed,start=performance.now();
    const preview=boundedNativePreview(wide);
    const elapsed=performance.now()-start,heapDelta=process.memoryUsage().heapUsed-heapStart;
    samples.push({count,ms:Math.round(elapsed*100)/100,heapDelta,chars:preview.text.length,omitted:preview.omitted});
  }
  assert.fail('R2_WIDE_OBJECT_NODE24_BASELINE '+JSON.stringify({node:process.version,samples}));
});
