import assert from 'node:assert/strict';
import { test } from 'node:test';
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
    assert.equal(updates.filter(u=>u._meta?.roleOrchestratorSource?.eventName==='operation.finished').length,120);
  }
  t.diagnostic('C15_HISTORY '+JSON.stringify({turns:120,passes:3,answerCodeUnits:big.length,elapsedMs:timings}));
  const stop=new AbortController();let reads=0,emitted=0;
  await replayHistory(session,async()=>{reads++;return A;},async()=>{emitted++;stop.abort();},'compact','inline',stop.signal);
  assert.equal(emitted,1);assert.equal(reads,1);
});
