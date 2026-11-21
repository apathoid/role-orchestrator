import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, final } from '../fixtures/application.js';
import { request, outcome, decision } from '../fixtures/core.js';
import { applyEvent, acceptedWorkerAllowed, createOperation, resourceSnapshot } from '../../src/core/operation.js';
import { encodeSnapshot, decodeSnapshot } from '../../src/core/snapshot.js';
import { createLocalStateStore } from '../../src/adapters/state/local-store.js';
import { decisionRecovery } from '../../src/application/decision-recovery.js';
import { parseDecisionText } from '../../src/adapters/invocation-prompt.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hostOf = invocation => invocation.context.find(item => item.ref === 'host:invocation-context')?.value;
const userOf = (invocation, ref) => invocation.context.find(item => item.ref === ref);

test('C16.0 RED: A→B after finished retains initial objective and identifies latest accepted user turn', async () => {
  const seen = [];
  const { api, respondErrors } = setup({ maxInvocations: 3, respond(invocation) {
    seen.push(invocation);
    return final(invocation);
  } });
  try {
    const first = await (await api.submit(request({ text: 'Investigate the latest commit' }))).completion;
    assert.equal(first.status, 'finished');
    const second = await (await api.resume(first.operationId, {
      requestId: 'undo-redo-focus', text: 'Investigate an unrelated Undo/Redo focus defect',
    })).completion;
    assert.equal(second.status, 'finished', respondErrors.map(String).join('\n'));
    assert.equal(seen.length, 2);
    assert.equal(seen[1].objective, 'Investigate the latest commit');
    assert.equal(userOf(seen[1], 'request-1')?.value, 'Investigate the latest commit');
    assert.equal(userOf(seen[1], 'undo-redo-focus')?.value, 'Investigate an unrelated Undo/Redo focus defect');
    assert.deepEqual(hostOf(seen[1]).userTurns.initial, {
      ref: 'request-1', receivedSequence: { revision: 0, index: 0 },
    });
    assert.deepEqual(hostOf(seen[1]).userTurns.latest, {
      ref: 'undo-redo-focus', receivedSequence: userOf(seen[1], 'undo-redo-focus').receivedSequence,
    });
  } finally { await api.close(); }
});

test('C16.0 RED: after a question, a correlated new user turn stays a literal message, not a Host-classified answer', async () => {
  const seen = [];
  const { api } = setup({ maxInvocations: 3, respond(invocation) {
    seen.push(invocation);
    return seen.length === 1
      ? final(invocation, { finalAssessment: undefined, clarification: { question: 'Which branch?' } })
      : final(invocation);
  } });
  try {
    const first = await (await api.submit(request())).completion;
    assert.equal(first.status, 'waiting');
    const second = await (await api.resume(first.operationId, {
      requestId: 'changed-task', questionId: first.waiting.questionId,
      text: 'Do not inspect the branch. Investigate Undo/Redo focus instead.',
    })).completion;
    assert.equal(second.status, 'finished');
    assert.equal(userOf(seen[1], 'changed-task')?.provenance.kind, 'user');
    assert.equal(hostOf(seen[1]).userTurns.latest.ref, 'changed-task');
    assert.equal(hostOf(seen[1]).userTurns.initial.ref, 'request-1');
  } finally { await api.close(); }
});

test('C16.0 RED: five identical rejected Controller Decisions enter technical waiting without a sixth reservation', async () => {
  const corrections = [];
  const { api, invocations } = setup({ maxInvocations: 15, respond(invocation) {
    const host = hostOf(invocation);
    if (invocations.length > 1) {
      const correction = invocation.context.find(item => item.ref === 'host:decision-error')?.value;
      // Capture actual transport facts without turning a missing field into
      // a provider failure; threshold behavior is asserted independently.
      corrections.push({
        category: correction?.category,
        attemptId: correction?.attemptId,
        previousAttemptId: invocations.at(-2).attemptId,
        totalRejected: correction?.totalRejected,
        consecutiveIdentical: correction?.consecutiveIdentical,
        hostTotal: host?.decisionRecovery?.totalRejected,
      });
    }
    return { ...final(invocation), output: '{', decisionTextError: 'invalid_json' };
  } });
  try {
    const state = await (await api.submit(request())).completion;
    assert.equal(invocations.length, 5);
    assert.equal(corrections.length, 4);
    for (const [index, correction] of corrections.entries()) {
      assert.equal(correction.category, 'invalid_json');
      assert.equal(correction.attemptId, correction.previousAttemptId);
      assert.equal(correction.totalRejected, index + 1);
      assert.equal(correction.consecutiveIdentical, index + 1);
      assert.equal(correction.hostTotal, index + 1);
    }
    assert.equal(state.events.filter(item => item.kind === 'controller.invalid_proposal').length, 5);
    assert.equal(state.status, 'waiting');
    assert.equal(state.waiting.kind, 'technical');
    assert.equal(state.waiting.reason.code, 'INVALID_PROPOSAL');
    assert.equal(state.waiting.reason.resource, 'controller_decision_recovery');
    assert.equal(state.waiting.reason.attemptId, invocations[4].attemptId);
    assert.equal(state.waiting.reason.actionId, invocations[4].attemptId);
  } finally { await api.close(); }
});

