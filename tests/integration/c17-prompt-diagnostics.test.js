import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createPromptReporter,reportPrompt} from '../../src/adapters/prompt-diagnostics.js';
import {renderInvocationPrompt} from '../../src/adapters/invocation-prompt.js';
import {createEventStream} from '../../src/application/events.js';
import {decisionContract} from '../../src/application/decision-instructions.js';
const fixture={kind:'controller',operationId:'op',attemptId:'a',actionId:'a',
  profile:{profileId:'p',providerId:'native'},objective:'Проверь 🧪',instructions:[decisionContract],
  userConstraints:[],context:[]};
test('C17.3 bytes and hash describe actual rendered text, not provider window; sections sum exactly',()=>{
  let sizes;
  const prompt=renderInvocationPrompt(fixture,'Native transport',value=>{sizes=value;});
  const events=[];
  const report=createPromptReporter({diagnostics:{emit:event=>events.push(event),flush(){}},
    clock:{now:()=>1,monotonicNow:()=>1},ids:{newId:()=>String(events.length)}});
  report(fixture,'prepared',sizes,prompt);
  assert.equal(events.length,1);
  assert.equal(events[0].attemptId,'a');
  assert.equal(events[0].details.serializedPromptBytes,Buffer.byteLength(prompt));
  assert.equal(Object.values(sizes).reduce((a,b)=>a+b,0),Buffer.byteLength(prompt));
  assert.equal(events[0].details.promptSha256,createHash('sha256').update(prompt).digest('hex'));
  assert.ok(!Object.hasOwn(events[0].details,'prompt'));
  assert.doesNotThrow(()=>reportPrompt(()=>{throw Error('sink failed');},fixture,'prepared',{},prompt));
});
test('C17.3 opt-in capture is private, bounded, redacted and never delivered to subscribers',async()=>{
  const stored=[],notices=[];
  const stream=createEventStream({emit:event=>stored.push(event),flush(){}},
    {captureBodies:true,secrets:['fixture-env-value']});
  stream.subscribe(event=>notices.push(event));
  const report=createPromptReporter({diagnostics:stream,privateDiagnostics:{emit:stream.emitPrivate,flush(){}},
    clock:{now:()=>1,monotonicNow:()=>1},ids:{newId:()=>String(stored.length)},captureBodies:true});
  const prompt='visible fixture-env-value\n{"password":"private-credential"}\n'+'x'.repeat(90000);
  report(fixture,'prepared',{},prompt);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stored.length,2);
  assert.equal(notices.length,1);
  assert.equal(stored[1].eventName,'adapter.prompt.capture');
  assert.equal(stored[1].details.captureCompleteness,'partial');
  assert.ok(stored[1].details.prompt.includes('visible [REDACTED]'));
  assert.ok(!JSON.stringify(stored).includes('private-credential'));
  assert.ok(!JSON.stringify(stored).includes('fixture-env-value'));
  assert.ok(stored[1].details.prompt.length<16384);
  assert.ok(!Object.hasOwn(notices[0].details,'prompt'));
  stream.close();
});
