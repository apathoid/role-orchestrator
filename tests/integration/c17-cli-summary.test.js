import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cliPresentation} from '../../src/hosts/cli-presentation.js';

const notice=(name,fact,reasonCode='CANCELLED',id='terminal')=>({channel:'execution',
  event:{schemaVersion:1,eventId:id,eventName:name,operationId:'op',sequence:1,receivedAt:1,level:'info',reasonCode},
  fact:{journalEventId:id,operationId:'op',kind:name,...fact}});
const state=(event,extra={})=>({operationId:'op',status:event.kind==='operation.cancelled'?'cancelled':'waiting',
  attempts:[],limits:{maxInvocations:4},events:[{eventId:'terminal',operationId:'op',...event}],...extra});
for(const kind of ['cancelled','waiting']){
  test('C17.7 equivalent compact '+kind+' summary; new late facts remain visible',async()=>{
    const lines=[],renderer=cliPresentation('compact',async value=>{lines.push(typeof value==='string'?value:value.map(v=>v.text).join(''));});
    const cancellation=kind==='cancelled';
    const waiting={kind:'technical',reason:{code:'DEADLINE_EXCEEDED',operationId:'op'}};
    if(cancellation)await renderer.notice(notice('attempt.cancel_requested',{attemptId:'a',cancellation:'client'},'CANCELLED','cancel-request'));
    await renderer.notice(notice('operation.'+kind,cancellation?{cancellation:'client',unsettledAttempts:1}:{waitingKind:'technical'},
      cancellation?'CANCELLED':'DEADLINE_EXCEEDED'));
    assert.doesNotMatch(lines.join('\n'),/Operation cancelled|Operation waiting/);
    const final=state(cancellation?{kind:'operation.cancelled',source:'client'}:{kind:'operation.waiting',waiting},
      cancellation?{cancellation:'client'}:{waiting});
    renderer.finish(final);renderer.finish(final);
    assert.equal((lines.join('\n').match(cancellation?/Operation cancelled/g:/Operation waiting/g)??[]).length,1);
    if(cancellation){assert.match(lines.join('\n'),/Cancellation requested/);assert.match(lines.join('\n'),/Cancellation recorded · source=client · unsettled attempts: 1/);}
    assert.doesNotMatch(lines.join('\n'),/Unknown effects\/outcomes remain/);
    await renderer.notice({...notice('attempt.outcome',{attemptId:'a',terminal:'unknown',effect:'unknown',late:true},'PROVIDER_ERROR','late'),
      event:{...notice('attempt.outcome',{},'PROVIDER_ERROR','late').event,eventName:'attempt.late_outcome'}});
    assert.match(lines.join('\n'),/Late outcome recorded/);
    assert.match(lines.join('\n'),/reported effect=unknown/);
    renderer.close();
  });
}
test('C17.7 unmatched or disconnected terminal facts are not suppressed; detailed/debug unchanged',async()=>{
  for(const mode of ['compact','detailed','debug']){
    const lines=[],renderer=cliPresentation(mode,async value=>{lines.push(value);});
    await renderer.notice(notice('operation.cancelled',{cancellation:'client'}));
    renderer.close();
    assert.match(lines.join('\n'),mode==='debug'?/operation.cancelled/:/Operation cancelled/);
  }
  const lines=[],renderer=cliPresentation('compact',async value=>{lines.push(value);});
  const waiting={kind:'technical',reason:{code:'DEADLINE_EXCEEDED',operationId:'op'}};
  await renderer.notice(notice('operation.waiting',{waitingKind:'technical'},'DEADLINE_EXCEEDED'));
  await renderer.notice(notice('operation.continued',{},'USER_INPUT','continue'));
  renderer.finish(state({kind:'operation.waiting',waiting},{status:'finished',assessment:{overall:'partial',answer:'original'},waiting:undefined}));
  assert.match(lines.join('\n'),/Operation waiting.*DEADLINE_EXCEEDED/);
  assert.match(lines.join('\n'),/Operation partial/);
  renderer.close();
});
