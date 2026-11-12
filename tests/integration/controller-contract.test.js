import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionContract, decisionExample } from '../../src/application/decision-instructions.js';
import { decodeDecision } from '../../src/core/contracts.js';
import { parseDecisionText, renderInvocationPrompt } from '../../src/adapters/invocation-prompt.js';
import { setup, final } from '../fixtures/application.js';
import { outcome, request } from '../fixtures/core.js';

test('C12R.10 shared Decision example decodes and admits with actual invocation ids', async () => {
  const shape=JSON.parse(decisionExample);
  assert.equal(decodeDecision(shape).kind,'accepted');
  const answer='# Heading\nПривет 🧪\n{"nested":true}';
  const {api}=setup({respond(invocation) {
    assert.equal(invocation.instructions.filter(x=>x===decisionContract).length,1);
    const host=invocation.context.find(x=>x.ref==='host:invocation-context').value;
    const prompt=renderInvocationPrompt(invocation,'fixture');
    const payload=JSON.parse(prompt.split('\n\nInvocation (JSON):\n')[1]);
    assert.equal(payload.instructions.filter(x=>x===decisionContract).length,1);
    assert.ok(!prompt.includes('cursor?: number'));
    const output={...shape,operationId:invocation.operationId,contextCursor:host.contextCursor,
      finalAssessment:{...shape.finalAssessment,author:invocation.profile.profileId,answer}};
    return {...final(invocation),output};
  }});
  try {
    const state=await (await api.submit(request())).completion;
    assert.equal(state.status,'finished');
    assert.equal(state.assessment.answer,answer);
    assert.deepEqual(state.assessment.requirements[0].findingRefs,[]);
  } finally { await api.close(); }
});

test('C12R.10 text parse distinguishes malformed, non-object and bounded depth without repair',()=>{
  for (const raw of ['{', 'not JSON', '```json\n{}\n```']) {
    assert.deepEqual(parseDecisionText(raw),{output:raw,decisionTextError:'invalid_json'});
  }
  for (const raw of ['null','false','42','"text"','[]']) {
    assert.deepEqual(parseDecisionText(raw),{output:JSON.parse(raw),decisionTextError:'non_object'});
  }
  const deep='{"x":'.repeat(17)+'0'+'}'.repeat(17);
  assert.deepEqual(parseDecisionText(deep),{output:deep,decisionTextError:'depth'});
  assert.deepEqual(parseDecisionText(decisionExample),{output:JSON.parse(decisionExample)});
  assert.equal(decodeDecision(parseDecisionText('{"assessment":{}}').output).kind,'rejected');
});

test('C12R.10 missing explicit Catalog skill is addressed without blocking independent native or configured skill Workers', async()=>{
  const action=(actionId,skills)=>({actionId,kind:'delegate',profileId:'primary',objective:'Use available tools',
    contextRefs:[],dependsOn:[],expectedResult:'Report',...(skills?{skills}:{})});
  const actions=[action('missing',['native-not-in-catalog']),action('native'),action('registered',['registered'])];
  let controllers=0;
  const {api,invocations}=setup({maxInvocations:4,maxConcurrentInvocations:2,
    extraCatalog:[{kind:'skill',value:{id:'registered',instructions:'Selected instructions'}}],
    respond(invocation) {
      if(invocation.kind==='delegate'){
        assert.ok(!invocation.instructions.includes(decisionContract));
        if(invocation.actionId==='native') assert.equal(invocation.skillInstructions,undefined);
        else assert.deepEqual(invocation.skillInstructions,[{id:'registered',status:'complete',instructions:'Selected instructions'}]);
        return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),output:'report'};
      }
      if(++controllers===1) return final(invocation,{finalAssessment:undefined,additions:actions,
        waitPolicy:{kind:'all_requested',targets:actions.map(a=>({kind:'action',id:a.actionId}))}});
      const host=invocation.context.find(x=>x.ref==='host:invocation-context').value;
      const rejected=host.actions.find(a=>a.kind==='action.rejected'&&a.actionId==='missing');
      assert.equal(rejected.code,'CAPABILITY_UNAVAILABLE');
      assert.equal(rejected.category,'skill');
      assert.equal(rejected.resource,'native-not-in-catalog');
      assert.equal(rejected.detail,'Skill ID is not registered in the Host Catalog. Native capabilities are independent of this catalog.');
      return final(invocation);
    }});
  try{
    const state=await(await api.submit(request())).completion;
    assert.equal(state.status,'finished');
    assert.deepEqual(invocations.filter(i=>i.kind==='delegate').map(i=>i.actionId).sort(),['native','registered']);
    assert.equal(state.attempts.some(a=>a.actionId==='missing'),false);
  }finally{await api.close();}
});

test('C12R.10 invalid proposal leaves accepted independent Worker and observed native effects intact', {timeout:5000}, async()=>{
  const started=Promise.withResolvers(), release=Promise.withResolvers();
  const action=actionId=>({actionId,kind:'delegate',profileId:'primary',objective:'Independent work',
    contextRefs:[],dependsOn:[],expectedResult:'Report'});
  let controllers=0, workers=0;
  const {api,invocations}=setup({maxInvocations:5,maxConcurrentInvocations:2,
    async respond(invocation,count,observe) {
      if(invocation.kind==='delegate'){
        workers++;
        assert.equal(invocation.actionId,'accepted');
        started.resolve();
        await release.promise;
        return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),output:'Worker result'};
      }
      if(++controllers===1) return final(invocation,{finalAssessment:undefined,
        additions:[action('accepted')],nextController:{continue:true}});
      if(controllers===2){
        await started.promise;
        observe({ref:'native-effect',source:'provider_reported',completeness:'complete',value:'Native observation'});
        const response=final(invocation,{finalAssessment:undefined,
          additions:[action('never-dispatch')],nextController:{continue:true}});
        return {...response,outcome:outcome(invocation.attemptId,{effect:'unknown'}),
          output:{...response.output,schemaVersion:2}};
      }
      if(controllers===3){
        const correction=invocation.context.find(x=>x.ref==='host:decision-error').value;
        assert.equal(correction.path,'$.schemaVersion');
        const host=invocation.context.find(x=>x.ref==='host:invocation-context').value;
        assert.ok(host.effectUncertainties.some(x=>x.effect==='unknown'&&x.dispatchCertainty==='sent'));
        release.resolve();
        return final(invocation,{finalAssessment:undefined,
          waitPolicy:{kind:'all_requested',targets:[{kind:'action',id:'accepted'}]}});
      }
      return final(invocation);
    }});
  try{
    const state=await(await api.submit(request())).completion;
    assert.equal(state.status,'finished');
    assert.equal(workers,1);
    assert.equal(controllers,4);
    assert.equal(invocations.length,5);
    assert.equal(state.attempts.some(a=>a.actionId==='never-dispatch'),false);
    const rejected=state.events.find(e=>e.kind==='controller.invalid_proposal');
    const invalidOutcome=state.events.find(e=>e.kind==='attempt.outcome'&&e.outcome.attemptId===rejected.attemptId);
    assert.equal(invalidOutcome.outcome.effect,'unknown');
    assert.equal(invalidOutcome.dispatchCertainty,'sent');
    assert.ok(invalidOutcome.observations.some(o=>o.value==='Native observation'));
    assert.equal(state.events.filter(e=>e.kind==='controller.responded').length,3);
  }finally{release.resolve();await api.close();}
});
