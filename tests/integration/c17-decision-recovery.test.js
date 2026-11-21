import assert from 'node:assert/strict';
import {test} from 'node:test';
import {controllerContext, operationHistory} from '../../src/application/controller-context.js';
import {parseDecisionText} from '../../src/adapters/invocation-prompt.js';
import {decodeSnapshot, encodeSnapshot} from '../../src/core/snapshot.js';
import {setup, final} from '../fixtures/application.js';
import {request} from '../fixtures/core.js';

const errorOf = invocation => invocation.context.find(item => item.ref === 'host:decision-error')?.value;
const historyOf = invocation => invocation.context.find(item => item.ref === 'host:invocation-context').value.decisionRecovery;

for (const kind of ['malformed', 'parsed', 'structured', 'bad-ref', 'conflict', 'tiny-budget', 'mismatch', 'non_object', 'depth', 'admission', 'wrong-kind', 'wrong-source', 'truncated', 'large']) {
  test('C17.2 declared result correlation: ' + kind, async () => {
    let declaredRef, independentRef, raw, fetched;
    const {api, invocations, respondErrors} = setup({
      ...(kind === 'tiny-budget' && {context:{controllerMaxBytes:1024}}),
      ...(kind === 'large' && {context:{controllerMaxBytes:8192,fetchMaxBytes:65536}}),
      async respond(invocation, count, observe) {
        if (count === 2) {
          const record = errorOf(invocation)?.result;
          if (record?.ref) fetched = await invocation.contextAccess.fetch(record.ref);
          return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
        }
        if (count === 3) return final(invocation);
        const reply = final(invocation);
        const invalid = {...reply.output,schemaVersion:2};
        if (kind === 'structured' || kind === 'tiny-budget') return {...reply,output:invalid};
        raw = kind === 'parsed' || kind === 'mismatch' ? JSON.stringify(invalid) :
          kind === 'non_object' ? JSON.stringify('not an object') :
          kind === 'depth' ? '['.repeat(18)+'0'+']'.repeat(18) :
          kind === 'admission' ? JSON.stringify({...reply.output,operationId:'different-operation'}) :
          kind === 'large' ? '# Draft '+ 'x'.repeat(30000) : '# Invalid JSON 🧪';
        independentRef = observe({kind:'model',sourceId:'progress',ref:'progress',completeness:'complete',value:raw});
        declaredRef = observe({kind:'model',sourceId:'final',ref:'actual',completeness:kind==='truncated'?'truncated':'complete',value:raw});
        if(kind === 'conflict') observe({kind:'model',sourceId:'final',ref:'actual',completeness:'complete',value:'inconsistent'});
        return {...reply,...parseDecisionText(raw),...(kind==='mismatch'&&{output:{...invalid,schemaVersion:3}}),
          // Explicit adapter attestation only when parser and source share the same message.
          ...(['parsed','non_object','admission'].includes(kind)&&{outputObservationParsed:true}),
          outputObservationRef:kind==='bad-ref' ? 'unknown-ref' : declaredRef,
          outcome:{...reply.outcome,outputRefs:[independentRef,declaredRef].map(ref=>({ref,
            kind:ref===declaredRef&&kind==='wrong-kind'?'tool_exit':'output',
            source:ref===declaredRef&&kind==='wrong-source'?'provider_reported':'model_claim'}))}};
      },
    });
    try {
      const state = await (await api.submit(request())).completion;
      assert.equal(state.status,'finished',respondErrors.map(String).join('\n'));
      const event = state.events.find(item=>item.kind==='controller.invalid_proposal');
      const original = ['malformed','parsed','non_object','depth','admission','large'].includes(kind);
      assert.deepEqual(event.result,{ref:original ? declaredRef : 'controller-output:'+event.attemptId,
        representation:original?'reported_text':'declared_value'});
      const error = errorOf(invocations[1]);
      assert.equal(error.result.ref,event.result.ref);
      assert.equal(error.result.storedCompleteness,'complete');
      assert.equal(error.result.retrieval,'bounded_context_request');
      if(kind==='tiny-budget') assert.equal(error.result.inline,'omitted');
      else if(kind==='large') assert.equal(error.result.inline,'excerpt');
      else assert.equal(error.result.inline,'complete');
      assert.equal(fetched.kind,'available');
      if(original) {
        assert.notEqual(event.result.ref,independentRef);
        assert.equal(fetched.item.value,raw);
        assert.equal(invocations[1].context.filter(item=>item.ref===declaredRef).length,1);
      }
      assert.equal(event.category, kind==='admission'?'admission_invalid':kind==='non_object'||kind==='depth'?kind:
        ['parsed','structured','tiny-budget','mismatch'].includes(kind)?'schema_invalid':'invalid_json');
      assert.equal(historyOf(invocations[1]).lastRejection.active,true);
      assert.equal(historyOf(invocations[2]).lastRejection.active,false);
      assert.equal(historyOf(invocations[2]).totalRejected,1);
      assert.equal(errorOf(invocations[2]),undefined);
      assert.equal(decodeSnapshot(encodeSnapshot(state)).kind,'accepted');
      const wrong = structuredClone(state);
      wrong.events.find(item=>item.kind==='controller.invalid_proposal').result.ref='unknown-ref';
      assert.throws(()=>encodeSnapshot(wrong));
      const legacy = structuredClone(state);
      delete legacy.events.find(item=>item.kind==='controller.invalid_proposal').result;
      assert.equal(decodeSnapshot(encodeSnapshot(legacy)).kind,'accepted');
    } finally {await api.close();}
  });
}

