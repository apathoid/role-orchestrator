import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {withOwnedRun} from '../../scripts/owned-run.mjs';
import {createNdjsonSink} from '../../src/adapters/state/ndjson-diagnostics.js';
import {setup,final} from '../fixtures/application.js';
import {request,outcome} from '../fixtures/core.js';
import {createHash,randomUUID} from 'node:crypto';
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

test('C17R UTF-8 capture includes late correction when configured, reports distinct persisted bytes and escaped credentials',async()=>{
  const stored=[];
  const stream=createEventStream({emit:e=>stored.push(e),flush(){}},
    {captureBodies:true,secrets:['abc"\\🧪private-value'],maxPrivateRecordBytes:300000});
  const report=createPromptReporter({diagnostics:stream,privateDiagnostics:{emit:stream.emitPrivate,flush(){}},
    clock:{now:()=>1,monotonicNow:()=>1},ids:{newId:()=>String(stored.length)},captureBodies:true,promptCaptureMaxBytes:262144});
  const prompt=JSON.stringify({description:'abc"\\🧪private-value'})+'\n'+'Привет 🧪\n'.repeat(4000)+'\n## Active technical correction\nprevious result';
  report(fixture,'prepared',{},prompt);
  const capture=stored[1].details;
  assert.equal(capture.serializedPromptBytes,Buffer.byteLength(prompt));
  assert.equal(capture.captureSourceBytes,Buffer.byteLength(prompt));
  assert.equal(capture.captureEndBytes,Buffer.byteLength(prompt));
  assert.equal(capture.captureStoredBytes,Buffer.byteLength(capture.prompt));
  assert.equal(capture.captureCompleteness,'complete_before_redaction');
  assert.match(capture.prompt,/Active technical correction/);
  assert.ok(!capture.prompt.includes('private-value'));
  assert.ok(capture.prompt.includes('[REDACTED]'));
  stream.close();
});
test('C17R source byte limit and serialized record limit are separate, Unicode boundaries are truthful',()=>{
  for(const limit of [256,65536]){
    const stored=[];
    const stream=createEventStream({emit:e=>stored.push(e),flush(){}},
      {captureBodies:true,maxPrivateRecordBytes:1024,secrets:['xxxx']});
    const report=createPromptReporter({diagnostics:stream,privateDiagnostics:{emit:stream.emitPrivate,flush(){}},
      clock:{now:()=>1,monotonicNow:()=>1},ids:{newId:()=>String(stored.length)},captureBodies:true,promptCaptureMaxBytes:limit});
    const prompt='hey 🧪\n'+'xxxx\n'.repeat(2000);
    report(fixture,'prepared',{},prompt);
    const event=stored[1],d=event.details;
    assert.ok(d.captureSourceBytes<=limit);
    assert.equal(d.captureEndBytes,d.captureSourceBytes);
    assert.equal(d.captureStoredBytes,Buffer.byteLength(d.prompt));
    assert.ok(Buffer.byteLength(JSON.stringify(event)+'\n')<=1024);
    assert.equal(d.captureCompleteness,'unavailable');
    assert.equal(d.captureUnavailableReason,'serialized_record_limit');
    assert.equal(d.prompt,'');
    stream.close();
  }
});
test('C17R UTF-8 partial prefix uses completed lines and off never emits capture',()=>{
  for(const captureBodies of [false,true]){
    const events=[];
    const stream=createEventStream({emit:e=>events.push(e),flush(){}},{captureBodies});
    const report=createPromptReporter({diagnostics:stream,privateDiagnostics:{emit:stream.emitPrivate,flush(){}},
      clock:{now:()=>1,monotonicNow:()=>1},ids:{newId:()=>String(events.length)},captureBodies,promptCaptureMaxBytes:17});
    const prompt='🧪🧪\n'+'🧪🧪\n'+'last';
    report(fixture,'prepared',{},prompt);
    assert.equal(events.length,captureBodies?2:1);
    if(captureBodies){
      assert.equal(events[1].details.prompt,'🧪🧪\n');
      assert.equal(events[1].details.captureSourceBytes,9);
      assert.equal(events[1].details.captureCompleteness,'partial');
    }
    stream.close();
  }
});
test('C17R production diagnostic queue, rotation and retention for large body records',()=>withOwnedRun('C17R-capture-sink',async directory=>{
  const sink=createNdjsonSink({directory,maxFileBytes:90000,retainedFiles:2});
  const stream=createEventStream(sink,{captureBodies:true,maxPrivateRecordBytes:90000,secrets:['fixture-known']});
  const report=createPromptReporter({diagnostics:stream,privateDiagnostics:{emit:stream.emitPrivate,flush(){}},
    clock:{now:()=>1,monotonicNow:()=>1},ids:{newId:()=>randomUUID()},captureBodies:true,promptCaptureMaxBytes:65536});
  for(let n=0;n<8;n++)report({...fixture,attemptId:'capture-'+n},'prepared',{},'fixture-known\n'+'🧪'.repeat(12000));
  await stream.flush();stream.close();
  assert.deepEqual(sink.stats(),{dropped:0,failed:0});
  const files=await readdir(directory);
  assert.equal(files.length,3);
  let captures=0;
  for(const file of files){
    const body=await readFile(join(directory,file),'utf8');
    assert.ok(Buffer.byteLength(body)<=90000);
    assert.ok(!body.includes('fixture-known'));
    for(const event of body.trim().split('\n').map(line=>JSON.parse(line))){
      assert.match(event.attemptId,/capture-\d/);
      if(event.eventName==='adapter.prompt.capture'){
        captures++;assert.equal(event.details.captureStoredBytes,Buffer.byteLength(event.details.prompt));
      }
    }
  }
  assert.ok(captures>0);
}));
test('C17R production sink modes leave operation, concurrent dispatch, budgets and cancellation unchanged',()=>withOwnedRun('C17R-diag-modes',async directory=>{
  let baseline;
  for(const mode of ['noop','off','capture','slow','fail','overflow']){
    const capture=['capture','slow','fail','overflow'].includes(mode);
    const release=Promise.withResolvers(), reached=Promise.withResolvers();
    const warnings=[];
    const sink=mode==='noop'?{emit(){},flush(){}}:createNdjsonSink({
      directory:join(directory,mode),maxFileBytes:131072,retainedFiles:2,
      ...(mode==='overflow'&&{queueMaxBytes:25000,queueSize:2}),
      flushDeadlineMs:mode==='slow'||mode==='overflow'?10:1000,stderr:{write:msg=>warnings.push(msg)},
      ...(mode==='slow'||mode==='overflow'?{writeLine:()=>release.promise}:mode==='fail'?{writeLine:async()=>{throw Error('disk fault');}}:{})
    });
    // Exercise real Application dispatch and native activity through a deterministic
    // ProviderPort. The renderer/reporter are called at that port boundary.
    const stream=createEventStream(sink,{captureBodies:capture,maxPrivateRecordBytes:131072});
    const notices=[];
    stream.subscribe(event=>notices.push(event));
    let id=0;
    const report=createPromptReporter({diagnostics:stream,privateDiagnostics:{emit:stream.emitPrivate,flush(){}},
      clock:{now:()=>1,monotonicNow:()=>1},ids:{newId:()=>String(++id)},captureBodies:capture,promptCaptureMaxBytes:65536});
    const fixtureRun=setup({maxInvocations:4,maxConcurrentInvocations:2,
      emit:event=>stream.emit(event),
      async respond(invocation,count,observe,activity){
        const prompt=renderInvocationPrompt(invocation,'fixture');
        report(invocation,'prepared',{},prompt);
        if(invocation.objective==='cancel me'){
          reached.resolve();await new Promise(resolve=>invocation.signal.addEventListener('abort',resolve,{once:true}));
          return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId,{terminal:'cancelled',effect:'unknown'})};
        }
        activity?.({kind:'reasoning',nativeKind:'agent_thought_chunk',payload:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'fixture activity'}}});
        return final(invocation);
      }});
    try{
      const runs=await Promise.all([fixtureRun.api.submit(request({requestId:'a',text:'Task A '+ '🧪'.repeat(6000)})),
        fixtureRun.api.submit(request({requestId:'b',text:'Task B'}))]);
      const states=await Promise.all(runs.map(run=>run.completion));
      const cancelled=await fixtureRun.api.submit(request({requestId:'c',text:'cancel me'}));
      await reached.promise;
      await fixtureRun.api.cancel(cancelled.operation.operationId,'client');
      const terminal=await cancelled.completion;
      const projection=[...states,terminal].map(s=>({status:s.status,cancellation:s.cancellation,answer:s.assessment?.answer,
        attempts:s.attempts.map(a=>({terminal:a.outcome?.terminal,effect:a.outcome?.effect,dispatch:a.dispatchCertainty})),
        decisions:s.events.filter(e=>e.kind==='controller.responded').length,
        reservations:s.events.filter(e=>e.kind==='attempt.reserved').length}));
      if(!baseline)baseline=projection;else assert.deepEqual(projection,baseline,mode);
      assert.equal(fixtureRun.invocations.length,3);
      assert.ok(notices.every(e=>e.eventName!=='adapter.prompt.capture'));
      await fixtureRun.api.close();
      await stream.flush();
      if(mode==='overflow')assert.ok(sink.stats().dropped>0);
      if(mode==='fail')assert.ok(sink.stats().failed>0);
      if(mode==='off'||mode==='capture'){
        const body=(await Promise.all((await readdir(join(directory,mode))).map(p=>readFile(join(directory,mode,p),'utf8')))).join('');
        assert.equal(body.includes('adapter.prompt.capture'),mode==='capture');
      }
    }finally{release.resolve();stream.close();await fixtureRun.api.close();}
  }
}));
