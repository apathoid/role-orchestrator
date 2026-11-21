import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOperation, applyEvent } from '../../src/core/operation.js';
import { historicalOutcomeReports } from '../../src/core/snapshot.js';
import { request, outcome } from '../fixtures/core.js';
import { replayHistory, historicalReply, responseBoundary, operationRequestId } from '../../src/hosts/acp-history.js';

const id=r=>operationRequestId('session',r);
const assessment=answer=>({author:'p',overall:'complete',answer,requirements:[],observationRefs:[],findingRefs:[],unresolvedQuestions:[]});
const event=(operationId,eventId,kind,fields)=>({operationId,eventId,kind,receivedAt:0,...fields});
function operation(operationId,requestId,text,events){
  return {operationId,request:{requestId:id(requestId),text},events,attempts:[],status:'finished',assessment:assessment('latest')};
}
const entry=(requestId,operationId,responseEventId)=>({requestId,operationId,responseEventId,fingerprint:'fixture'});
const plain=updates=>updates.filter(u=>!u._meta?.roleOrchestratorSource).map(u=>u.content.text);

test('C15.5 recovered history associates background facts with A, not B; legacy ambiguity never guesses',async()=>{
  const A=operation('A','a1','A initial',[
    event('A','question','operation.waiting',{waiting:{kind:'question',questionId:'q',question:'A question'}}),
    event('A','background','operation.recovered',{}),
    event('A','technical','operation.waiting',{waiting:{kind:'technical',reason:{code:'RESOURCE_LIMIT'}}}),
    event('A','continue','operation.continued',{input:{requestId:id('a2'),text:'A follow-up'}}),
    event('A','answer','operation.finished',{assessment:assessment('A result')}),
  ]);
  const B=operation('B','b','B initial',[event('B','b-answer','operation.finished',{assessment:assessment('B result')})]);
  assert.equal(historicalReply(A,id('a1')),undefined);
  assert.equal(historicalReply(A,id('a1'),'answer'),undefined);
  assert.equal(historicalReply(A,id('a1'),'question').reply.text,'A question');
  assert.equal(responseBoundary(A,id('a2')),'answer');
  const updates=[],reads=[];
  const session={sessionId:'session',cwd:'/tmp',operations:['A','B'],requests:[entry('a1','A','question'),entry('b','B','b-answer'),entry('a2','A','answer')]};
  await replayHistory(session,async operationId=>{reads.push(operationId);return operationId==='A'?A:B;},async u=>updates.push(u),'compact','inline');
  assert.deepEqual(plain(updates),['A initial','A question','B initial','B result','A follow-up','A result']);
  const recovered=updates.find(u=>u._meta?.roleOrchestratorSource?.eventId==='technical');
  assert.equal(recovered._meta.roleOrchestratorSource.operationId,'A');
  assert.equal(recovered._meta.roleOrchestratorSource.recovered,true);
  assert.ok(updates.indexOf(recovered)>updates.findIndex(u=>u.content?.text==='B result'));
  assert.ok(updates.indexOf(recovered)<updates.findIndex(u=>u.content?.text==='A follow-up'));
  assert.deepEqual(reads,['A','B','A']);
  const legacy=[];
  await replayHistory({...session,requests:[entry('a1','A',undefined)]},async()=>A,async u=>legacy.push(u),'compact','inline');
  assert.deepEqual(plain(legacy),['A initial']);
  assert.ok(legacy.some(u=>u.content?.text.includes('Historical response boundary unavailable')));
});

