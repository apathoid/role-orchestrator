import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workerRequestHash} from '../../../../src/application/worker-request-identity.js';

test('C11R review P1: hashing covers effective instructions, evidence and restrictions without action IDs',()=>{
  const action={actionId:'first',kind:'delegate',objective:'Edit A',profileId:'p',contextRefs:['request'],
    expectedResult:'Done',dependsOn:[],reasoningLevel:'high'};
  const handoff={objective:'Edit A',expectedResult:'Done',kind:'delegate',operationId:'op',
    actionId:'first',profile:{profileId:'p',providerId:'provider',model:'model'},
    userConstraints:['do not change B'],authorityRef:'grant',workspaceContext:{cwd:'/project'}};
  const base={handoff,action,context:[{ref:'request',value:'task',source:'user',completeness:'complete'}],
    instructions:['rule A'],skillInstructions:[{id:'s',status:'complete',instructions:'Check'}],
    attachments:[],requiredCapabilities:[]};
  const original=workerRequestHash(base);
  assert.match(original,/^[0-9a-f]{64}$/);
  assert.equal(workerRequestHash({...base,action:{...action,actionId:'second',retryOf:'original',
    retryBasis:'provider_idempotency'}}),original);
  for(const changed of [
    {...base,handoff:{...handoff,objective:'Edit B'}},
    {...base,handoff:{...handoff,expectedResult:'Other'}},
    {...base,instructions:['rule B']},
    {...base,skillInstructions:[{id:'s',status:'complete',instructions:'Different'}]},
    {...base,context:[{ref:'request',value:'changed evidence',source:'user',completeness:'complete'}]},
    {...base,requiredCapabilities:['input.image']},
    {...base,action:{...action,contextRefs:['different']}},
  ]) assert.notEqual(workerRequestHash(changed),original);
});