test('C16.0 RED: ten alternating rejections count per user turn, not by shared error text', async () => {
  const { api, invocations } = setup({ maxInvocations: 15, respond(invocation) {
    const current = invocations.length;
    const reply = final(invocation);
    return current % 2 === 0
      ? { ...reply, output: { ...reply.output, schemaVersion: 2 } }
      : { ...reply, output: 'invalid json', decisionTextError: 'invalid_json' };
  } });
  try {
    const state = await (await api.submit(request())).completion;
    assert.equal(state.status, 'waiting');
    assert.equal(invocations.length, 10);
    assert.equal(state.events.filter(item => item.kind === 'controller.invalid_proposal').length, 10);
    assert.equal(state.waiting.reason.code, 'INVALID_PROPOSAL');
  } finally { await api.close(); }
});


test('C16.5: accepted Decision resets the identical series but not total rejections in the user turn', async () => {
  const { api, invocations, respondErrors } = setup({ maxInvocations: 15, respond(invocation) {
    const n = invocations.length;
    if (n === 5 || n === 10) {
      if (n === 10) {
        assert.equal(hostOf(invocation).decisionRecovery.totalRejected, 8);
        assert.equal(hostOf(invocation).decisionRecovery.consecutiveIdentical, 4);
      }
      return final(invocation, { finalAssessment: undefined, nextController: { continue: true } });
    }
    if (n === 6 || n === 11) {
      assert.equal(hostOf(invocation).decisionRecovery.consecutiveIdentical, 0);
      assert.equal(hostOf(invocation).decisionRecovery.totalRejected, n === 6 ? 4 : 8);
    }
    return { ...final(invocation), output: 'not-json', decisionTextError: 'invalid_json' };
  } });
  try {
    const state = await (await api.submit(request())).completion;
    assert.equal(state.status, 'waiting', respondErrors.map(String).join('\n'));
    assert.equal(state.waiting.reason.resource, 'controller_decision_recovery');
    assert.equal(invocations.length, 12);
    assert.equal(state.events.filter(event => event.kind === 'controller.invalid_proposal').length, 10);
    assert.equal(state.events.filter(event => event.kind === 'controller.responded').length, 2);
  } finally { await api.close(); }
});

test('C16.5: new accepted user input resets turn-local recovery, never the operation invocation budget', async () => {
  const { api, invocations } = setup({ maxInvocations: 11, respond(invocation) {
    const n = invocations.length;
    if (n === 6 || n === 11) {
      const recovery = hostOf(invocation).decisionRecovery;
      assert.equal(recovery.totalRejected, 0);
      assert.equal(recovery.consecutiveIdentical, 0);
      assert.equal(recovery.lastRejection.scope, 'prior_user_turn');
      return n === 11 ? final(invocation) : { ...final(invocation), output: '{', decisionTextError: 'invalid_json' };
    }
    return { ...final(invocation), output: '{', decisionTextError: 'invalid_json' };
  } });
  try {
    const first = await (await api.submit(request())).completion;
    assert.equal(first.status, 'waiting');
    assert.equal(first.waiting.reason.resource, 'controller_decision_recovery');
    const noInput = await (await api.resume(first.operationId)).completion;
    assert.equal(noInput.status, 'waiting');
    assert.equal(invocations.length, 5, 'plain technical resume must not dispatch a sixth Controller');
    const second = await (await api.resume(first.operationId, {
      requestId: 'new-input-1', text: 'Please address a different question.',
    })).completion;
    assert.equal(second.status, 'waiting');
    assert.equal(second.waiting.reason.resource, 'controller_decision_recovery');
    assert.equal(invocations.length, 10);
    const third = await (await api.resume(first.operationId, {
      requestId: 'new-input-2', text: 'Provide the final answer now.',
    })).completion;
    assert.equal(third.status, 'finished');
    assert.equal(invocations.length, 11);
    assert.equal(third.attempts.length, 11);
    assert.equal(third.limits.maxInvocations, 11);
  } finally { await api.close(); }
});

