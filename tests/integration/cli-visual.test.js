import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { terminalColor, sourceTone, styleText } from '../../src/hosts/cli-styling.js';
import { renderMarkdownAnswer } from '../../src/hosts/cli-markdown.js';
import { createCliInput } from '../../src/hosts/cli-input.js';
import { cliPresentation } from '../../src/hosts/cli-presentation.js';
import { createCliTools } from '../../src/hosts/cli-tools.js';

const strip=text=>text.replace(/\x1b\[[0-9;]*m/g,'');
test('A101 terminal capability fallback and role coloring are stable independent of role name/arrival order',()=>{
  const tty={isTTY:true};
  assert.equal(terminalColor(tty,{TERM:'dumb'}),'none');
  assert.equal(terminalColor(tty,{}),'none');
  assert.equal(terminalColor(tty,{TERM:'unknown'}),'none');
  assert.equal(terminalColor(tty,{TERM:'xterm-256color',NO_COLOR:''}),'none');
  assert.equal(terminalColor(tty,{TERM:'xterm-256color'}),'256');
  assert.equal(terminalColor(tty,{TERM:'xterm',COLORTERM:'truecolor'}),'truecolor');
  assert.equal(terminalColor(tty,{TERM:'xterm'}),'16');
  assert.equal(terminalColor(new PassThrough(),{TERM:'xterm-256color'}),'none');
  const controller={invocationKind:'controller',roleId:'completely arbitrary'};
  const worker={invocationKind:'delegate',roleId:'Controller'};
  const arbitrary={invocationKind:'delegate',roleId:'内部角色-🦊'};
  assert.equal(sourceTone(controller),'controller');
  assert.notEqual(sourceTone(worker),'controller','role string must not confer Controller identity');
  assert.equal(sourceTone(arbitrary),sourceTone({...arbitrary,attemptOrdinal:50,profileId:'other'}));
  assert.match(sourceTone(arbitrary),/^worker-[0-5]$/);
  assert.equal(sourceTone({invocationKind:'delegate'}),'neutral');
  assert.equal(styleText('payload','accent','none'),'payload');
  assert.match(styleText('payload',sourceTone(arbitrary),'truecolor'),/\x1b\[38;2;/);
  assert.match(styleText('payload',sourceTone(arbitrary),'256'),/\x1b\[38;5;/);
  assert.match(styleText('payload',sourceTone(arbitrary),'16'),/\x1b\[[0-9;]+m/);
});

test('A105 Markdown renders only supplied structure, preserves long/fenced source and never emits untrusted controls',()=>{
  const original='## Результат\n**жирный** и *курсив*\n- пункт\n> Цитата\n\x60код\x60\n[ссылка](https://example.org)\n\x60\x60\x60js\nconst x = 1;\n\x60\x60\x60';
  const styled=renderMarkdownAnswer(original,'256');
  assert.match(styled,/\x1b\[[0-9;]+m/);
  assert.match(strip(styled),/Результат\nжирный и курсив\n- пункт\n> Цитата\nкод/);
  assert.match(strip(styled),/ссылка \(https:\/\/example.org\)/);
  assert.match(strip(styled),/\x60\x60\x60js\nconst x = 1;\n\x60\x60\x60/);
  assert.equal(renderMarkdownAnswer(original,'none'),original,'NO_COLOR fallback remains ordinary Markdown');
  assert.equal(renderMarkdownAnswer('Обычный текст модели','256'),'Обычный текст модели');
  const ordinary='foo_bar_baz, x*y*z, 2*3*4 и ~~не изменено~~';
  assert.equal(renderMarkdownAnswer(ordinary,'256'),ordinary,
    'ordinary identifiers and arithmetic remain literal, not synthetic Markdown');
  assert.equal(renderMarkdownAnswer('## unclosed **\n<script>not executed</script>','none'),'## unclosed **\n<script>not executed</script>');
  const unsafe='Hello\x1b]52;c;SECRET\x07\u202e world';
  assert.equal(renderMarkdownAnswer(unsafe,'256'),'Hello world');
  const long='Содержимое '+ 'x'.repeat(260*1024)+'\n**final**';
  assert.equal(renderMarkdownAnswer(long,'256'),long,'large answers fall back without truncation');
  const pathological='['.repeat(12000)+'\n'+'*'.repeat(24000);
  assert.equal(renderMarkdownAnswer(pathological,'256'),pathological,
    'malformed excessive markup returns original safe text with bounded parsing work');
  const hugeLine='## heading '+'a'.repeat(20000);
  assert.equal(renderMarkdownAnswer(hugeLine,'256'),hugeLine,
    'overlong lines fall back to complete plain text without scanning for closures');
});

test('A103 native fragments retain identity across two arbitrary Workers and source switching',async()=>{
  const output=new PassThrough(),input=new PassThrough();let transcript='';
  output.on('data',part=>transcript+=part.toString());
  const terminal=createCliInput(input,output,false,()=>{});
  const renderer=cliPresentation('compact',terminal.print,terminal.printChunk,terminal.resetPresentation);
  const seen=[
    {attemptId:'w1',roleId:'research-this-code',attemptOrdinal:1},
    {attemptId:'w2',roleId:'unexpected/role',attemptOrdinal:2},
  ];
  for(const item of seen){
    await renderer.notice({channel:'execution',event:{eventName:'attempt.dispatched',reasonCode:'DISPATCH_STARTED',eventId:'start'+item.attemptId,sequence:1,receivedAt:1,level:'info'},
      fact:{kind:'attempt.dispatched',invocationKind:'delegate',attemptId:item.attemptId,roleId:item.roleId,attemptOrdinal:item.attemptOrdinal,profileId:'fixture'}});
  }
  for(const [i,body] of [[0,'alpha'],[1,'beta'],[0,' and omega']]){
    const id=seen[i].attemptId;
    await renderer.notice({channel:'activity',event:{kind:'reasoning',nativeKind:'agent_thought_chunk',
      operationId:'op',attemptId:id,profileId:'fixture',providerId:'native',sequence:i+2,
      payload:{content:{type:'text',text:body}}}});
  }
  terminal.close();renderer.close();
  assert.match(transcript,/research-this-code #1/);
  assert.match(transcript,/unexpected\/role #2/);
  assert.match(transcript,/alpha[\s\S]*beta[\s\S]*and omega/);
  assert.equal((transcript.match(/Invocation dispatched/g)??[]).length,2);
  assert.doesNotMatch(transcript,/2 workers started|Planner|Explorer/);
});

test('A102 original lengthy native constraints are pageable without modifying a typed answer',async()=>{
  const input=new PassThrough(),output=new PassThrough();let transcript='';
  output.on('data',part=>transcript+=part.toString());
  const terminal=createCliInput(input,output,true,()=>{});
  const long='L'.repeat(6000);
  const entry={kind:'input',request:{requestId:'r',attemptId:'a',profileId:'p',operationId:'op',
    payload:{mode:'form',message:'Ответьте',requestedSchema:{type:'object',properties:{
      answer:{title:'Комментарий',type:'string',description:long,minLength:1}},required:['answer']}}}};
  const pending=terminal.ask(entry,new AbortController().signal);
  await tick();
  assert.match(transcript,/\[display truncated\]/);
  input.write(':details 1\n');
  await tick();
  assert.match(transcript,/Original request details · page 1\//);
  input.write(':details 2\n');
  await tick();
  assert.match(transcript,/Original request details · page 2\//);
  input.write('  произвольное значение  \n');
  assert.deepEqual(await pending,{kind:'answered',payload:{action:'accept',content:{answer:'  произвольное значение  '}}});
  terminal.close();
});

test('A104 first generic tool update is visible; true duplicates suppressed, 1000+ updates stay bounded',()=>{
  const tools=createCliTools(),base={kind:'tool',operationId:'op',attemptId:'a',
    profileId:'fixture',providerId:'p',nativeId:'native-1',nativeKind:'tool_call',sequence:1,
    payload:{kind:'shell',title:'shell',status:'pending'}};
  assert.match(tools.accept(base,'compact').text,/shell · pending/);
  assert.equal(tools.accept({...base,sequence:2},'compact'),undefined);
  assert.match(tools.accept({...base,sequence:3,payload:{title:'Actual task',status:'in_progress'}},'compact').text,/Actual task/);
  assert.match(tools.accept({...base,sequence:4,payload:{status:'completed'}},'compact').text,/completed/);
  for(let i=0;i<1100;i++)tools.accept({...base,nativeId:'native-'+i,sequence:i,payload:{title:'native-'+i,status:'in_progress'}},'compact');
  assert.match(tools.accept({...base,sequence:2000,payload:{status:'unknown'}},'compact').text,/unknown/);
});