test('C15.6 large repeated history streams exact Unicode, stops on disconnect and preserves bounded snapshot reads',async t=>{
  const big='😀'.repeat(40000),events=[],requests=[];
  for(let i=0;i<120;i++){
    if(i)events.push(event('A','c'+i,'operation.continued',{input:{requestId:id('r'+i),text:'turn '+i}}));
    events.push(event('A','f'+i,'operation.finished',{assessment:assessment(i===119?big:'answer '+i)}));
    requests.push(entry('r'+i,'A','f'+i));
  }
  const A=operation('A','r0','turn 0',events);
  const session={sessionId:'session',cwd:'/tmp',operations:['A'],requests};
  const timings=[];
  for(let pass=0;pass<3;pass++){
    let reads=0;const updates=[];const start=performance.now();
    await replayHistory(session,async()=>{reads++;return A;},async u=>updates.push(u),'compact','inline');
    timings.push(performance.now()-start);
    assert.equal(reads,1);
    const raw=plain(updates);assert.equal(raw.at(-2)+raw.at(-1),big);
    assert.equal(raw.filter(s=>s.startsWith('turn ')).length,120);
    assert.equal(updates.filter(u=>u._meta?.roleOrchestratorSource?.eventName==='operation.finished').length,0);
    assert.equal(raw.filter(text=>text.startsWith('answer ')).length,119);
  }
  t.diagnostic('C15_HISTORY '+JSON.stringify({turns:120,passes:3,answerCodeUnits:big.length,elapsedMs:timings}));
  const stop=new AbortController();let reads=0,emitted=0;
  await replayHistory(session,async()=>{reads++;return A;},async()=>{emitted++;stop.abort();},'compact','inline',stop.signal);
  assert.equal(emitted,1);assert.equal(reads,1);
});


test('C15R.4 historical classifications match actual applied ordinary, late and conflicting reports',async()=>{
  let state=createOperation('A',request({requestId:id('r')}),'authority',{maxInvocations:4,maxConcurrentInvocations:2},0);
  const diagnostics=[];
  const commit=(eventId,kind,fields)=>{
    const transition=applyEvent(state,event('A',eventId,kind,fields));
    assert.equal(transition.kind,'applied',eventId);
    state=transition.state;diagnostics.push(transition.diagnostic);
  };
  const reserve=attemptId=>{
    commit('reserve-'+attemptId,'attempt.reserved',{attemptId,actionId:attemptId});
    commit('dispatch-'+attemptId,'attempt.dispatched',{attemptId,route:{profileId:'p',providerId:'fixture',model:'m',configurationRef:'test-config'}});
  };
  reserve('a');reserve('b');
  commit('ordinary','attempt.outcome',{outcome:outcome('a'),dispatchCertainty:'sent'});
  commit('cancel','operation.cancelled',{source:'client'});
  commit('late','attempt.outcome',{outcome:outcome('b',{terminal:'unknown',effect:'unknown'}),dispatchCertainty:'unknown'});
  commit('enrich','attempt.outcome',{outcome:outcome('b',{terminal:'completed',effect:'confirmed'}),dispatchCertainty:'sent',late:true});
  commit('conflict','attempt.outcome',{outcome:outcome('b',{terminal:'failed',effect:'none'}),dispatchCertainty:'sent',late:true});
  const duplicate=applyEvent(state,event('A','duplicate','attempt.outcome',{outcome:outcome('b',{terminal:'completed',effect:'confirmed'}),dispatchCertainty:'sent',late:true}));
  assert.equal(duplicate.kind,'duplicate');
  const reports=historicalOutcomeReports(state);
  for(const name of ['ordinary','late','enrich','conflict']){
    const d=diagnostics.find(item=>item.eventId===name);
    assert.deepEqual(reports.get(name),{eventName:d.eventName,reasonCode:d.reasonCode});
  }
  assert.equal(reports.get('conflict').eventName,'attempt.outcome_discrepancy');
  const session={sessionId:'session',cwd:'/tmp',operations:['A'],requests:[entry('r','A','cancel')]};
  const updates=[];
  await replayHistory(session,async()=>state,async u=>updates.push(u),'detailed','inline');
  for(const name of ['ordinary','late','enrich','conflict']){
    const u=updates.find(item=>item._meta?.roleOrchestratorSource?.eventId===name);
    assert.equal(u._meta.roleOrchestratorSource.eventName,reports.get(name).eventName);
    assert.equal(u._meta.roleOrchestratorSource.reasonCode,reports.get(name).reasonCode);
    assert.equal(u._meta.roleOrchestratorSource.recovered,true);
  }
  assert.match(updates.find(u=>u._meta?.roleOrchestratorSource?.eventId==='conflict').content.text,/Outcome discrepancy/);
  const legacy={...state,revision:state.revision+1};const fallback=[];
  await replayHistory(session,async()=>legacy,async u=>fallback.push(u),'detailed','inline');
  assert.match(fallback.find(u=>u._meta?.roleOrchestratorSource?.eventId==='ordinary').content.text,/Historical outcome report/);
});