test('C16.5: category follows the actual parser decoder or admission boundary, not the rejected output text', async () => {
  const { api, invocations } = setup({ maxInvocations: 6, respond(invocation) {
    const n = invocations.length;
    const reply = final(invocation);
    if (n === 1) return { ...reply, output: 'still-text', decisionTextError: 'invalid_json' };
    if (n === 2) return { ...reply, output: { ...reply.output, schemaVersion: 2 } };
    if (n === 3) return { ...reply, output: { ...reply.output, operationId: 'not-this-operation' } };
    assert.equal(hostOf(invocation).decisionRecovery.totalRejected, 3);
    assert.equal(invocation.context.find(item => item.ref === 'host:decision-error').value.category, 'admission_invalid');
    return reply;
  } });
  try {
    const state = await (await api.submit(request())).completion;
    assert.equal(state.status, 'finished');
    assert.deepEqual(state.events.filter(item => item.kind === 'controller.invalid_proposal').map(item => item.category),
      ['invalid_json', 'schema_invalid', 'admission_invalid']);
  } finally { await api.close(); }
});

test('C16.5: crash after durable threshold rejection cannot reserve an extra Controller', async () => {
  const { encodeSnapshot, decodeSnapshot } = await import('../../src/core/snapshot.js');
  const states = new Map();
  let failOnce = true;
  const store = {
    async load(id) { return structuredClone(states.get(id)); },
    async list() { return structuredClone([...states.values()]); },
    async commit(id, revision, next) {
      if ((states.get(id)?.revision ?? null) !== revision) return { kind: 'conflict' };
      if (failOnce && next.events.at(-1)?.kind === 'operation.waiting' &&
          next.waiting?.kind === 'technical' && next.waiting.reason.resource === 'controller_decision_recovery') {
        failOnce = false;
        return { kind: 'unavailable' };
      }
      const checked = decodeSnapshot(encodeSnapshot(next));
      assert.equal(checked.kind, 'accepted');
      states.set(id, structuredClone(checked.value));
      return { kind: 'committed' };
    },
  };
  const invalid = invocation => ({ ...final(invocation), output: '{', decisionTextError: 'invalid_json' });
  const initial = setup({ store, maxInvocations: 12, respond: invalid });
  let operationId;
  try {
    const submission = await initial.api.submit(request());
    operationId = submission.operation.operationId;
    await assert.rejects(submission.completion, error => error.code === 'STORE_UNAVAILABLE');
    assert.equal(states.get(operationId).status, 'active');
    assert.equal(states.get(operationId).events.filter(e => e.kind === 'controller.invalid_proposal').length, 5);
  } finally { await initial.api.close(); }
  const restarted = setup({ store, idPrefix: 'restarted-', maxInvocations: 12,
    respond: () => assert.fail('the sixth Controller must not run') });
  try {
    const state = await (await restarted.api.resume(operationId)).completion;
    assert.equal(state.status, 'waiting');
    assert.equal(state.waiting.reason.code, 'INVALID_PROPOSAL');
    assert.equal(state.waiting.reason.resource, 'controller_decision_recovery');
    assert.equal(restarted.invocations.length, 0);
  } finally { await restarted.api.close(); }
});

test('C16.5: duplicate rejection records for the same Controller attempt are charged once', async () => {
  const { decisionRecovery } = await import('../../src/application/decision-recovery.js');
  const { createOperation } = await import('../../src/core/operation.js');
  const state = createOperation('op', request(), 'grant',
    { maxInvocations: 20, maxConcurrentInvocations: 1 }, 1);
  const event = {kind:'controller.invalid_proposal', eventId:'invalid-one', operationId:'op',
    receivedAt:2, attemptId:'attempt-one', category:'schema_invalid',
    reason:{code:'INVALID_PROPOSAL', path:'$.schemaVersion', expected:'1'}};
  state.events.push(event, {...event, eventId:'invalid-duplicate', receivedAt:3});
  const recovery = decisionRecovery(state);
  assert.equal(recovery.totalRejected, 1);
  assert.equal(recovery.consecutiveIdentical, 1);
});

