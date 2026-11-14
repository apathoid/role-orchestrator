import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { applyEvent, createOperation, resourceSnapshot } from '../../src/core/operation.js';
import { createAuthorityGrant } from '../../src/main/index.js';
import { final, setup } from '../fixtures/application.js';
import { decision, outcome, request } from '../fixtures/core.js';

async function durableFixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'role-orchestrator-resume-'));
  const store = createLocalStateStore(directory);
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test('explicit resume reuses crash history, current grant and alternative provider in a changed non-Git directory', { timeout: 5000 }, async t => {
  const { directory, store } = await durableFixture(t);
  const cwd = join(directory, 'workspace');
  await fs.mkdir(cwd);
  const file = join(cwd, 'task.txt');
  await fs.writeFile(file, 'before');
  const child = fork(new URL('../fixtures/dispatch-crash.js', import.meta.url), [
    directory, 'after_provider_dispatch', cwd,
  ], { silent: true });
  const exit = once(child, 'exit');
  t.after(async () => { child.kill('SIGKILL'); await exit; });
  const { operationId } = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exit.then(() => assert.fail('Child did not reach dispatch')),
  ]);
  child.kill('SIGKILL');
  assert.deepEqual(await exit, [null, 'SIGKILL']);
  await fs.writeFile(file, 'after');

  await store.open();
  const before = await store.load(operationId);
  const alt = { profileId: 'alternative', providerId: 'replacement', model: 'other' };
  const current = setup({
    store, idPrefix: 'restart-', configurationRef: 'new-config', profile: alt, maxInvocations: 2,
    authority: createAuthorityGrant({ reference: 'new-grant', origin: 'user', profileIds: [alt.profileId] }),
    async respond(invocation) {
      if (invocation.objective === 'Independent') return final(invocation);
      assert.equal(invocation.workspaceContext.cwd, cwd);
      assert.equal(await fs.readFile(file, 'utf8'), 'after');
      assert.equal(invocation.authorityRef, 'new-grant');
      assert.equal(invocation.profile.providerId, 'replacement');
      const context = invocation.context[1].value;
      assert.deepEqual(context.unresolvedAttempts.map(item => [item.attemptId, item.effect, item.statusLookup]),
        [[before.attempts[0].attemptId, 'unknown', 'unavailable']]);
      assert.equal(context.resources.charged, 2);
      return final(invocation);
    },
  });
  // An unrelated operation can use the slot before anyone resumes the orphan.
  const independent = await current.api.submit(request({
    requestId: 'independent', text: 'Independent', configurationRef: 'new-config',
  }));
  assert.equal((await independent.completion).status, 'finished');
  const [first, concurrent] = await Promise.all([current.api.resume(operationId), current.api.resume(operationId)]);
  assert.equal(first.completion, concurrent.completion);
  const recovered = await first.completion;
  assert.equal(recovered.status, 'finished',current.respondErrors.map(error=>error instanceof Error?error.stack:String(error)).join('\n'));
  assert.equal(recovered.assessment.author, alt.profileId);
  assert.equal(recovered.request.configurationRef, 'test-config');
  assert.equal(recovered.events.find(event => event.kind === 'operation.recovered').trusted.configurationRef, 'new-config');
  assert.equal(recovered.attempts[0].outcome.terminal, 'unknown');
  assert.equal(resourceSnapshot(recovered).charged, 2);
  assert.equal(resourceSnapshot(recovered).remaining, 0);
  assert.equal(current.invocations.filter(invocation => invocation.operationId === operationId).length, 1);
  assert.equal(await fs.readFile(join(directory, 'external-effects'), 'utf8'), 'effect\n');
});

