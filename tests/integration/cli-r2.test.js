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

test('R2-F3: Node 24 wide-object preview cost remains independent of total property count',()=>{
  const samples=[];
  for(const count of [10000,100000,300000]){
    const wide={};
    for(let i=0;i<count;i++)wide['p'+i]=i;
    const heapStart=process.memoryUsage().heapUsed,start=performance.now();
    const preview=boundedNativePreview(wide);
    const elapsed=performance.now()-start,heapDelta=process.memoryUsage().heapUsed-heapStart;
    samples.push({count,ms:Math.round(elapsed*100)/100,heapDelta,chars:preview.text.length,omitted:preview.omitted});
  }
  assert.ok(samples.every(sample=>sample.ms<25),
    'R2 wide preview exceeded resource target: '+JSON.stringify({node:process.version,samples}));
  assert.ok(samples.every(sample=>sample.chars<=32000));
  assert.equal(boundedNativePreview({scope:'always'}).partial,true);
});

test('R2-F1 boundaries 1/20/21 and 101 preserve original IDs and scope and only visible numeric choices',async()=>{
  for(const [length,position,expected] of [[1,1,'native-1'],[20,20,'native-20'],[21,21,'native-21'],[101,101,'native-101']]){
    const options=Array.from({length},(_,i)=>({id:'native-'+(i+1),
      kind:i===length-1?'allow':'deny',label:i===length-1?'Allow privileged scope':'Deny '+i,
      scope:i===length-1?'always':'once'}));
    const req=permission(options);
    const input=new PassThrough(),output=new PassThrough();let transcript='';
    output.on('data',chunk=>transcript+=chunk.toString());
    const terminal=createCliInput(input,output,true,()=>{});
    let sent=false;const asking=terminal.ask(req,new AbortController().signal).then(x=>{sent=true;return x;});
    if(position>20){
      input.write(position+'\n');await tick();
      assert.equal(sent,false);
      assert.match(transcript,new RegExp('Use :choices '+position));
      input.write(':choices '+position+'\n');await tick();
      assert.match(transcript,/Allow privileged scope.*always/);
    }
    input.write(position+'\n');
    assert.deepEqual(await asking,{kind:'answered',payload:{optionId:expected}});
    terminal.close();
  }
});

test('R2-F1 exact native id selection is distinct from displayed numeric positions',async()=>{
  const input=new PassThrough(),output=new PassThrough();output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const value=terminal.ask(permission(choices),new AbortController().signal);
  // Intentional exact-ID syntax remains an explicitly selected provider option;
  // it must never map through the visible page's numeric offset.
  input.write('id:option-30\n');
  assert.deepEqual(await value,{kind:'answered',payload:{optionId:'option-30'}});
  terminal.close();
});

test('R2-F1 permission choices are request-scoped with concurrent form and no late grants',async()=>{
  const input=new PassThrough(),output=new PassThrough();let outputText='';
  output.on('data',b=>outputText+=b.toString());
  const terminal=createCliInput(input,output,true,()=>{});
  const stop=new AbortController();
  const p=terminal.ask(permission(choices),stop.signal);
  const q=terminal.ask({kind:'input',request:{requestId:'q',operationId:'op',attemptId:'b',
    profileId:'p',providerRequestId:'native-form',payload:{mode:'form',message:'Type',requestedSchema:{
      type:'object',properties:{answer:{type:'string'}}}}}},new AbortController().signal);
  input.write('#1 :choices 30\n');
  await tick();
  assert.match(outputText,/30\. Allow all paths.*always/);
  input.write('#2 correct answer\n');
  assert.deepEqual(await q,{kind:'answered',payload:{action:'accept',content:{answer:'correct answer'}}});
  stop.abort();
  assert.deepEqual(await p,{kind:'cancelled'});
  input.write('#1 30\n');
  await tick();
  terminal.close();
  // The terminated permission cannot be reopened or granted by late input.
  assert.doesNotMatch(outputText,/Permission selection recorded · allow option/);
});

test('R2-F3 preview avoids enumerating arbitrary keys, executing accessors or crashing on descriptor exceptions',()=>{
  let enumerations=0,getters=0;
  const raw={scope:'always',title:'Native action'};
  Object.defineProperty(raw,'details',{enumerable:true,get(){getters++;throw Error('getter must not run');}});
  const view=new Proxy(raw,{ownKeys(){enumerations++;throw Error('native keys must not be enumerated');},
    getOwnPropertyDescriptor(target,key){
      if(key==='annotations')throw Error('descriptor unavailable');
      return Reflect.getOwnPropertyDescriptor(target,key);
    }});
  const preview=boundedNativePreview({action:view});
  assert.equal(enumerations,0);
  assert.equal(getters,0);
  assert.match(preview.text,/Native action/);
  assert.match(preview.text,/accessor not inspected/);
  assert.match(preview.text,/metadata access unavailable/);
  assert.match(preview.text,/always/);
  assert.equal(preview.partial,true);
  const cycle={title:'cycle'};cycle.metadata=cycle;
  assert.match(boundedNativePreview(cycle).text,/repeated object not displayed/);
});

test('R2-F4 native Unicode label clipping preserves original values and avoids splitting combining sequences',()=>{
  const label='Ω'.repeat(237)+'e\u0301'+'😀'+'tail'.repeat(200);
  const option={id:'native-id',kind:'allow',label,scope:'always'};
  const original=structuredClone(option);
  const segments=permissionChoicesView(permission([option]).request).map(x=>x.text).join('');
  assert.doesNotMatch(segments,/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  assert.match(segments,/\[display truncated\]/);
  assert.deepEqual(option,original);
});

test('R2-F4 truncation before a combining mark does not display a false unaccented base',()=>{
  const item={kind:'deny',id:'x',label:'a'.repeat(239)+'e\u0301'+'tail'};
  const shown=permissionChoicesView(permission([item]).request).map(x=>x.text).join('');
  assert.match(shown,/\[display truncated\]/);
  assert.doesNotMatch(shown,/e… \[display truncated\]/);
  assert.ok(item.label.includes('e\u0301'),'the native option label was not edited');
});

test('R2-F1 an already shown permission choice stays selectable after opening another page',async()=>{
  const input=new PassThrough(),output=new PassThrough();let outputText='';
  output.on('data',data=>outputText+=data.toString());
  const terminal=createCliInput(input,output,true,()=>{});
  const outcome=terminal.ask(permission(choices),new AbortController().signal);
  input.write(':choices 30\n');
  await tick();
  assert.match(outputText,/30\. Allow all paths.*always/);
  input.write('1\n');
  assert.deepEqual(await outcome,{kind:'answered',payload:{optionId:'option-1'}});
  terminal.close();
});

test('R2-F1 already viewed form choice pages retain their positions without changing provider values',async()=>{
  const options=Array.from({length:30},(_,i)=>({const:'native-'+(i+1),title:'Label '+(i+1)}));
  const entry={kind:'input',request:{requestId:'q',operationId:'op',attemptId:'a',profileId:'p',
    providerRequestId:'form',payload:{mode:'form',message:'Pick one',requestedSchema:{
      type:'object',properties:{picked:{type:'string',oneOf:options}},required:['picked']}}}};
  const input=new PassThrough(),output=new PassThrough();output.resume();
  const terminal=createCliInput(input,output,true,()=>{});
  const answer=terminal.ask(entry,new AbortController().signal);
  input.write(':choices 30\n');
  await tick();
  input.write('1\n');
  assert.deepEqual(await answer,{kind:'answered',payload:{action:'accept',content:{picked:'native-1'}}});
  terminal.close();
});