test('C16.5: the literal latest user message remains mandatory under a long optional history budget', async () => {
  const { controllerContext } = await import('../../src/application/controller-context.js');
  const { createOperation } = await import('../../src/core/operation.js');
  const state = createOperation('op', request({text:'First user instruction'}), 'grant',
    {maxInvocations:500,maxConcurrentInvocations:1}, 1);
  for(let i=0; i<80; i++) {
    state.events.push({kind:'operation.continued',eventId:'continued-'+i,receivedAt:2+i,operationId:'op',
      input:{requestId:'follow-'+i,text:'User context '+i+' '+('x'.repeat(1500))}});
  }
  state.revision = state.events.length;
  const context = controllerContext(state, [], undefined, undefined, 8192);
  const users = context.filter(item => item.provenance?.kind === 'user');
  const host = context.find(item => item.ref === 'host:invocation-context')?.value;
  assert.equal(users.length, 81);
  assert.equal(users.at(-1).value, 'User context 79 '+('x'.repeat(1500)));
  assert.deepEqual(host.userTurns.latest, {
    ref:'follow-79',receivedSequence:{revision:80,index:0},
  });
  assert.equal(host.userTurns.initial.ref, 'request-1');
  assert.ok(!JSON.stringify(host.userTurns).includes('User context'));
});


test('C16.5: Controller reaching the rejection threshold does not cancel independently accepted running Workers', {timeout:5000}, async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  const action = { actionId:'independent', kind:'delegate', profileId:'primary',
    objective:'Complete independent work', contextRefs:[], dependsOn:[], expectedResult:'Report' };
  let controllers = 0;
  const { api, invocations, cancellations } = setup({maxInvocations:12,maxConcurrentInvocations:2,
    committedDiagnostic(diag) {
      if(diag.eventName === 'operation.waiting' && diag.reasonCode === 'INVALID_PROPOSAL') waiting.resolve();
    },
    async respond(invocation) {
      if(invocation.kind === 'delegate') {
        started.resolve();
        await release.promise;
        return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),output:'Independent report'};
      }
      if(++controllers === 1) return final(invocation, {
        finalAssessment:undefined, additions:[action], nextController:{continue:true},
      });
      return {...final(invocation),output:'{',decisionTextError:'invalid_json'};
    },
  });
  try {
    const run = await api.submit(request());
    await started.promise;
    await waiting.promise;
    const during = await api.inspect(run.operation.operationId);
    assert.equal(during.status,'waiting');
    assert.equal(during.waiting.reason.code,'INVALID_PROPOSAL');
    assert.equal(during.events.filter(e=>e.kind==='controller.invalid_proposal').length,5);
    const worker = during.attempts.find(item=>item.actionId==='independent');
    assert.equal(worker.status,'dispatched');
    assert.equal(cancellations.length,0);
    release.resolve();
    const complete = await run.completion;
    assert.equal(complete.status,'waiting');
    assert.equal(complete.attempts.find(item=>item.actionId==='independent').outcome.terminal,'completed');
    assert.equal(invocations.filter(item=>item.kind==='controller').length,6);
  } finally { release.resolve(); await api.close(); }
});


/**
 * Build an authentic reducer-validated journal, then persist it through the
 * production local StateStore. The Worker reservation is intentionally
 * before the external dispatch boundary: an interrupted process cannot
 * manufacture an observation or claim a successful invocation.
 * @param {ReturnType<typeof createLocalStateStore>} store
 * @param {boolean} dispatched
 */