test('negotiated status lookup settles the original attempt without executing old output', async t => {
  const { store } = await durableFixture(t);
  await store.open();
  const old = setup({ store, respond() { throw Error('connection lost'); } });
  const lost = await (await old.api.submit(request())).completion;
  await store.close();
  await store.open();

  const lookedUp = [];
  const current = setup({
    store, idPrefix: 'next-', capabilities: { 'attempt.status': { support: 'supported', source: 'negotiated' } },
    async lookupStatus(query) {
      lookedUp.push([query.operationId, query.attemptId]);
      return { outcome: outcome(query.attemptId, { effect: 'confirmed' }), dispatchCertainty: 'sent',
        output: { finalAssessment: { answer: 'Old model output' } } };
    },
    respond(invocation) {
      assert.deepEqual(invocation.context[1].value.unresolvedAttempts, []);
      const status = invocation.context.find(item => item.ref.startsWith('attempt-status:'));
      assert.equal(status.source, 'provider_reported');
      assert.equal(status.value.outcome.effect, 'confirmed');
      assert.equal(status.value.output, undefined);
      return final(invocation);
    },
  });
  const result = await (await current.api.resume(lost.operationId, { requestId: 'follow', text: 'Continue' })).completion;
  assert.deepEqual(lookedUp, [[lost.operationId, lost.attempts[0].attemptId]]);
  assert.equal(result.assessment?.answer, 'Direct answer', current.respondErrors.map(error=>error instanceof Error?error.stack:String(error)).join('\n'));
  assert.equal(result.attempts[0].outcome.effect, 'confirmed');
  assert.equal(current.invocations.length, 1);
  assert.equal(resourceSnapshot(result).charged, 2);
});

test('a configured-only capability cannot authorize a lookup', async t => {
  const { store } = await durableFixture(t);
  await store.open();
  const old = setup({ store, respond() { throw Error('connection lost'); } });
  const lost = await (await old.api.submit(request())).completion;
  let calls = 0;
  const current = setup({
    store, idPrefix: 'later-', capabilities: { 'attempt.status': { support: 'supported', source: 'configured' } },
    async lookupStatus() { calls++; },
    respond(invocation) {
      assert.equal(invocation.context[1].value.unresolvedAttempts[0].statusLookup, 'unsupported');
      return final(invocation);
    },
  });
  const result = await (await current.api.resume(lost.operationId, { requestId: 'follow', text: 'Continue' })).completion;
  assert.equal(result.status, 'finished');
  assert.equal(calls, 0);
  assert.equal(result.attempts[0].outcome.effect, 'unknown');
});

test('a stuck lookup is bounded and does not suppress the uncertainty passed to the Controller', { timeout: 3000 }, async t => {
  const { store } = await durableFixture(t);
  await store.open();
  const old = setup({ store, respond() { throw Error('connection lost'); } });
  const lost = await (await old.api.submit(request())).completion;
  const started = Promise.withResolvers();
  let expire;
  const current = setup({
    store, idPrefix: 'later-', capabilities: { 'attempt.status': { support: 'supported', source: 'negotiated' } },
    schedule(ms, callback) { expire = callback; return () => {}; },
    async lookupStatus() { started.resolve(); return new Promise(() => {}); },
    respond(invocation) {
      assert.equal(invocation.context[1].value.unresolvedAttempts[0].statusLookup, 'unavailable');
      return final(invocation);
    },
  });
  const resumed = await current.api.resume(lost.operationId, { requestId: 'follow', text: 'Continue' });
  await started.promise;
  expire();
  assert.equal((await resumed.completion).status, 'finished');
});

test('a lookup result naming a different attempt cannot settle the recorded uncertainty', async t => {
  const { store } = await durableFixture(t);
  await store.open();
  const old = setup({ store, respond() { throw Error('connection lost'); } });
  const lost = await (await old.api.submit(request())).completion;
  const current = setup({
    store, idPrefix: 'later-', capabilities: { 'attempt.status': { support: 'supported', source: 'negotiated' } },
    async lookupStatus() {
      return { outcome: outcome('foreign-attempt', { effect: 'confirmed' }), dispatchCertainty: 'sent' };
    },
    respond(invocation) {
      const [unresolved] = invocation.context[1].value.unresolvedAttempts;
      assert.equal(unresolved.attemptId, lost.attempts[0].attemptId);
      assert.equal(unresolved.statusLookup, 'unavailable');
      return final(invocation);
    },
  });
  const result = await (await current.api.resume(lost.operationId, { requestId: 'follow', text: 'Continue' })).completion;
  assert.equal(result.status, 'finished');
  assert.equal(result.attempts[0].outcome.effect, 'unknown');
  assert.ok(!result.events.some(event => event.kind === 'attempt.outcome' && event.outcome.attemptId === 'foreign-attempt'));
});