test('C15R.6.5 missing initial and intermittent continuations are attributed, never fabricated as session user turns',async()=>{
  const A=operation('A','a0','orphan first',[
    event('A','old-finished','operation.finished',{assessment:assessment('not for a1')}),
    event('A','start1','operation.continued',{input:{requestId:id('a1'),text:'associated A1'}}),
    event('A','answer1','operation.finished',{assessment:assessment('answer A1')}),
    event('A','start2','operation.continued',{input:{requestId:id('a2'),text:'orphan middle'}}),
    event('A','orphan-done','operation.finished',{assessment:assessment('not for a3')}),
    event('A','start3','operation.continued',{input:{requestId:id('a3'),text:'associated A3'}}),
    event('A','answer3','operation.finished',{assessment:assessment('answer A3')}),
  ]);
  const B=operation('B','b0','unrelated orphan',[
    event('B','b-work','operation.recovered',{}),
    event('B','b-end','operation.finished',{assessment:assessment('unknown session reply')}),
  ]);
  const records=[entry('a1','A','answer1'),entry('a3','A','answer3')];
  const session={sessionId:'session',cwd:'/tmp',operations:['A','B'],requests:records};
  const updates=[],reads=[];
  await replayHistory(session,async id=>{reads.push(id);return id==='A'?A:B;},async u=>updates.push(u),'compact','inline');
  assert.deepEqual(plain(updates),['associated A1','answer A1','associated A3','answer A3']);
  const meta=updates.filter(u=>u._meta?.roleOrchestratorSource?.source==='history');
  assert.ok(meta.some(u=>u.content.text.includes('orphan first')));
  assert.ok(meta.some(u=>u.content.text.includes('orphan middle')));
  assert.ok(meta.some(u=>u.content.text.includes('unrelated orphan')));
  assert.ok(meta.every(u=>u._meta.roleOrchestratorSource.recovered));
  assert.ok(!updates.some(u=>u.sessionUpdate==='user_message_chunk'&&/orphan/.test(u.content.text)));
  assert.ok(!updates.some(u=>u.sessionUpdate==='agent_message_chunk'&&!u._meta?.roleOrchestratorSource&&/not for|unknown session reply/.test(u.content.text)));
  assert.deepEqual(reads,['A','B']); // one full snapshot at a time
  const stop=new AbortController();const partial=[];
  await replayHistory(session,async()=>A,async u=>{partial.push(u);stop.abort();},'compact','inline',stop.signal);
  assert.equal(partial.length,1);
});