async function seedC16RejectedControllerWithWorker(store, dispatched) {
  const limits = { maxInvocations: 9, maxConcurrentInvocations: 2 };
  let state = createOperation('c16r-operation', request({requestId:'c16r-initial-request'}),
    'fixture-authority', limits, 1);
  assert.deepEqual(await store.commit(state.operationId, null, state), {kind:'committed'});
  let serial = 0;
  const append = async data => {
    const event = {eventId:'c16r-seed-'+(++serial), operationId:state.operationId,
      receivedAt:serial+1, ...data};
    const transition = applyEvent(state, event);
    assert.equal(transition.kind, 'applied', JSON.stringify(transition.reason));
    assert.deepEqual(await store.commit(state.operationId, state.revision, transition.state), {kind:'committed'});
    state = transition.state;
  };
  const route = {configurationRef:'test-config',profileId:'primary',providerId:'fixture',model:'fake'};
  const worker = {kind:'delegate', actionId:'independent-worker', profileId:'primary',
    objective:'Complete independent work', contextRefs:[], dependsOn:[], expectedResult:'Worker report'};
  const initial = 'controller-initial';
  await append({kind:'attempt.reserved',attemptId:initial,actionId:initial});
  await append({kind:'attempt.dispatched',attemptId:initial,route});
  await append({kind:'attempt.outcome',outcome:outcome(initial),dispatchCertainty:'sent'});
  const accepted = decision({decisionId:'accepted-worker-decision',operationId:state.operationId,
    contextCursor:state.revision, additions:[worker],finalAssessment:undefined,
    nextController:{continue:true}});
  await append({kind:'controller.responded',attemptId:initial,decision:accepted,
    admissions:[{kind:'accepted',action:worker}]});
  const workerAttemptId = 'original-worker-attempt';
  await append({kind:'attempt.reserved',attemptId:workerAttemptId,actionId:worker.actionId});
  if (dispatched) await append({kind:'attempt.dispatched',attemptId:workerAttemptId,route});
  for (let index=0; index<5; index++) {
    const attemptId = 'rejected-controller-'+index;
    await append({kind:'attempt.reserved',attemptId,actionId:attemptId,
      ...(index===0 ? {reasoningDecisionId:'accepted-worker-decision'} : {})});
    await append({kind:'attempt.dispatched',attemptId,route});
    await append({kind:'attempt.outcome',outcome:outcome(attemptId),dispatchCertainty:'sent'});
    await append({kind:'controller.invalid_proposal',attemptId,category:'schema_invalid',
      reason:{code:'INVALID_PROPOSAL',path:'$.schemaVersion',expected:'1'}});
  }
  const lastController = 'rejected-controller-4';
  await append({kind:'operation.waiting',waiting:{kind:'technical',
    reason:{code:'INVALID_PROPOSAL',operationId:state.operationId,
      attemptId:lastController,actionId:lastController,resource:'controller_decision_recovery'}}});
  const snapshot = decodeSnapshot(encodeSnapshot(state));
  assert.equal(snapshot.kind,'accepted');
  assert.equal(snapshot.value.status,'waiting');
  assert.equal(snapshot.value.attempts.length,7);
  assert.equal(resourceSnapshot(snapshot.value).charged,7);
  assert.equal(decisionRecovery(snapshot.value).totalRejected,5);
  assert.equal(decisionRecovery(snapshot.value).consecutiveIdentical,5);
  assert.equal(acceptedWorkerAllowed(snapshot.value,worker.actionId),true);
  return {operationId:state.operationId,worker,workerAttemptId,lastController,limits};
}

test('C16R.1A: after restart a reserved unsent independent Worker reuses its identity and budget under Controller technical waiting', {timeout:10000}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'role-orchestrator-c16r-reserved-'));
  const before = createLocalStateStore(dir);
  const after = createLocalStateStore(dir);
  let api;
  try {
    await before.open();
    const seed = await seedC16RejectedControllerWithWorker(before,false);
    const persistedBefore = await before.load(seed.operationId);
    assert.equal(persistedBefore.attempts.find(a=>a.attemptId===seed.workerAttemptId).status,'reserved');
    assert.equal(persistedBefore.attempts.find(a=>a.attemptId===seed.workerAttemptId).dispatchCertainty,'not_sent');
    await before.close(); // release the old process's single-writer ownership
    await after.open(); // model a new Host instance on the same durable directory
    const calls = [];
    const fixture = setup({store:after,idPrefix:'c16r-reserved-restarted-',...seed.limits,
      respond(invocation) {
        calls.push({kind:invocation.kind,actionId:invocation.actionId,attemptId:invocation.attemptId});
        return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),output:'Original worker result'};
      },
    });
    api = fixture.api;
    const {completion} = await api.resume(seed.operationId);
    const restored = await completion;
    assert.deepEqual(calls,[{kind:'delegate',actionId:seed.worker.actionId,attemptId:seed.workerAttemptId}]);
    assert.equal(restored.status,'waiting');
    assert.equal(restored.waiting.kind,'technical');
    assert.equal(restored.waiting.reason.resource,'controller_decision_recovery');
    assert.equal(restored.waiting.reason.attemptId,seed.lastController);
    assert.equal(restored.attempts.length,7);
    assert.equal(resourceSnapshot(restored).charged,7);
    assert.equal(resourceSnapshot(restored).remaining,2);
    assert.equal(restored.attempts.find(a=>a.attemptId===seed.workerAttemptId).status,'terminal');
    assert.equal(restored.attempts.find(a=>a.attemptId===seed.workerAttemptId).outcome.terminal,'completed');
    assert.equal(restored.events.filter(e=>e.kind==='attempt.reserved'&&e.actionId===seed.worker.actionId).length,1);
    assert.equal(restored.events.filter(e=>e.kind==='attempt.outcome'&&e.outcome.attemptId===seed.workerAttemptId).length,1);
    assert.equal(restored.events.filter(e=>e.kind==='operation.continued').length,0);
    assert.equal(restored.events.filter(e=>e.kind==='operation.recovered').length,1);
    assert.equal(decisionRecovery(restored).totalRejected,5);
    assert.equal(decisionRecovery(restored).consecutiveIdentical,5);
    assert.equal(decodeSnapshot(encodeSnapshot(restored)).kind,'accepted');
  } finally {
    await api?.close();
    await after.close();
    await before.close();
    await rm(dir,{recursive:true,force:true});
  }
});

