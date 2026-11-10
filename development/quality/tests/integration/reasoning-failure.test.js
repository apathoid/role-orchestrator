import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCatalog} from '../../../../src/application/configuration/catalog.js';
import {operationView, operationTrace} from '../../../../src/hosts/commands.js';
import {runCli} from '../../../../src/hosts/cli.js';
import {Readable, Writable} from 'node:stream';
import {setup, final} from '../../fixtures/application.js';
import {decision, outcome, request} from '../../fixtures/core.js';

test('C11R.6 unsupported own effort surfaces durable failure, no fallback, explicit resume', async () => {
  const profile={profileId:'primary',providerId:'fixture',model:'same'};
  const trusted=createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',reasoningEffort:[
      {level:'low',effort:'low-native'}, {level:'high',effort:'high-native'}],defaultReasoningLevel:'low'}},
    controllerProfile:'primary'});
  let repaired=false;
  const catalog={...trusted,selectReasoning(id,level){
    return repaired ? trusted.selectReasoning(id) : trusted.selectReasoning(id,level);
  }};
  const {api,invocations}=setup({profile,catalog,maxInvocations:5,respond(i,n){
    if(n===1) return {dispatchCertainty:'sent',outcome:outcome(i.attemptId),
      output:decision({operationId:i.operationId,decisionId:'choose-unsupported',finalAssessment:undefined,
        nextController:{continue:true,reasoningLevel:'ultra'}})};
    return final(i,{decisionId:'corrected'});
  }});
  const waiting=await (await api.submit(request())).completion;
  assert.equal(waiting.status,'waiting');
  assert.equal(invocations.length,1,'failed selection must not open or invoke');
  assert.equal(waiting.waiting.reason.code,'CAPABILITY_UNAVAILABLE');
  assert.equal(waiting.waiting.reason.profileId,'primary');
  assert.equal(waiting.waiting.reason.reasoningLevel,'ultra');
  assert.deepEqual(waiting.waiting.reason.availableLevels,['high','low']);
  assert.equal(waiting.attempts[1].dispatchCertainty,'not_sent');
  assert.equal(waiting.attempts[1].outcome.effect,'none');
  assert.equal(operationView(waiting).waiting.reason.reasoningLevel,'ultra');
  assert.equal(operationTrace(waiting).waiting.reasoningLevel,'ultra');
  repaired=true;
  const resumed=await (await api.resume(waiting.operationId,{requestId:'followup-1',
    text:'Continue with corrected trusted provider settings'})).completion;
  assert.equal(resumed.status,'finished');
  assert.equal(invocations.length,2);
  assert.equal(invocations[1].reasoning.level,'low');
  assert.equal(resumed.attempts.length,3);
  assert.equal(resumed.attempts[1].outcome.effect,'none');
  await api.close();
});

test('C11R.6 unsupported configured Controller default fails before opening provider', async () => {
  const profile={profileId:'primary',providerId:'fixture',model:'same',
    reasoning:{mode:'selectable',levels:['one'],defaultLevel:'one'}};
  const {api,invocations}=setup({profile,maxInvocations:2});
  const result=await (await api.submit(request())).completion;
  assert.equal(result.waiting.reason.code,'CAPABILITY_UNAVAILABLE');
  assert.equal(result.waiting.reason.profileId,'primary');
  assert.deepEqual(result.waiting.reason.availableLevels,['one']);
  assert.equal(invocations.length,0);
  await api.close();
});

test('C11R review P1: ACP session effort refusal becomes visible Host failure and nonzero CLI exit',async()=>{
  const profile={profileId:'primary',providerId:'fixture',model:'same'};
  const catalog=createCatalog({schemaVersion:1,providers:{fixture:{adapter:'fixture'}},
    profiles:{primary:{provider:'fixture',model:'same',reasoningEffort:[
      {level:'low',effort:'native-low'}, {level:'high',effort:'native-high'},
    ],defaultReasoningLevel:'low'}},controllerProfile:'primary'});
  let calls=0;
  const {api,invocations}=setup({profile,catalog,maxInvocations:4,respond(i,n){
    calls++;
    if(n===1)return {dispatchCertainty:'sent',outcome:outcome(i.attemptId),
      output:decision({operationId:i.operationId,decisionId:'high',
        finalAssessment:undefined,nextController:{continue:true,reasoningLevel:'high'}})};
    return {dispatchCertainty:'not_sent',
      outcome:outcome(i.attemptId,{terminal:'failed',effect:'none',
        diagnostics:[{code:'CAPABILITY_UNAVAILABLE'}]}),
      reasoningUnavailable:'session_option_unavailable'};
  }});
  const waiting=await(await api.submit(request({requestId:'acp-error'}))).completion;
  assert.equal(waiting.status,'waiting');
  assert.equal(waiting.waiting.reason.profileId,'primary');
  assert.equal(waiting.waiting.reason.reasoningLevel,'high');
  assert.equal(waiting.waiting.reason.reasoningCause,'session_option_unavailable');
  assert.deepEqual(waiting.waiting.reason.availableLevels,['high','low']);
  assert.equal(calls,2);
  assert.equal(invocations.length,2);
  assert.equal(waiting.attempts[1].outcome.effect,'none');
  assert.equal(operationTrace(waiting).waiting.reasoningCause,'session_option_unavailable');

  let stdout='',stderr='';
  const output=()=>new Writable({write(chunk,enc,done){stdout+=chunk.toString();done();}});
  const err=()=>new Writable({write(chunk,enc,done){stderr+=chunk.toString();done();}});
  const exit=await runCli(['run','check','--format','text'],
    {cwd:process.cwd(),stdin:Readable.from([]),stdout:output(),stderr:err()},
    async()=>waiting);
  assert.equal(exit,1);
  assert.match(stdout,/Error: CAPABILITY_UNAVAILABLE/);
  assert.match(stdout,/reasoningLevel=high/);
  assert.match(stdout,/cause=session_option_unavailable/);
  assert.equal(stderr,'');
  assert.equal((await api.inspect(waiting.operationId)).status,'waiting');
  await api.close();
});
