import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { createTerminalMargin, terminalMarginColumns } from '../../src/hosts/cli-layout.js';
import { createCliInput } from '../../src/hosts/cli-input.js';
import { runCli } from '../../src/hosts/cli.js';
import { setup, final } from '../fixtures/application.js';
import { assessment, request } from '../fixtures/core.js';

const plain=value=>value.replace(/\x1b\[[0-9;]*m/g,'');

test('P1 terminal left margin follows visible line boundaries, not arbitrary native chunk boundaries',()=>{
  const m=createTerminalMargin();
  assert.equal(m.format('Title\n\n  inner\n',2),'  Title\n\n    inner\n');
  assert.equal(m.format('Inspecting ',2),'  Inspecting ');
  assert.equal(m.format('the repo\nNext ',2),'the repo\n  Next ');
  assert.equal(m.format('step\n',2),'step\n');
  assert.equal(m.format('\n',2),'\n');
  assert.equal(m.format('\x1b[1;36mTitle\x1b[0m\n',2),'  \x1b[1;36mTitle\x1b[0m\n');
  assert.equal(m.format('\x1b[32m',2),'\x1b[32m');
  assert.equal(m.format('green\x1b[0m\n',2),'  green\x1b[0m\n');
  assert.equal(m.format('👋 Привет\ncode: `value`\n',2),'  👋 Привет\n  code: `value`\n');
});

test('P1 decoration scales only with credible TTY width and leaves redirected streams unchanged',()=>{
  for(const [width,pad] of [[120,2],[80,2],[40,1],[24,0],[1,0],[0,1],[-1,1],[undefined,1]]){
    assert.equal(terminalMarginColumns({isTTY:true,columns:width}),pad,String(width));
    const formatted=createTerminalMargin().format('one\ntwo\n',pad);
    assert.equal(formatted,' '.repeat(pad)+'one\n'+' '.repeat(pad)+'two\n');
  }
  assert.equal(terminalMarginColumns({isTTY:false,columns:120}),0);
  assert.equal(terminalMarginColumns({columns:120}),0);
});

test('P1 live transcript and interleaved Worker chunks retain hierarchy without double prefix',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  output.isTTY=true;output.columns=80;
  let printed='';output.on('data',data=>printed+=data.toString());
  const cli=createCliInput(input,output,true,()=>{});
  try{
    await cli.print([{text:'Controller #1',tone:'header'},
      {text:'\n\n  Invocation dispatched\n  ◆ Finding'}]);
    const fragment=(source,header,text)=>({
      source,header,text,indent:'  ',headerTone:'muted',
    });
    await cli.printChunk(fragment('w1','\n  Thinking · Worker A\n','Inspecting '));
    await cli.printChunk(fragment('w1','\n  Thinking · Worker A\n','repository\nNext '));
    await cli.printChunk(fragment('w1','\n  Thinking · Worker A\n','step'));
    await cli.printChunk(fragment('w2','\n  Thinking · Worker B\n','Other'));
    await cli.print('Done');
    const text=plain(printed);
    assert.match(text,/^  Controller #1\n\n    Invocation dispatched\n    ◆ Finding\n/m);
    assert.match(text,/\n    Thinking · Worker A\n    Inspecting repository\n    Next step\n/m);
    assert.match(text,/\n    Thinking · Worker B\n    Other\n/m);
    assert.match(text,/\n  Done\n/);
    assert.doesNotMatch(text,/Inspecting\s{3}repository|Next\s{3}step/);
  }finally{cli.close();input.destroy();output.destroy();}
});

test('P1 successful page receipt includes padded native permission view; prompt remains separate',async()=>{
  const input=new PassThrough();
  /** @type {((error?:Error)=>void)|undefined} */
  let pageCallback;
  let transcript='';
  const output=new Writable({write(chunk,_enc,cb){
    const text=String(chunk);
    transcript+=text;
    if(text.includes('Permission requested'))pageCallback=cb;
    else cb();
  }});
  output.isTTY=true;output.columns=80;
  const cli=createCliInput(input,output,true,()=>{});
  const stop=new AbortController();
  const entry={kind:'permission',request:{
    requestId:'r',operationId:'op',attemptId:'a',profileId:'p',providerRequestId:'native',
    resource:'fixture',options:[{id:'deny',kind:'deny',label:'Deny'},{id:'allow',kind:'allow',label:'Allow',scope:'always'}],
  }};
  let settled=false;
  const answer=cli.ask(entry,stop.signal).then(value=>{settled=true;return value;});
  try{
    assert.match(plain(transcript),/(?:^|\n)  #1 ·/);
    assert.match(plain(transcript),/(?:^|\n)    1\. Deny/);
    input.write('1\n');await tick();
    assert.equal(settled,false,'visually padded write is not confirmed before Writable callback');
    assert.ok(pageCallback);
    pageCallback?.();await tick();
    input.write('1\n');
    assert.deepEqual(await answer,{kind:'answered',payload:{optionId:'deny'}});
    assert.match(plain(transcript),/  Reply \(#1\):/,'readline prompt has exactly one outer prefix');
  }finally{stop.abort();cli.close();input.destroy();output.destroy();}
});

test('P1 authoritative TTY final uses the same margin without changing assessment, JSON or redirected stdout',async()=>{
  const original='## Результат\n- элемент\n\n`code` и 🦊\n```js\nconst x = 1;\n```';
  const {api}=setup({respond:invocation=>final(invocation,{finalAssessment:assessment({
    author:invocation.profile.profileId,overall:'complete',answer:original,
  })})});
  let state;
  try{
    const submission=await api.submit(request());
    state=await submission.completion;
  }finally{await api.close();}
  assert.equal(state.assessment.answer,original);
  const invoke=async (args,width,isTTY)=>{
    const stdout=new PassThrough(),stderr=new PassThrough(),stdin=new PassThrough();
    stdout.isTTY=isTTY;stdout.columns=width;
    let text='';stdout.on('data',part=>text+=part.toString());stderr.resume();
    const after=[];
    const code=await runCli(args,{cwd:'/tmp',stdin,stdout,stderr},async()=>state,()=>after.push('after'));
    return {code,text,after};
  };
  const shown=await invoke(['run','anything'],80,true);
  assert.equal(shown.code,0);
  const visible=plain(shown.text);
  assert.match(visible,/^  Результат\n  - элемент\n\n  code и 🦊\n  ```js\n  const x = 1;\n  ```\n$/);
  assert.deepEqual(shown.after,['after']);
  const narrow=await invoke(['run','anything'],24,true);
  assert.equal(plain(narrow.text).startsWith('Результат\n'),true);
  const redirect=await invoke(['run','anything'],80,false);
  assert.equal(redirect.text,original+'\n');
  const machine=await invoke(['run','anything','--format','json'],80,true);
  assert.equal(JSON.parse(machine.text).assessment.answer,original);
  assert.equal(machine.text.startsWith('  '),false);
});