for (const resolvedByLookup of [false,true]) {
  test('C16R.1B: dispatched unknown-effect Worker is not replayed after restart'+
    (resolvedByLookup?' and trusted lookup may settle it':' without a supported lookup'),
    {timeout:10000}, async () => {
    const dir = await mkdtemp(join(tmpdir(),'role-orchestrator-c16r-unknown-'));
    const before = createLocalStateStore(dir);
    const after = createLocalStateStore(dir);
    let api;
    try {
      await before.open();
      const seed = await seedC16RejectedControllerWithWorker(before,true);
      await before.close();
      await after.open();
      const observedLookups=[];
      const fixture = setup({store:after,idPrefix:'c16r-unknown-restarted-',...seed.limits,
        ...(resolvedByLookup?{
          capabilities:{'attempt.status':{support:'supported',source:'negotiated'}},
          lookupStatus(query) {
            observedLookups.push(query.attemptId);
            return {dispatchCertainty:'unknown',outcome:outcome(query.attemptId,
              {terminal:'completed',effect:'confirmed'})};
          },
        }:{}),
        respond(invocation) {
          // Do not turn an unexpected replay into a Provider failure. Assert
          // the invocation count at the Orchestrator boundary instead.
          return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId),
            output:'unexpected replay'};
        },
      });
      api = fixture.api;
      const {completion} = await api.resume(seed.operationId);
      const restored = await completion;
      const worker = restored.attempts.find(a=>a.attemptId===seed.workerAttemptId);
      assert.equal(fixture.invocations.length,0);
      assert.deepEqual(observedLookups,resolvedByLookup?[seed.workerAttemptId]:[]);
      assert.equal(restored.status,'waiting');
      assert.equal(restored.waiting.reason.resource,'controller_decision_recovery');
      assert.equal(restored.waiting.reason.attemptId,seed.lastController);
      assert.equal(worker.status,'terminal');
      assert.equal(worker.dispatchCertainty,'unknown');
      assert.equal(worker.outcome.terminal,resolvedByLookup?'completed':'unknown');
      assert.equal(worker.outcome.effect,resolvedByLookup?'confirmed':'unknown');
      assert.equal(restored.events.filter(e=>e.kind==='controller.invalid_proposal').length,5);
      assert.equal(restored.events.filter(e=>e.kind==='operation.continued').length,0);
      assert.equal(restored.events.filter(e=>e.kind==='action.cancelled').length,0);
      assert.equal(restored.events.filter(e=>e.kind==='attempt.reserved'&&e.actionId===seed.worker.actionId).length,1);
      assert.equal(resourceSnapshot(restored).charged,7);
      assert.equal(decisionRecovery(restored).totalRejected,5);
      assert.equal(decodeSnapshot(encodeSnapshot(restored)).kind,'accepted');
    } finally {
      await api?.close();
      await after.close();
      await before.close();
      await rm(dir,{recursive:true,force:true});
    }
  });
}