test('C17R recovery reserve precedes default work previews and chronological projection survives priority',async()=>{
  let rejectedRef;
  const {api,invocations}=setup({maxInvocations:24,async respond(invocation,count,observe){
    if(count<=12)return final(invocation,{finalAssessment:undefined,nextController:{continue:true}});
    if(count===13){
      const raw='draft-'+ 'z'.repeat(8000);
      rejectedRef=observe({kind:'model',sourceId:'final',ref:'rejected',completeness:'complete',value:raw});
      const reply=final(invocation);
      return {...reply,...parseDecisionText(raw),outputObservationRef:rejectedRef,
        outcome:{...reply.outcome,outputRefs:[{ref:rejectedRef,kind:'output',source:'model_claim'}]}};
    }
    return final(invocation);
  }});
  try{
    const state=await (await api.submit(request())).completion;
    assert.equal(state.status,'finished');
    const rejectionIndex=state.events.findIndex(e=>e.kind==='controller.invalid_proposal');
    const rejection=state.events[rejectionIndex];
    // Synthetic projection of durable journal prefix, with a later observed receipt.
    const prefix={...state,events:state.events.slice(0,rejectionIndex+1),revision:rejectionIndex+1};
    const later={...prefix.events.findLast(e=>e.kind==='attempt.outcome'),late:true,eventId:'later-receipt',
      observations:[{ref:'later-a',source:'model_claim',completeness:'complete',value:'late A'},
        {ref:'later-b',source:'model_claim',completeness:'complete',value:'late B'}]};
    prefix.events.push(later);prefix.revision++;
    const history=operationHistory(prefix);
    const source=history.find(item=>item.ref===rejectedRef);
    assert.ok(source);
    const all=controllerContext(prefix,[],rejection.reason,undefined,65536);
    const chronological=all.filter(i=>[rejectedRef,'later-a','later-b'].includes(i.ref)).map(i=>i.ref);
    assert.deepEqual(chronological,[rejectedRef,'later-a','later-b']);
    // Find a budget where mandatory facts and an excerpt fit but the default map is crowded.
    const small=controllerContext(prefix,[],rejection.reason,undefined,6500);
    const recovered=small.find(i=>i.ref===rejectedRef);
    assert.ok(recovered?.excerpt||recovered?.value,'recovery should precede previews');
    const host=small.find(i=>i.ref==='host:invocation-context').value;
    assert.ok(host.workMap.omitted>0);
    assert.ok(host.workMap.represented>0,'recovery excerpt and minimal work identity can coexist');
    const requested=history.find(i=>i.ref==='later-a');
    const selected=controllerContext(prefix,[],rejection.reason,undefined,6500,undefined,[requested]);
    assert.ok(selected.some(i=>i.ref==='later-a'));
    for(const cursor of [0,{revision:prefix.events.length,index:0}]){
      const explicit=controllerContext(prefix,[],rejection.reason,undefined,6500,undefined,[],cursor);
      assert.ok(explicit.find(i=>i.ref==='host:invocation-context').value.workMap.represented>0);
    }
    const once=controllerContext(prefix,[],rejection.reason,undefined,65536,undefined,[source]);
    assert.equal(once.filter(i=>i.ref===rejectedRef).length,1);
  }finally{await api.close();}
});

