import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCatalog} from '../../src/main/index.js';
import {renderInvocationPrompt} from '../../src/adapters/invocation-prompt.js';
import {setup, final} from '../fixtures/application.js';
import {assessment, outcome, request} from '../fixtures/core.js';

test('C12R.6 model selects scoped skills and effort, revises delegation from opposing findings, and owns partial assessment', async () => {
  const instruction = 'Do not use provider-native subagents for this task.';
  const profile = {profileId:'primary',providerId:'fixture',model:'same'};
  let loads = 0;
  const catalog = createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',
      reasoningEffort:[{level:'low',effort:'lite'},{level:'high',effort:'deep'}],
      defaultReasoningLevel:'low'}},controllerProfile:'primary'}, [],
    {records:[{id:'checks',version:'v1',description:'Review checks',instructions:instruction}],
      async loadSkill(){loads++;throw new Error('Inline source must not be reloaded');}});
  const worker = (actionId, reasoningLevel, contextRefs=[], skills=['checks']) => ({
    actionId, kind:'delegate', objective:'Inspect '+actionId, profileId:'primary', reasoningLevel,
    expectedResult:'Finding', contextRefs, dependsOn:[], skills,
  });
  const wait = actions => ({kind:'all_requested',targets:actions.map(a=>({kind:'action',id:a.actionId}))});
  const refs = new Map();
  let controllers = 0;
  const {api,invocations} = setup({profile,catalog,maxInvocations:6,maxConcurrentInvocations:2,
    async respond(invocation,count,observe){
      if(invocation.kind==='delegate'){
        const id=invocation.actionId;
        if(id==='verify'){
          assert.equal(invocation.skillInstructions?.length??0,0);
          for(const ref of ['finding:left','finding:right',refs.get('left'),refs.get('right')]){
            assert.equal((await invocation.contextAccess.fetch(ref)).kind,'available');
          }
        }else{
          assert.deepEqual(invocation.skillInstructions,[{id:'checks',version:'v1',status:'complete',instructions:instruction}]);
          assert.ok(renderInvocationPrompt(invocation,'fixture').includes(instruction));
        }
        const value=id==='left'?'failed':id==='right'?'passed':'different inputs';
        refs.set(id,observe({kind:'provider_tool',sourceId:'run-'+id,ref:'check-result',
          completeness:'complete',value}));
        return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),
          output:value,findings:[{findingId:id,author:'primary',subject:'target',claim:value,
            supports:['check-result'],uncertainties:[]}]};
      }
      const contextCursor=invocation.context[1].value.contextCursor;
      assert.equal(invocation.skillInstructions?.length??0,0);
      assert.ok(!renderInvocationPrompt(invocation,'fixture').includes(instruction));
      if(++controllers===1){
        const additions=[worker('left','low'),worker('right','high'),
          {...worker('bad','low'),roleId:'missing-role'}];
        return final(invocation,{contextCursor,additions,finalAssessment:undefined,waitPolicy:wait(additions)});
      }
      if(controllers===2){
        const claims=invocation.context.filter(x=>x.kind==='finding');
        assert.deepEqual(claims.map(x=>x.value.claim).sort(),['failed','passed']);
        assert.notEqual(refs.get('left'),refs.get('right'));
        const additions=[worker('verify','high',['finding:left','finding:right',refs.get('left'),refs.get('right')],[])];
        return final(invocation,{contextCursor,additions,finalAssessment:undefined,
          waitPolicy:wait(additions),nextController:{reasoningLevel:'high'}});
      }
      assert.equal(invocation.reasoning.level,'high');
      const ref=refs.get('verify');
      assert.equal((await invocation.contextAccess.fetch(ref)).kind,'available');
      return final(invocation,{contextCursor,finalAssessment:assessment({overall:'partial',
        answer:'Different inputs checked; the intended input remains unverified.',
        requirements:[
          {requirementId:'reconcile',status:'fulfilled',observationRefs:[ref],findingRefs:['finding:verify']},
          {requirementId:'intended-input',status:'unverified',observationRefs:[],findingRefs:[],reason:'No evidence'},
        ],observationRefs:[ref],findingRefs:['finding:verify'],unresolvedQuestions:['Which input was intended?']})});
    }});
  try{
    const state=await(await api.submit(request())).completion;
    assert.equal(state.status,'finished');
    assert.equal(state.assessment.overall,'partial');
    assert.deepEqual(state.assessment.requirements.map(x=>x.status),['fulfilled','unverified']);
    assert.equal(loads,0);
    assert.equal(controllers,3);
    assert.equal(invocations.length,6);
    assert.deepEqual(invocations.filter(x=>x.kind==='delegate').map(x=>x.actionId).sort(),['left','right','verify']);
    assert.deepEqual(state.attempts.filter(x=>x.actionId!==x.attemptId).map(x=>[x.actionId,x.route.reasoning.level]).sort(),
      [['left','low'],['right','high'],['verify','high']]);
    assert.ok(state.events.some(x=>x.kind==='action.rejected'&&x.actionId==='bad'&&x.category==='role'));
    assert.ok(state.attempts.every(x=>x.outcome.terminal==='completed'));
  }finally{await api.close();}
});
