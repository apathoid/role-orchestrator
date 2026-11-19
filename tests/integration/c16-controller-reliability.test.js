import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, final } from '../fixtures/application.js';
import { request, outcome } from '../fixtures/core.js';

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
  const { api, invocations } = setup({ maxInvocations: 15, respond(invocation) {
    const host = hostOf(invocation);
    if (invocations.length > 1) {
      const correction = invocation.context.find(item => item.ref === 'host:decision-error')?.value;
      assert.equal(correction.category, 'invalid_json');
      assert.equal(correction.attemptId, invocations.at(-2).attemptId);
      assert.equal(correction.totalRejected, invocations.length - 1);
      assert.equal(correction.consecutiveIdentical, invocations.length - 1);
      assert.equal(host.decisionRecovery.totalRejected, invocations.length - 1);
    }
    return { ...final(invocation), output: '{', decisionTextError: 'invalid_json' };
  } });
  try {
    const state = await (await api.submit(request())).completion;
    assert.equal(invocations.length, 5);
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
