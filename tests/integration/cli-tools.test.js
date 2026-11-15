import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliTools } from '../../src/hosts/cli-tools.js';
const tool=(payload,sequence=1,attemptId='a',nativeId='x')=>({kind:'tool',operationId:'op',attemptId,profileId:'p',providerId:'fixture',sequence,nativeId,nativeKind:payload.sessionUpdate??'tool_call_update',payload});
test('C15R.1 sparse native tool identity, distinct modes, no invented terminal',()=>{
  const events=[tool({title:'shell',kind:'execute',status:'pending'},1),tool({title:'git show HEAD',status:'in_progress'},2),tool({title:'git show HEAD',status:'in_progress'},3),tool({status:'completed'},4)];
  for(const [mode,count] of [['compact',2],['detailed',3],['debug',4]]){
    const projection=createCliTools(),lines=events.map(e=>projection.accept(e,mode)).filter(Boolean);
    assert.equal(lines.length,count,mode);assert.match(lines.at(-1).text,/git show HEAD · completed/);
    assert.ok(!lines.some(l=>l.text.includes('tool_call_update ·')));
    assert.equal(events[3].payload.title,undefined);
  }
});
test('C15R.1 scope, gaps, late/conflicting updates, unknown IDs and bounded eviction',()=>{
  const p=createCliTools();
  assert.match(p.accept(tool({title:'one',status:'in_progress'},1),'compact').text,/one/);
  assert.match(p.accept(tool({title:'two',status:'in_progress'},1,'b'),'compact').text,/two/);
  assert.match(p.accept(tool({status:'completed'},2),'compact').text,/one · completed/);
  assert.match(p.accept(tool({status:'failed'},3),'compact').text,/conflicting status report/);
  assert.match(p.accept(tool({status:'in_progress'},1),'compact').text,/out-of-order report/);
  assert.match(p.accept(tool({status:'completed'},2,'b'),'compact').text,/two · completed/);
  const absent={...tool({title:'same',status:'in_progress'}),nativeId:undefined};
  assert.ok(p.accept(absent,'compact'));assert.ok(p.accept(absent,'compact'));
  p.clear();assert.match(p.accept(tool({status:'completed'},5),'compact').text,/earlier details unavailable/);
  for(let i=0;i<150;i++)p.accept(tool({title:'large '+ 'x'.repeat(6000),status:'in_progress'},1,'a','id'+i),'compact');
  assert.match(p.accept(tool({status:'completed'},2,'a','id0'),'compact').text,/earlier details unavailable/);
});