test('C17R cross-attempt reference falls back and late cancelled result cannot replace a durable rejection',{timeout:5000},async()=>{
  const reached=Promise.withResolvers(),release=Promise.withResolvers(),reported=Promise.withResolvers();
  let firstRef,secondRef,lateAttempt,firstAttempt;
  const {api,invocations}=setup({maxInvocations:5,async close(){
    // The adapter must not acknowledge detachment before reporting its late
    // result: observations after confirmed detachment are intentionally ignored.
    if(invocations.length===3){
      release.resolve();
      await reported.promise;
      await new Promise(resolve=>setImmediate(resolve));
    }
  },async respond(invocation,count,observe){
    const reply=final(invocation);
    if(count===1){
      firstAttempt=invocation.attemptId;
      firstRef=observe({kind:'model',ref:'first',sourceId:'native',completeness:'complete',value:'# draft'});
      return {...reply,outcome:{...reply.outcome,outputRefs:[{ref:firstRef,kind:'output',source:'model_claim'}]},
        outputObservationRef:firstRef};
    }
    if(count===2){
      secondRef=observe({kind:'model',ref:'second',sourceId:'native',completeness:'complete',value:'# draft'});
      return {...reply,...parseDecisionText('# draft'),outputObservationRef:firstRef,
        outcome:{...reply.outcome,outputRefs:[{ref:secondRef,kind:'output',source:'model_claim'}]}};
    }
    if(count===3){
      lateAttempt=invocation.attemptId;reached.resolve();await release.promise;
      const ref=observe({kind:'model',ref:'late',sourceId:'native',completeness:'complete',value:'# late draft'});
      reported.resolve();
      return {...reply,...parseDecisionText('# late draft'),outputObservationRef:ref,
        outcome:{...reply.outcome,outputRefs:ref?[{ref,kind:'output',source:'model_claim'}]:[]}};
    }
    return reply;
  }});
  try{
    const initial=await(await api.submit(request())).completion;
    assert.equal(initial.status,'finished');
    const run=await api.resume(initial.operationId,{requestId:'next-turn',text:'another task'});
    await reached.promise;
    const active=await api.inspect(initial.operationId);
    const rejected=active.events.find(e=>e.kind==='controller.invalid_proposal');
    assert.notEqual(rejected.attemptId,firstAttempt);
    assert.deepEqual(rejected.result,{ref:'controller-output:'+rejected.attemptId,representation:'declared_value'});
    assert.notEqual(rejected.result.ref,firstRef);
    assert.notEqual(rejected.result.ref,secondRef);
    await api.cancel(initial.operationId,'client');
    const terminal=await run.completion;
    assert.equal(terminal.status,'cancelled');
    const settled=await api.inspect(initial.operationId);
    assert.equal(settled.status,'cancelled');
    assert.equal(settled.events.filter(e=>e.kind==='controller.invalid_proposal').length,1);
    assert.ok(settled.events.some(e=>e.kind==='attempt.outcome'&&e.late&&e.outcome.attemptId===lateAttempt&&
      e.observations?.some(o=>o.value==='# late draft')));
    assert.deepEqual(settled.events.find(e=>e.kind==='controller.invalid_proposal').result,rejected.result);
    assert.equal(invocations.length,3);
  }finally{release.resolve();reported.resolve();await api.close();}
});