for (const sample of [
  {category:'non_object', wire:JSON.stringify('C16R_REJECTED_PAYLOAD_non_object'),
    expected:'a JSON object'},
  {category:'depth', wire:'{"nested":'.repeat(17)+
    '"C16R_REJECTED_PAYLOAD_depth"'+'}'.repeat(17),
    expected:'JSON nesting depth at most 16'},
]) {
  test('C16R.2: text parser '+sample.category+' → Application → durable journal → restart → correction',
    {timeout:10000}, async () => {
    const directory = await mkdtemp(join(tmpdir(),'role-orchestrator-c16r-parser-'));
    const firstStore = createLocalStateStore(directory);
    const secondStore = createLocalStateStore(directory);
    let firstApi, secondApi;
    try {
      await firstStore.open();
      const parserReports = [];
      let ambiguousCommitReported = false;
      // Only the commit acknowledgement is lost, AFTER the journal event
      // is durably persisted. This separates Provider output failure from
      // snapshot recovery without crashing or re-running an external process.
      const ambiguousStore = {
        ...firstStore,
        async commit(operationId, revision, next) {
          const result = await firstStore.commit(operationId,revision,next);
          if (result.kind === 'committed' && !ambiguousCommitReported &&
              next.events.at(-1)?.kind === 'controller.invalid_proposal') {
            ambiguousCommitReported = true;
            return {kind:'unavailable'};
          }
          return result;
        },
      };
      const first = setup({store:ambiguousStore,maxInvocations:4,
        respond(invocation) {
          const reported = parseDecisionText(sample.wire);
          parserReports.push({attemptId:invocation.attemptId, ...reported});
          return {...final(invocation),...reported};
        },
      });
      firstApi = first.api;
      const started = await firstApi.submit(request({requestId:'c16r-parser-'+sample.category}));
      const operationId = started.operation.operationId;
      await assert.rejects(started.completion,error => error.code === 'STORE_UNAVAILABLE');
      assert.equal(ambiguousCommitReported,true);
      assert.equal(first.invocations.length,1);
      assert.equal(first.respondErrors.length,0);
      assert.equal(parserReports.length,1);
      assert.equal(parserReports[0].decisionTextError,sample.category);
      const failed = await firstStore.load(operationId);
      assert.equal(failed.status,'active');
      assert.equal(failed.attempts.length,1);
      assert.equal(failed.attempts[0].outcome.terminal,'completed');
      assert.equal(failed.events.filter(e=>e.kind==='controller.responded').length,0);
      const invalid = failed.events.filter(e=>e.kind==='controller.invalid_proposal');
      assert.equal(invalid.length,1);
      assert.equal(invalid[0].attemptId,parserReports[0].attemptId);
      assert.equal(invalid[0].category,sample.category);
      assert.deepEqual(invalid[0].reason,{
        code:'INVALID_PROPOSAL',path:'$',expected:sample.expected,
      });
      assert.equal(decisionRecovery(failed).totalRejected,1);
      assert.equal(decisionRecovery(failed).consecutiveIdentical,1);
      assert.equal(resourceSnapshot(failed).charged,1);
      // The existing provider-output Observation is authoritative evidence.
      // C16 must not copy the rejected body into an additional error record
      // or recovery counter. Removing that original observation would be a
      // source-of-truth regression, not a fix.
      const originalOutputs = failed.events.flatMap(event=>event.kind==='attempt.outcome'
        ? (event.observations??[]).filter(item=>typeof item.value==='string' &&
          item.value.includes('C16R_REJECTED_PAYLOAD_')) : []);
      assert.equal(originalOutputs.length,1);
      assert.equal(originalOutputs[0].ref,'controller-output:'+parserReports[0].attemptId);
      assert.equal(originalOutputs[0].source,'model_claim');
      assert.deepEqual(invalid[0].result,{ref:originalOutputs[0].ref,representation:'declared_value'});
      assert.equal(originalOutputs[0].provenance.kind,'model');
      assert.equal(JSON.stringify(invalid[0]).includes('C16R_REJECTED_PAYLOAD_'),false);
      assert.equal(JSON.stringify(decisionRecovery(failed)).includes('C16R_REJECTED_PAYLOAD_'),false);
      assert.equal(decodeSnapshot(encodeSnapshot(failed)).kind,'accepted');

      await firstApi.close();
      firstApi=undefined;
      await firstStore.close();
      await secondStore.open();
      const corrections=[];
      const second = setup({store:secondStore,idPrefix:'c16r-correction-',maxInvocations:4,
        respond(invocation) {
          const error = invocation.context.find(item=>item.ref==='host:decision-error')?.value;
          const history = invocation.context.find(item=>item.ref==='host:invocation-context')?.value?.decisionRecovery;
          corrections.push({kind:invocation.kind,attemptId:invocation.attemptId,
            correction:error,history});
          return final(invocation); // a valid Decision must complete normally
        },
      });
      secondApi = second.api;
      const restored = await (await secondApi.resume(operationId)).completion;
      assert.equal(restored.status,'finished',second.respondErrors.map(String).join('\n'));
      assert.equal(second.respondErrors.length,0);
      assert.equal(corrections.length,1);
      assert.equal(corrections[0].kind,'controller');
      assert.deepEqual({
        category:corrections[0].correction?.category,
        stage:corrections[0].correction?.stage,
        attemptId:corrections[0].correction?.attemptId,
        path:corrections[0].correction?.path,
        expected:corrections[0].correction?.expected,
        totalRejected:corrections[0].correction?.totalRejected,
        consecutiveIdentical:corrections[0].correction?.consecutiveIdentical,
      },{
        category:sample.category,stage:'parser',attemptId:parserReports[0].attemptId,
        path:'$',expected:sample.expected,totalRejected:1,consecutiveIdentical:1,
      });
      assert.deepEqual(corrections[0].correction.result.ref,invalid[0].result.ref);
      assert.equal(corrections[0].correction.result.representation,'declared_value');
      assert.equal(corrections[0].history?.totalRejected,1);
      assert.equal(corrections[0].history?.consecutiveIdentical,1);
      assert.equal(corrections[0].history?.lastRejection?.category,sample.category);
      assert.equal(corrections[0].history?.lastRejection?.stage,'parser');
      assert.equal(corrections[0].history?.lastRejection?.scope,'current_user_turn');
      assert.equal(corrections[0].history?.lastRejection?.attemptId,parserReports[0].attemptId);
      assert.equal(restored.events.filter(e=>e.kind==='controller.invalid_proposal').length,1);
      assert.equal(restored.events.filter(e=>e.kind==='controller.responded').length,1);
      assert.equal(restored.attempts.length,2);
      assert.equal(resourceSnapshot(restored).charged,2);
      assert.equal(resourceSnapshot(restored).remaining,2);
      assert.equal(restored.events.filter(e=>e.kind==='operation.recovered').length,1);
      const restoredOutputs = restored.events.flatMap(event=>event.kind==='attempt.outcome'
        ? (event.observations??[]).filter(item=>typeof item.value==='string' &&
          item.value.includes('C16R_REJECTED_PAYLOAD_')) : []);
      assert.deepEqual(restoredOutputs,originalOutputs,
        'restart preserves the original provider Observation without duplicating rejected output');
      assert.equal(decodeSnapshot(encodeSnapshot(restored)).kind,'accepted');
    } finally {
      await secondApi?.close();
      await firstApi?.close();
      await secondStore.close();
      await firstStore.close();
      await rm(directory,{recursive:true,force:true});
    }
  });
}

