import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAuthorityGrant, createCatalog} from '../../src/main/index.js';
import {setup, final} from '../fixtures/application.js';
import {decision, request, outcome} from '../fixtures/core.js';

test('C11R.4 parallel workers on one model retain distinct selections and invalid peers do not block', async () => {
  const profile={profileId:'primary',providerId:'fixture',model:'base'};
  const config={schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'base'},worker:{provider:'fixture',model:'same',
      reasoningEffort:[{level:'low',effort:'lite'},{level:'high',effort:'deep'}],defaultReasoningLevel:'low'}},
    controllerProfile:'primary'};
  const catalog=createCatalog(config);
  const actions=['low','high','invalid'].map((level,i)=>({
    actionId:'a'+i,kind:'delegate',profileId:'worker',reasoningLevel:level,
    objective:'Review '+i,expectedResult:'Findings',contextRefs:[],dependsOn:[],
  }));
  const seen=[];
  const {api,invocations}=setup({profile,catalog,
    authority:createAuthorityGrant({reference:'fixture-authority',origin:'user',profileIds:['primary','worker']}),
    maxInvocations:7,maxConcurrentInvocations:3,
    respond(invocation) {
      if (invocation.kind==='delegate') {
        seen.push({level:invocation.reasoning,profile:invocation.profile});
        return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),output:'Checked'};
      }
      if (invocations.length===1) return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),
        output:decision({operationId:invocation.operationId,decisionId:'choose',
          finalAssessment:undefined,additions:actions,
          waitPolicy:{kind:'all_requested',targets:actions.map(a=>({kind:'action',id:a.actionId}))}})};
      return final(invocation,{decisionId:'done'});
    },
  });
  const completed=await (await api.submit(request())).completion;
  assert.equal(completed.status,'finished');
  assert.equal(seen.length,2);
  assert.deepEqual(seen.map(x=>x.level.nativeValue).sort(),['deep','lite']);
  assert.equal(seen[0].profile,seen[1].profile);
  assert.equal(completed.events.filter(e=>e.kind==='action.rejected'&&e.actionId==='a2').length,1);
  const routes=completed.attempts.filter(x=>x.route?.profileId==='worker').map(x=>x.route.reasoning);
  assert.deepEqual(routes.map(x=>x.nativeValue).sort(),['deep','lite']);
  assert.equal(invocations.filter(x=>x.kind==='delegate'&&x.reasoning?.level==='invalid').length,0);
  await api.close();
});
