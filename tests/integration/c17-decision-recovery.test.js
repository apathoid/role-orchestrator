import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseDecisionText} from '../../src/adapters/invocation-prompt.js';
import {decodeSnapshot, encodeSnapshot} from '../../src/core/snapshot.js';
import {setup, final} from '../fixtures/application.js';
import {request} from '../fixtures/core.js';

const errorOf = invocation => invocation.context.find(item => item.ref === 'host:decision-error')?.value;
const historyOf = invocation => invocation.context.find(item => item.ref === 'host:invocation-context').value.decisionRecovery;

for (const kind of ['malformed', 'parsed', 'structured', 'bad-ref', 'conflict', 'tiny-budget']) {
  test('C17.2 declared result correlation: ' + kind, async () => {
    let declaredRef, independentRef, raw, fetched;
    const {api, invocations, respondErrors} = setup({
      ...(kind === 'tiny-budget' && {context:{controllerMaxBytes:1024}}),
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
        raw = kind === 'parsed' ? JSON.stringify(invalid) : '# Invalid JSON 🧪';
        independentRef = observe({kind:'model',sourceId:'progress',ref:'progress',completeness:'complete',value:raw});
        declaredRef = observe({kind:'model',sourceId:'final',ref:'actual',completeness:'complete',value:raw});
        if(kind === 'conflict') observe({kind:'model',sourceId:'final',ref:'actual',completeness:'complete',value:'inconsistent'});
        return {...reply,...parseDecisionText(raw),outputObservationRef:kind==='bad-ref' ? 'unknown-ref' : declaredRef,
          outcome:{...reply.outcome,outputRefs:[independentRef,declaredRef].map(ref=>({ref,kind:'output',source:'model_claim'}))}};
      },
    });
    try {
      const state = await (await api.submit(request())).completion;
      assert.equal(state.status,'finished',respondErrors.map(String).join('\n'));
      const event = state.events.find(item=>item.kind==='controller.invalid_proposal');
      const original = kind==='malformed'||kind==='parsed';
      assert.deepEqual(event.result,{ref:original ? declaredRef : 'controller-output:'+event.attemptId,
        representation:original?'reported_text':'declared_value'});
      const error = errorOf(invocations[1]);
      assert.equal(error.result.ref,event.result.ref);
      assert.equal(error.result.storedCompleteness,'complete');
      assert.equal(error.result.retrieval,'bounded_context_request');
      if(kind==='tiny-budget') assert.equal(error.result.inline,'omitted');
      else assert.equal(error.result.inline,'complete');
      assert.equal(fetched.kind,'available');
      if(original) {
        assert.notEqual(event.result.ref,independentRef);
        assert.equal(fetched.item.value,raw);
        assert.equal(invocations[1].context.filter(item=>item.ref===declaredRef).length,1);
      }
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
