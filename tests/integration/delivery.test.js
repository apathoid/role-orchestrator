import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createBoundedDelivery } from '../../src/application/delivery.js';
import { createEventStream } from '../../src/application/events.js';
import { createActivityStream } from '../../src/application/activity.js';

test('execution subscribers are bounded, scoped and independent of diagnostic sink', async () => {
  const durable = [], seen = [], other = [];
  const gate = Promise.withResolvers();
  const stream = createEventStream({ emit: event => durable.push(event), flush() {} });
  stream.subscribe(async event => { seen.push(event); await gate.promise; }, { operationId: 'op' });
  stream.subscribe(event => other.push(event), { operationId: 'other' });
  for (let i = 0; i < 1000; i++) stream.emit({ schemaVersion: 1, eventId: String(i), receivedAt: i,
    sequence: i, level: 'info', component: 'fixture', eventName: 'attempt.event', reasonCode: 'fixture', operationId: 'op' });
  await tick();
  assert.equal(durable.length, 1000);
  assert.equal(seen.length, 1);
  gate.resolve();
  await tick();
  assert.equal(other.length, 0);
  assert.equal(seen.at(-1).eventName, 'delivery.gap');
  assert.equal(seen.length - 1 + seen.at(-1).details.droppedCount, 1000);
  assert.ok(seen.length <= 128);
  stream.close();
});

test('oversized activity is represented by a gap and does not consume result capacity', async () => {
  const stream = createActivityStream(), notices = [];
  stream.subscribe({ operationId: 'op' }, event => notices.push(event));
  const emit = stream.bind({ operationId: 'op', attemptId: 'a', profileId: 'p', providerId: 'x' }, () => true);
  emit({ kind: 'reasoning', payload: 'x'.repeat(1024 * 1024 + 1) });
  await tick();
  emit({ kind: 'reasoning', payload: 'after' });
  await tick();
  assert.equal(notices[0].kind, 'gap');
  assert.equal(notices[0].droppedCount, 1);
  assert.equal(notices[1].payload, 'after');
  stream.close();
});

test('C13R.3 normal finish drains queued native events and overflow gap in order',async()=>{
  const seen=[],gate=Promise.withResolvers();
  const delivery=createBoundedDelivery(async x=>{seen.push(x);if(x===1)await gate.promise;},(prior)=>({gap:(prior?.gap??0)+1}));
  delivery.enqueue(1,1);await tick();
  for(let i=2;i<=140;i++)delivery.enqueue(i,1);
  const finishing=delivery.finish();delivery.enqueue(999,1);gate.resolve();
  assert.equal(await finishing,0);
  assert.equal(seen[0],1);assert.equal(seen.at(-1).gap,13);
  assert.equal(seen.includes(999),false);
});
test('C13R.3 blocked consumer finish is finite; close interrupts without late queued calls',async()=>{
  for(const immediate of [false,true]){
    const seen=[],gate=Promise.withResolvers();
    const d=createBoundedDelivery(async x=>{seen.push(x);await gate.promise;},()=>({gap:1}));
    d.enqueue(1,1);d.enqueue(2,1);await tick();
    const result=d.finish(20);if(immediate)d.close();
    assert.equal(await result,2);gate.resolve();await tick();
    assert.deepEqual(seen,[1]);
  }
});
test('C13R.3 activity subscription finish delivers completion before terminal view',async()=>{
  const stream=createActivityStream(),seen=[],gate=Promise.withResolvers();
  const sub=stream.subscribe({operationId:'op'},async e=>{seen.push(e.payload);if(e.payload==='start')await gate.promise;});
  const emit=stream.bind({operationId:'op',attemptId:'a',profileId:'p',providerId:'p'},()=>true);
  emit({kind:'tool',payload:'start'});await tick();emit({kind:'tool',payload:'completed'});emit({kind:'reasoning',payload:'last'});
  const finish=sub.finish();gate.resolve();assert.equal(await finish,0);
  seen.push('final');assert.deepEqual(seen,['start','completed','last','final']);stream.close();
});

test('C14R.4 scoped execution carries committed findings without diagnostic sink or unscoped body',async()=>{
  const sink=[],unscoped=[],scoped=[];
  const stream=createEventStream({emit:e=>sink.push(e),flush(){}});
  stream.subscribe((event,findings)=>unscoped.push({event,findings}));
  const sub=stream.subscribe((event,findings)=>scoped.push({event,findings}),{operationId:'op'});
  const finding={findingId:'f',author:'p',claim:'model finding',subject:'file',supports:[],uncertainties:[]};
  stream.emit({schemaVersion:1,eventId:'e',receivedAt:1,sequence:1,level:'info',component:'core',eventName:'attempt.outcome',reasonCode:'COMPLETED',operationId:'op'},[finding]);
  finding.claim='mutated';await sub.finish();await tick();
  assert.equal(scoped[0].findings[0].claim,'model finding');
  assert.equal(unscoped[0].findings,undefined);
  assert.equal(JSON.stringify(sink).includes('model finding'),false);
  stream.close();
});

test('C13R.3 failed consumer callbacks are unconfirmed, not successful delivery',async()=>{
  const delivery=createBoundedDelivery(async()=>{throw Error('transport closed');},()=>({gap:1}));
  delivery.enqueue(1,1);delivery.enqueue(2,1);
  assert.equal(await delivery.finish(),2);
});