test('C12R.1 restart retains local Controller failure, resumes accepted unsent attempts and never replays dispatched effects', async t => {
  const {store}=await durableFixture(t);
  await store.open();
  const limits={maxInvocations:15,maxConcurrentInvocations:4};
  let state=createOperation('mixed-op',request(),'fixture-authority',limits);
  assert.deepEqual(await store.commit(state.operationId,null,state),{kind:'committed'});
  let n=0;
  const apply=async event=>{
    const result=applyEvent(state,{eventId:'seed-'+(++n),operationId:state.operationId,receivedAt:n,...event});
    assert.equal(result.kind,'applied',JSON.stringify(result.reason));
    assert.deepEqual(await store.commit(state.operationId,state.revision,result.state),{kind:'committed'});
    state=result.state;
  };
  const worker=(id,dependsOn=[])=>({kind:'delegate',actionId:id,profileId:'primary',objective:id,
    contextRefs:[],dependsOn,expectedResult:'Result'});
  const additions=[worker('reserved'),worker('new'),worker('unknown'),worker('done'),worker('cancelled'),
    worker('dependent',[{actionId:'unknown',kind:'after_terminal'}]),
    worker('blocked',[{actionId:'done',kind:'after_model_acceptance'}])];
  await apply({kind:'controller.responded',decision:decision({operationId:state.operationId,finalAssessment:undefined,
    additions,nextController:{continue:true,reasoningLevel:'unsupported'}}),
    admissions:additions.map(action=>({kind:'accepted',action}))});
  await apply({kind:'attempt.reserved',attemptId:'reserved-id',actionId:'reserved'});
  await apply({kind:'attempt.reserved',attemptId:'unknown-id',actionId:'unknown'});
  await apply({kind:'attempt.dispatched',attemptId:'unknown-id'});
  await apply({kind:'attempt.reserved',attemptId:'done-id',actionId:'done'});
  await apply({kind:'attempt.dispatched',attemptId:'done-id'});
  await apply({kind:'attempt.outcome',outcome:outcome('done-id'),dispatchCertainty:'sent'});
  await apply({kind:'action.cancelled',actionId:'cancelled',source:'superseded'});
  await apply({kind:'attempt.reserved',attemptId:'controller-failed',actionId:'controller-failed',reasoningDecisionId:'decision-1'});
  await apply({kind:'attempt.outcome',outcome:outcome('controller-failed',{terminal:'failed',diagnostics:[{code:'CAPABILITY_UNAVAILABLE'}]}),
    dispatchCertainty:'not_sent'});
  await apply({kind:'operation.waiting',waiting:{kind:'technical',reason:{code:'CAPABILITY_UNAVAILABLE',
    operationId:state.operationId,attemptId:'controller-failed',actionId:'controller-failed',reasoningLevel:'unsupported'}}});
  const {api,invocations}=setup({store,idPrefix:'recovered-',...limits,respond(i){
    assert.equal(i.kind,'delegate');
    return {dispatchCertainty:'sent',outcome:outcome(i.attemptId),output:i.actionId};
  }});
  const restored=await(await api.resume(state.operationId)).completion;
  assert.equal(restored.status,'waiting');
  assert.equal(restored.waiting.reason.reasoningLevel,'unsupported');
  assert.deepEqual(invocations.map(i=>i.actionId).sort(),['dependent','new','reserved']);
  assert.equal(invocations.find(i=>i.actionId==='reserved').attemptId,'reserved-id');
  assert.equal(restored.attempts.find(a=>a.attemptId==='unknown-id').outcome.effect,'unknown');
  assert.equal(restored.attempts.find(a=>a.attemptId==='done-id').outcome.terminal,'completed');
  assert.equal(restored.attempts.filter(a=>a.actionId==='reserved').length,1);
  assert.ok(restored.attempts.every(a=>a.status==='terminal'));
  await api.close();
});
