import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliTools } from '../../src/hosts/cli-tools.js';
const tool=(payload,sequence=1,attemptId='a',nativeId='x')=>({kind:'tool',operationId:'op',attemptId,profileId:'p',providerId:'fixture',sequence,nativeId,nativeKind:payload.sessionUpdate??'tool_call_update',payload});
test('C15R.1 sparse native tool identity, distinct modes, no invented terminal',()=>{
  const events=[tool({title:'shell',kind:'execute',status:'pending'},1),tool({title:'git show HEAD',status:'in_progress'},2),tool({title:'git show HEAD',status:'in_progress'},3),tool({status:'completed'},4)];
  for(const [mode,count] of [['compact',2],['detailed',3],['debug',4]]){
    const projection=createCliTools(),lines=events.map(e=>projection.accept(e,mode)).filter(Boolean);
    assert.equal(lines.length,count,mode);assert.match(lines.at(-1).text,mode==='debug'?/git show HEAD · completed/:/\[T1\] · completed/);
    assert.ok(!lines.some(l=>l.text.includes('tool_call_update ·')));
    assert.equal(events[3].payload.title,undefined);
  }
});
test('C15R.1 scope, gaps, late/conflicting updates, unknown IDs and bounded eviction',()=>{
  const p=createCliTools();
  assert.match(p.accept(tool({title:'one',status:'in_progress'},1),'compact').text,/one/);
  assert.match(p.accept(tool({title:'two',status:'in_progress'},1,'b'),'compact').text,/two/);
  assert.match(p.accept(tool({status:'completed'},2),'compact').text,/\[T1\] · completed/);
  assert.match(p.accept(tool({status:'failed'},3),'compact').text,/conflicting status report/);
  assert.match(p.accept(tool({status:'in_progress'},1),'compact').text,/out-of-order report/);
  assert.match(p.accept(tool({status:'completed'},2,'b'),'compact').text,/\[T2\] · completed/);
  const absent={...tool({title:'same',status:'in_progress'}),nativeId:undefined};
  assert.ok(p.accept(absent,'compact'));assert.ok(p.accept(absent,'compact'));
  p.clear();assert.match(p.accept(tool({status:'completed'},5),'compact').text,/earlier details unavailable/);
  for(let i=0;i<150;i++)p.accept(tool({title:'large '+ 'x'.repeat(6000),status:'in_progress'},1,'a','id'+i),'compact');
  assert.match(p.accept(tool({status:'completed'},2,'a','id0'),'compact').text,/earlier details unavailable/);
});


test('C15R.1 null optional ACP fields do not erase earlier title; absent native identity remains visible',()=>{
  const p=createCliTools();
  p.accept(tool({title:'Read file',status:'in_progress'},1),'compact');
  assert.match(p.accept(tool({title:null,status:'completed'},2),'compact').text,/\[T1\] · completed/);
  const anonymous={...tool({title:'shell',kind:'execute',status:'pending'}),nativeId:undefined};
  assert.match(p.accept(anonymous,'compact').text,/shell · pending/);
});


test('C15R Codex item completion without status is displayed as report, not fabricated success',()=>{
  const p=createCliTools();
  const initial={...tool({item:{type:'command_execution',command:'git status',status:'in_progress'}},1),nativeKind:'item.started'};
  assert.match(p.accept(initial,'compact').text,/command_execution · git status · in_progress/);
  const completion={...initial,sequence:2,nativeKind:'item.completed',payload:{item:{type:'command_execution'}}};
  const line=p.accept(completion,'compact');
  assert.match(line.text,/\[T1\] · item completion reported \(status not supplied; last status=in_progress\)/);
  assert.doesNotMatch(line.text,/^✓/);
  assert.equal(p.accept({...completion,sequence:3},'compact'),undefined);
  assert.match(p.accept({...initial,sequence:4},'compact').text,/conflicting status report/);
});


test('C15R.6.4 same-title independent tools keep distinct local aliases, terminal details are not repeated',()=>{
  const view=createCliTools();
  const first=view.accept(tool({title:'Read same file',status:'in_progress'},1,'a','native-a'),'compact');
  const second=view.accept(tool({title:'Read same file',status:'in_progress'},2,'a','native-b'),'compact');
  const done=view.accept(tool({status:'completed'},3,'a','native-a'),'compact');
  assert.match(first.text,/\[T1\] Read same file/);assert.match(second.text,/\[T2\] Read same file/);
  assert.match(done.text,/\[T1\] · completed/);assert.doesNotMatch(done.text,/Read same file/);
  view.clear();
  const fresh=view.accept(tool({status:'failed'},4,'a','native-a'),'compact');
  assert.match(fresh.text,/\[T3\] Tool \(earlier details unavailable\)/);
  const unknown={...tool({title:'Read same file',status:'in_progress'},5,'a','native-c'),nativeId:undefined};
  assert.match(view.accept(unknown,'compact').text,/Read same file/);
  assert.match(view.accept(unknown,'compact').text,/Read same file/);
});


test('C15R.6R.3 compact shows genuine native locations and description, but not repeat long details',()=>{
  const p=createCliTools();
  const first=p.accept(tool({title:'Read',kind:'read',status:'in_progress',
    locations:[{path:'src/editor/one.js',line:8}],description:'source tree file'},1,'a','call1'),'compact');
  const other=p.accept(tool({title:'Read',kind:'read',status:'in_progress',
    locations:[{path:'src/editor/two.js'}],description:'another file'},2,'a','call2'),'compact');
  assert.match(first.text,/src\/editor\/one.js:8/);
  assert.match(first.text,/source tree file/);
  assert.match(other.text,/src\/editor\/two.js/);
  const complete=p.accept(tool({status:'completed'},3,'a','call1'),'compact');
  assert.match(complete.text,/\[T1\] · completed/);
  assert.doesNotMatch(complete.text,/editor\/one|source tree/);
  const missing=p.accept({...tool({title:'Read',status:'in_progress'},4,'a','call3'),nativeId:undefined},'compact');
  assert.doesNotMatch(missing.text,/\[T\d+\]/);
});