test('C15R.6R.4 inline/notices replay the same known orphan continuations without inventing turns',async()=>{
  const A=operation('A','a0','orphan initial',[
    event('A','wait0','operation.waiting',{waiting:{kind:'question',question:'unattributed'}}),
    event('A','c1','operation.continued',{input:{requestId:id('a1'),text:'associated a1'}}),
    event('A','f1','operation.finished',{assessment:assessment('answer a1')}),
    event('A','c2','operation.continued',{input:{requestId:id('a2'),text:'orphan a2'}}),
    event('A','f2','operation.finished',{assessment:assessment('not associated')}),
    event('A','c3','operation.continued',{input:{requestId:id('a3'),text:'associated a3'}}),
    event('A','f3','operation.finished',{assessment:assessment('answer a3')}),
    event('A','c4','operation.continued',{input:{requestId:id('a4'),text:'orphan trailing'}}),
  ]);
  const session={sessionId:'session',cwd:'/tmp',operations:['A'],
    requests:[entry('a1','A','f1'),entry('a3','A','f3')]};
  for(const display of ['inline','notices']){
    for(let pass=0;pass<2;pass++){
      let reads=0;const updates=[];
      await replayHistory(session,async()=>{reads++;return A;},async update=>updates.push(update),'compact',display);
      assert.equal(reads,1);
      assert.deepEqual(plain(updates),['associated a1','answer a1','associated a3','answer a3']);
      const recovered=updates.filter(u=>u._meta?.roleOrchestratorSource?.source==='history'&&
        u.content?.text?.includes('Recovered '));
      for(const phrase of ['orphan initial','orphan a2','orphan trailing']){
        assert.equal(recovered.filter(x=>x.content.text.includes(phrase)).length,1,display+' '+phrase);
      }
      assert.ok(recovered.every(u=>u._meta.roleOrchestratorSource.recovered));
      assert.ok(!updates.some(u=>u.sessionUpdate==='user_message_chunk'&&u.content.text.includes('orphan')));
      assert.ok(!updates.some(u=>u.sessionUpdate==='agent_message_chunk'&&!u._meta?.roleOrchestratorSource&&
        u.content.text.includes('not associated')));
    }
  }
});

test('R2F-A121 replayHistory retains partial/unresolved model assessments, Markdown and stable no-duplicate turns',async()=>{
  const original='### Assessment answer\n**model** [link](https://example.test) 🌍';
  const items=[
    {id:'complete',overall:'complete',answer:original},
    {id:'partial',overall:'partial',answer:original},
    {id:'unresolved',overall:'unresolved',answer:original},
    {id:'no-answer',overall:'partial',answer:''},
  ];
  const operations=new Map(items.map(item=>[item.id,operation(item.id,item.id,'Ask '+item.id,[
    event(item.id,'finished-'+item.id,'operation.finished',{assessment:{
      ...assessment(item.answer),overall:item.overall,
    }}),
  ])]));
  const session={sessionId:'session',cwd:'/tmp',operations:[...operations.keys()],
    requests:items.map(item=>entry(item.id,item.id,'finished-'+item.id))};
  const all=[];
  for(let pass=0;pass<2;pass++){
    const updates=[];
    await replayHistory(session,async id=>operations.get(id),async update=>updates.push(update),'compact','inline');
    all.push(updates);
    for(const item of items){
      const progress=updates.filter(update=>update._meta?.roleOrchestratorSource?.eventId==='finished-'+item.id);
      assert.equal(progress.length,item.id==='complete'?0:1,item.id);
      if(progress.length){
        assert.match(progress[0].content.text,new RegExp('overall='+item.overall));
        assert.equal(progress[0]._meta.roleOrchestratorSource.recovered,true);
        assert.equal(progress[0]._meta.roleOrchestratorSource.operationId,item.id);
        if(!item.answer)assert.match(progress[0].content.text,/no final answer text available/);
      }
      const replies=updates.filter(update=>!update._meta?.roleOrchestratorSource &&
        update.sessionUpdate==='agent_message_chunk'&&update.content.text===item.answer);
      if(item.answer)assert.equal(replies.length,3,'all three identical original answers are unchanged');
      else assert.equal(replies.length,1,'empty answer is reproduced once');
    }
    assert.deepEqual(plain(updates),items.flatMap(item=>['Ask '+item.id,item.answer]));
    assert.equal(updates.filter(update=>update.sessionUpdate==='plan'||update.sessionUpdate==='agent_thought_chunk'||update.sessionUpdate==='tool_call').length,0);
  }
  assert.deepEqual(all[1],all[0]);
});