test('C16R.2: a noncompleted Provider attempt without a declared Decision never counts as a rejected proposal',
  async () => {
  const attempts=[];
  const {api,respondErrors}=setup({maxInvocations:3,
    respond(invocation) {
      attempts.push(invocation.attemptId);
      return {dispatchCertainty:'sent',outcome:outcome(invocation.attemptId,{
        terminal:'failed',effect:'unknown',diagnostics:[{code:'PROVIDER_DISCONNECTED'}],
      })};
    },
  });
  try {
    const state = await (await api.submit(request({requestId:'c16r-provider-failure'}))).completion;
    assert.equal(respondErrors.length,0);
    assert.equal(state.status,'waiting');
    assert.equal(state.waiting.reason.code,'PROVIDER_DISCONNECTED');
    assert.equal(state.attempts.length,1);
    assert.equal(attempts.length,1);
    assert.equal(state.events.filter(e=>e.kind==='controller.invalid_proposal').length,0);
    assert.equal(decisionRecovery(state).totalRejected,0);
    assert.equal(decisionRecovery(state).consecutiveIdentical,0);
    assert.equal(resourceSnapshot(state).charged,1);
    assert.equal(decodeSnapshot(encodeSnapshot(state)).kind,'accepted');
  } finally { await api.close(); }
});
